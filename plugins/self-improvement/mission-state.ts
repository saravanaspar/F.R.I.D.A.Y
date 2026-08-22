import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PermissionMode } from "../permissions/contract.js";
import type { SelfImprovementContinuation, SelfImprovementGateSpec } from "./contract.js";

export type SelfImprovementMissionStatus =
  | "running"
  | "restarting"
  | "resuming"
  | "completed"
  | "failed"
  | "rolled-back";

export interface SelfImprovementMissionExecutable {
  path: string;
  sha256: string;
}

export interface SelfImprovementMission {
  id: string;
  objective: string;
  repository: string;
  worktreeRoot: string;
  provider: string;
  model: string;
  permissionMode: PermissionMode;
  gates: SelfImprovementGateSpec[];
  status: SelfImprovementMissionStatus;
  candidateId: string;
  fromGenerationId: string | undefined;
  targetGenerationId: string;
  targetCommit: string;
  targetExecutable?: SelfImprovementMissionExecutable | undefined;
  previousExecutable?: SelfImprovementMissionExecutable | undefined;
  createdAt: string;
  updatedAt: string;
  lastError: string | undefined;
  continuation?: SelfImprovementContinuation | undefined;
}

interface MissionState {
  schema: 1;
  missions: Record<string, SelfImprovementMission>;
}

export const SELF_IMPROVEMENT_MISSION_FILE_NAME = "missions.json";

export class SelfImprovementMissionStateError extends Error {
  override name = "SelfImprovementMissionStateError";
}

function emptyState(): MissionState {
  return { schema: 1, missions: {} };
}

export function getSelfImprovementMissionStatePath(stateDir: string): string {
  return join(stateDir, SELF_IMPROVEMENT_MISSION_FILE_NAME);
}

function assertPrivateStateDir(stateDir: string, create: boolean): void {
  if (!existsSync(stateDir)) {
    if (!create) return;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
  const info = lstatSync(stateDir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new SelfImprovementMissionStateError(`Self-improvement mission directory must be a private directory: ${stateDir}`);
  if ((info.mode & 0o077) !== 0) throw new SelfImprovementMissionStateError(`Self-improvement mission directory permissions are too broad: ${stateDir}`);
}

function assertPrivateStateFile(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new SelfImprovementMissionStateError(`Self-improvement mission state must be a regular file: ${path}`);
  if ((info.mode & 0o077) !== 0) throw new SelfImprovementMissionStateError(`Self-improvement mission state permissions are too broad: ${path}`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new SelfImprovementMissionStateError(`Mission field ${field} must be a non-empty string`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new SelfImprovementMissionStateError(`Mission gate field ${field} must be a positive integer`);
  }
  return value as number;
}


function optionalExecutable(value: unknown, field: string): SelfImprovementMissionExecutable | undefined {
  if (value === undefined) return undefined;
  const raw = record(value);
  if (!raw) throw new SelfImprovementMissionStateError(`Mission ${field} must be an object`);
  const path = requiredString(raw, "path");
  const sha256 = requiredString(raw, "sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new SelfImprovementMissionStateError(`Mission ${field} hash is invalid`);
  return Object.freeze({ path, sha256 });
}


function optionalContinuation(value: unknown, missionId: string): SelfImprovementContinuation | undefined {
  if (value === undefined) return undefined;
  const raw = record(value);
  if (!raw) throw new SelfImprovementMissionStateError(`Mission ${missionId} continuation must be an object`);
  const id = requiredString(raw, "id");
  const text = requiredString(raw, "text");
  if (text.length > 32_000) throw new SelfImprovementMissionStateError(`Mission ${missionId} continuation text is too large`);
  if (!Number.isFinite(raw.timestamp) || (raw.timestamp as number) < 0) {
    throw new SelfImprovementMissionStateError(`Mission ${missionId} continuation timestamp is invalid`);
  }
  const principalRaw = record(raw.principal);
  if (!principalRaw) throw new SelfImprovementMissionStateError(`Mission ${missionId} continuation principal is invalid`);
  const authority = requiredString(principalRaw, "authority");
  if (authority !== "channel") {
    throw new SelfImprovementMissionStateError(`Mission ${missionId} continuation must originate from a channel`);
  }
  const principal = Object.freeze({
    authority: "channel" as const,
    channel: requiredString(principalRaw, "channel"),
    accountId: requiredString(principalRaw, "accountId"),
    conversationId: requiredString(principalRaw, "conversationId"),
    senderId: requiredString(principalRaw, "senderId"),
    ...(principalRaw.threadId === undefined ? {} : { threadId: requiredString(principalRaw, "threadId") }),
  });
  let attachments: SelfImprovementContinuation["attachments"];
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments) || raw.attachments.length > 16) {
      throw new SelfImprovementMissionStateError(`Mission ${missionId} continuation attachments are invalid`);
    }
    attachments = Object.freeze(raw.attachments.map((entry, index) => {
      const attachment = record(entry);
      if (!attachment) throw new SelfImprovementMissionStateError(`Mission ${missionId} continuation attachment ${index} is invalid`);
      const kind = requiredString(attachment, "kind");
      if (!["image", "audio", "video", "document", "sticker", "other"].includes(kind)) {
        throw new SelfImprovementMissionStateError(`Mission ${missionId} continuation attachment ${index} kind is invalid`);
      }
      const sizeBytes = attachment.sizeBytes;
      if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0)) {
        throw new SelfImprovementMissionStateError(`Mission ${missionId} continuation attachment ${index} size is invalid`);
      }
      return Object.freeze({
        kind: kind as "image" | "audio" | "video" | "document" | "sticker" | "other",
        externalId: requiredString(attachment, "externalId"),
        ...(attachment.mimeType === undefined ? {} : { mimeType: requiredString(attachment, "mimeType") }),
        ...(attachment.fileName === undefined ? {} : { fileName: requiredString(attachment, "fileName") }),
        ...(sizeBytes === undefined ? {} : { sizeBytes: sizeBytes as number }),
        ...(attachment.downloadUrl === undefined ? {} : { downloadUrl: requiredString(attachment, "downloadUrl") }),
        ...(attachment.artifactRef === undefined ? {} : { artifactRef: requiredString(attachment, "artifactRef") }),
      });
    }));
  }
  const destinationId = raw.destinationId === undefined ? undefined : requiredString(raw, "destinationId");
  if (destinationId !== undefined && destinationId !== "session:new" && !/^session:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(destinationId)) {
    throw new SelfImprovementMissionStateError(`Mission ${missionId} continuation destination is invalid`);
  }
  return Object.freeze({
    id,
    principal,
    text,
    ...(destinationId === undefined ? {} : { destinationId }),
    timestamp: raw.timestamp as number,
    ...(attachments === undefined ? {} : { attachments }),
  });
}

