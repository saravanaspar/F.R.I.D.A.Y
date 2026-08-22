import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type SandboxKind = "podman" | "unavailable";
export type SandboxWorkspaceAccess = "read" | "write";
export type SandboxNetworkMode = "unrestricted" | "requested";

export interface SandboxResourceLimits {
  readonly memory: string;
  readonly memorySwap: string;
  readonly cpus: number;
  readonly pids: number;
  readonly openFiles: number;
  readonly fileSizeBytes: number;
  readonly tempSize: string;
}

export interface SandboxShellRequest {
  command: string;
  cwd: string;
  workspace: string;
  access: SandboxWorkspaceAccess;
  network: boolean;
  env: NodeJS.ProcessEnv;
}

export interface SandboxShellContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SandboxKernelRequest {
  python: string;
  connectionPath: string;
  tempDir: string;
  cwd: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

export interface SandboxKernelContext {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SandboxProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  workspace: string;
  access: SandboxWorkspaceAccess;
  network: boolean;
  env: NodeJS.ProcessEnv;
  interactive?: boolean | undefined;
  managed?: { readonly id: string; readonly runId: string } | undefined;
}

export interface SandboxProcessContext {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SandboxService {
  readonly sandboxKind: SandboxKind;
  readonly image: string;
  readonly unavailableReason?: string | undefined;
  readonly networkMode?: SandboxNetworkMode | undefined;
  readonly limits?: SandboxResourceLimits | undefined;
  assertAvailable(): void;
  registerTrustedReadOnlyMount(workspace: string, source: string, target?: string): () => void;
  sandboxShell(request: SandboxShellRequest): SandboxShellContext;
  sandboxProcess(request: SandboxProcessRequest): SandboxProcessContext;
  sandboxKernel(request: SandboxKernelRequest): SandboxKernelContext;
  cleanupManagedProcess?(id: string): void;
  cleanupStaleManagedProcesses?(): void;
}

export function sandboxNetworkEnabled(service: SandboxService, requested = false): boolean {
  return service.networkMode === "unrestricted" || requested;
}

export const SANDBOX_CAPABILITY: Capability<SandboxService> =
  defineCapability<SandboxService>("sandbox");
