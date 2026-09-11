import type { ExecutionOperation } from "@friday/execution-targets";
import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type ComputerNodePlatform = "linux" | "windows" | "macos" | "test";
export type ComputerNodeAvailability = "online" | "draining" | "offline" | "degraded";
export type ComputerScreenKind = "human" | "agent";
export type ComputerAutomationMode = "playwright-dom" | "accessibility" | "cdp" | "visual";
export type ComputerBrowserWindowOwner = "human" | "developer" | "research" | "friday";
export type ComputerAdmissionReason =
  | "node-unavailable"
  | "browser-unavailable"
  | "memory-pressure"
  | "cpu-pressure"
  | "browser-renderer-pressure"
  | "gpu-pressure"
  | "screen-pressure"
  | "screen-unavailable";

export interface ComputerNodeCapabilities {
  /** Existing code-execution operations that a platform provider can service on this node. */
  readonly executionOperations: readonly ExecutionOperation[];
  readonly browser: boolean;
  readonly playwright: boolean;
  readonly accessibility: boolean;
  readonly cdp: boolean;
  readonly visualControl: boolean;
  readonly screenCapture: boolean;
  readonly rawInput: boolean;
  readonly virtualDisplays: boolean;
  readonly managedLifecycle: boolean;
}

export interface ComputerAdmissionPolicy {
  readonly minAvailableMemoryMb?: number | undefined;
  readonly maxCpuPercent?: number | undefined;
  readonly maxBrowserRenderers?: number | undefined;
  readonly maxGpuPercent?: number | undefined;
  readonly maxScreenWorkloadPercent?: number | undefined;
}

export interface ComputerResolvedAdmissionPolicy {
  readonly minAvailableMemoryMb: number;
  readonly maxCpuPercent: number;
  readonly maxBrowserRenderers: number;
  readonly maxGpuPercent: number;
  readonly maxScreenWorkloadPercent: number;
}

export interface ComputerNodeDescriptor {
  readonly id: string;
  readonly label: string;
  readonly platform: ComputerNodePlatform;
  /** Optional paired Devices identity for a remote Computer Node. Local providers may omit it. */
  readonly deviceId?: string | undefined;
  readonly capabilities: ComputerNodeCapabilities;
  readonly admission?: ComputerAdmissionPolicy | undefined;
}

export interface ComputerScreenDescriptor {
  readonly id: string;
  readonly label: string;
  readonly kind: ComputerScreenKind;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly scale?: number | undefined;
}

export interface ComputerResourceSnapshot {
  readonly totalMemoryMb: number;
  readonly availableMemoryMb: number;
  readonly cpuPercent: number;
  readonly browserRendererCount: number;
  readonly gpuPercent?: number | undefined;
  /** Provider-observed display/input workload from 0 to 100. */
  readonly screenWorkloadPercent: number;
}

export interface ComputerBrowserTabSnapshot {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
}

export interface ComputerBrowserWindowSnapshot {
  readonly id: string;
  readonly owner: ComputerBrowserWindowOwner;
  readonly screenId?: string | undefined;
  readonly tabIds: readonly string[];
}

export interface ComputerBrowserSupervisorSnapshot {
  readonly running: boolean;
  /** Opaque provider-owned profile identifier. Never a credential or cookie path. */
  readonly profileId: string;
  readonly persistentProfile: boolean;
  readonly windows: readonly ComputerBrowserWindowSnapshot[];
  readonly tabs: readonly ComputerBrowserTabSnapshot[];
}

export interface ComputerNodeRuntimeSnapshot {
  readonly availability: ComputerNodeAvailability;
  readonly resources: ComputerResourceSnapshot;
  readonly screens: readonly ComputerScreenDescriptor[];
  readonly browser?: ComputerBrowserSupervisorSnapshot | undefined;
}

export interface ComputerProcessObservation {
  readonly pid: number;
  readonly name: string;
}

export interface ComputerObservation {
  readonly observedAt: string;
  readonly screenId: string;
  /** Current browser URL after provider-side secret redaction. */
  readonly url?: string | undefined;
  /** Bounded provider-side DOM summary. Raw password/OTP values must never appear here. */
  readonly domSummary?: string | undefined;
  /** Bounded provider-side accessibility summary. Secret values must be omitted. */
  readonly accessibilitySummary?: string | undefined;
  readonly tabs: readonly ComputerBrowserTabSnapshot[];
  /** Artifact reference only; raw screenshot bytes never cross the Computer capability. */
  readonly screenshotArtifactRef?: string | undefined;
  readonly processes: readonly ComputerProcessObservation[];
}

export type ComputerBrowserAction =
  | Readonly<{ kind: "navigate"; url: string }>
  | Readonly<{ kind: "click"; target: string }>
  | Readonly<{ kind: "type"; target: string; text: string; sensitive?: boolean | undefined }>
  | Readonly<{ kind: "press"; key: string }>;