function parseMission(id: string, value: unknown): SelfImprovementMission {
  const raw = record(value);
  if (!raw) throw new SelfImprovementMissionStateError(`Mission ${id} must be an object`);
  const missionId = requiredString(raw, "id");
  if (missionId !== id) {
    throw new SelfImprovementMissionStateError(`Mission key ${id} does not match record id ${missionId}`);
  }
  const allowed = new Set<SelfImprovementMissionStatus>([
    "running",
    "restarting",
    "resuming",
    "completed",
    "failed",
    "rolled-back",
  ]);
  const status = requiredString(raw, "status") as SelfImprovementMissionStatus;
  if (!allowed.has(status)) {
    throw new SelfImprovementMissionStateError(`Mission ${id} has unsupported status ${status}`);
  }
  if (!Array.isArray(raw.gates) || raw.gates.length === 0) {
    throw new SelfImprovementMissionStateError(`Mission ${id} must retain at least one deterministic gate`);
  }
  const gates = raw.gates.map((value, index): SelfImprovementGateSpec => {
    const gate = record(value);
    if (!gate) throw new SelfImprovementMissionStateError(`Mission ${id} gate ${index} must be an object`);
    const command = requiredString(gate, "command");
    const gateId = gate.id === undefined ? undefined : requiredString(gate, "id");
    const timeoutMs = optionalPositiveInteger(gate.timeoutMs, "timeoutMs");
    const maxOutputChars = optionalPositiveInteger(gate.maxOutputChars, "maxOutputChars");
    return {
      ...(gateId === undefined ? {} : { id: gateId }),
      command,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
    };
  });
  const permissionMode = raw.permissionMode === undefined ? "ask" : requiredString(raw, "permissionMode");
  if (permissionMode !== "ask" && permissionMode !== "auto" && permissionMode !== "full") {
    throw new SelfImprovementMissionStateError(`Mission ${id} has unsupported permission mode ${permissionMode}`);
  }
  const fromGenerationId = raw.fromGenerationId;
  if (fromGenerationId !== undefined && (typeof fromGenerationId !== "string" || !fromGenerationId.trim())) {
    throw new SelfImprovementMissionStateError(`Mission ${id} has invalid fromGenerationId`);
  }
  const lastError = raw.lastError;
  if (lastError !== undefined && typeof lastError !== "string") {
    throw new SelfImprovementMissionStateError(`Mission ${id} has invalid lastError`);
  }
  const continuation = optionalContinuation(raw.continuation, id);
  const targetExecutable = optionalExecutable(raw.targetExecutable, `${id} targetExecutable`);
  const previousExecutable = optionalExecutable(raw.previousExecutable, `${id} previousExecutable`);
  return {
    id: missionId,
    objective: requiredString(raw, "objective"),
    repository: requiredString(raw, "repository"),
    worktreeRoot: requiredString(raw, "worktreeRoot"),
    provider: requiredString(raw, "provider"),
    model: requiredString(raw, "model"),
    permissionMode,
    gates,
    status,
    candidateId: requiredString(raw, "candidateId"),
    fromGenerationId: fromGenerationId as string | undefined,
    targetGenerationId: requiredString(raw, "targetGenerationId"),
    targetCommit: requiredString(raw, "targetCommit"),
    ...(targetExecutable === undefined ? {} : { targetExecutable }),
    ...(previousExecutable === undefined ? {} : { previousExecutable }),
    createdAt: requiredString(raw, "createdAt"),
    updatedAt: requiredString(raw, "updatedAt"),
    lastError: lastError as string | undefined,
    ...(continuation === undefined ? {} : { continuation }),
  };
}

