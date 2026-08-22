import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type {
  SandboxKernelContext,
  SandboxNetworkMode,
  SandboxKernelRequest,
  SandboxProcessContext,
  SandboxProcessRequest,
  SandboxService,
  SandboxShellContext,
  SandboxShellRequest,
  SandboxWorkspaceAccess,
  SandboxResourceLimits,
} from "./contract.js";

export type PodmanProbeStatus = "ready" | "podman-unavailable" | "rootless-required" | "image-missing";

export interface PodmanProbeResult {
  available: boolean;
  status?: PodmanProbeStatus | undefined;
  reason?: string | undefined;
}

export interface PodmanSandboxOptions {
  image?: string | undefined;
  probe?: ((image: string) => PodmanProbeResult) | undefined;
  networkMode?: SandboxNetworkMode | undefined;
  limits?: Partial<SandboxResourceLimits> | undefined;
  onExecution?: ((event: Readonly<{
    kind: "shell" | "process" | "kernel";
    workspace: string;
    requestedNetwork: boolean;
    networkEnabled: boolean;
    networkMode: SandboxNetworkMode;
  }>) => void) | undefined;
}

export interface PodmanImageSetupResult {
  status: "already-ready" | "built";
  image: string;
}

export interface PodmanImageSetupOptions {
  image?: string | undefined;
  probe?: ((image: string) => PodmanProbeResult) | undefined;
  run?: ((command: string, args: readonly string[]) => SpawnSyncReturns<string>) | undefined;
  containerfile?: string | undefined;
  contextDir?: string | undefined;
}

const DEFAULT_SANDBOX_IMAGE = "localhost/friday-sandbox:gen0";
const PODMAN_PROBE_TIMEOUT_MS = 2_000;
const SANDBOX_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
function defaultContainerfile(): string {
  const bundled = process.env.FRIDAY_BUNDLED_ROOT?.trim();
  return bundled
    ? join(bundled, "sandbox", "Containerfile")
    : join(dirname(fileURLToPath(import.meta.url)), "Containerfile");
}
const DEFAULT_LIMITS: SandboxResourceLimits = Object.freeze({
  memory: "8g",
  memorySwap: "8g",
  cpus: 4,
  pids: 1_024,
  openFiles: 4_096,
  fileSizeBytes: 4 * 1024 * 1024 * 1024,
  tempSize: "4g",
});

