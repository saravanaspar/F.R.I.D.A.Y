import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  computerNodeExecutionTarget,
  coreHostExecutionTarget,
  normalizeExecutionTargetPolicy,
  resolveExecutionTarget,
  sandboxExecutionTarget,
  type ExecutionTarget,
} from "@friday/execution-targets";
import { reportOperationalError } from "@friday/operational-errors";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EVENTS_CAPABILITY, type EventsService } from "../events/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION, type SystemJsonObject, type SystemJsonValue } from "../system/contract.js";
import { WORKTREES_CAPABILITY, type WorktreesService } from "../worktrees/contract.js";
import {
  PROJECTS_CAPABILITY,
  type Project,
  type ProjectCreateInput,
  type ProjectPolicy,
  type ProjectRepositoryMetadata,
  type ProjectsService,
  type ProjectUpdateInput,
} from "./contract.js";

const MAX_PROJECTS = 256;
const MAX_DESCRIPTION = 4_000;

interface ProjectState {
  readonly schema: 1;
  readonly projects: readonly Project[];
}

export interface ProjectsServiceOptions {
  readonly stateDir?: string | undefined;
  readonly worktrees: WorktreesService;
  readonly events?: EventsService | undefined;
}

function stateRoot(override?: string): string {
  const configured = override?.trim() || process.env.FRIDAY_STATE_DIR?.trim() || process.env.FRIDAY_HOME?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "projects");
}

function statePath(override?: string): string {
  return join(stateRoot(override), "projects.json");
}

function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").replaceAll("\u0000", "�").trim();
  if (!normalized || normalized.length > maximum || /[\u0001-\u001f\u007f]/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function freeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").replaceAll("\u0000", "�").trim();
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return normalized;
}

function projectId(value: unknown): string {
  const normalized = text(value, "project id", 96).toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized)) throw new Error("project id must use lowercase kebab-case");
  return normalized;
}

function optionalText(value: unknown, label: string, maximum = 256): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, label, maximum);
}

function absolutePath(value: unknown, label: string): string {
  const path = text(value, label, 4_096);
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  return resolve(path);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function repository(value: unknown): ProjectRepositoryMetadata | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("repository must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "git") throw new Error("repository.kind must be git");
  return Object.freeze({
    kind: "git" as const,
    ...(raw.defaultBranch === undefined ? {} : { defaultBranch: text(raw.defaultBranch, "repository.defaultBranch", 256) }),
    ...(raw.remote === undefined ? {} : { remote: text(raw.remote, "repository.remote", 2_048) }),
  });
}

function policy(value: unknown): ProjectPolicy {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("project policy must be an object");
  const raw = (value ?? {}) as Record<string, unknown>;
  const normalized = normalizeExecutionTargetPolicy({
    ...(raw.defaultTargetId === undefined ? {} : { defaultTargetId: text(raw.defaultTargetId, "policy.defaultTargetId", 128) }),
    ...(raw.allowedTargetIds === undefined ? {} : {
      allowedTargetIds: Array.isArray(raw.allowedTargetIds)
        ? raw.allowedTargetIds.map((item) => text(item, "policy.allowedTargetIds item", 128))
        : (() => { throw new Error("policy.allowedTargetIds must be an array"); })(),
    }),
    ...(raw.requireWorktreeForWrites === undefined ? {} : { requireWorktreeForWrites: booleanValue(raw.requireWorktreeForWrites, "policy.requireWorktreeForWrites") }),
    ...(raw.allowCoreHostWrites === undefined ? {} : { allowCoreHostWrites: booleanValue(raw.allowCoreHostWrites, "policy.allowCoreHostWrites") }),
  });
  return Object.freeze({
    ...normalized,
    ...(raw.worktreeRoot === undefined ? {} : { worktreeRoot: absolutePath(raw.worktreeRoot, "policy.worktreeRoot") }),
  });
}

function parseProject(value: unknown): Project {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid project record");
  const raw = value as Record<string, unknown>;
  const parsedRepository = repository(raw.repository);
  return Object.freeze({
    id: projectId(raw.id),
    name: text(raw.name, "project name", 160),
    description: freeText(raw.description ?? "", "project description", MAX_DESCRIPTION),
    rootPath: absolutePath(raw.rootPath, "project rootPath"),
    ...(raw.preferredComputerNodeId === undefined ? {} : { preferredComputerNodeId: optionalText(raw.preferredComputerNodeId, "preferredComputerNodeId", 128) }),
    ...(parsedRepository === undefined ? {} : { repository: parsedRepository }),
    policy: policy(raw.policy),
    createdAt: text(raw.createdAt, "createdAt", 64),
    updatedAt: text(raw.updatedAt, "updatedAt", 64),
  });
}

async function canonicalProjectRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("project rootPath must be an absolute path");
  const resolved = resolve(path);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("project rootPath must be a real directory, not a symlink");
  return realpath(resolved);
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || rel === "." || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function overlaps(left: string, right: string): boolean {
  return contained(left, right) || contained(right, left);
}

async function privateStateRoot(override: string | undefined, create: boolean): Promise<void> {
  const root = stateRoot(override);
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("project state directory must be private");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
  }
}

