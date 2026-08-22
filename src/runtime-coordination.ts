import { createHash, randomUUID } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getFridayHome } from "./host/runtime-env.js";

const COORDINATION_SCHEMA = 1 as const;
const GATE_NAME = "operation.gate";
const LEASES_NAME = "runtime-leases";
const OWNER_NAME = "owner.json";
const DEFAULT_WAIT_MS = 30_000;
const INCOMPLETE_GATE_STALE_MS = 15 * 60_000;

interface ProcessLease {
  readonly schema: typeof COORDINATION_SCHEMA;
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
  /** Linux boot identity + kernel process start ticks; prevents PID-reuse false liveness. */
  readonly birthId?: string | undefined;
}

export interface RuntimeLeaseOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Lifecycle successors are intentionally alive beside a quiescing predecessor. */
  readonly allowConcurrent?: boolean | undefined;
  readonly waitMs?: number | undefined;
}

export interface StoppedRuntimeGuardOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly waitMs?: number | undefined;
}

function coordinationRoot(environment: NodeJS.ProcessEnv): string {
  const home = getFridayHome(environment);
  const label = basename(home) || "friday";
  return join(dirname(home), `.${label}-coordination`);
}

function boundedWait(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WAIT_MS;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new Error("Runtime coordination wait must be between 1000 and 300000ms");
  }
  return value;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error(`FRIDAY runtime coordination requires a private directory: ${path}`);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

type BirthProbe =
  | Readonly<{ status: "known"; birthId: string }>
  | Readonly<{ status: "dead" }>
  | Readonly<{ status: "unavailable" }>;

async function probeProcessBirth(pid: number): Promise<BirthProbe> {
  if (process.platform !== "linux") return { status: "unavailable" };
  let statText: string;
  try {
    statText = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "dead" };
    return { status: "unavailable" };
  }
  let bootId: string;
  try {
    bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
  } catch {
    return { status: "unavailable" };
  }
  // /proc/<pid>/stat field 2 is parenthesized comm and may contain spaces. Start
  // parsing after its final ')' so field 22 (starttime) is stable.
  const close = statText.lastIndexOf(")");
  if (close < 0) return { status: "unavailable" };
  const fields = statText.slice(close + 1).trim().split(/\s+/);
  const startTicks = fields[19]; // field 22; fields[0] is kernel field 3 (state)
  if (!/^[0-9]+$/.test(startTicks ?? "") || !/^[a-f0-9-]{36}$/.test(bootId)) return { status: "unavailable" };
  return { status: "known", birthId: `${bootId}:${startTicks}` };
}

async function currentBirthId(): Promise<string | undefined> {
  const probe = await probeProcessBirth(process.pid);
  return probe.status === "known" ? probe.birthId : undefined;
}

async function leaseProcessAlive(lease: ProcessLease): Promise<boolean> {
  if (!processAlive(lease.pid)) return false;
  if (!lease.birthId) return true; // backward-compatible legacy lease
  const probe = await probeProcessBirth(lease.pid);
  if (probe.status === "dead") return false;
  if (probe.status === "unavailable") return true; // fail safe: never delete uncertain live ownership
  return probe.birthId === lease.birthId;
}

