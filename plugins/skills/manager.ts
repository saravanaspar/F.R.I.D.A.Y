import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SkillsModule } from "./contract.js";

const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_SKILL_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_FILES = 128;
const MAX_RELATIVE_PATH_CHARS = 240;
const FORBIDDEN_SOURCE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|authorization)\b\s*[:=]\s*[^\s]{8,}|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}))/i;
const PROMPT_INJECTION = /(?:ignore|disregard|override|bypass).{0,60}(?:system|developer|previous instructions?|security|permission)|(?:system prompt|developer message).{0,40}(?:reveal|exfiltrate|print)/i;

export function userSkillsDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_HOME?.trim() || environment.FRIDAY_STATE_DIR?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "skills");
}

export function normalizeSkillName(value: unknown): string {
  if (typeof value !== "string") throw new Error("skill name must be a string");
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) || name.includes("--")) {
    throw new Error("skill name must be 1-64 lowercase letters, numbers, or single hyphens");
  }
  return name;
}

function normalizedRelativePath(value: unknown, fallback = "SKILL.md"): string {
  const raw = value === undefined ? fallback : value;
  if (typeof raw !== "string" || !raw.trim()) throw new Error("skill file path must be a non-empty string");
  const normalized = raw.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.length > MAX_RELATIVE_PATH_CHARS || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("skill file path must be a bounded relative path without traversal");
  }
  if (normalized.startsWith(".git/") || normalized === ".git" || normalized.includes("/node_modules/")) {
    throw new Error("skill file path targets a reserved directory");
  }
  return normalized;
}

function contained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function assertNoSymlinkAncestors(root: string, target: string, allowMissingLeaf = true): Promise<void> {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  if (!contained(absoluteRoot, absoluteTarget)) throw new Error("skill path escapes the user skill root");
  const rel = relative(absoluteRoot, absoluteTarget);
  let current = absoluteRoot;
  try {
    const rootInfo = await lstat(current);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`user skill root is not a regular directory: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(current, { recursive: true, mode: 0o700 });
  }
  const parts = rel ? rel.split(sep) : [];
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`skill path contains a symlink: ${current}`);
      if (i < parts.length - 1 && !info.isDirectory()) throw new Error(`skill path ancestor is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && (allowMissingLeaf || i < parts.length - 1)) continue;
      throw error;
    }
  }
}

function cleanContent(value: unknown, label: string, maximum = MAX_SKILL_FILE_BYTES): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/[\u{e0000}-\u{e007f}]/gu, "")
    .replaceAll("\u0000", "\ufffd")
    .replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(normalized, "utf8") > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
  if (FORBIDDEN_SOURCE.test(normalized)) throw new Error(`${label} appears to contain authentication material; secrets must not be embedded in Skills`);
  return normalized;
}

function validateSkillFrontmatter(skills: SkillsModule, name: string, content: string): void {
  if (PROMPT_INJECTION.test(content)) throw new Error("SKILL.md contains policy-override or prompt-exfiltration language and was rejected by the managed-skill security scan");
  const parsed = skills.parseFrontmatter<Record<string, unknown>>(content).frontmatter;
  if (parsed.name !== name) throw new Error(`SKILL.md frontmatter name must exactly match ${name}`);
  if (typeof parsed.description !== "string" || !parsed.description.trim()) throw new Error("SKILL.md requires a description");
  const description = parsed.description.trim();
  if (description.length > 60) throw new Error("SKILL.md description must be at most 60 characters");
  if (!/[.!?]$/.test(description)) throw new Error("SKILL.md description must be one short sentence ending with punctuation");
  if (/\b(?:powerful|comprehensive|seamless|advanced|robust)\b/i.test(description)) {
    throw new Error("SKILL.md description must state the capability without marketing language");
  }
  if (parsed.version !== "0.1.0" && typeof parsed.version !== "string") throw new Error("SKILL.md version must be a string (new Skills should start at 0.1.0)");
  if (parsed.author !== "FRIDAY") throw new Error("Agent-authored Skills must use author: FRIDAY");
}

function assertManagedSkillFilePath(path: string): void {
  if (path === "SKILL.md") return;
  const [top] = path.split("/");
  if (top !== "references" && top !== "scripts" && top !== "templates" && top !== "assets") {
    throw new Error("supporting Skill files must live under references/, scripts/, templates/, or assets/");
  }
}

