import { randomUUID } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import { cp, chmod, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArtifactService } from "../artifacts/contract.js";
import type { PermissionsService } from "../permissions/contract.js";
import type { SystemActionExecutionContext } from "../system/contract.js";
import type { SkillsService } from "./contract.js";

export interface SkillInstallInput {
  readonly url?: string | undefined;
  readonly attachmentIndex?: number | undefined;
  readonly replace?: boolean | undefined;
}

export interface SkillInstallResult {
  readonly installed: readonly string[];
  readonly source: string;
  readonly files: number;
  readonly bytes: number;
}

function stateRoot(): string {
  const configured = process.env.FRIDAY_HOME?.trim() || process.env.FRIDAY_STATE_DIR?.trim();
  return configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
}

function contained(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || rel === "." || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function makePrivateTree(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`skill installation contains symlink: ${path}`);
    if (info.isDirectory()) await makePrivateTree(path);
    else if (info.isFile()) await chmod(path, 0o600);
    else throw new Error(`skill installation contains unsupported file type: ${path}`);
  }
}

async function atomicInstall(source: string, destination: string, replaceExisting: boolean): Promise<void> {
  const root = resolve(join(destination, ".."));
  if (!contained(root, destination)) throw new Error("skill destination escaped the user skill root");
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`user skill root must be a private directory: ${root}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`user skill root permissions are too broad: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error(`user skill root could not be made private: ${root}`);
  }
  const staging = join(root, `.install-${randomUUID()}`);
  const backup = join(root, `.backup-${randomUUID()}`);
  let hadExisting = false;
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await makePrivateTree(staging);
    try {
      const info = await lstat(destination);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`existing skill destination is not a regular directory: ${destination}`);
      hadExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (hadExisting && !replaceExisting) throw new Error(`skill already installed: ${destination}`);
    if (hadExisting) await rename(destination, backup);
    try {
      await rename(staging, destination);
    } catch (error) {
      if (hadExisting) {
        try { await rename(backup, destination); } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Skill installation failed and the prior skill could not be restored");
        }
      }
      throw error;
    }
    if (hadExisting) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch((error: unknown) => {
      reportOperationalError({ component: "skills", operation: "remove install staging directory", error });
    });
    await rm(backup, { recursive: true, force: true }).catch((error: unknown) => {
      reportOperationalError({ component: "skills", operation: "remove install backup directory", error });
    });
  }
}

export async function installSkills(input: SkillInstallInput, dependencies: {
  readonly skills: SkillsService;
  readonly artifacts: ArtifactService;
  readonly permissions: PermissionsService;
  readonly context: SystemActionExecutionContext;
}): Promise<SkillInstallResult> {
  const url = input.url?.trim();
  const attachments = dependencies.context.turn.attachments ?? [];
  const attachmentIndex = input.attachmentIndex ?? (url ? undefined : attachments.length > 0 ? 0 : undefined);
  if (Boolean(url) === (attachmentIndex !== undefined)) throw new Error("provide exactly one skill source: url or attachmentIndex");
  if (attachmentIndex !== undefined && (!Number.isSafeInteger(attachmentIndex) || attachmentIndex < 0 || attachmentIndex >= attachments.length)) {
    throw new Error("attachmentIndex does not identify an attachment on this turn");
  }

  if (url) {
    await dependencies.permissions.authorize({
      mode: dependencies.permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
      workspace: process.cwd(),
      access: "read",
      action: { id: "skills.inspect-package", effect: "external-read", resource: url, network: true },
      reason: "inspect the user-provided skill package before presenting its installation plan",
    });
  }

  const stage = await dependencies.artifacts.stagePackageSource({
    ...(url ? { url } : {}),
    ...(attachmentIndex === undefined ? {} : { attachment: attachments[attachmentIndex], principal: dependencies.context.turn.principal }),
    ...(dependencies.context.signal === undefined ? {} : { signal: dependencies.context.signal }),
  });
  try {
    const loaded = dependencies.skills.api.loadSkillsFromDir({ dir: stage.sourceDir, source: "install-candidate" });
    const candidates = loaded.skills;
    if (candidates.length === 0) {
      const diagnostics = loaded.diagnostics.slice(0, 6).map((entry) => entry.message).join("; ");
      throw new Error(`no valid skill was found in the supplied package${diagnostics ? `: ${diagnostics}` : ""}`);
    }
    if (candidates.length > 16) throw new Error("skill package contains more than 16 skills");
    const names = [...new Set(candidates.map((skill) => skill.name))];
    if (names.length !== candidates.length) throw new Error("skill package contains duplicate skill names");

    await dependencies.context.turn.reply([
      "Skill installation plan",
      `Source: ${stage.source}`,
      `Skills: ${names.join(", ")}`,
      `Files: ${stage.files}`,
      `Expanded size: ${stage.bytes} bytes`,
      `Destination: ${join(stateRoot(), "skills")}`,
      input.replace ? "Existing skills with the same name will be replaced." : "Existing skills with the same name will not be overwritten.",
    ].join("\n"));

    await dependencies.permissions.authorize({
      mode: dependencies.permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
      workspace: process.cwd(),
      access: "write",
      action: { id: "skills.install", effect: "system-write", resource: `skills:${names.join(",")}`, network: Boolean(url) },
      reason: `install user-provided skills: ${names.join(", ")}`,
    });

    const installRoot = join(stateRoot(), "skills");
    for (const skill of candidates) await atomicInstall(skill.baseDir, join(installRoot, skill.name), input.replace === true);
    return Object.freeze({ installed: Object.freeze(names), source: stage.source, files: stage.files, bytes: stage.bytes });
  } finally {
    await stage.dispose();
  }
}
