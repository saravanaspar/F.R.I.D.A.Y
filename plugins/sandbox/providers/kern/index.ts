import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type {
  SandboxExecutionEvent,
  SandboxKernelContext,
  SandboxKernelRequest,
  SandboxNetworkMode,
  SandboxProbeResult,
  SandboxProcessContext,
  SandboxProcessRequest,
  SandboxProvider,
  SandboxProviderCreateOptions,
  SandboxProviderDescriptor,
  SandboxResourceLimits,
  SandboxService,
  SandboxSetupResult,
  SandboxShellContext,
  SandboxShellRequest,
  SandboxWorkspaceAccess,
} from "../../contract.js";

export interface KernSandboxOptions extends SandboxProviderCreateOptions {
  readonly image?: string | undefined;
  readonly binary?: string | undefined;
  readonly probe?: (() => SandboxProbeResult) | undefined;
  /** Injectable kern runner/process probes for deterministic provider lifecycle tests. */
  readonly run?: ((command: string, args: readonly string[]) => SpawnSyncReturns<string>) | undefined;
  readonly processIdentity?: ((pid: number) => string | undefined) | undefined;
  readonly processAlive?: ((pid: number) => boolean | undefined) | undefined;
  readonly runtimePid?: number | undefined;
}

export interface KernProviderOptions {
  readonly image?: string | undefined;
  readonly binary?: string | undefined;
  readonly probeRun?: ((command: string, args: readonly string[]) => SpawnSyncReturns<string>) | undefined;
  readonly setupRun?: ((command: string, args: readonly string[]) => SpawnSyncReturns<string>) | undefined;
  readonly containerfile?: string | undefined;
  readonly contextDir?: string | undefined;
}

export const DEFAULT_SANDBOX_IMAGE = "friday-sandbox:gen0";
const KERN_PROBE_TIMEOUT_MS = 5_000;
const SANDBOX_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const SANDBOX_SCRATCH_PATH = "/tmp/.friday-sandbox";
const DEFAULT_LIMITS: SandboxResourceLimits = Object.freeze({
  memory: "2g",
  cpus: 4,
  pids: 1_024,
  openFiles: 4_096,
  fileSizeBytes: 2 * 1024 * 1024 * 1024,
  tempSize: "64m",
});

export const KERN_SANDBOX_DESCRIPTOR: SandboxProviderDescriptor = Object.freeze({
  id: "kern",
  displayName: "kern",
  isolationClass: "namespaces-seccomp",
  capabilities: Object.freeze({
    filesystemIsolation: true,
    processIsolation: true,
    networkIsolation: true,
    resourceLimits: true,
    writableWorkspace: true,
    trustedReadOnlyMounts: true,
    persistentProcesses: true,
    rootless: true,
    daemonless: true,
    sharesHostKernel: true,
  }),
});

function defaultContainerfile(): string {
  const bundled = process.env.FRIDAY_BUNDLED_ROOT?.trim();
  return bundled
    ? join(bundled, "sandbox", "providers", "kern", "Containerfile")
    : join(dirname(fileURLToPath(import.meta.url)), "Containerfile");
}

function kernBinary(value?: string): string {
  const binary = value?.trim() || process.env.FRIDAY_KERN_BIN?.trim() || "kern";
  if (binary.length > 4_096 || binary.includes("\0")) throw new Error("FRIDAY_KERN_BIN is invalid");
  return binary;
}

function sandboxImage(value?: string): string {
  const image = value?.trim() || process.env.FRIDAY_SANDBOX_IMAGE?.trim() || DEFAULT_SANDBOX_IMAGE;
  if (!image || image.length > 512 || /[\0\r\n]/.test(image)) throw new Error("FRIDAY_SANDBOX_IMAGE is invalid");
  return image;
}

function effectiveNetworkMode(value?: SandboxNetworkMode): SandboxNetworkMode {
  const configured = value ?? process.env.FRIDAY_SANDBOX_NETWORK_MODE ?? "requested";
  if (configured !== "unrestricted" && configured !== "requested") {
    throw new Error("FRIDAY_SANDBOX_NETWORK_MODE must be unrestricted or requested");
  }
  return configured;
}

function normalizeEgressDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.+$/g, "");
  if (!normalized || normalized.length > 253 || /[\0\r\n,\s]/.test(normalized)) {
    throw new Error(`Sandbox egress domain is invalid: ${JSON.stringify(value)}`);
  }
  const labels = normalized.split(".");
  if (labels.some((label) => {
    const bytes = Buffer.byteLength(label, "utf8");
    return bytes < 1
      || bytes > 63
      || label.startsWith("-")
      || label.endsWith("-")
      || !/^[a-z0-9-]+$/.test(label);
  })) {
    throw new Error(`Sandbox egress domain is invalid: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function effectiveEgressAllow(value?: readonly string[]): readonly string[] {
  const configured = value ?? process.env.FRIDAY_SANDBOX_EGRESS_ALLOW?.split(",") ?? [];
  const unique = new Set<string>();
  for (const entry of configured) {
    if (!entry.trim()) continue;
    unique.add(normalizeEgressDomain(entry));
  }
  return Object.freeze([...unique]);
}

function sizeValue(value: string | undefined, fallback: string, label: string): string {
  const normalized = value?.trim() || fallback;
  if (!/^[1-9][0-9]*(?:[kKmMgGtT])?$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized.toLowerCase();
}

function boundedInteger(value: number | undefined, fallback: number, label: string, maximum: number): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) throw new Error(`${label} is invalid`);
  return normalized;
}

function boundedNumber(value: number | undefined, fallback: number, label: string, maximum: number): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > maximum) throw new Error(`${label} is invalid`);
  return normalized;
}

function resourceLimits(options: KernSandboxOptions): SandboxResourceLimits {
  const configured = options.limits ?? {};
  return Object.freeze({
    memory: sizeValue(configured.memory ?? process.env.FRIDAY_SANDBOX_MEMORY, DEFAULT_LIMITS.memory, "sandbox memory limit"),
    cpus: boundedNumber(configured.cpus ?? Number(process.env.FRIDAY_SANDBOX_CPUS || DEFAULT_LIMITS.cpus), DEFAULT_LIMITS.cpus, "sandbox CPU limit", 256),
    pids: boundedInteger(configured.pids ?? Number(process.env.FRIDAY_SANDBOX_PIDS || DEFAULT_LIMITS.pids), DEFAULT_LIMITS.pids, "sandbox PID limit", 131_072),
    openFiles: boundedInteger(configured.openFiles ?? Number(process.env.FRIDAY_SANDBOX_OPEN_FILES || DEFAULT_LIMITS.openFiles), DEFAULT_LIMITS.openFiles, "sandbox open-file limit", 1_048_576),
    fileSizeBytes: boundedInteger(configured.fileSizeBytes ?? Number(process.env.FRIDAY_SANDBOX_FILE_SIZE_BYTES || DEFAULT_LIMITS.fileSizeBytes), DEFAULT_LIMITS.fileSizeBytes, "sandbox file-size limit", Number.MAX_SAFE_INTEGER),
    tempSize: sizeValue(configured.tempSize ?? process.env.FRIDAY_SANDBOX_TEMP_SIZE, DEFAULT_LIMITS.tempSize, "sandbox temporary-filesystem limit"),
  });
}

function canonical(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || rel === "." || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function ensureMountPath(path: string, label: string): void {
  if (path.includes(":")) throw new Error(`${label} cannot contain ':' when using the kern provider: ${path}`);
  if (/\r|\n|\0/.test(path)) throw new Error(`${label} is invalid`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sandboxPath(workspace: string): string {
  return `${join(workspace, "node_modules", ".bin")}:${SANDBOX_SYSTEM_PATH}`;
}

function kernClientEnv(source: NodeJS.ProcessEnv, allowNetwork = false): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "TMPDIR",
  ] as const;
  const networkAllowed = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  if (allowNetwork) {
    for (const key of networkAllowed) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) env[key] = value;
    }
  }
  return env;
}

function defaultProbeRun(command: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: KERN_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: kernClientEnv(process.env, false),
  }) as SpawnSyncReturns<string>;
}

function defaultSetupRun(command: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["inherit", "inherit", "inherit"],
    env: kernClientEnv(process.env, true),
  }) as SpawnSyncReturns<string>;
}

function helpFlags(help: string): ReadonlySet<string> {
  const flags = new Set<string>();
  const expression = /(?:^|[\s,[(])(--[A-Za-z0-9][A-Za-z0-9-]*|-[A-Za-z])(?=$|[\s,)\]=<>])/gm;
  for (const match of help.matchAll(expression)) {
    const flag = match[1];
    if (flag) flags.add(flag);
  }
  return flags;
}

function missingHelpFlags(help: string, required: readonly string[]): string[] {
  const available = helpFlags(help);
  return required.filter((flag) => !available.has(flag));
}

function imageReferenceParts(reference: string): { repository: string; tag?: string } {
  const slash = reference.lastIndexOf("/");
  const colon = reference.lastIndexOf(":");
  if (colon > slash) return { repository: reference.slice(0, colon), tag: reference.slice(colon + 1) };
  return { repository: reference };
}

function imageAppearsInValue(value: unknown, image: string): boolean {
  if (typeof value === "string") return value === image;
  if (Array.isArray(value)) return value.some((entry) => imageAppearsInValue(entry, image));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const { repository, tag } = imageReferenceParts(image);
  const candidateName = [record.reference, record.name, record.image, record.repository, record.repo].find((entry) => typeof entry === "string") as string | undefined;
  const candidateTag = typeof record.tag === "string" ? record.tag : undefined;
  if (candidateName === image) return true;
  if (candidateName === repository && (tag === undefined || candidateTag === tag)) return true;
  return Object.values(record).some((entry) => imageAppearsInValue(entry, image));
}

function imageAppearsInJson(output: string, image: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  try {
    return imageAppearsInValue(JSON.parse(trimmed), image);
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      try {
        if (imageAppearsInValue(JSON.parse(line), image)) return true;
      } catch {
        // Keep looking; some kern versions may mix status text around JSON.
      }
    }
    return trimmed.includes(image);
  }
}

function safeManagedIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function safeManagedLabelValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 256 || /[\0\r\n,]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function managedOwnerLabel(): string {
  const home = resolve(process.env.FRIDAY_HOME?.trim() || join(homedir(), ".friday"));
  return createHash("sha256").update(home).digest("hex").slice(0, 24);
}

function linuxProcessIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = stat.lastIndexOf(")");
    if (closing < 0) return undefined;
    const fieldsAfterCommand = stat.slice(closing + 2).trim().split(/\s+/);
    const startTicks = fieldsAfterCommand[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) return undefined;
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[a-f0-9-]{16,64}$/i.test(bootId)) return undefined;
    return createHash("sha256").update(`${bootId}:${startTicks}`).digest("hex").slice(0, 32);
  } catch {
    return undefined;
  }
}

function linuxProcessAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    return undefined;
  }
}

function runtimeIdentityForName(identity: string | undefined): string {
  return identity && /^[a-f0-9]{32}$/.test(identity) ? identity : "unverifiable";
}

function boxName(
  kind: "shell" | "process" | "kernel",
  managed: SandboxProcessRequest["managed"] | undefined,
  runtimePid: number,
  runtimeIdentity: string | undefined,
): string {
  if (managed) {
    const id = safeManagedIdentifier(managed.id, "Managed sandbox process id").replaceAll(":", "-").slice(0, 32);
    const identity = runtimeIdentityForName(runtimeIdentity);
    return `friday-bg-${runtimePid}-${identity}-${id}-${randomBytes(4).toString("hex")}`.slice(0, 96);
  }
  return `friday-${kind}-${runtimePid}-${randomBytes(6).toString("hex")}`.slice(0, 96);
}

function managedRuntimeFromBoxName(name: string): { pid: number; identity: string } | undefined {
  const match = /^friday-bg-([1-9][0-9]*)-([a-f0-9]{32}|unverifiable)-/.exec(name);
  if (!match?.[1] || !match[2]) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  return { pid, identity: match[2] };
}

export function probeKern(image = sandboxImage(), binary = kernBinary(), run = defaultProbeRun): SandboxProbeResult {
  if (process.platform !== "linux") {
    return { available: false, status: "unsupported-platform", reason: "kern requires a Linux kernel" };
  }

  let version = run(binary, ["--version"]);
  if (version.error || version.status !== 0) version = run(binary, ["version"]);
  if (version.error || version.status !== 0) {
    const detail = version.error?.message || version.stderr || version.stdout || `${binary} version probe failed`;
    return { available: false, status: "binary-unavailable", reason: `kern is unavailable: ${String(detail).trim()}` };
  }

  const doctor = run(binary, ["doctor"]);
  if (doctor.error || doctor.status !== 0) {
    const detail = doctor.error?.message || doctor.stderr || doctor.stdout || "kern doctor failed";
    return { available: false, status: "host-unready", reason: `kern host checks failed: ${String(detail).trim()}` };
  }

  const boxHelp = run(binary, ["box", "--help"]);
  if (boxHelp.error || boxHelp.status !== 0) {
    const detail = boxHelp.error?.message || boxHelp.stderr || boxHelp.stdout || "kern box --help failed";
    return { available: false, status: "host-unready", reason: `kern box interface is unavailable: ${String(detail).trim()}` };
  }
  const boxRequiredFlags = [
    "--image", "--security-profile", "--require-limits", "--memory", "--cpus", "--pids-limit",
    "--tmpfs", "--shm-size", "--net", "--egress-allow", "--label", "-v", "-w", "-e", "-i",
  ] as const;
  const missingBoxFlags = missingHelpFlags(`${boxHelp.stdout}\n${boxHelp.stderr}`, boxRequiredFlags);
  if (missingBoxFlags.length > 0) {
    return {
      available: false,
      status: "host-unready",
      reason: `Installed kern is missing required sandbox features: ${missingBoxFlags.join(", ")}`,
    };
  }

  const psHelp = run(binary, ["ps", "--help"]);
  if (psHelp.error || psHelp.status !== 0) {
    const detail = psHelp.error?.message || psHelp.stderr || psHelp.stdout || "kern ps --help failed";
    return { available: false, status: "host-unready", reason: `kern managed-process interface is unavailable: ${String(detail).trim()}` };
  }
  const missingPsFlags = missingHelpFlags(`${psHelp.stdout}\n${psHelp.stderr}`, ["-q", "--filter"]);
  if (missingPsFlags.length > 0) {
    return {
      available: false,
      status: "host-unready",
      reason: `Installed kern is missing required managed-process features: ${missingPsFlags.join(", ")}`,
    };
  }

  const stopHelp = run(binary, ["stop", "--help"]);
  if (stopHelp.error || stopHelp.status !== 0) {
    const detail = stopHelp.error?.message || stopHelp.stderr || stopHelp.stdout || "kern stop --help failed";
    return { available: false, status: "host-unready", reason: `kern managed-process stop interface is unavailable: ${String(detail).trim()}` };
  }

  const buildHelp = run(binary, ["build", "--help"]);
  if (buildHelp.error || buildHelp.status !== 0) {
    const detail = buildHelp.error?.message || buildHelp.stderr || buildHelp.stdout || "kern build --help failed";
    return { available: false, status: "host-unready", reason: `kern image-build interface is unavailable: ${String(detail).trim()}` };
  }
  const missingBuildFlags = missingHelpFlags(`${buildHelp.stdout}\n${buildHelp.stderr}`, ["-t", "-f"]);
  if (missingBuildFlags.length > 0) {
    return {
      available: false,
      status: "host-unready",
      reason: `Installed kern is missing required image-build features: ${missingBuildFlags.join(", ")}`,
    };
  }

  const images = run(binary, ["images", "--json"]);
  if (images.error || images.status !== 0) {
    const detail = images.error?.message || images.stderr || images.stdout || "kern images --json failed";
    return { available: false, status: "host-unready", reason: `kern image store is unavailable: ${String(detail).trim()}` };
  }
  if (!imageAppearsInJson(images.stdout, image)) {
    return { available: false, status: "image-missing", reason: `FRIDAY sandbox image is not available locally in kern: ${image}` };
  }
  return { available: true, status: "ready" };
}

function mountArgument(source: string, access: SandboxWorkspaceAccess, target = source): string {
  ensureMountPath(source, "Sandbox mount source");
  ensureMountPath(target, "Sandbox mount target");
  return `${source}:${target}:${access === "read" ? "ro" : "rw"}`;
}

function baseBoxArguments(
  name: string,
  image: string,
  workspace: string,
  cwd: string,
  access: SandboxWorkspaceAccess,
  networkArgs: readonly string[],
  limits: SandboxResourceLimits,
  mounts: readonly { source: string; target: string; access?: SandboxWorkspaceAccess }[],
): string[] {
  ensureMountPath(workspace, "Sandbox workspace");
  ensureMountPath(cwd, "Sandbox working directory");
  const args = [
    "box",
    name,
    "--image",
    image,
    "--security-profile",
    "untrusted",
    "--require-limits",
    "--memory",
    limits.memory,
    "--cpus",
    String(limits.cpus),
    "--pids-limit",
    String(limits.pids),
    "--tmpfs",
    `${SANDBOX_SCRATCH_PATH}:${limits.tempSize}`,
    "--shm-size",
    limits.tempSize,
    "-v",
    mountArgument(workspace, access),
    "-w",
    cwd,
    "-e",
    `HOME=${SANDBOX_SCRATCH_PATH}`,
    "-e",
    `TMPDIR=${SANDBOX_SCRATCH_PATH}`,
    "-e",
    `TMP=${SANDBOX_SCRATCH_PATH}`,
    "-e",
    `TEMP=${SANDBOX_SCRATCH_PATH}`,
    "-e",
    `PATH=${sandboxPath(workspace)}`,
    "-e",
    "FRIDAY_SANDBOX_PROVIDER=kern",
    "-e",
    "FRIDAY_SANDBOX=kern",
    ...networkArgs,
  ];
  for (const mount of mounts) args.push("-v", mountArgument(mount.source, mount.access ?? "read", mount.target));
  return args;
}

function limitPrelude(limits: SandboxResourceLimits): string {
  const blocks = Math.max(1, Math.ceil(limits.fileSizeBytes / 1024));
  return `ulimit -n ${limits.openFiles}; ulimit -f ${blocks};`;
}

export function createKernSandboxService(options: KernSandboxOptions = {}): SandboxService {
  const image = sandboxImage(options.image);
  const binary = kernBinary(options.binary);
  const run = options.run ?? defaultProbeRun;
  const probe = options.probe ?? (() => probeKern(image, binary, run));
  const networkMode = effectiveNetworkMode(options.networkMode);
  const egressAllow = effectiveEgressAllow(options.egressAllow);
  const limits = resourceLimits(options);
  const processIdentity = options.processIdentity ?? linuxProcessIdentity;
  const processAlive = options.processAlive ?? linuxProcessAlive;
  const runtimePid = options.runtimePid ?? process.pid;
  const runtimeIdentity = processIdentity(runtimePid);
  const managedOwner = managedOwnerLabel();
  const PROBE_TTL_MS = 60_000;
  let cachedProbe: SandboxProbeResult | undefined;
  let cachedProbeAt = 0;

  interface TrustedReadOnlyMount {
    source: string;
    target: string;
    count: number;
  }
  const trustedReadOnlyMounts = new Map<string, Map<string, TrustedReadOnlyMount>>();

  const availability = (): SandboxProbeResult => {
    const now = Date.now();
    if (cachedProbe?.available && now - cachedProbeAt < PROBE_TTL_MS) return cachedProbe;
    const checked = probe();
    if (checked.available) {
      cachedProbe = checked;
      cachedProbeAt = now;
    } else {
      cachedProbe = undefined;
      cachedProbeAt = 0;
    }
    return checked;
  };

  const auxiliaryMounts = (workspace: string): TrustedReadOnlyMount[] => {
    const mounts = [...(trustedReadOnlyMounts.get(workspace)?.values() ?? [])];
    for (const mount of mounts) {
      if (!existsSync(mount.source) || canonical(mount.source) !== mount.source) {
        throw new Error(`Trusted sandbox mount source changed after registration: ${mount.source}`);
      }
      if (mount.target !== mount.source) {
        if (!existsSync(mount.target)) throw new Error(`Trusted sandbox mount target disappeared after registration: ${mount.target}`);
        if (lstatSync(mount.target).isSymbolicLink()) throw new Error(`Trusted sandbox mount target became a symlink after registration: ${mount.target}`);
        const currentTarget = canonical(mount.target);
        if (currentTarget !== mount.target || currentTarget === workspace || !contained(workspace, currentTarget)) {
          throw new Error(`Trusted sandbox mount target changed after registration: ${mount.target}`);
        }
      }
    }
    return mounts;
  };

  const networkArguments = (requested: boolean): string[] => {
    if (networkMode === "unrestricted") return ["--net", "host"];
    if (!requested) return [];
    if (egressAllow.length === 0) {
      throw new Error(
        "kern requested networking requires FRIDAY_SANDBOX_EGRESS_ALLOW (comma-separated domains) or the explicit FRIDAY_SANDBOX_NETWORK_MODE=unrestricted override",
      );
    }
    return ["--egress-allow", egressAllow.join(",")];
  };

  const report = (
    kind: SandboxExecutionEvent["kind"],
    workspace: string,
    requestedNetwork: boolean,
    networkEnabled: boolean,
  ): void => {
    options.onExecution?.(Object.freeze({
      kind,
      providerId: KERN_SANDBOX_DESCRIPTOR.id,
      workspace,
      requestedNetwork,
      networkEnabled,
      networkMode,
    }));
  };

  const listManagedNames = (processId?: string): string[] => {
    const args = [
      "ps",
      "-q",
      "--filter",
      "label=io.friday.managed=true",
      "--filter",
      `label=io.friday.owner=${managedOwner}`,
    ];
    if (processId !== undefined) {
      args.push("--filter", `label=io.friday.process=${safeManagedIdentifier(processId, "Managed sandbox process id")}`);
    }
    const listed = run(binary, args);
    if (listed.error) throw new Error(`Unable to inspect managed kern processes: ${listed.error.message}`);
    if (listed.status !== 0) {
      throw new Error(`Unable to inspect managed kern processes: ${(listed.stderr || "kern ps failed").trim()}`);
    }
    return listed.stdout.trim().split(/\s+/).filter(Boolean);
  };

  const stopManagedNames = (names: readonly string[], label: string): void => {
    if (names.length === 0) return;
    const stopped = run(binary, ["stop", ...names]);
    if (stopped.error) throw new Error(`Unable to stop ${label}: ${stopped.error.message}`);
    if (stopped.status !== 0) {
      throw new Error(`Unable to stop ${label}: ${(stopped.stderr || "kern stop failed").trim()}`);
    }
  };

  const service: SandboxService = {
    provider: KERN_SANDBOX_DESCRIPTOR,
    image,
    networkMode,
    egressAllow,
    limits,
    get unavailableReason() {
      const status = availability();
      return status.available ? undefined : status.reason;
    },

    assertAvailable() {
      const status = availability();
      if (!status.available) throw new Error(status.reason ?? "kern sandbox is unavailable");
    },

    registerTrustedReadOnlyMount(workspacePath: string, sourcePath: string, targetPath?: string) {
      const workspace = canonical(workspacePath);
      const source = canonical(sourcePath);
      if (!existsSync(workspace)) throw new Error(`Sandbox workspace does not exist: ${workspace}`);
      if (!existsSync(source)) throw new Error(`Trusted sandbox mount does not exist: ${source}`);
      if (contained(workspace, source) || contained(source, workspace)) {
        throw new Error(`Trusted sandbox mount source must be disjoint from workspace: ${source}`);
      }
      ensureMountPath(source, "Trusted sandbox mount source");

      let target = source;
      if (targetPath !== undefined) {
        const requestedTarget = resolve(targetPath);
        if (!existsSync(requestedTarget)) throw new Error(`Trusted sandbox mount target does not exist: ${requestedTarget}`);
        if (lstatSync(requestedTarget).isSymbolicLink()) throw new Error(`Trusted sandbox mount target must not be a symlink: ${requestedTarget}`);
        target = canonical(requestedTarget);
        if (target === workspace || !contained(workspace, target)) {
          throw new Error(`Trusted sandbox mount target must stay inside workspace: ${target}`);
        }
      }
      ensureMountPath(target, "Trusted sandbox mount target");

      const scoped = trustedReadOnlyMounts.get(workspace) ?? new Map<string, TrustedReadOnlyMount>();
      const key = `${source}\0${target}`;
      const existing = scoped.get(key);
      scoped.set(key, existing ? { ...existing, count: existing.count + 1 } : { source, target, count: 1 });
      trustedReadOnlyMounts.set(workspace, scoped);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = trustedReadOnlyMounts.get(workspace);
        const entry = current?.get(key);
        if (!current || !entry) return;
        if (entry.count <= 1) current.delete(key);
        else current.set(key, { ...entry, count: entry.count - 1 });
        if (current.size === 0) trustedReadOnlyMounts.delete(workspace);
      };
    },

    sandboxShell(request: SandboxShellRequest): SandboxShellContext {
      service.assertAvailable();
      const workspace = canonical(request.workspace);
      const cwd = canonical(request.cwd);
      if (!contained(workspace, cwd)) throw new Error(`Sandbox working directory is outside workspace: ${cwd}`);
      const networkArgs = networkArguments(request.network);
      report("shell", workspace, request.network, networkArgs.length > 0);
      const args = baseBoxArguments(
        boxName("shell", undefined, runtimePid, runtimeIdentity),
        image,
        workspace,
        cwd,
        request.access,
        networkArgs,
        limits,
        auxiliaryMounts(workspace),
      );
      args.push("--", "/bin/bash", "-c", `${limitPrelude(limits)} exec /bin/bash -c \"$1\"`, "friday-shell", request.command);
      return {
        command: [binary, ...args].map(shellQuote).join(" "),
        cwd: workspace,
        env: kernClientEnv(request.env, false),
      };
    },

    sandboxProcess(request: SandboxProcessRequest): SandboxProcessContext {
      service.assertAvailable();
      const workspace = canonical(request.workspace);
      const cwd = canonical(request.cwd);
      if (!contained(workspace, cwd)) throw new Error(`Sandbox working directory is outside workspace: ${cwd}`);
      if (!request.command.trim()) throw new Error("Sandbox process command is required");
      const networkArgs = networkArguments(request.network);
      report("process", workspace, request.network, networkArgs.length > 0);
      const name = boxName("process", request.managed, runtimePid, runtimeIdentity);
      const args = baseBoxArguments(
        name,
        image,
        workspace,
        cwd,
        request.access,
        networkArgs,
        limits,
        auxiliaryMounts(workspace),
      );
      if (request.managed) {
        const managedId = safeManagedIdentifier(request.managed.id, "Managed sandbox process id");
        const runId = safeManagedLabelValue(request.managed.runId, "Managed sandbox run id");
        args.push(
          "--label", "io.friday.managed=true",
          "--label", `io.friday.owner=${managedOwner}`,
          "--label", `io.friday.process=${managedId}`,
          "--label", `io.friday.run=${runId}`,
          "--label", `io.friday.runtime-pid=${runtimePid}`,
          "--label", `io.friday.runtime-start=${runtimeIdentityForName(runtimeIdentity)}`,
        );
      }
      if (request.interactive === true) args.push("-i");
      args.push("--", "/bin/bash", "-c", `${limitPrelude(limits)} exec \"$@\"`, "friday-exec", request.command, ...request.args);
      return {
        command: binary,
        args,
        cwd: workspace,
        env: kernClientEnv(request.env, false),
      };
    },

    cleanupManagedProcess(id: string) {
      const status = availability();
      if (!status.available) throw new Error(status.reason ?? "kern is unavailable during managed-process cleanup");
      const normalizedId = safeManagedIdentifier(id, "Managed sandbox process id");
      stopManagedNames(listManagedNames(normalizedId), `managed kern process ${normalizedId}`);
    },

    cleanupStaleManagedProcesses() {
      const status = availability();
      if (!status.available) return;
      const names = listManagedNames();
      const stale = names.filter((name) => {
        const owner = managedRuntimeFromBoxName(name);
        if (!owner || owner.identity === "unverifiable") return false;
        const actualIdentity = processIdentity(owner.pid);
        if (actualIdentity !== undefined) return actualIdentity !== owner.identity;
        // An unreadable /proc record is not evidence of death. Only ESRCH-equivalent proof removes it.
        return processAlive(owner.pid) === false;
      });
      stopManagedNames(stale, "stale FRIDAY kern processes");
    },

    sandboxKernel(request: SandboxKernelRequest): SandboxKernelContext {
      service.assertAvailable();
      const workspace = canonical(request.workspace);
      const cwd = canonical(request.cwd);
      const tempDir = canonical(request.tempDir);
      const connectionPath = canonical(request.connectionPath);
      if (!contained(workspace, cwd)) throw new Error(`Sandbox working directory is outside workspace: ${cwd}`);
      if (!contained(tempDir, connectionPath)) throw new Error(`Kernel connection file is outside its temporary directory: ${connectionPath}`);
      ensureMountPath(tempDir, "Kernel temporary directory");
      const networkArgs = networkArguments(false);
      report("kernel", workspace, false, networkArgs.length > 0);
      const mounts = [...auxiliaryMounts(workspace), { source: tempDir, target: tempDir, access: "write" as const }];
      const args = baseBoxArguments(
        boxName("kernel", undefined, runtimePid, runtimeIdentity),
        image,
        workspace,
        cwd,
        "write",
        networkArgs,
        limits,
        mounts,
      );
      const pythonPath = request.env.PYTHONPATH;
      if (typeof pythonPath === "string" && pythonPath.trim()) args.push("-e", `PYTHONPATH=${pythonPath}`);
      args.push("--", "/bin/bash", "-c", `${limitPrelude(limits)} exec python3 -m ipykernel_launcher -f \"$1\"`, "friday-kernel", connectionPath);
      return {
        command: binary,
        args,
        cwd: workspace,
        env: kernClientEnv(request.env, false),
      };
    },
  };

  return Object.freeze(service);
}