async function scanTree(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Skill contains a symlink: ${relative(root, path)}`);
      if (info.isDirectory()) { await visit(path); continue; }
      if (!info.isFile()) throw new Error(`Skill contains unsupported file type: ${relative(root, path)}`);
      files += 1;
      bytes += info.size;
      if (files > MAX_SKILL_FILES) throw new Error(`Skill exceeds ${MAX_SKILL_FILES} files`);
      if (bytes > MAX_SKILL_TOTAL_BYTES) throw new Error(`Skill exceeds ${MAX_SKILL_TOTAL_BYTES} bytes`);
    }
  };
  await visit(root);
  return { files, bytes };
}

async function validateSkill(skills: SkillsModule, root: string, name: string): Promise<void> {
  const skillPath = join(root, name, "SKILL.md");
  const content = await readFile(skillPath, "utf8");
  validateSkillFrontmatter(skills, name, content);
  await scanTree(join(root, name));
  const result = skills.loadSkillsFromDir({ dir: join(root, name), source: "user" });
  if (!result.skills.some((entry) => entry.name === name)) {
    throw new Error(`Skill ${name} did not load after mutation: ${result.diagnostics.map((item) => item.message).join("; ") || "unknown validation failure"}`);
  }
  const severe = result.diagnostics.filter((item) => item.type !== "collision");
  if (severe.length > 0) throw new Error(`Skill ${name} has validation diagnostics: ${severe.map((item) => item.message).join("; ")}`);
}

async function withRollback<T>(root: string, name: string, operation: () => Promise<T>, validate = true, skills?: SkillsModule): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, name);
  await assertNoSymlinkAncestors(root, target);
  const backup = join(root, `.friday-skill-backup-${name}-${randomUUID()}`);
  let existed = false;
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Skill target is not a directory: ${target}`);
    existed = true;
    await cp(target, backup, { recursive: true, force: false, errorOnExist: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const result = await operation();
    if (validate) {
      if (!skills) throw new Error("Skill validation runtime is unavailable");
      await validateSkill(skills, root, name);
    }
    return result;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    if (existed) await rename(backup, target);
    throw error;
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
}

async function atomicWrite(root: string, path: string, content: string): Promise<void> {
  await assertNoSymlinkAncestors(root, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertNoSymlinkAncestors(root, dirname(path));
  let mode = 0o644;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Skill file is not a regular file: ${path}`);
    mode = info.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode, flag: "wx" });
  try {
    await rename(tmp, path);
    await chmod(path, mode);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError([error, cleanupError], "Skill file publication and temporary-file cleanup both failed");
      }
    }
    throw error;
  }
}

function normalizeForFuzzy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fuzzyReplace(content: string, oldText: string, newText: string, replaceAll: boolean): string {
  if (content.includes(oldText)) {
    const count = content.split(oldText).length - 1;
    if (count > 1 && !replaceAll) throw new Error("patch oldText matches multiple exact locations; set replaceAll=true or provide more context");
    return replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
  }
  const target = normalizeForFuzzy(oldText);
  if (!target) throw new Error("patch oldText must not be empty");
  const lines = content.split("\n");
  const oldLines = oldText.split("\n");
  const width = Math.max(1, oldLines.length);
  const matches: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < lines.length; start += 1) {
    for (let extra = -2; extra <= 2; extra += 1) {
      const end = start + width + extra;
      if (end <= start || end > lines.length) continue;
      if (normalizeForFuzzy(lines.slice(start, end).join("\n")) === target) matches.push({ start, end });
    }
  }
  const unique = matches.filter((match, index) => matches.findIndex((other) => other.start === match.start && other.end === match.end) === index);
  if (unique.length === 0) throw new Error("patch oldText was not found, including whitespace-tolerant matching");
  if (unique.length > 1 && !replaceAll) throw new Error("patch oldText has multiple whitespace-tolerant matches; provide more context");
  const selected = replaceAll ? unique.sort((a, b) => b.start - a.start) : [unique[0]!];
  let next = [...lines];
  for (const match of selected) next.splice(match.start, match.end - match.start, ...newText.split("\n"));
  return next.join("\n");
}

export interface SkillManageInput {
  readonly action: "create" | "edit" | "patch" | "write_file" | "remove_file" | "delete";
  readonly name: string;
  readonly description?: string | undefined;
  readonly body?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly path?: string | undefined;
  readonly content?: string | undefined;
  readonly oldText?: string | undefined;
  readonly newText?: string | undefined;
  readonly replaceAll?: boolean | undefined;
}

export async function manageSkill(skills: SkillsModule, input: SkillManageInput): Promise<Record<string, unknown>> {
  const root = userSkillsDir();
  const name = normalizeSkillName(input.name);
  const target = join(root, name);
  if (input.action === "create") {
    const skill = input.content !== undefined
      ? cleanContent(input.content, "skill content")
      : (() => {
          const description = cleanContent(input.description, "skill description", 60).trim();
          const body = cleanContent(input.body, "skill body");
          const tags = [...new Set((input.tags ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))]
            .map((tag) => {
              if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tag)) throw new Error("skill tags must be 1-64 lowercase letters, numbers, dots, underscores, or hyphens");
              return tag;
            })
            .slice(0, 16);
          return cleanContent([
            "---",
            `name: ${name}`,
            `description: ${JSON.stringify(description)}`,
            "version: 0.1.0",
            "author: FRIDAY",
            ...(tags.length === 0 ? [] : ["metadata:", "  friday:", `    tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`]),
            "---",
            "",
            body.trim(),
            "",
          ].join("\n"), "generated SKILL.md");
        })();
    return withRollback(root, name, async () => {
      try { await lstat(target); throw new Error(`Skill ${name} already exists; view and patch/edit it instead`); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(target, { recursive: false, mode: 0o700 });
      await atomicWrite(root, join(target, "SKILL.md"), skill);
      return { action: "create", name, path: join(target, "SKILL.md") };
    }, true, skills);
  }
  if (input.action === "delete") {
    await assertNoSymlinkAncestors(root, target, false);
    try { await lstat(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { action: "delete", name, deleted: false };
      throw error;
    }
    await rm(target, { recursive: true, force: false });
    return { action: "delete", name, deleted: true };
  }
  const rel = normalizedRelativePath(input.path);
  assertManagedSkillFilePath(rel);
  const file = join(target, rel);
  return withRollback(root, name, async () => {
    await assertNoSymlinkAncestors(root, target, false);
    if (input.action === "edit" || input.action === "write_file") {
      const content = cleanContent(input.content, "skill file content");
      await atomicWrite(root, file, content);
      return { action: input.action, name, path: rel, bytes: Buffer.byteLength(content) };
    }
    if (input.action === "patch") {
      const oldText = cleanContent(input.oldText, "patch oldText");
      const newText = cleanContent(input.newText, "patch newText");
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Skill file is not a regular file: ${rel}`);
      if (info.size > MAX_SKILL_FILE_BYTES) throw new Error(`Skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
      const current = await readFile(file, "utf8");
      const next = fuzzyReplace(current, oldText, newText, input.replaceAll === true);
      await atomicWrite(root, file, next);
      return { action: "patch", name, path: rel, bytes: Buffer.byteLength(next) };
    }
    if (input.action === "remove_file") {
      if (rel === "SKILL.md") throw new Error("SKILL.md cannot be removed; delete the Skill instead");
      try {
        const info = await lstat(file);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Skill file is not a regular file: ${rel}`);
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { action: "remove_file", name, path: rel, deleted: false };
        throw error;
      }
      return { action: "remove_file", name, path: rel, deleted: true };
    }
    throw new Error(`Unsupported skill_manage action: ${String(input.action)}`);
  }, true, skills);
}