async function readState(override?: string): Promise<readonly Project[]> {
  await privateStateRoot(override, false);
  try {
    const file = statePath(override);
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) throw new Error("project state file must be private");
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid project state");
    const raw = parsed as Record<string, unknown>;
    if (raw.schema !== 1 || !Array.isArray(raw.projects)) throw new Error("unsupported project state");
    if (raw.projects.length > MAX_PROJECTS) throw new Error("project state exceeds project limit");
    return Object.freeze(raw.projects.map(parseProject));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
}

async function writeState(override: string | undefined, projects: readonly Project[]): Promise<void> {
  await privateStateRoot(override, true);
  const target = statePath(override);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const state: ProjectState = { schema: 1, projects };
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        reportOperationalError({ component: "projects", operation: "remove temporary project state file", error, severity: "warn" });
      }
    });
  }
}

async function normalizeInput(input: ProjectCreateInput, existing?: Project): Promise<Project> {
  const id = existing?.id ?? projectId(input.id ?? input.name);
  const now = new Date().toISOString();
  const rootPath = await canonicalProjectRoot(input.rootPath);
  const projectPolicy = policy(input.policy);
  if (projectPolicy.worktreeRoot && overlaps(rootPath, projectPolicy.worktreeRoot)) {
    throw new Error("project worktreeRoot must be disjoint from the canonical project root");
  }
  const parsedRepository = repository(input.repository);
  return Object.freeze({
    id,
    name: text(input.name, "project name", 160),
    description: freeText(input.description ?? "", "project description", MAX_DESCRIPTION),
    rootPath,
    ...(input.preferredComputerNodeId === undefined ? {} : { preferredComputerNodeId: optionalText(input.preferredComputerNodeId, "preferredComputerNodeId", 128) }),
    ...(parsedRepository === undefined ? {} : { repository: parsedRepository }),
    policy: projectPolicy,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

function targetsFor(project: Project): readonly ExecutionTarget[] {
  return Object.freeze([
    sandboxExecutionTarget(),
    coreHostExecutionTarget(),
    ...(project.preferredComputerNodeId ? [computerNodeExecutionTarget(project.preferredComputerNodeId)] : []),
  ]);
}

function requireProject(projects: readonly Project[], id: string): Project {
  const normalized = projectId(id);
  const project = projects.find((entry) => entry.id === normalized);
  if (!project) throw new Error(`project not found: ${normalized}`);
  return project;
}

function safeWorktreeRoot(stateDir: string | undefined, project: Project): string {
  const root = project.policy.worktreeRoot ?? join(stateRoot(stateDir), "worktrees", project.id);
  if (!isAbsolute(root)) throw new Error("project worktreeRoot must be absolute");
  if (overlaps(project.rootPath, root)) throw new Error("project worktreeRoot must be disjoint from the canonical project root");
  return resolve(root);
}

export async function createProjectsService(options: ProjectsServiceOptions): Promise<ProjectsService> {
  let projects: readonly Project[] = await readState(options.stateDir);
  let mutationTail: Promise<void> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const persist = async (next: readonly Project[]): Promise<void> => {
    await writeState(options.stateDir, next);
    projects = Object.freeze([...next]);
  };
  const publish = (type: string, project: Project): void => {
    options.events?.publish({ type, source: "projects", subject: `project:${project.id}`, data: { projectId: project.id, rootPath: project.rootPath } });
  };

  const service: ProjectsService = {
    create: (input) => serialize(async () => {
      if (projects.length >= MAX_PROJECTS) throw new Error("project limit reached");
      const created = await normalizeInput(input);
      if (projects.some((project) => project.id === created.id)) throw new Error(`project already exists: ${created.id}`);
      if (projects.some((project) => project.rootPath === created.rootPath)) throw new Error("project rootPath is already registered");
      await persist([...projects, created]);
      publish("project.created", created);
      return created;
    }),
    get: (id) => projects.find((project) => project.id === projectId(id)),
    list: () => Object.freeze([...projects]),
    update: (id, input) => serialize(async () => {
      const current = requireProject(projects, id);
      const merged: ProjectCreateInput = {
        id: current.id,
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        rootPath: input.rootPath ?? current.rootPath,
        preferredComputerNodeId: input.preferredComputerNodeId === null ? undefined : (input.preferredComputerNodeId ?? current.preferredComputerNodeId),
        repository: input.repository === null ? undefined : (input.repository ?? current.repository),
        policy: input.policy === undefined ? current.policy : { ...current.policy, ...input.policy },
      };
      const updated = await normalizeInput(merged, current);
      if (projects.some((project) => project.id !== current.id && project.rootPath === updated.rootPath)) throw new Error("project rootPath is already registered");
      await persist(projects.map((project) => project.id === current.id ? updated : project));
      publish("project.updated", updated);
      return updated;
    }),
    remove: (id) => serialize(async () => {
      const normalized = projectId(id);
      const current = projects.find((project) => project.id === normalized);
      if (!current) return false;
      await persist(projects.filter((project) => project.id !== normalized));
      publish("project.removed", current);
      return true;
    }),
    availableTargets: (projectIdInput) => targetsFor(requireProject(projects, projectIdInput)),
    async resolveExecution(request) {
      const project = requireProject(projects, request.projectId);
      const rootPath = await canonicalProjectRoot(project.rootPath);
      const resolved = resolveExecutionTarget(targetsFor(project), project.policy, {
        operation: request.operation,
        access: request.access,
        ...(request.targetId === undefined ? {} : { requestedTargetId: request.targetId }),
      });
      return Object.freeze({ ...resolved, projectId: project.id, projectRoot: rootPath, workspacePath: rootPath });
    },
    async createCodingWorkspace(input) {
      const project = requireProject(projects, input.projectId);
      if (project.repository?.kind !== "git") throw new Error("coding workspaces require project.repository.kind=git");
      const plan = await service.resolveExecution({ projectId: project.id, operation: "edit", access: "write", ...(input.targetId === undefined ? {} : { targetId: input.targetId }) });
      if (plan.target.kind === "computer-node") throw new Error("Computer Node execution becomes available in Phase 4; select sandbox or core-host for this Phase 3 workspace");
      const info = await options.worktrees.createWorktree({
        repository: project.rootPath,
        root: safeWorktreeRoot(options.stateDir, project),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return Object.freeze({ projectId: project.id, target: plan.target, directory: info.directory, baseCommit: info.baseCommit, ...(info.branch === undefined ? {} : { branch: info.branch }) });
    },
    async inspectCodingWorkspace(projectIdInput, directory, signal) {
      const project = requireProject(projects, projectIdInput);
      return options.worktrees.inspectWorktree({ repository: project.rootPath, directory, ...(signal === undefined ? {} : { signal }) });
    },
    async diffCodingWorkspace(projectIdInput, directory, signal) {
      const project = requireProject(projects, projectIdInput);
      const diff = await options.worktrees.diffWorktree({ repository: project.rootPath, directory, ...(signal === undefined ? {} : { signal }) });
      return Object.freeze({ projectId: project.id, directory: diff.directory, patch: diff.patch, status: diff.status });
    },
    async commitCodingWorkspace(projectIdInput, directory, message, signal) {
      const project = requireProject(projects, projectIdInput);
      return options.worktrees.commitWorktree({ repository: project.rootPath, directory, message, ...(signal === undefined ? {} : { signal }) });
    },
    async removeCodingWorkspace(projectIdInput, directory, removeOptions = {}) {
      const project = requireProject(projects, projectIdInput);
      return options.worktrees.removeWorktree({ repository: project.rootPath, directory, ...(removeOptions.force === undefined ? {} : { force: removeOptions.force }), ...(removeOptions.deleteBranch === undefined ? {} : { deleteBranch: removeOptions.deleteBranch }), ...(removeOptions.signal === undefined ? {} : { signal: removeOptions.signal }) });
    },
  };
  return Object.freeze(service);
}

function requiredString(input: Readonly<SystemJsonObject>, key: string, maximum = 4_096): string {
  return text(input[key], key, maximum);
}

function actionPermission(id: string, resource: string, write: boolean) {
  return { id, effect: write ? "system-write" as const : "global-operational-read" as const, resource, network: false };
}

const projectsPlugin: FridayPlugin = definePlugin({
  id: "projects",
  requires: [EVENTS_CAPABILITY, WORKTREES_CAPABILITY],
  provides: [PROJECTS_CAPABILITY],
}, async (ctx) => {
  const service = await createProjectsService({ worktrees: ctx.services.require(WORKTREES_CAPABILITY), events: ctx.services.require(EVENTS_CAPABILITY) });
  ctx.services.provide(PROJECTS_CAPABILITY, service);
  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, { id: "projects", label: "Projects", snapshot: () => ({ count: service.list().length }) });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "projects.list", label: "List projects", description: "List server-owned Projects and their execution policies.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission: () => actionPermission("projects.list", "projects", false),
    execute: async () => service.list() as unknown as SystemJsonValue,
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "projects.create", label: "Create project", description: "Register a server-owned Project root and execution policy.",
    parameters: Object.freeze({ type: "object", properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, rootPath: { type: "string" }, repositoryKind: { type: "string", enum: ["git"] }, defaultTargetId: { type: "string" } }, required: ["name", "rootPath"], additionalProperties: false }),
    permission: (input) => actionPermission("projects.create", `project:${String(input.id ?? input.name ?? "new")}`, true),
    execute: async (input) => service.create({
      ...(typeof input.id === "string" ? { id: input.id } : {}), name: requiredString(input, "name", 160),
      ...(typeof input.description === "string" ? { description: input.description } : {}), rootPath: requiredString(input, "rootPath"),
      ...(input.repositoryKind === "git" ? { repository: { kind: "git" as const } } : {}),
      ...(typeof input.defaultTargetId === "string" ? { policy: { defaultTargetId: input.defaultTargetId, allowedTargetIds: [input.defaultTargetId] } } : {}),
    }) as unknown as SystemJsonValue,
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "projects.resolve-target", label: "Resolve project execution target", description: "Resolve one Project operation to its allowed execution target without executing it.",
    parameters: Object.freeze({ type: "object", properties: { projectId: { type: "string" }, operation: { type: "string", enum: ["shell", "edit", "process", "git"] }, access: { type: "string", enum: ["read", "write"] }, targetId: { type: "string" } }, required: ["projectId", "operation", "access"], additionalProperties: false }),
    permission: (input) => actionPermission("projects.resolve-target", `project:${String(input.projectId ?? "unknown")}`, false),
    execute: async (input) => service.resolveExecution({ projectId: requiredString(input, "projectId", 96), operation: requiredString(input, "operation", 32) as "shell" | "edit" | "process" | "git", access: requiredString(input, "access", 16) as "read" | "write", ...(typeof input.targetId === "string" ? { targetId: input.targetId } : {}) }) as unknown as SystemJsonValue,
  });
});

export default projectsPlugin;
export * from "./contract.js";
