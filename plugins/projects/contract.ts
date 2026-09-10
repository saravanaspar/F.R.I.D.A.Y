import type {
  ExecutionAccess,
  ExecutionOperation,
  ExecutionTarget,
  ExecutionTargetPolicy,
  ExecutionTargetResolution,
} from "@friday/execution-targets";
import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export interface ProjectRepositoryMetadata {
  readonly kind: "git";
  readonly defaultBranch?: string | undefined;
  readonly remote?: string | undefined;
}

export interface ProjectPolicy extends ExecutionTargetPolicy {
  /** Optional host path for isolated worktrees. Defaults under FRIDAY state. */
  readonly worktreeRoot?: string | undefined;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly rootPath: string;
  readonly preferredComputerNodeId?: string | undefined;
  readonly repository?: ProjectRepositoryMetadata | undefined;
  readonly policy: ProjectPolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectCreateInput {
  readonly id?: string | undefined;
  readonly name: string;
  readonly description?: string | undefined;
  readonly rootPath: string;
  readonly preferredComputerNodeId?: string | undefined;
  readonly repository?: ProjectRepositoryMetadata | undefined;
  readonly policy?: Partial<ProjectPolicy> | undefined;
}

export interface ProjectUpdateInput {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly rootPath?: string | undefined;
  readonly preferredComputerNodeId?: string | null | undefined;
  readonly repository?: ProjectRepositoryMetadata | null | undefined;
  readonly policy?: Partial<ProjectPolicy> | undefined;
}

export interface ProjectExecutionRequest {
  readonly projectId: string;
  readonly operation: ExecutionOperation;
  readonly access: ExecutionAccess;
  readonly targetId?: string | undefined;
}

export interface ProjectExecutionPlan extends ExecutionTargetResolution {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly workspacePath: string;
}

export interface ProjectCodingWorkspace {
  readonly projectId: string;
  readonly target: ExecutionTarget;
  readonly directory: string;
  readonly baseCommit: string;
  readonly branch?: string | undefined;
}

export interface ProjectCodingWorkspaceDiff {
  readonly projectId: string;
  readonly directory: string;
  readonly patch: string;
  readonly status: string;
}

export interface ProjectsService {
  create(input: ProjectCreateInput): Promise<Project>;
  get(id: string): Project | undefined;
  list(): readonly Project[];
  update(id: string, input: ProjectUpdateInput): Promise<Project>;
  remove(id: string): Promise<boolean>;
  availableTargets(projectId: string): readonly ExecutionTarget[];
  resolveExecution(request: ProjectExecutionRequest): Promise<ProjectExecutionPlan>;
  createCodingWorkspace(input: {
    readonly projectId: string;
    readonly targetId?: string | undefined;
    readonly name?: string | undefined;
    readonly baseRef?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<ProjectCodingWorkspace>;
  inspectCodingWorkspace(projectId: string, directory: string, signal?: AbortSignal): Promise<{
    readonly directory: string;
    readonly head: string;
    readonly branch?: string | undefined;
    readonly clean: boolean;
  }>;
  diffCodingWorkspace(projectId: string, directory: string, signal?: AbortSignal): Promise<ProjectCodingWorkspaceDiff>;
  commitCodingWorkspace(projectId: string, directory: string, message: string, signal?: AbortSignal): Promise<{
    readonly directory: string;
    readonly commit: string;
    readonly changed: boolean;
  }>;
  removeCodingWorkspace(projectId: string, directory: string, options?: {
    readonly force?: boolean | undefined;
    readonly deleteBranch?: boolean | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<boolean>;
}

export const PROJECTS_CAPABILITY: Capability<ProjectsService> =
  defineCapability<ProjectsService>("projects");