export async function viewSkill(skills: SkillsModule, name?: string, path?: string): Promise<Record<string, unknown>> {
  const root = userSkillsDir();
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!name) {
    const result = skills.loadSkillsFromDir({ dir: root, source: "user" });
    return {
      skills: result.skills.map((skill) => ({ name: skill.name, description: skill.description, kind: skill.kind, filePath: skill.filePath })),
      diagnostics: result.diagnostics.slice(0, 50),
    };
  }
  const normalized = normalizeSkillName(name);
  const target = join(root, normalized);
  await assertNoSymlinkAncestors(root, target, false);
  if (path) {
    const rel = normalizedRelativePath(path);
    const file = join(target, rel);
    await assertNoSymlinkAncestors(root, file, false);
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Skill file is not a regular file: ${rel}`);
    if (info.size > MAX_SKILL_FILE_BYTES) throw new Error(`Skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
    return { name: normalized, path: rel, content: await readFile(file, "utf8") };
  }
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (files.length >= MAX_SKILL_FILES) break;
      const file = join(dir, entry.name);
      const info = await lstat(file);
      if (info.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push(relative(target, file).replaceAll("\\", "/"));
    }
  };
  await visit(target);
  const skillMdPath = join(target, "SKILL.md");
  const skillMdInfo = await lstat(skillMdPath);
  if (skillMdInfo.isSymbolicLink() || !skillMdInfo.isFile()) throw new Error("SKILL.md is not a regular file");
  if (skillMdInfo.size > MAX_SKILL_FILE_BYTES) throw new Error(`SKILL.md exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
  const skillMd = await readFile(skillMdPath, "utf8");
  return { name: normalized, files, skillMd };
}
