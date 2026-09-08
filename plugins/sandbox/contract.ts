import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type SandboxWorkspaceAccess = "read" | "write";
export type SandboxNetworkMode = "unrestricted" | "requested";
export type SandboxIsolationClass = "microvm" | "userspace-kernel" | "namespaces-seccomp";

export interface SandboxResourceLimits {
  readonly memory: string;
  readonly cpus: number;
  readonly pids: number;
  readonly openFiles: number;
  readonly fileSizeBytes: number;
  readonly tempSize: string;
}

export interface SandboxProviderCapabilities {
  readonly filesystemIsolation: boolean;
  readonly processIsolation: boolean;
  readonly networkIsolation: boolean;
  readonly resourceLimits: boolean;
  readonly writableWorkspace: boolean;
  readonly trustedReadOnlyMounts: boolean;
  readonly persistentProcesses: boolean;
  readonly rootless: boolean;
  readonly daemonless: boolean;
  readonly sharesHostKernel: boolean;
}

export interface SandboxProviderDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly isolationClass: SandboxIsolationClass;
  readonly capabilities: SandboxProviderCapabilities;
}

export type SandboxProviderStatus = "ready" | "unsupported-platform" | "binary-unavailable" | "host-unready" | "image-missing" | "unavailable";

export interface SandboxProbeResult {
  readonly available: boolean;
  readonly status: SandboxProviderStatus;
  readonly reason?: string | undefined;
}

export interface SandboxSetupResult {
  readonly status: "already-ready" | "prepared";
  readonly providerId: string;
  readonly image?: string | undefined;
}

export interface SandboxExecutionEvent {
  readonly kind: "shell" | "process" | "kernel";
  readonly providerId: string;
  readonly workspace: string;
  readonly requestedNetwork: boolean;
  readonly networkEnabled: boolean;
  readonly networkMode: SandboxNetworkMode;
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
  readonly provider?: SandboxProviderDescriptor | undefined;
  readonly image?: string | undefined;
  readonly unavailableReason?: string | undefined;
  readonly networkMode?: SandboxNetworkMode | undefined;
  readonly egressAllow?: readonly string[] | undefined;
  readonly limits?: SandboxResourceLimits | undefined;
  assertAvailable(): void;
  registerTrustedReadOnlyMount(workspace: string, source: string, target?: string): () => void;
  sandboxShell(request: SandboxShellRequest): SandboxShellContext;
  sandboxProcess(request: SandboxProcessRequest): SandboxProcessContext;
  sandboxKernel(request: SandboxKernelRequest): SandboxKernelContext;
  cleanupManagedProcess?(id: string): void;
  cleanupStaleManagedProcesses?(): void;
}

export interface SandboxProviderCreateOptions {
  readonly networkMode?: SandboxNetworkMode | undefined;
  /**
   * Domains allowed when an operation explicitly requests network in `requested` mode.
   * Providers that cannot enforce a scoped allowlist must fail closed rather than widen to host networking.
   */
  readonly egressAllow?: readonly string[] | undefined;
  readonly limits?: Partial<SandboxResourceLimits> | undefined;
  readonly onExecution?: ((event: SandboxExecutionEvent) => void) | undefined;
}

export interface SandboxProvider {
  readonly descriptor: SandboxProviderDescriptor;
  readonly setupLabel: string;
  readonly setupDescription: string;
  createService(options?: SandboxProviderCreateOptions): SandboxService;
  probe(): SandboxProbeResult;
  repairHint(result: SandboxProbeResult): string;
  setup(): SandboxSetupResult | Promise<SandboxSetupResult>;
}

export const REQUIRED_SANDBOX_CAPABILITIES = Object.freeze([
  "filesystemIsolation",
  "processIsolation",
  "networkIsolation",
  "resourceLimits",
  "writableWorkspace",
  "trustedReadOnlyMounts",
  "persistentProcesses",
] as const satisfies readonly (keyof SandboxProviderCapabilities)[]);

export function assertSandboxProviderSatisfiesContract(provider: SandboxProvider): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider.descriptor.id)) {
    throw new Error(`Sandbox provider id is invalid: ${provider.descriptor.id}`);
  }
  for (const capability of REQUIRED_SANDBOX_CAPABILITIES) {
    if (provider.descriptor.capabilities[capability] !== true) {
      throw new Error(`Sandbox provider ${provider.descriptor.id} cannot satisfy required capability: ${capability}`);
    }
  }
}

export function sandboxNetworkEnabled(service: SandboxService, requested = false): boolean {
  return service.networkMode === "unrestricted" || requested;
}

export const SANDBOX_CAPABILITY: Capability<SandboxService> =
  defineCapability<SandboxService>("sandbox");