export function createKernSandboxProvider(options: KernProviderOptions = {}): SandboxProvider {
  const probeRun = options.probeRun ?? defaultProbeRun;
  const setupRun = options.setupRun ?? defaultSetupRun;
  const currentImage = () => sandboxImage(options.image);
  const currentBinary = () => kernBinary(options.binary);
  const provider: SandboxProvider = {
    descriptor: KERN_SANDBOX_DESCRIPTOR,
    setupLabel: "Set up kern sandbox image",
    setupDescription: "Build FRIDAY's approved OCI sandbox image with the selected kern provider.",
    createService(createOptions: SandboxProviderCreateOptions = {}) {
      return createKernSandboxService({ ...createOptions, image: currentImage(), binary: currentBinary(), probe: () => provider.probe() });
    },
    probe() {
      return probeKern(currentImage(), currentBinary(), probeRun);
    },
    repairHint(result: SandboxProbeResult) {
      if (result.status === "binary-unavailable") {
        return "Install kern, ensure it is on PATH (or set FRIDAY_KERN_BIN), then rerun: friday doctor";
      }
      if (result.status === "host-unready") {
        return "Run `kern doctor`, repair the reported Linux user-namespace/cgroup prerequisites, then rerun: friday doctor";
      }
      if (result.status === "unsupported-platform") {
        return "Use Linux directly (or a Linux VM/WSL2) for the kern sandbox provider";
      }
      return "friday setup sandbox";
    },
    setup(): SandboxSetupResult {
      const image = currentImage();
      const binary = currentBinary();
      const before = provider.probe();
      if (before.available) return { status: "already-ready", providerId: KERN_SANDBOX_DESCRIPTOR.id, image };
      if (before.status !== "image-missing") throw new Error(before.reason ?? "kern sandbox is unavailable");

      const containerfile = resolve(options.containerfile ?? defaultContainerfile());
      const contextDir = resolve(options.contextDir ?? dirname(containerfile));
      if (!existsSync(containerfile)) throw new Error(`Sandbox Containerfile does not exist: ${containerfile}`);
      if (!existsSync(contextDir)) throw new Error(`Sandbox build context does not exist: ${contextDir}`);
      const result = setupRun(binary, ["build", "-t", image, "-f", containerfile, contextDir]);
      if (result.error) throw new Error(`Unable to build FRIDAY sandbox image with kern: ${result.error.message}`);
      if (result.status !== 0) throw new Error(`Unable to build FRIDAY sandbox image ${image}: kern build exited with ${result.status ?? "unknown status"}`);
      const after = provider.probe();
      if (!after.available) throw new Error(after.reason ?? `FRIDAY sandbox image was not available after kern build: ${image}`);
      return { status: "prepared", providerId: KERN_SANDBOX_DESCRIPTOR.id, image };
    },
  };
  return Object.freeze(provider);
}

export const KERN_SANDBOX_PROVIDER = createKernSandboxProvider();
