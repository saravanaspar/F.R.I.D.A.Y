import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";

const MIB = 1024 * 1024;
const DEFAULT_PER_AGENT_RESERVE_MIB = 384;
const DEFAULT_MIN_HOST_RESERVE_MIB = 512;
const DEFAULT_HOST_RESERVE_RATIO = 0.15;

export interface SubagentMemorySnapshot {
  /** Effective memory visible to FRIDAY after host/cgroup constraints. */
  readonly totalBytes: number;
  /** Effective memory currently available before FRIDAY's safety reserve. */
  readonly availableBytes: number;
  /** Memory FRIDAY leaves untouched for the OS and unrelated workloads. */
  readonly safetyReserveBytes: number;
  /** Conservative incremental reservation used for each newly admitted child. */
  readonly perAgentReserveBytes: number;
  /** Number of additional children that can be started safely right now. */
  readonly safeAdditionalAgents: number;
  readonly source: "linux-meminfo" | "linux-meminfo+cgroup" | "os" | "os+cgroup";
}

function positiveEnvMib(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1024 * 1024) {
    throw new Error(`${name} must be a positive MiB value`);
  }
  return value;
}

function optionalText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") return undefined;
    throw error;
  }
}

function parseMeminfo(): { totalBytes: number; availableBytes: number } | undefined {
  const text = optionalText("/proc/meminfo");
  if (!text) return undefined;
  const values = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB\s*$/.exec(line);
    if (!match) continue;
    values.set(match[1]!, Number(match[2]) * 1024);
  }
  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable") ?? values.get("MemFree");
  if (!totalBytes || !availableBytes) return undefined;
  return { totalBytes, availableBytes };
}

function parseCgroupHeadroom(): { limitBytes: number; availableBytes: number } | undefined {
  const maxRaw = optionalText("/sys/fs/cgroup/memory.max");
  const currentRaw = optionalText("/sys/fs/cgroup/memory.current");
  if (!maxRaw || !currentRaw || maxRaw === "max") return undefined;
  const limitBytes = Number(maxRaw);
  const currentBytes = Number(currentRaw);
  if (!Number.isFinite(limitBytes) || limitBytes <= 0 || !Number.isFinite(currentBytes) || currentBytes < 0) return undefined;
  return { limitBytes, availableBytes: Math.max(0, limitBytes - currentBytes) };
}

export function readSubagentMemorySnapshot(): SubagentMemorySnapshot {
  const meminfo = parseMeminfo();
  const host = meminfo ?? { totalBytes: totalmem(), availableBytes: freemem() };
  let totalBytes = host.totalBytes;
  let availableBytes = host.availableBytes;
  let source: SubagentMemorySnapshot["source"] = meminfo ? "linux-meminfo" : "os";

  const cgroup = parseCgroupHeadroom();
  if (cgroup) {
    totalBytes = Math.min(totalBytes, cgroup.limitBytes);
    availableBytes = Math.min(availableBytes, cgroup.availableBytes);
    source = source === "linux-meminfo" ? "linux-meminfo+cgroup" : "os+cgroup";
  }

  const configuredHostReserve = positiveEnvMib("FRIDAY_SUBAGENT_HOST_RESERVE_MIB", DEFAULT_MIN_HOST_RESERVE_MIB) * MIB;
  const ratioReserve = Math.ceil(totalBytes * DEFAULT_HOST_RESERVE_RATIO);
  const safetyReserveBytes = Math.max(configuredHostReserve, ratioReserve);
  const perAgentReserveBytes = positiveEnvMib("FRIDAY_SUBAGENT_MEMORY_RESERVE_MIB", DEFAULT_PER_AGENT_RESERVE_MIB) * MIB;
  const spendable = Math.max(0, availableBytes - safetyReserveBytes);
  const safeAdditionalAgents = Math.max(0, Math.floor(spendable / perAgentReserveBytes));

  return Object.freeze({
    totalBytes,
    availableBytes,
    safetyReserveBytes,
    perAgentReserveBytes,
    safeAdditionalAgents,
    source,
  });
}

export function formatMib(bytes: number): string {
  return `${Math.max(0, Math.round(bytes / MIB))} MiB`;
}