function parseLease(text: string, path: string): ProcessLease {
  if (Buffer.byteLength(text) > 16 * 1024) throw new Error(`Runtime lease is too large: ${path}`);
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch (error) {
    throw new Error(`Runtime lease is invalid JSON: ${path}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Runtime lease is invalid: ${path}`);
  const record = parsed as Record<string, unknown>;
  if (
    record.schema !== COORDINATION_SCHEMA
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || typeof record.token !== "string"
    || !/^[a-f0-9-]{36}$/.test(record.token)
    || typeof record.startedAt !== "string"
    || !Number.isFinite(Date.parse(record.startedAt))
  ) throw new Error(`Runtime lease schema is invalid: ${path}`);
  const birthId = record.birthId;
  if (birthId !== undefined && (typeof birthId !== "string" || !/^[a-f0-9-]{36}:[0-9]+$/.test(birthId))) {
    throw new Error(`Runtime lease birth identity is invalid: ${path}`);
  }
  return {
    schema: COORDINATION_SCHEMA,
    pid: record.pid as number,
    token: record.token,
    startedAt: new Date(record.startedAt).toISOString(),
    ...(birthId === undefined ? {} : { birthId }),
  };
}

const LIFECYCLE_STATUS_ENV = "FRIDAY_LIFECYCLE_RESTART_STATUS";
const LIFECYCLE_REQUEST_ENV = "FRIDAY_LIFECYCLE_RESTART_REQUEST";
const LIFECYCLE_TOKEN_ENV = "FRIDAY_LIFECYCLE_RESTART_TOKEN";

/**
 * Validate the full authenticated lifecycle handoff tuple before allowing two
 * runtimes to coexist. Presence of a single environment variable is never enough.
 */
export async function isVerifiedLifecycleSuccessor(environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const statusPath = environment[LIFECYCLE_STATUS_ENV]?.trim();
  const requestId = environment[LIFECYCLE_REQUEST_ENV]?.trim();
  const token = environment[LIFECYCLE_TOKEN_ENV];
  const supplied = [statusPath, requestId, token].filter((value) => value !== undefined && value !== "").length;
  if (supplied === 0) return false;
  if (supplied !== 3 || !statusPath || !requestId || !token) throw new Error("Incomplete lifecycle restart environment");
  const info = await lstat(statusPath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 64 * 1024) {
    throw new Error(`Lifecycle restart status is unsafe: ${statusPath}`);
  }
  let raw: unknown;
  try { raw = JSON.parse(await readFile(statusPath, "utf8")) as unknown; } catch (error) {
    throw new Error(`Lifecycle restart status is invalid: ${statusPath}`, { cause: error });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Lifecycle restart status record is invalid");
  const record = raw as Record<string, unknown>;
  const successor = record.successor;
  if (
    record.version !== 1
    || record.requestId !== requestId
    || typeof record.tokenHash !== "string"
    || record.tokenHash !== createHash("sha256").update(token).digest("hex")
    || (record.phase !== "launching" && record.phase !== "ready" && record.phase !== "quiesced")
    || !record.predecessor
    || typeof record.predecessor !== "object"
    || !Number.isSafeInteger((record.predecessor as Record<string, unknown>).pid)
    || ((record.predecessor as Record<string, unknown>).pid as number) <= 0
    || (successor !== undefined && (
      !successor
      || typeof successor !== "object"
      || (successor as Record<string, unknown>).pid !== process.pid
    ))
  ) throw new Error("Lifecycle restart status does not authorize this successor process");
  return true;
}

async function acquireGate(root: string, waitMs: number): Promise<() => Promise<void>> {
  await privateDirectory(root);
  const gate = join(root, GATE_NAME);
  const token = randomUUID();
  const birthId = await currentBirthId();
  const deadline = Date.now() + waitMs;
  while (true) {
    const staged = join(root, `.${GATE_NAME}.${process.pid}.${randomUUID()}.tmp`);
    try {
      // Publish ownership atomically: build the complete private gate off to the
      // side, then rename it into place. A crash can no longer leave a freshly
      // created ownerless gate that wedges coordination for minutes.
      await mkdir(staged, { mode: 0o700 });
      const owner: ProcessLease = {
        schema: COORDINATION_SCHEMA,
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
        ...(birthId === undefined ? {} : { birthId }),
      };
      await writeFile(join(staged, OWNER_NAME), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
      try {
        await rename(staged, gate);
      } catch (error) {
        await rm(staged, { recursive: true, force: true });
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        throw Object.assign(new Error("coordination gate exists"), { code: "EEXIST" });
      }
      let released = false;
      return async () => {
        if (released) return;
        const ownerPath = join(gate, OWNER_NAME);
        const current = parseLease(await readFile(ownerPath, "utf8"), ownerPath);
        if (current.token !== token || current.pid !== process.pid) {
          throw new Error("Runtime coordination gate ownership changed before release");
        }
        await rm(gate, { recursive: true, force: false });
        released = true;
      };
    } catch (error) {
      try {
        await rm(staged, { recursive: true, force: true });
      } catch (cleanupError) {
        reportOperationalError({ component: "runtime-coordination", operation: "remove staged coordination gate", error: cleanupError, severity: "warn" });
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const ownerPath = join(gate, OWNER_NAME);
      let stale = false;
      try {
        const owner = parseLease(await readFile(ownerPath, "utf8"), ownerPath);
        stale = !await leaseProcessAlive(owner);
      } catch (ownerError) {
        const info = await lstat(gate).catch((statError: NodeJS.ErrnoException) => {
          if (statError.code === "ENOENT") return undefined;
          throw statError;
        });
        if (!info) continue;
        // Compatibility cleanup for ownerless gates left by an older FRIDAY build.
        if (Date.now() - info.mtimeMs > INCOMPLETE_GATE_STALE_MS) stale = true;
        else if ((ownerError as NodeJS.ErrnoException).code !== "ENOENT") throw ownerError;
      }
      if (stale) {
        await rm(gate, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for FRIDAY runtime coordination");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
}

async function liveLeases(root: string): Promise<ProcessLease[]> {
  const leases = join(root, LEASES_NAME);
  await privateDirectory(leases);
  const live: ProcessLease[] = [];
  for (const entry of await readdir(leases, { withFileTypes: true })) {
    const path = join(leases, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9]+-[a-f0-9-]{36}\.json$/.test(entry.name)) {
      throw new Error(`Unsafe runtime lease entry: ${path}`);
    }
    const info = await lstat(path);
    if ((info.mode & 0o077) !== 0 || info.size > 16 * 1024) throw new Error(`Runtime lease is not private and bounded: ${path}`);
    const lease = parseLease(await readFile(path, "utf8"), path);
    if (entry.name !== `${lease.pid}-${lease.token}.json`) throw new Error(`Runtime lease filename disagrees with contents: ${path}`);
    if (await leaseProcessAlive(lease)) live.push(lease);
    else await unlink(path);
  }
  return live;
}

async function releasePreservingFailure(
  release: () => Promise<void>,
  primary: unknown,
  label: string,
): Promise<void> {
  try {
    await release();
  } catch (releaseError) {
    if (primary !== undefined) {
      throw new AggregateError([
        primary instanceof Error ? primary : new Error(String(primary)),
        releaseError instanceof Error ? releaseError : new Error(String(releaseError)),
      ], `${label} failed and its coordination guard could not be released`);
    }
    throw releaseError;
  }
}

export async function acquireRuntimeLease(options: RuntimeLeaseOptions = {}): Promise<() => Promise<void>> {
  const environment = options.environment ?? process.env;
  const root = resolve(coordinationRoot(environment));
  const releaseGate = await acquireGate(root, boundedWait(options.waitMs));
  let primary: unknown;
  let leasePath: string | undefined;
  let token: string | undefined;
  try {
    const live = await liveLeases(root);
    if (live.length > 0 && options.allowConcurrent !== true) {
      throw new Error(`Another FRIDAY runtime is active (pid${live.length === 1 ? "" : "s"} ${live.map((lease) => lease.pid).join(", ")})`);
    }
    token = randomUUID();
    const birthId = await currentBirthId();
    const lease: ProcessLease = {
      schema: COORDINATION_SCHEMA,
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
      ...(birthId === undefined ? {} : { birthId }),
    };
    leasePath = join(root, LEASES_NAME, `${lease.pid}-${lease.token}.json`);
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await releasePreservingFailure(releaseGate, primary, "Runtime lease acquisition");
  }
  const ownedPath = leasePath!;
  const ownedToken = token!;
  let released = false;
  return async () => {
    if (released) return;
    const current = parseLease(await readFile(ownedPath, "utf8"), ownedPath);
    if (current.pid !== process.pid || current.token !== ownedToken) throw new Error("Runtime lease ownership changed before release");
    await unlink(ownedPath);
    released = true;
  };
}

/** Hold the coordination gate for an operation that requires every runtime stopped. */
export async function acquireStoppedRuntimeGuard(options: StoppedRuntimeGuardOptions = {}): Promise<() => Promise<void>> {
  const environment = options.environment ?? process.env;
  const root = resolve(coordinationRoot(environment));
  const releaseGate = await acquireGate(root, boundedWait(options.waitMs));
  try {
    const live = await liveLeases(root);
    if (live.length > 0) {
      throw new Error(`FRIDAY must be stopped for this operation; active pid${live.length === 1 ? "" : "s"}: ${live.map((lease) => lease.pid).join(", ")}`);
    }
    return releaseGate;
  } catch (error) {
    await releasePreservingFailure(releaseGate, error, "Stopped-runtime check");
    throw error;
  }
}
