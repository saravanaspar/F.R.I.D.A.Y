import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

export type SkillSecurityIssueKind = "prompt-injection" | "dangerous-command";

export interface SkillSecurityIssue {
  readonly kind: SkillSecurityIssueKind;
  readonly message: string;
  readonly path?: string | undefined;
}

const MAX_SECURITY_SCAN_FILES = 128;
const MAX_SECURITY_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_SECURITY_WALK_ENTRIES = 4096;
const MAX_SECURITY_WALK_DEPTH = 32;
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".sh", ".bash", ".zsh",
  ".fish", ".ps1", ".cmd", ".bat", ".rb", ".pl", ".php", ".lua", ".go", ".rs", ".java", ".kt",
  ".sql", ".rst", ".yaml", ".yml", ".json", ".toml", ".ini", ".cfg", ".conf", ".xml", ".html", ".css", ".svg",
]);
const TEXT_BASENAMES = new Set(["Dockerfile", "Makefile", "Justfile", "Procfile"]);
const TEXT_SNIFF_BYTES = 4096;

type UnknownFileDisposition = "scan" | "skip" | "reject";

function classifyUnknownFile(path: string, mode: number): UnknownFileDisposition {
  const executable = (mode & 0o111) !== 0;
  const buffer = Buffer.alloc(TEXT_SNIFF_BYTES);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count === 0) return executable ? "reject" : "skip";
    const sample = buffer.subarray(0, count);
    if (sample[0] === 0x23 && sample[1] === 0x21) return "scan"; // #!
    let suspiciousControls = 0;
    for (const byte of sample) {
      if (byte === 0) return executable ? "reject" : "skip";
      if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspiciousControls += 1;
    }
    if (suspiciousControls / sample.length > 0.02) return executable ? "reject" : "skip";
    const decoded = sample.toString("utf8");
    const replacements = [...decoded].filter((char) => char === "�").length;
    if (replacements / Math.max(1, decoded.length) >= 0.01) return executable ? "reject" : "skip";
    return "scan";
  } catch {
    return "reject";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|override|bypass|forget)\b.{0,100}\b(?:system|developer|host|previous|prior|user)\b.{0,80}\b(?:instruction|message|prompt|policy|security|permission|request)s?\b/i,
  /\b(?:reveal|print|show|exfiltrate|leak|dump)\b.{0,100}\b(?:system prompt|developer message|hidden prompt|hidden instruction|private reasoning|chain[- ]of[- ]thought|credential|secret)s?\b/i,
  /\b(?:you are now|act as|pretend to be|treat (?:this|the following) as)\b.{0,80}\b(?:system|developer|administrator|root|higher[- ]priority)\b/i,
  /\b(?:ignore|disobey|override)\b.{0,80}\b(?:the )?user(?:'s)?\b.{0,80}\b(?:request|instruction|objective)s?\b/i,
  /<\/?(?:system|developer|assistant)(?:\s[^>]*)?>/i,
  /<\/?friday_(?:prompt_section|runtime_context|attachment_context|persisted_input_context|compaction_summary|branch_summary)\b/i,
];