export interface ComputerBrowserActionRequest {
  readonly screenId: string;
  readonly controlGeneration: number;
  readonly action: ComputerBrowserAction;
  /** Ordered provider fallback sequence. API/MCP is intentionally upstream of Computer. */
  readonly automationOrder: readonly ComputerAutomationMode[];
  readonly signal?: AbortSignal | undefined;
}

export interface ComputerBrowserActionResult {
  readonly mode: ComputerAutomationMode;
  readonly observation: ComputerObservation;
}

export type ComputerExecutionToolName = "bash" | "edit" | "process" | "ipython";
export type ComputerExecutionOwnerKind = "main-agent" | "subagent";

/** Stable Agent-run binding used to prove that a Computer tool call owns the leased screen. */
export interface ComputerExecutionBinding {
  readonly nodeId: string;
  readonly screenId: string;
  readonly screenLeaseId: string;
  readonly ownerId: string;
  readonly ownerKind: ComputerExecutionOwnerKind;
  readonly generation: number;
}

export interface ComputerToolExecutionRequest {
  readonly workspace: string;
  readonly tool: ComputerExecutionToolName;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ComputerNodeToolExecutionRequest extends ComputerToolExecutionRequest {
  readonly operation: ExecutionOperation;
  readonly screenId: string;
  readonly screenLeaseId: string;
  readonly ownerId: string;
  readonly ownerKind: ComputerExecutionOwnerKind;
  readonly controlGeneration: number;
  readonly signal?: AbortSignal | undefined;
}

export type ComputerToolExecutionContent =
  | Readonly<{ readonly type: "text"; readonly text: string }>
  | Readonly<{ readonly type: "image"; readonly data: string; readonly mimeType: string }>;

export interface ComputerToolExecutionResult {
  readonly content: readonly ComputerToolExecutionContent[];
  readonly details?: unknown;
  readonly terminate?: boolean | undefined;
}

/** Platform implementation boundary. Phase 5/8 providers implement this contract. */
export interface ComputerNodeAdapter {
  readonly descriptor: ComputerNodeDescriptor;
  snapshot(signal?: AbortSignal): Promise<ComputerNodeRuntimeSnapshot>;
  observeScreen(screenId: string, controlGeneration: number, signal?: AbortSignal): Promise<ComputerObservation>;
  /** Execute an existing FRIDAY tool on this node without introducing a second tool/executor stack. */
  runTool?(request: ComputerNodeToolExecutionRequest): Promise<ComputerToolExecutionResult>;
  runBrowserAction?(request: ComputerBrowserActionRequest): Promise<ComputerBrowserActionResult>;
  restart?(signal?: AbortSignal): Promise<void>;
  update?(signal?: AbortSignal): Promise<void>;
  /** Reset only FRIDAY-managed Agent state. It must never silently reset the person's OS. */
  resetManagedState?(signal?: AbortSignal): Promise<void>;
  close?(): void | Promise<void>;
}

export interface ComputerNode {
  readonly id: string;
  readonly label: string;
  readonly platform: ComputerNodePlatform;
  readonly deviceId?: string | undefined;
  readonly capabilities: ComputerNodeCapabilities;
  readonly admission: ComputerResolvedAdmissionPolicy;
  readonly availability: ComputerNodeAvailability;
  readonly resources: ComputerResourceSnapshot;
  readonly screens: readonly ComputerScreenDescriptor[];
  readonly browser?: ComputerBrowserSupervisorSnapshot | undefined;
  readonly registeredAt: string;
  readonly updatedAt: string;
}

export interface ScreenLease {
  readonly id: string;
  readonly nodeId: string;
  readonly screenId: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface ControlLeaseTranscriptPolicy {
  readonly captureKeystrokes: false;
  readonly captureSecrets: false;
  readonly captureSensitiveScreenshots: false;
}

export interface ControlLease {
  readonly id: string;
  readonly screenLeaseId: string;
  readonly nodeId: string;
  readonly screenId: string;
  readonly holder: "agent" | "human";
  readonly holderId: string;
  readonly agentOwnerId: string;
  /** Changes whenever ownership/activity invalidates pending GUI work. */
  readonly generation: number;
  readonly acquiredAt: string;
  readonly lastActivityAt: string;
  /** Null means manual-only hand-back. */
  readonly handBackAfterMs: number | null;
  readonly transcriptPolicy: ControlLeaseTranscriptPolicy;
}

export interface ComputerScreenRequest {
  readonly ownerId: string;
  readonly preferredNodeId?: string | undefined;
  readonly preferredScreenId?: string | undefined;
  readonly requireBrowser?: boolean | undefined;
  readonly demand?: Readonly<{
    readonly memoryMb?: number | undefined;
    readonly browserRenderers?: number | undefined;
    readonly gpu?: boolean | undefined;
  }> | undefined;
  readonly leaseTtlMs?: number | undefined;
}

export interface ComputerWaitingForComputer {
  readonly state: "waiting";
  readonly code: "WAITING_FOR_COMPUTER";
  readonly ownerId: string;
  readonly reasons: readonly ComputerAdmissionReason[];
}

export interface ComputerScreenGrant {
  readonly state: "acquired";
  readonly screenLease: ScreenLease;
  readonly controlLease: ControlLease;
}

export type ComputerScreenRequestResult = ComputerScreenGrant | ComputerWaitingForComputer;

export interface ComputerHandBackResult {
  readonly controlLease: ControlLease;
  readonly observation: ComputerObservation;
}

export interface ComputerDoctorNodeReport {
  readonly nodeId: string;
  readonly status: "ok" | "degraded" | "unavailable";
  readonly issues: readonly string[];
  readonly availableAgentScreens: number;
  readonly activeScreenLeases: number;
}

export interface ComputerDoctorReport {
  readonly status: "ok" | "degraded" | "unavailable";
  readonly nodes: readonly ComputerDoctorNodeReport[];
  readonly waitingRequests: number;
}

export interface ComputerStatusBrowserSummary {
  readonly available: boolean;
  readonly running: boolean;
  readonly persistentProfile?: boolean | undefined;
  readonly windows?: number | undefined;
  readonly tabs?: number | undefined;
}

export interface ComputerNodeStatusSummary {
  readonly id: string;
  readonly label: string;
  readonly platform: ComputerNodePlatform;
  readonly availability: ComputerNodeAvailability;
  readonly agentScreens: number;
  readonly leasedScreens: number;
  readonly browser: ComputerStatusBrowserSummary;
  readonly resources: ComputerResourceSnapshot;
}

export interface ComputerStatusSnapshot {
  readonly nodes: number;
  readonly online: number;
  readonly degraded: number;
  readonly offline: number;
  readonly activeScreenLeases: number;
  readonly humanTakeovers: number;
  readonly waitingRequests: number;
  readonly nodeStatus: readonly ComputerNodeStatusSummary[];
}

export interface ComputerLeaseStatus {
  readonly screenLeaseId: string;
  readonly nodeId: string;
  readonly screenId: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly control?: Readonly<{
    readonly holder: "agent" | "human";
    readonly generation: number;
    readonly acquiredAt: string;
    readonly lastActivityAt: string;
    readonly handBackAfterMs: number | null;
    readonly transcriptPolicy: ControlLeaseTranscriptPolicy;
  }> | undefined;
}

export interface ComputerService {
  registerNode(adapter: ComputerNodeAdapter): Promise<ComputerNode>;
  unregisterNode(nodeId: string, options?: { readonly force?: boolean | undefined }): Promise<boolean>;
  refreshNode(nodeId: string, signal?: AbortSignal): Promise<ComputerNode>;
  refreshAll(signal?: AbortSignal): Promise<readonly ComputerNode[]>;
  node(nodeId: string): ComputerNode | undefined;
  nodes(): readonly ComputerNode[];
  status(): ComputerStatusSnapshot;
  leaseStatus(): readonly ComputerLeaseStatus[];
  screenLeases(): readonly ScreenLease[];
  controlLease(screenLeaseId: string): ControlLease | undefined;
  requestScreen(request: ComputerScreenRequest): Promise<ComputerScreenRequestResult>;
  waitForScreen(
    request: ComputerScreenRequest,
    signal?: AbortSignal,
    onWaiting?: ((waiting: ComputerWaitingForComputer) => void | Promise<void>) | undefined,
  ): Promise<ComputerScreenGrant>;
  renewScreenLease(screenLeaseId: string, ownerId: string, ttlMs?: number): Promise<ScreenLease>;
  releaseScreen(screenLeaseId: string, ownerId: string): Promise<boolean>;
  expireLeases(now?: number): Promise<number>;
  takeOver(screenLeaseId: string, humanOwnerId: string, handBackAfterMs?: number | null): Promise<ControlLease>;
  recordHumanActivity(screenLeaseId: string, humanOwnerId: string): Promise<ControlLease>;
  handBack(screenLeaseId: string, humanOwnerId: string, signal?: AbortSignal): Promise<ComputerHandBackResult>;
  sweepIdleTakeovers(now?: number): Promise<number>;
  assertAgentControl(screenLeaseId: string, ownerId: string, generation: number): ControlLease;
  observeScreen(
    screenLeaseId: string,
    ownerId: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<ComputerObservation>;
  runTool(
    binding: ComputerExecutionBinding,
    request: ComputerToolExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ComputerToolExecutionResult>;
  runBrowserAction(
    screenLeaseId: string,
    ownerId: string,
    generation: number,
    action: ComputerBrowserAction,
    signal?: AbortSignal,
  ): Promise<ComputerBrowserActionResult>;
  restartNode(nodeId: string, signal?: AbortSignal): Promise<ComputerNode>;
  updateNode(nodeId: string, signal?: AbortSignal): Promise<ComputerNode>;
  resetManagedState(nodeId: string, signal?: AbortSignal): Promise<ComputerNode>;
  doctor(): Promise<ComputerDoctorReport>;
  close(): Promise<void>;
}

export const COMPUTER_CAPABILITY: Capability<ComputerService> =
  defineCapability<ComputerService>("computer");
