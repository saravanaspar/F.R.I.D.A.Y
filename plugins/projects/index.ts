import { createHash, randomUUID } from "node:crypto";
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
import { definePlugin, type PluginContext } from "../capabilities/protocol.js";
import { ARTIFACTS_CAPABILITY, type ArtifactService } from "../artifacts/contract.js";
import { EVENTS_CAPABILITY, type EventsService } from "../events/contract.js";
import { PERMISSIONS_CAPABILITY, type PermissionsService } from "../permissions/contract.js";
import { TOOLS_CAPABILITY, type ToolsService } from "../tools/contract.js";
import {
  AGENT_PROMPT_SECTION_CONTRIBUTION,
  AGENT_TOOL_CONTRIBUTION,
  type AgentExtensionJsonValue,
  type AgentToolExecutionContext,
} from "../turn-loop/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION, type SystemJsonObject, type SystemJsonValue } from "../system/contract.js";
import { WORKTREES_CAPABILITY, type WorktreesService } from "../worktrees/contract.js";
import {
  PROJECTS_CAPABILITY,
  type Project,
  type ProjectComputerAdmission,
  type ProjectCreateInput,
  type ProjectPolicy,
  type ProjectRepositoryMetadata,
  type ProjectValidationCommands,
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
  readonly artifacts?: ArtifactService | undefined;
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

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function computerAdmission(value: unknown): ProjectComputerAdmission | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("policy.computerAdmission must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.requireBrowser !== undefined && typeof raw.requireBrowser !== "boolean") throw new Error("policy.computerAdmission.requireBrowser must be a boolean");
  if (raw.gpu !== undefined && typeof raw.gpu !== "boolean") throw new Error("policy.computerAdmission.gpu must be a boolean");
  return Object.freeze({
    ...(raw.requireBrowser === undefined ? {} : { requireBrowser: raw.requireBrowser }),
    ...(raw.memoryMb === undefined ? {} : { memoryMb: nonNegativeNumber(raw.memoryMb, "policy.computerAdmission.memoryMb") }),
    ...(raw.browserRenderers === undefined ? {} : { browserRenderers: nonNegativeInteger(raw.browserRenderers, "policy.computerAdmission.browserRenderers") }),
    ...(raw.gpu === undefined ? {} : { gpu: raw.gpu }),
  });
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

function validationCommands(value: unknown): ProjectValidationCommands {
  if (value === undefined || value === null) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("validation must be an object");
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    ...(raw.test === undefined ? {} : { test: text(raw.test, "validation.test", 4_096) }),
    ...(raw.build === undefined ? {} : { build: text(raw.build, "validation.build", 4_096) }),
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
  const normalizedComputerAdmission = computerAdmission(raw.computerAdmission);
  return Object.freeze({
    ...normalized,
    ...(raw.worktreeRoot === undefined ? {} : { worktreeRoot: absolutePath(raw.worktreeRoot, "policy.worktreeRoot") }),
    ...(normalizedComputerAdmission === undefined ? {} : { computerAdmission: normalizedComputerAdmission }),
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
    validation: validationCommands(raw.validation),
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
    validation: validationCommands(input.validation),
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

function codingOwnerName(projectIdValue: string, ownerId: string): string {
  const digest = createHash("sha256").update(`${projectIdValue}:${ownerId}`).digest("hex").slice(0, 20);
  return `job-${digest}`;
}

function boundedPatchPreview(patch: string, maximum = 12_000): string {
  if (patch.length <= maximum) return patch;
  return `${patch.slice(0, maximum)}\n\n[diff truncated; use the artifact reference for the complete patch]`;
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
        validation: input.validation === null ? undefined : (input.validation ?? current.validation),
        policy: input.policy === undefined ? current.policy : {
          ...current.policy,
          ...input.policy,
          ...(input.policy.computerAdmission === undefined ? {} : {
            computerAdmission: { ...current.policy.computerAdmission, ...input.policy.computerAdmission },
          }),
        },
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
    async acquireAgentWorkspace(input) {
      const project = requireProject(projects, input.projectId);
      const plan = await service.resolveExecution({
        projectId: project.id,
        operation: "shell",
        access: "write",
        ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      });
      if (!plan.requiresWorktree) {
        return Object.freeze({
          projectId: project.id,
          projectRoot: plan.projectRoot,
          workspacePath: plan.projectRoot,
          target: plan.target,
          isolated: false,
        });
      }
      if (project.repository?.kind !== "git") throw new Error("project write policy requires a Git repository for isolated worktrees");
      const owner = text(input.ownerId, "coding workspace owner", 160);
      const name = codingOwnerName(project.id, owner);
      const branch = `friday/${name}`;
      const root = safeWorktreeRoot(options.stateDir, project);
      const existing = (await options.worktrees.listWorktrees({ repository: project.rootPath, ...(input.signal === undefined ? {} : { signal: input.signal }) }))
        .find((entry) => entry.branch === branch && contained(root, entry.directory));
      const workspace = existing
        ? Object.freeze({
            projectId: project.id,
            target: plan.target,
            directory: resolve(existing.directory),
            baseCommit: existing.head ?? "unknown",
            branch,
          })
        : await service.createCodingWorkspace({
            projectId: project.id,
            targetId: plan.target.id,
            name,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
      await service.inspectCodingWorkspace(project.id, workspace.directory, input.signal);
      return Object.freeze({
        projectId: project.id,
        projectRoot: plan.projectRoot,
        workspacePath: workspace.directory,
        target: plan.target,
        isolated: true,
        worktree: workspace,
      });
    },
    async createCodingWorkspace(input) {
      const project = requireProject(projects, input.projectId);
      if (project.repository?.kind !== "git") throw new Error("coding workspaces require project.repository.kind=git");
      const plan = await service.resolveExecution({ projectId: project.id, operation: "edit", access: "write", ...(input.targetId === undefined ? {} : { targetId: input.targetId }) });
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
    async publishCodingWorkspaceDiff(projectIdInput, directory, signal) {
      const diff = await service.diffCodingWorkspace(projectIdInput, directory, signal);
      if (!options.artifacts || !diff.patch.trim()) return Object.freeze({ diff });
      const record = await options.artifacts.storeGenerated({
        fileName: `${diff.projectId}-worktree.patch`,
        mimeType: "text/x-diff",
        bytes: Buffer.from(diff.patch, "utf8"),
      });
      return Object.freeze({ diff, artifactRef: record.ref });
    },
    async commitCodingWorkspace(projectIdInput, directory, message, signal) {
      const project = requireProject(projects, projectIdInput);
      return options.worktrees.commitWorktree({ repository: project.rootPath, directory, message, ...(signal === undefined ? {} : { signal }) });
    },
    async promoteCodingWorkspace(projectIdInput, directory, strategy, signal) {
      const project = requireProject(projects, projectIdInput);
      const result = await options.worktrees.promoteWorktree({
        repository: project.rootPath,
        directory,
        strategy,
        ...(signal === undefined ? {} : { signal }),
      });
      options.events?.publish({
        type: "project.worktree.promoted",
        source: "projects",
        subject: `project:${project.id}`,
        data: { projectId: project.id, directory: result.directory, strategy, head: result.head, candidateHead: result.candidateHead },
      });
      return Object.freeze({ projectId: project.id, ...result });
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

function agentProjectContext(context: AgentToolExecutionContext | undefined): {
  projectId: string;
  workspace: string;
  target: ExecutionTarget;
} {
  if (!context?.projectId || !context.projectWorkspace || !context.projectExecutionTarget) {
    throw new Error("This tool requires an active Project turn");
  }
  return { projectId: context.projectId, workspace: context.projectWorkspace, target: context.projectExecutionTarget };
}

function toolResultText(result: { readonly content: readonly ({ readonly type: string; readonly text?: string | undefined })[] }): string {
  return result.content.flatMap((item) => item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n").trim();
}

async function runValidationCommand(
  tools: ToolsService,
  command: string,
  label: "test" | "build",
  context: AgentToolExecutionContext,
  signal?: AbortSignal,
): Promise<{ readonly label: string; readonly command: string; readonly output: string }> {
  const active = agentProjectContext(context);
  const bash = tools.createTool("bash", active.workspace, {
    ...(context.permissionMode === undefined ? {} : { permissionMode: context.permissionMode }),
    executionTarget: active.target,
    ...(context.computerExecution === undefined ? {} : { computer: context.computerExecution }),
  });
  const execute = bash.execute as unknown as (
    toolCallId: string,
    params: { readonly command: string; readonly network?: boolean },
    signal?: AbortSignal,
  ) => Promise<{ readonly content: readonly ({ readonly type: string; readonly text?: string | undefined })[] }>;
  const result = await execute(`projects-validation-${label}-${randomUUID()}`, { command, network: false }, signal);
  return Object.freeze({ label, command, output: toolResultText(result) });
}

function registerAgentProjectTools(
  ctx: PluginContext,
  service: ProjectsService,
  tools: ToolsService,
  permissions: PermissionsService,
): void {
  ctx.contribute(AGENT_PROMPT_SECTION_CONTRIBUTION, {
    id: "projects-active-project",
    render(context) {
      if (!context.projectId || !context.projectRoot || !context.projectWorkspace || !context.projectExecutionTarget) return undefined;
      const isolated = resolve(context.projectWorkspace) !== resolve(context.projectRoot);
      return [
        "<friday_project_context>",
        `Project: ${context.projectId}`,
        `Canonical root: ${context.projectRoot}`,
        `Active workspace: ${context.projectWorkspace}`,
        `Execution target: ${context.projectExecutionTarget.id} (${context.projectExecutionTarget.kind})`,
        `Isolated coding worktree: ${isolated ? "yes" : "no"}`,
        "Run shell/edit/process/IPython operations against the active workspace. Use project_validate for configured deterministic test/build commands, project_diff to inspect/publish the complete patch, and project_commit before requesting project_promote. Promotion mutates the canonical repository and always requires explicit authorization.",
        "</friday_project_context>",
      ].join("\n");
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "projects.diff",
    sourcePluginId: "projects",
    name: "project_diff",
    label: "Project diff",
    description: "Inspect the active Project worktree diff and persist the complete patch as an artifact when artifact storage is available.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    async execute(_input, signal, executionContext) {
      const active = agentProjectContext(executionContext);
      const project = service.get(active.projectId);
      if (!project) throw new Error(`project not found: ${active.projectId}`);
      if (resolve(active.workspace) === resolve(project.rootPath)) {
        throw new Error("The active Project is not using an isolated coding worktree");
      }
      const report = await service.publishCodingWorkspaceDiff(active.projectId, active.workspace, signal);
      const preview = boundedPatchPreview(report.diff.patch);
      return {
        output: {
          projectId: active.projectId,
          directory: report.diff.directory,
          status: report.diff.status,
          patch: preview || "(no diff)",
          ...(report.artifactRef === undefined ? {} : { artifactRef: report.artifactRef }),
        } as AgentExtensionJsonValue,
      };
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "projects.validate",
    sourcePluginId: "projects",
    name: "project_validate",
    label: "Validate Project",
    description: "Run the active Project's server-configured deterministic test and build commands through its resolved Execution Target.",
    parameters: Object.freeze({
      type: "object",
      properties: { step: { type: "string", enum: ["all", "test", "build"] } },
      additionalProperties: false,
    }),
    async execute(input, signal, executionContext) {
      if (!executionContext) throw new Error("project_validate requires Agent execution context");
      const active = agentProjectContext(executionContext);
      const project = service.get(active.projectId);
      if (!project) throw new Error(`project not found: ${active.projectId}`);
      const step = input.step === undefined ? "all" : input.step;
      if (step !== "all" && step !== "test" && step !== "build") throw new Error("step must be all, test, or build");
      const commands: Array<{ label: "test" | "build"; command: string }> = [];
      if ((step === "all" || step === "test") && project.validation.test) commands.push({ label: "test", command: project.validation.test });
      if ((step === "all" || step === "build") && project.validation.build) commands.push({ label: "build", command: project.validation.build });
      if (commands.length === 0) throw new Error(`Project ${project.id} has no configured ${step === "all" ? "test/build" : step} validation command`);
      const results: Array<{ readonly label: string; readonly command: string; readonly output: string }> = [];
      for (const entry of commands) results.push(await runValidationCommand(tools, entry.command, entry.label, executionContext, signal));
      return { output: { projectId: project.id, workspace: active.workspace, targetId: active.target.id, steps: results } as unknown as AgentExtensionJsonValue };
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "projects.commit",
    sourcePluginId: "projects",
    name: "project_commit",
    label: "Commit Project worktree",
    description: "Commit all changes in the active isolated Project worktree using FRIDAY's trusted Worktrees capability.",
    parameters: Object.freeze({
      type: "object",
      properties: { message: { type: "string", minLength: 1, maxLength: 4096 } },
      required: ["message"],
      additionalProperties: false,
    }),
    async execute(input, signal, executionContext) {
      const active = agentProjectContext(executionContext);
      const project = service.get(active.projectId);
      if (!project) throw new Error(`project not found: ${active.projectId}`);
      if (resolve(active.workspace) === resolve(project.rootPath)) throw new Error("project_commit requires an isolated coding worktree");
      const result = await service.commitCodingWorkspace(project.id, active.workspace, text(input.message, "message", 4_096), signal);
      return { output: { projectId: project.id, ...result } as unknown as AgentExtensionJsonValue };
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "projects.promote",
    sourcePluginId: "projects",
    name: "project_promote",
    label: "Promote Project worktree",
    description: "After review and commit, merge or cherry-pick the active isolated worktree into the canonical Project repository. This always requires authorization.",
    parameters: Object.freeze({
      type: "object",
      properties: { strategy: { type: "string", enum: ["merge", "cherry-pick"] } },
      required: ["strategy"],
      additionalProperties: false,
    }),
    async execute(input, signal, executionContext) {
      if (!executionContext) throw new Error("project_promote requires Agent execution context");
      const active = agentProjectContext(executionContext);
      const project = service.get(active.projectId);
      if (!project) throw new Error(`project not found: ${active.projectId}`);
      if (resolve(active.workspace) === resolve(project.rootPath)) throw new Error("project_promote requires an isolated coding worktree");
      const strategy = input.strategy;
      if (strategy !== "merge" && strategy !== "cherry-pick") throw new Error("strategy must be merge or cherry-pick");
      await permissions.authorize({
        mode: executionContext.permissionMode ?? permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: project.rootPath,
        access: "write",
        action: {
          id: "projects.worktree.promote",
          effect: "workspace-write",
          resource: project.rootPath,
          network: false,
        },
        reason: `${strategy} approved Project worktree ${active.workspace} into ${project.rootPath}`,
        ...(executionContext.jobId === undefined ? {} : { jobId: executionContext.jobId }),
      });
      const result = await service.promoteCodingWorkspace(project.id, active.workspace, strategy, signal);
      return { output: result as unknown as AgentExtensionJsonValue };
    },
  });
}

const projectsPlugin: FridayPlugin = definePlugin({
  id: "projects",
  requires: [EVENTS_CAPABILITY, WORKTREES_CAPABILITY],
  optional: [ARTIFACTS_CAPABILITY, TOOLS_CAPABILITY, PERMISSIONS_CAPABILITY],
  provides: [PROJECTS_CAPABILITY],
}, async (ctx) => {
  const tools = ctx.services.optional(TOOLS_CAPABILITY);
  const permissions = ctx.services.optional(PERMISSIONS_CAPABILITY);
  const service = await createProjectsService({
    worktrees: ctx.services.require(WORKTREES_CAPABILITY),
    events: ctx.services.require(EVENTS_CAPABILITY),
    artifacts: ctx.services.optional(ARTIFACTS_CAPABILITY),
  });
  ctx.services.provide(PROJECTS_CAPABILITY, service);
  if (tools && permissions) registerAgentProjectTools(ctx, service, tools, permissions);

  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, { id: "projects", label: "Projects", snapshot: () => ({ count: service.list().length }) });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "projects.list", label: "List projects", description: "List server-owned Projects and their execution policies.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission: () => actionPermission("projects.list", "projects", false),
    execute: async () => service.list() as unknown as SystemJsonValue,
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "projects.create", label: "Create project", description: "Register a server-owned Project root and execution policy.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        rootPath: { type: "string" },
        repositoryKind: { type: "string", enum: ["git"] },
        defaultTargetId: { type: "string" },
        computerRequireBrowser: { type: "boolean" },
        computerMemoryMb: { type: "number", minimum: 0 },
        computerBrowserRenderers: { type: "integer", minimum: 0 },
        computerGpu: { type: "boolean" },
        testCommand: { type: "string" },
        buildCommand: { type: "string" },
      },
      required: ["name", "rootPath"],
      additionalProperties: false,
    }),
    permission: (input) => actionPermission("projects.create", `project:${String(input.id ?? input.name ?? "new")}`, true),
    execute: async (input) => service.create({
      ...(typeof input.id === "string" ? { id: input.id } : {}),
      name: requiredString(input, "name", 160),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      rootPath: requiredString(input, "rootPath"),
      ...(input.repositoryKind === "git" ? { repository: { kind: "git" as const } } : {}),
      ...((typeof input.testCommand === "string" || typeof input.buildCommand === "string") ? {
        validation: {
          ...(typeof input.testCommand === "string" ? { test: input.testCommand } : {}),
          ...(typeof input.buildCommand === "string" ? { build: input.buildCommand } : {}),
        },
      } : {}),
      ...((typeof input.defaultTargetId === "string"
        || typeof input.computerRequireBrowser === "boolean"
        || typeof input.computerMemoryMb === "number"
        || typeof input.computerBrowserRenderers === "number"
        || typeof input.computerGpu === "boolean") ? {
        policy: {
          ...(typeof input.defaultTargetId === "string" ? { defaultTargetId: input.defaultTargetId, allowedTargetIds: [input.defaultTargetId] } : {}),
          ...((typeof input.computerRequireBrowser === "boolean"
            || typeof input.computerMemoryMb === "number"
            || typeof input.computerBrowserRenderers === "number"
            || typeof input.computerGpu === "boolean") ? {
            computerAdmission: {
              ...(typeof input.computerRequireBrowser === "boolean" ? { requireBrowser: input.computerRequireBrowser } : {}),
              ...(typeof input.computerMemoryMb === "number" ? { memoryMb: input.computerMemoryMb } : {}),
              ...(typeof input.computerBrowserRenderers === "number" ? { browserRenderers: input.computerBrowserRenderers } : {}),
              ...(typeof input.computerGpu === "boolean" ? { gpu: input.computerGpu } : {}),
            },
          } : {}),
        },
      } : {}),
    }) as unknown as SystemJsonValue,
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "projects.resolve-target", label: "Resolve project execution target", description: "Resolve one Project operation to its allowed execution target without executing it.",
    parameters: Object.freeze({ type: "object", properties: { projectId: { type: "string" }, operation: { type: "string", enum: ["shell", "edit", "process", "git"] }, access: { type: "string", enum: ["read", "write"] }, targetId: { type: "string" } }, required: ["projectId", "operation", "access"], additionalProperties: false }),
    permission: (input) => actionPermission("projects.resolve-target", `project:${String(input.projectId ?? "unknown")}`, false),
    execute: async (input) => service.resolveExecution({ projectId: requiredString(input, "projectId", 96), operation: requiredString(input, "operation", 32) as "shell" | "edit" | "process" | "git", access: requiredString(input, "access", 16) as "read" | "write", ...(typeof input.targetId === "string" ? { targetId: input.targetId } : {}) }) as unknown as SystemJsonValue,
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "projects.promote-worktree",
    label: "Promote Project worktree",
    description: "Merge or cherry-pick one committed isolated Project worktree into its clean canonical repository after authorization.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        projectId: { type: "string" },
        directory: { type: "string" },
        strategy: { type: "string", enum: ["merge", "cherry-pick"] },
      },
      required: ["projectId", "directory", "strategy"],
      additionalProperties: false,
    }),
    permission: (input) => actionPermission("projects.promote-worktree", `project:${String(input.projectId ?? "unknown")}`, true),
    execute: async (input, context) => {
      const strategy = requiredString(input, "strategy", 32);
      if (strategy !== "merge" && strategy !== "cherry-pick") throw new Error("strategy must be merge or cherry-pick");
      return service.promoteCodingWorkspace(
        requiredString(input, "projectId", 96),
        requiredString(input, "directory", 4_096),
        strategy,
        context.signal,
      ) as unknown as SystemJsonValue;
    },
  });
});

export default projectsPlugin;
export * from "./contract.js";