export class SelfImprovementMissionStore {
  readonly #stateDir: string;
  #state: MissionState;

  constructor(stateDir: string) {
    this.#stateDir = stateDir;
    this.#state = this.#load();
  }

  get(id: string): SelfImprovementMission | undefined {
    const mission = this.#state.missions[id];
    return mission ? structuredClone(mission) : undefined;
  }

  list(): readonly SelfImprovementMission[] {
    return Object.freeze(Object.values(this.#state.missions)
      .map((mission) => structuredClone(mission))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)));
  }

  findByGeneration(id: string): SelfImprovementMission | undefined {
    const found = Object.values(this.#state.missions).filter((mission) => mission.targetGenerationId === id);
    if (found.length > 1) {
      throw new SelfImprovementMissionStateError(`Multiple self-improvement missions target generation ${id}`);
    }
    return found[0] ? structuredClone(found[0]) : undefined;
  }

  put(mission: SelfImprovementMission): SelfImprovementMission {
    if (this.#state.missions[mission.id]) {
      throw new SelfImprovementMissionStateError(`Self-improvement mission ${mission.id} already exists`);
    }
    this.#state.missions[mission.id] = structuredClone(mission);
    this.#save();
    return structuredClone(mission);
  }

  update(
    id: string,
    patch: Partial<Omit<SelfImprovementMission, "id" | "createdAt">>,
  ): SelfImprovementMission {
    const current = this.#state.missions[id];
    if (!current) throw new SelfImprovementMissionStateError(`Self-improvement mission ${id} not found`);
    const next: SelfImprovementMission = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
    };
    this.#state.missions[id] = next;
    this.#save();
    return structuredClone(next);
  }

  #load(): MissionState {
    assertPrivateStateDir(this.#stateDir, false);
    const path = getSelfImprovementMissionStatePath(this.#stateDir);
    if (!existsSync(path)) return emptyState();
    assertPrivateStateFile(path);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      throw new SelfImprovementMissionStateError(
        `Failed to parse self-improvement mission state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const object = record(raw);
    if (!object || object.schema !== 1) {
      throw new SelfImprovementMissionStateError(`Unsupported or malformed self-improvement mission state at ${path}`);
    }
    const missions = record(object.missions);
    if (!missions) {
      throw new SelfImprovementMissionStateError(`Self-improvement mission state at ${path} is missing missions`);
    }
    const state = emptyState();
    for (const [id, value] of Object.entries(missions)) state.missions[id] = parseMission(id, value);
    return state;
  }

  #save(): void {
    assertPrivateStateDir(this.#stateDir, true);
    const path = getSelfImprovementMissionStatePath(this.#stateDir);
    if (existsSync(path)) assertPrivateStateFile(path);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(this.#state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
      chmodSync(path, 0o600);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
}