function networkMode(options: PodmanSandboxOptions): SandboxNetworkMode {
  const configured = options.networkMode ?? process.env.FRIDAY_SANDBOX_NETWORK_MODE ?? "requested";
  if (configured !== "unrestricted" && configured !== "requested") {
    throw new Error("FRIDAY_SANDBOX_NETWORK_MODE must be unrestricted or requested");
  }
  return configured;
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

function resourceLimits(options: PodmanSandboxOptions): SandboxResourceLimits {
  const configured = options.limits ?? {};
  return Object.freeze({
    memory: sizeValue(configured.memory ?? process.env.FRIDAY_SANDBOX_MEMORY, DEFAULT_LIMITS.memory, "sandbox memory limit"),
    memorySwap: sizeValue(configured.memorySwap ?? process.env.FRIDAY_SANDBOX_MEMORY_SWAP, DEFAULT_LIMITS.memorySwap, "sandbox memory-swap limit"),
    cpus: boundedNumber(configured.cpus ?? Number(process.env.FRIDAY_SANDBOX_CPUS || DEFAULT_LIMITS.cpus), DEFAULT_LIMITS.cpus, "sandbox CPU limit", 256),
    pids: boundedInteger(configured.pids ?? Number(process.env.FRIDAY_SANDBOX_PIDS || DEFAULT_LIMITS.pids), DEFAULT_LIMITS.pids, "sandbox PID limit", 131_072),
    openFiles: boundedInteger(configured.openFiles ?? Number(process.env.FRIDAY_SANDBOX_OPEN_FILES || DEFAULT_LIMITS.openFiles), DEFAULT_LIMITS.openFiles, "sandbox open-file limit", 1_048_576),
    fileSizeBytes: boundedInteger(configured.fileSizeBytes ?? Number(process.env.FRIDAY_SANDBOX_FILE_SIZE_BYTES || DEFAULT_LIMITS.fileSizeBytes), DEFAULT_LIMITS.fileSizeBytes, "sandbox file-size limit", Number.MAX_SAFE_INTEGER),
    tempSize: sizeValue(configured.tempSize ?? process.env.FRIDAY_SANDBOX_TEMP_SIZE, DEFAULT_LIMITS.tempSize, "sandbox temporary-filesystem limit"),
  });
}

function confinementArguments(limits: SandboxResourceLimits): string[] {
  return [
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--memory=${limits.memory}`,
    `--memory-swap=${limits.memorySwap}`,
    `--cpus=${limits.cpus}`,
    `--pids-limit=${limits.pids}`,
    `--ulimit=nofile=${limits.openFiles}:${limits.openFiles}`,
    `--ulimit=fsize=${limits.fileSizeBytes}:${limits.fileSizeBytes}`,
    `--tmpfs=/tmp:rw,nosuid,nodev,size=${limits.tempSize}`,
  ];
}

function sandboxPath(workspace: string): string {
  return `${join(workspace, "node_modules", ".bin")}:${SANDBOX_SYSTEM_PATH}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}


function managedContainerName(id: string): string {
  const normalized = id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(normalized)) throw new Error("Managed sandbox process id is invalid");
  return `friday-bg-${normalized.replaceAll(":", "-")}`;
}

function managedOwnerLabel(): string {
  const home = resolve(process.env.FRIDAY_HOME?.trim() || join(homedir(), ".friday"));
  return createHash("sha256").update(home).digest("hex").slice(0, 24);
}

function canonical(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || rel === "." || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function probePodman(image: string): PodmanProbeResult {
  const result = spawnSync("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PODMAN_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.error) {
    return {
      available: false,
      status: "podman-unavailable",
      reason: `podman is unavailable: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "podman info failed").trim();
    return { available: false, status: "podman-unavailable", reason: `podman is unavailable: ${detail}` };
  }
  if (result.stdout.trim() !== "true") {
    return { available: false, status: "rootless-required", reason: "FRIDAY requires rootless Podman" };
  }
  const imageResult = spawnSync("podman", ["image", "exists", image], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PODMAN_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (imageResult.status === 1) {
    return {
      available: false,
      status: "image-missing",
      reason: `FRIDAY sandbox image is not available locally: ${image}`,
    };
  }
  if (imageResult.status !== 0) {
    const detail = (imageResult.stderr || imageResult.stdout || "podman image exists failed").trim();
    return {
      available: false,
      status: "podman-unavailable",
      reason: `podman image storage is unavailable: ${detail}`,
    };
  }
  return { available: true, status: "ready" };
}

function defaultSetupRun(command: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["inherit", "inherit", "inherit"],
  }) as SpawnSyncReturns<string>;
}

export function ensurePodmanSandboxImage(options: PodmanImageSetupOptions = {}): PodmanImageSetupResult {
  const image = options.image?.trim() || process.env.FRIDAY_SANDBOX_IMAGE?.trim() || DEFAULT_SANDBOX_IMAGE;
  const probe = options.probe ?? probePodman;
  const before = probe(image);
  if (before.available) return { status: "already-ready", image };
  if (before.status !== "image-missing") {
    throw new Error(before.reason ?? "Rootless Podman is unavailable");
  }

  const containerfile = resolve(options.containerfile ?? defaultContainerfile());
  const contextDir = resolve(options.contextDir ?? dirname(containerfile));
  if (!existsSync(containerfile)) throw new Error(`Sandbox Containerfile does not exist: ${containerfile}`);
  if (!existsSync(contextDir)) throw new Error(`Sandbox build context does not exist: ${contextDir}`);

  const run = options.run ?? defaultSetupRun;
  const result = run("podman", [
    "build",
    "--pull=missing",
    "--tag",
    image,
    "--file",
    containerfile,
    contextDir,
  ]);
  if (result.error) throw new Error(`Unable to build FRIDAY sandbox image: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Unable to build FRIDAY sandbox image ${image}: podman build exited with ${result.status ?? "unknown status"}`);
  }

  const after = probe(image);
  if (!after.available) {
    throw new Error(after.reason ?? `FRIDAY sandbox image was not available after build: ${image}`);
  }
  return { status: "built", image };
}

function volumeArgument(source: string, access: SandboxWorkspaceAccess, target = source): string {
  return `${source}:${target}:${access === "read" ? "ro" : "rw"}`;
}

export function createPodmanSandboxService(options: PodmanSandboxOptions = {}): SandboxService {
  const image = options.image?.trim() || process.env.FRIDAY_SANDBOX_IMAGE?.trim() || DEFAULT_SANDBOX_IMAGE;
  const probe = options.probe ?? probePodman;
  const PROBE_TTL_MS = 5_000;
  let cachedProbe: PodmanProbeResult | undefined;
  let cachedProbeAt = 0;
  const effectiveNetworkMode = networkMode(options);
  const limits = resourceLimits(options);
  const networkArguments = (requested: boolean): string[] =>
    effectiveNetworkMode === "requested" && !requested
      ? ["--http-proxy=false", "--network=none"]
      : [];
  const reportExecution = (kind: "shell" | "process" | "kernel", workspace: string, requestedNetwork: boolean): void => {
    options.onExecution?.(Object.freeze({
      kind,
      workspace,
      requestedNetwork,
      networkEnabled: effectiveNetworkMode === "unrestricted" || requestedNetwork,
      networkMode: effectiveNetworkMode,
    }));
  };

  const availability = (): PodmanProbeResult => {
    const now = Date.now();
    if (cachedProbe?.available && now - cachedProbeAt < PROBE_TTL_MS) return cachedProbe;
    const checked = probe(image);
    if (checked.available) {
      cachedProbe = checked;
      cachedProbeAt = now;
    } else {
      // Missing Podman/image state may be repaired by setup at any moment. Never
      // pin an unavailable result behind the health TTL.
      cachedProbe = undefined;
      cachedProbeAt = 0;
    }
    return checked;
  };

  interface TrustedReadOnlyMount {
    source: string;
    target: string;
    count: number;
  }

  const trustedReadOnlyMounts = new Map<string, Map<string, TrustedReadOnlyMount>>();
  const managedOwner = managedOwnerLabel();

  const auxiliaryMounts = (workspace: string): TrustedReadOnlyMount[] => {
    const mounts = [...(trustedReadOnlyMounts.get(workspace)?.values() ?? [])];
    for (const mount of mounts) {
      if (!existsSync(mount.source) || canonical(mount.source) !== mount.source) {
        throw new Error(`Trusted sandbox mount source changed after registration: ${mount.source}`);
      }
      if (mount.target !== mount.source) {
        if (!existsSync(mount.target)) {
          throw new Error(`Trusted sandbox mount target disappeared after registration: ${mount.target}`);
        }
        if (lstatSync(mount.target).isSymbolicLink()) {
          throw new Error(`Trusted sandbox mount target became a symlink after registration: ${mount.target}`);
        }
        const currentTarget = canonical(mount.target);
        if (currentTarget !== mount.target || currentTarget === workspace || !contained(workspace, currentTarget)) {
          throw new Error(`Trusted sandbox mount target changed after registration: ${mount.target}`);
        }
      }
    }
    return mounts;
  };

  const service: SandboxService = {
    get sandboxKind() {
      return availability().available ? "podman" : "unavailable";
    },
    image,
    networkMode: effectiveNetworkMode,
    limits,
    get unavailableReason() {
      const result = availability();
      return result.available ? undefined : result.reason;
    },

    assertAvailable() {
      const result = availability();
      if (!result.available) throw new Error(result.reason ?? "Podman sandbox is unavailable");
    },

    registerTrustedReadOnlyMount(workspacePath: string, sourcePath: string, targetPath?: string) {
      const workspace = canonical(workspacePath);
      const source = canonical(sourcePath);
      if (!existsSync(workspace)) throw new Error(`Sandbox workspace does not exist: ${workspace}`);
      if (!existsSync(source)) throw new Error(`Trusted sandbox mount does not exist: ${source}`);
      if (contained(workspace, source) || contained(source, workspace)) {
        throw new Error(`Trusted sandbox mount source must be disjoint from workspace: ${source}`);
      }

      let target = source;
      if (targetPath !== undefined) {
        const requestedTarget = resolve(targetPath);
        if (!existsSync(requestedTarget)) {
          throw new Error(`Trusted sandbox mount target does not exist: ${requestedTarget}`);
        }
        if (lstatSync(requestedTarget).isSymbolicLink()) {
          throw new Error(`Trusted sandbox mount target must not be a symlink: ${requestedTarget}`);
        }
        target = canonical(requestedTarget);
        if (target === workspace || !contained(workspace, target)) {
          throw new Error(`Trusted sandbox mount target must stay inside workspace: ${target}`);
        }
      }

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
      if (!contained(workspace, cwd)) {
        throw new Error(`Sandbox working directory is outside workspace: ${cwd}`);
      }
      reportExecution("shell", workspace, request.network);

      const args = [
        "run",
        "--rm",
        "--pull=never",
        "--userns=keep-id",
        ...confinementArguments(limits),
        ...networkArguments(request.network),
        `--volume=${volumeArgument(workspace, request.access)}`,
        ...auxiliaryMounts(workspace).map((mount) => `--volume=${volumeArgument(mount.source, "read", mount.target)}`),
        `--workdir=${cwd}`,
        "--env=HOME=/tmp",
        `--env=PATH=${sandboxPath(workspace)}`,
        "--env=FRIDAY_SANDBOX=podman",
        "--entrypoint=/bin/bash",
        image,
        "-c",
        request.command,
      ];

      return {
        command: ["podman", ...args].map(shellQuote).join(" "),
        cwd: workspace,
        env: { ...request.env },
      };
    },

    sandboxProcess(request: SandboxProcessRequest): SandboxProcessContext {
      service.assertAvailable();
      const workspace = canonical(request.workspace);
      const cwd = canonical(request.cwd);
      if (!contained(workspace, cwd)) {
        throw new Error(`Sandbox working directory is outside workspace: ${cwd}`);
      }
      if (!request.command.trim()) throw new Error("Sandbox process command is required");
      reportExecution("process", workspace, request.network);

      const managedArgs = request.managed === undefined ? [] : [
        `--name=${managedContainerName(request.managed.id)}`,
        "--label=io.friday.managed=true",
        `--label=io.friday.owner=${managedOwner}`,
        `--label=io.friday.process=${request.managed.id}`,
        `--label=io.friday.run=${request.managed.runId}`,
      ];
      const args = [
        "run",
        "--rm",
        "--pull=never",
        "--userns=keep-id",
        ...managedArgs,
        ...(request.interactive === true ? ["--interactive"] : []),
        ...confinementArguments(limits),
        ...networkArguments(request.network),
        `--volume=${volumeArgument(workspace, request.access)}`,
        ...auxiliaryMounts(workspace).map((mount) => `--volume=${volumeArgument(mount.source, "read", mount.target)}`),
        `--workdir=${cwd}`,
        "--env=HOME=/tmp",
        `--env=PATH=${sandboxPath(workspace)}`,
        "--env=FRIDAY_SANDBOX=podman",
        `--entrypoint=${request.command}`,
        image,
        ...request.args,
      ];

      return {
        command: "podman",
        args,
        cwd: workspace,
        env: { ...request.env },
      };
    },

    cleanupManagedProcess(id: string) {
      const status = availability();
      if (!status.available) throw new Error(status.reason ?? "Podman is unavailable during managed-process cleanup");
      const normalizedId = id.trim();
      managedContainerName(normalizedId);
      const listed = spawnSync("podman", [
        "ps", "-aq",
        "--filter", "label=io.friday.managed=true",
        "--filter", `label=io.friday.owner=${managedOwner}`,
        "--filter", `label=io.friday.process=${normalizedId}`,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (listed.error) throw new Error(`Unable to inspect managed Podman process ${normalizedId}: ${listed.error.message}`);
      if (listed.status !== 0) throw new Error(`Unable to inspect managed Podman process ${normalizedId}: ${(listed.stderr || "podman ps failed").trim()}`);
      const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
      if (ids.length === 0) return;
      const removed = spawnSync("podman", ["rm", "-f", ...ids], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      });
      if (removed.error) throw new Error(`Unable to remove managed Podman process ${normalizedId}: ${removed.error.message}`);
      if (removed.status !== 0) throw new Error(`Unable to remove managed Podman process ${normalizedId}: ${(removed.stderr || "podman rm failed").trim()}`);
    },

    cleanupStaleManagedProcesses() {
      const status = availability();
      if (!status.available) return;
      const listed = spawnSync("podman", [
        "ps", "-aq",
        "--filter", "label=io.friday.managed=true",
        "--filter", `label=io.friday.owner=${managedOwner}`,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (listed.error) throw new Error(`Unable to inspect stale FRIDAY Podman processes: ${listed.error.message}`);
      if (listed.status !== 0) throw new Error(`Unable to inspect stale FRIDAY Podman processes: ${(listed.stderr || "podman ps failed").trim()}`);
      if (!listed.stdout?.trim()) return;
      const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
      if (ids.length === 0) return;
      const removed = spawnSync("podman", ["rm", "-f", ...ids], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      });
      if (removed.error) throw new Error(`Unable to remove stale FRIDAY Podman processes: ${removed.error.message}`);
      if (removed.status !== 0) throw new Error(`Unable to remove stale FRIDAY Podman processes: ${(removed.stderr || "podman rm failed").trim()}`);
    },

    sandboxKernel(request: SandboxKernelRequest): SandboxKernelContext {
      service.assertAvailable();
      const workspace = canonical(request.workspace);
      const cwd = canonical(request.cwd);
      const tempDir = canonical(request.tempDir);
      const connectionPath = canonical(request.connectionPath);
      if (!contained(workspace, cwd)) {
        throw new Error(`Sandbox working directory is outside workspace: ${cwd}`);
      }
      if (!contained(tempDir, connectionPath)) {
        throw new Error(`Kernel connection file is outside its temporary directory: ${connectionPath}`);
      }
      reportExecution("kernel", workspace, false);

      const args = [
        "run",
        "--rm",
        "--pull=never",
        "--userns=keep-id",
        ...confinementArguments(limits),
        ...networkArguments(false),
        `--volume=${volumeArgument(workspace, "write")}`,
        `--volume=${tempDir}:${tempDir}:rw`,
        ...auxiliaryMounts(workspace).map((mount) => `--volume=${volumeArgument(mount.source, "read", mount.target)}`),
        `--workdir=${cwd}`,
        "--env=HOME=/tmp",
        `--env=PATH=${sandboxPath(workspace)}`,
        "--env=FRIDAY_SANDBOX=podman",
      ];
      const pythonPath = request.env.PYTHONPATH;
      if (typeof pythonPath === "string" && pythonPath.trim()) {
        args.push(`--env=PYTHONPATH=${pythonPath}`);
      }
      args.push(image, "python3", "-m", "ipykernel_launcher", "-f", connectionPath);

      return {
        command: "podman",
        args,
        cwd: workspace,
        env: { ...request.env },
      };
    },
  };

  return Object.freeze(service);
}

export { DEFAULT_SANDBOX_IMAGE };
