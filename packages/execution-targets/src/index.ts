export type ExecutionTargetKind = "sandbox" | "core-host" | "computer-node";
export type ExecutionOperation = "shell" | "edit" | "process" | "git";
export type ExecutionAccess = "read" | "write";

export interface ExecutionTarget {
  readonly id: string;
  readonly kind: ExecutionTargetKind;
  readonly label: string;
  readonly operations: readonly ExecutionOperation[];
  readonly computerNodeId?: string | undefined;
}

export interface ExecutionTargetPolicy {
  readonly defaultTargetId: string;
  readonly allowedTargetIds: readonly string[];
  readonly requireWorktreeForWrites: boolean;
  readonly allowCoreHostWrites: boolean;
}

export interface ExecutionTargetRequest {
  readonly operation: ExecutionOperation;
  readonly access: ExecutionAccess;
  readonly requestedTargetId?: string | undefined;
}

export interface ExecutionTargetResolution {
  readonly target: ExecutionTarget;
  readonly operation: ExecutionOperation;
  readonly access: ExecutionAccess;
  readonly requiresWorktree: boolean;
}

const TARGET_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

function text(value: string, label: string, maximum = 160): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function targetId(value: string): string {
  const normalized = text(value, "execution target id", 128);
  if (!TARGET_ID.test(normalized)) throw new Error("execution target id is invalid");
  return normalized;
}

function uniqueOperations(values: readonly ExecutionOperation[]): readonly ExecutionOperation[] {
  const allowed = new Set<ExecutionOperation>(["shell", "edit", "process", "git"]);
  const normalized: ExecutionOperation[] = [];
  for (const value of values) {
    if (!allowed.has(value)) throw new Error(`unsupported execution operation: ${String(value)}`);
    if (!normalized.includes(value)) normalized.push(value);
  }
  if (normalized.length === 0) throw new Error("execution target must support at least one operation");
  return Object.freeze(normalized);
}

export function defineExecutionTarget(input: ExecutionTarget): ExecutionTarget {
  const id = targetId(input.id);
  const label = text(input.label, "execution target label");
  const operations = uniqueOperations(input.operations);
  if (input.kind !== "sandbox" && input.kind !== "core-host" && input.kind !== "computer-node") {
    throw new Error(`unsupported execution target kind: ${String(input.kind)}`);
  }
  if (input.kind === "computer-node") {
    const computerNodeId = text(input.computerNodeId ?? "", "computer node id", 128);
    return Object.freeze({ id, kind: input.kind, label, operations, computerNodeId });
  }
  if (input.computerNodeId !== undefined) throw new Error("computerNodeId is only valid for computer-node targets");
  return Object.freeze({ id, kind: input.kind, label, operations });
}

export function sandboxExecutionTarget(): ExecutionTarget {
  return defineExecutionTarget({
    id: "sandbox",
    kind: "sandbox",
    label: "Sandbox",
    operations: ["shell", "edit", "process", "git"],
  });
}

export function coreHostExecutionTarget(): ExecutionTarget {
  return defineExecutionTarget({
    id: "core-host",
    kind: "core-host",
    label: "Core Host",
    operations: ["shell", "edit", "process", "git"],
  });
}

export function computerNodeExecutionTarget(nodeId: string): ExecutionTarget {
  const normalizedNodeId = text(nodeId, "computer node id", 128);
  return defineExecutionTarget({
    id: `computer:${normalizedNodeId}`,
    kind: "computer-node",
    label: `Computer Node ${normalizedNodeId}`,
    computerNodeId: normalizedNodeId,
    operations: ["shell", "edit", "process", "git"],
  });
}

export function normalizeExecutionTargetPolicy(input: Partial<ExecutionTargetPolicy> = {}): ExecutionTargetPolicy {
  const defaultTargetId = targetId(input.defaultTargetId ?? "sandbox");
  const allowedTargetIds = Object.freeze(
    [...new Set((input.allowedTargetIds ?? [defaultTargetId]).map(targetId))],
  );
  if (!allowedTargetIds.includes(defaultTargetId)) {
    throw new Error("default execution target must be included in allowedTargetIds");
  }
  return Object.freeze({
    defaultTargetId,
    allowedTargetIds,
    requireWorktreeForWrites: input.requireWorktreeForWrites !== false,
    allowCoreHostWrites: input.allowCoreHostWrites === true,
  });
}

export function resolveExecutionTarget(
  targets: readonly ExecutionTarget[],
  policyInput: Partial<ExecutionTargetPolicy>,
  request: ExecutionTargetRequest,
): ExecutionTargetResolution {
  const policy = normalizeExecutionTargetPolicy(policyInput);
  const requestedTargetId = targetId(request.requestedTargetId ?? policy.defaultTargetId);
  if (!policy.allowedTargetIds.includes(requestedTargetId)) {
    throw new Error(`execution target is not allowed by project policy: ${requestedTargetId}`);
  }
  const target = targets.find((candidate) => candidate.id === requestedTargetId);
  if (!target) throw new Error(`execution target is unavailable: ${requestedTargetId}`);
  if (!target.operations.includes(request.operation)) {
    throw new Error(`execution target ${requestedTargetId} does not support ${request.operation}`);
  }
  if (request.access !== "read" && request.access !== "write") {
    throw new Error(`unsupported execution access: ${String(request.access)}`);
  }
  if (request.access === "write" && target.kind === "core-host" && !policy.allowCoreHostWrites) {
    throw new Error("project policy denies direct Core Host writes");
  }
  return Object.freeze({
    target,
    operation: request.operation,
    access: request.access,
    requiresWorktree: request.access === "write" && policy.requireWorktreeForWrites,
  });
}