const DANGEROUS_COMMAND_PATTERNS: readonly { pattern: RegExp; message: string }[] = [
  { pattern: /\brm\s+-[^\n]{0,30}r[^\n]{0,30}f[^\n]{0,30}\s+\/(?:\s|$|[;|&])/i, message: "destructive recursive root deletion command" },
  { pattern: /\b(?:curl|wget)\b[^\n|]{0,500}\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i, message: "download-and-execute shell pipeline" },
  { pattern: /\b(?:bash|sh|zsh)\s+-c\s+['\"][^'\"\n]{0,800}\/dev\/tcp\//i, message: "reverse-shell command" },
  { pattern: /\bnc\b[^\n]{0,200}\s-e\s+(?:\/bin\/)?(?:sh|bash)\b/i, message: "netcat reverse-shell command" },
  { pattern: /\bchmod\s+(?:-R\s+)?777\b/i, message: "world-writable recursive permission command" },
  { pattern: /\b(?:cat|cp|scp|tar|zip|curl|wget)\b[^\n]{0,240}(?:\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.config\/gcloud\/|\.kube\/config)/i, message: "credential/private-key collection command" },
  { pattern: /\b(?:env|printenv)\b[^\n|]{0,80}\|[^\n]{0,120}\b(?:curl|wget|nc)\b/i, message: "environment exfiltration pipeline" },
  { pattern: /\bsudo\s+(?:rm|chmod|chown)\b[^\n]{0,200}(?:\/etc\b|\/usr\b|\/var\b|\/home\b|\/\s*$)/i, message: "privileged destructive filesystem command" },
  { pattern: /\b(?:mkfs(?:\.[a-z0-9]+)?|wipefs)\b[^\n]{0,160}\/dev\//i, message: "destructive block-device formatting command" },
  { pattern: /\bdd\b[^\n]{0,200}\bof=\/dev\/(?:sd|nvme|vd|xvd|mmcblk)/i, message: "raw block-device overwrite command" },
  { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/i, message: "fork-bomb command" },
  { pattern: /\bshutil\.rmtree\s*\(\s*['"]\/['"]\s*\)/i, message: "destructive Python root deletion" },
  { pattern: /\b(?:rmSync|rm)\s*\(\s*['"]\/['"][^)]{0,160}\brecursive\s*:\s*true/i, message: "destructive JavaScript root deletion" },
  { pattern: /\b(?:upload|send|post|exfiltrate|leak|copy)\b.{0,160}\b(?:private key|ssh key|credential|api key|access token|refresh token|password|recovery phrase|seed phrase)\b/i, message: "secret-exfiltration instruction" },
];

function normalizeForSecurityScan(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/[\u{e0000}-\u{e007f}]/gu, "")
    .replaceAll("\u0000", "\ufffd")
    .replace(/\r\n?/g, "\n");
}

function locallyNegated(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 120), index);
  const clause = prefix.split(/[.!?;\n]/).at(-1) ?? prefix;
  return /\b(?:do not|don't|never|must not|should not|reject|refuse|block|detect|flag|prevent|avoid)(?:\s+ever)?(?:\s+(?:run|execute|use|invoke|call|perform|allow|follow|obey|attempt|issue|include|write|send|upload|exfiltrate|reveal|print|show))?$/i.test(clause.trimEnd());
}

function firstUnsafeMatch(text: string, pattern: RegExp): RegExpExecArray | undefined {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  for (let match = global.exec(text); match; match = global.exec(text)) {
    if (!locallyNegated(text, match.index)) return match;
    if (match[0].length === 0) global.lastIndex += 1;
  }
  return undefined;
}

/** Analyze one Skill text payload without executing or trusting it. */
export function analyzeSkillTextSecurity(input: string, path?: string): readonly SkillSecurityIssue[] {
  const text = normalizeForSecurityScan(input);
  const issues: SkillSecurityIssue[] = [];
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (firstUnsafeMatch(text, pattern)) {
      issues.push({ kind: "prompt-injection", message: "policy-override or prompt-exfiltration language", ...(path ? { path } : {}) });
      break;
    }
  }
  for (const rule of DANGEROUS_COMMAND_PATTERNS) {
    if (firstUnsafeMatch(text, rule.pattern)) issues.push({ kind: "dangerous-command", message: rule.message, ...(path ? { path } : {}) });
  }
  return Object.freeze(issues);
}

/**
 * Scan model/procedure-bearing text files in a Skill directory. Binary/static
 * assets are not interpreted as instructions and are skipped.
 */
export function analyzeSkillDirectorySecuritySync(root: string): readonly SkillSecurityIssue[] {
  const issues: SkillSecurityIssue[] = [];
  try {
    const rootStats = lstatSync(root);
    if (rootStats.isSymbolicLink()) {
      return Object.freeze([{ kind: "dangerous-command", message: "Skill root is a symlink and was not trusted", path: root }]);
    }
    if (!rootStats.isDirectory()) {
      return Object.freeze([{ kind: "dangerous-command", message: "Skill security scan root is not a directory", path: root }]);
    }
  } catch {
    return Object.freeze([{ kind: "dangerous-command", message: "Skill security scan root could not be inspected", path: root }]);
  }
  let files = 0;
  let bytes = 0;
  let walkedEntries = 0;
  let halted = false;
  const visit = (dir: string, depth: number): void => {
    if (halted) return;
    if (depth > MAX_SECURITY_WALK_DEPTH) {
      issues.push({ kind: "dangerous-command", message: "Skill exceeds the bounded security-scan directory depth" });
      halted = true;
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (halted) return;
      walkedEntries += 1;
      if (walkedEntries > MAX_SECURITY_WALK_ENTRIES) {
        issues.push({ kind: "dangerous-command", message: "Skill exceeds the bounded security-scan filesystem entry budget" });
        halted = true;
        return;
      }
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push({ kind: "dangerous-command", message: "Skill contains a symlink and was not trusted", path: relative(root, path) });
        continue;
      }
      if (entry.isDirectory()) { visit(path, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      const info = statSync(path);
      const knownInstructionText = entry.name === "SKILL.md"
        || TEXT_EXTENSIONS.has(extension)
        || extension === ""
        || TEXT_BASENAMES.has(basename(entry.name));
      const disposition = knownInstructionText ? "scan" : classifyUnknownFile(path, info.mode);
      if (disposition === "reject") {
        issues.push({ kind: "dangerous-command", message: "Skill contains an executable or unreadable binary procedure that cannot be statically trusted", path: relative(root, path) });
        continue;
      }
      if (disposition === "skip") continue;
      files += 1;
      const size = info.size;
      bytes += size;
      if (files > MAX_SECURITY_SCAN_FILES || bytes > MAX_SECURITY_SCAN_BYTES) {
        issues.push({ kind: "dangerous-command", message: "Skill exceeds the bounded instruction-text security-scan budget" });
        halted = true;
        return;
      }
      const content = readFileSync(path, "utf8");
      issues.push(...analyzeSkillTextSecurity(content, relative(root, path) || entry.name));
    }
  };
  visit(root, 0);
  return Object.freeze(issues);
}
