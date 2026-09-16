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
  /** Bounded current media state for FRIDAY-owned browser targets; no audio/video payload is captured. */
  readonly media?: Readonly<{
    readonly elementCount: number;
    readonly playing: boolean;
    readonly paused: boolean;
    readonly ended: boolean;
    readonly currentTime?: number | undefined;
    readonly duration?: number | undefined;
    readonly muted?: boolean | undefined;
    readonly volume?: number | undefined;
  }> | undefined;
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
  /** Opaque id for the single live browser context. Present only while the supervisor is running. */
  readonly contextId?: string | undefined;
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

export interface ComputerObservationSafety {
  /** Provider attests that password, OTP, token, cookie, and other protected input values were omitted. */
  readonly protectedInputOmitted: true;
  /** Provider attests that raw human keystrokes/input history were omitted. */
  readonly keystrokesOmitted: true;
  /** Provider attests that CAPTCHA/challenge content was omitted from model-visible observation text. */
  readonly captchaOmitted: true;
  /** Provider attests that any screenshot artifact reference is safe for model-visible consumption. */
  readonly sensitiveScreenshotOmitted: true;
}

export interface ComputerBoundingBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type ComputerElementSource = "dom" | "aria" | "atspi" | "uia" | "visual";
export type ComputerElementAction = "click" | "type" | "toggle" | "select" | "expand" | "scroll";

/** Canonical cross-platform UI element shape exposed to the planning model. */
export interface ComputerElement {
  /** Stable local id reused across observations while the provider can prove element continuity. */
  readonly id: string;
  /** Observation-scoped action reference, for example `obs-12:e7`. */
  readonly ref: string;
  readonly role: string;
  readonly name?: string | undefined;
  readonly value?: string | undefined;
  readonly bbox?: ComputerBoundingBox | undefined;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly interactive: boolean;
  readonly clickable: boolean;
  readonly editable: boolean;
  readonly selectable: boolean;
  readonly scrollable: boolean;
  readonly draggable: boolean;
  readonly selected?: boolean | undefined;
  readonly checked?: boolean | undefined;
  readonly expanded?: boolean | undefined;
  readonly protected?: boolean | undefined;
  readonly context?: string | undefined;
  readonly actions: readonly ComputerElementAction[];
  readonly source: ComputerElementSource;
  /** Provider confidence that this semantic element maps uniquely to the intended live control. */
  readonly confidence: number;
}

export interface ComputerObservationDeltaUpdate {
  readonly previousRef: string;
  readonly element: ComputerElement;
}

export interface ComputerObservationDelta {
  readonly baseObservationId: string;
  readonly added: readonly ComputerElement[];
  readonly updated: readonly ComputerObservationDeltaUpdate[];
  readonly removedIds: readonly string[];
  readonly retained: number;
}

export interface ComputerObservationRequest {
  /** Interactive-only is the token-efficient default. */
  readonly scope?: "interactive" | "all" | undefined;
  readonly query?: string | undefined;
  /** Restrict results near a current observation-scoped element reference. */
  readonly near?: string | undefined;
  readonly maxElements?: number | undefined;
}

export interface ComputerObservation {
  readonly observedAt: string;
  readonly screenId: string;
  /** Provider observation generation used to scope semantic element references. */
  readonly observationId?: string | undefined;
  /** Required provider-side safety attestation; the core also applies bounded credential redaction defensively. */
  readonly safety: ComputerObservationSafety;
  /** Current browser URL after provider-side secret redaction. */
  readonly url?: string | undefined;
  /** Bounded provider-side DOM summary. Raw password/OTP values must never appear here. */
  readonly domSummary?: string | undefined;
  /** Bounded provider-side accessibility summary. Secret values must be omitted. */
  readonly accessibilitySummary?: string | undefined;
  readonly tabs: readonly ComputerBrowserTabSnapshot[];
  /** Artifact reference only; raw screenshots are exposed only by explicit bounded visual probes. */
  readonly screenshotArtifactRef?: string | undefined;
  /** Canonical semantic snapshot. Providers that do not support structured perception may omit it. */
  readonly elements?: readonly ComputerElement[] | undefined;
  /** Structural difference from the provider's previous observation of this screen. */
  readonly delta?: ComputerObservationDelta | undefined;
  readonly processes: readonly ComputerProcessObservation[];
}

export type ComputerBrowserAction =
  | Readonly<{ kind: "navigate"; url: string }>
  | Readonly<{ kind: "click"; target: string; visualProbeToken?: string | undefined }>
  | Readonly<{ kind: "type"; target: string; text: string; sensitive?: boolean | undefined; visualProbeToken?: string | undefined }>
  | Readonly<{ kind: "press"; key: string; target?: string | undefined; visualProbeToken?: string | undefined }>
  | Readonly<{ kind: "scroll"; deltaX?: number | undefined; deltaY: number; target?: string | undefined; visualProbeToken?: string | undefined }>;

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
  /** False means the provider intentionally deferred the action until a visual probe is reviewed. */
  readonly performed?: boolean | undefined;
  readonly confidence?: number | undefined;
  readonly visualProbeRequired?: Readonly<{
    readonly ref: string;
    readonly reason: "low-confidence" | "high-impact-action";
    readonly recommendedSize: ComputerVisualProbeSize;
  }> | undefined;
  readonly verification?: Readonly<{
    readonly structuralChange: boolean;
    readonly urlChanged: boolean;
  }> | undefined;
  readonly observation: ComputerObservation;
}

export type ComputerVisualProbeSize = "tiny" | "small" | "medium" | "window" | "full";
export type ComputerVisualProbeReturn = "text" | "image";

export interface ComputerVisualProbeRequest {
  readonly screenId: string;
  readonly controlGeneration: number;
  readonly ref?: string | undefined;
  readonly bbox?: ComputerBoundingBox | undefined;
  readonly size?: ComputerVisualProbeSize | undefined;
  readonly maxSide?: number | undefined;
  readonly includeContext?: boolean | undefined;
  readonly purpose?: string | undefined;
  readonly return: ComputerVisualProbeReturn;
  readonly signal?: AbortSignal | undefined;
}

export interface ComputerVisualProbeSafety {
  /** Provider attests that password/OTP/token/credential regions were refused before capture. */
  readonly protectedRegionOmitted: true;
  /** Provider attests that known CAPTCHA/challenge regions were refused before capture. */
  readonly challengeRegionOmitted: true;
}

export interface ComputerVisualProbeResult {
  readonly observationId: string;
  readonly safety: ComputerVisualProbeSafety;
  readonly ref?: string | undefined;
  readonly bbox: ComputerBoundingBox;
  readonly width: number;
  readonly height: number;
  readonly targetMatch: boolean;
  readonly confidence: number;
  readonly visibleText: readonly string[];
  /** One-use token proving the caller inspected this exact current target before retrying a gated action. */
  readonly probeToken?: string | undefined;
  readonly image?: Readonly<{ readonly data: string; readonly mimeType: "image/png" }> | undefined;
}

export type ComputerExecutionToolName = "bash" | "edit" | "process" | "ipython";
export type ComputerExecutionOwnerKind = "main-agent" | "subagent";

/** Stable Agent-run binding used to prove that a Computer tool call owns the leased screen. */
export interface ComputerResourceDemand {
  readonly memoryMb?: number | undefined;
  readonly browserRenderers?: number | undefined;
  readonly gpu?: boolean | undefined;
}

export interface ComputerExecutionAdmission {
  readonly requireBrowser?: boolean | undefined;
  readonly demand?: ComputerResourceDemand | undefined;
}

export interface ComputerExecutionBinding {
  readonly nodeId: string;
  readonly screenId: string;
  readonly screenLeaseId: string;
  readonly ownerId: string;
  readonly ownerKind: ComputerExecutionOwnerKind;
  /** Unique top-level Agent run identity; provider-owned resources must be scoped to this run. */
  readonly runId: string;
  /** Server-owned admission requirements retained so later Computer actions can re-check the same resource budget. */
  readonly admission?: ComputerExecutionAdmission | undefined;
  /** Shared presentation is opened only after this task's Computer-control approval succeeds. */
  readonly presentation?: "shared" | "background" | undefined;
  readonly generation: number;
}

type ComputerSharedScreenSupportLevel = "full" | "conditional" | "unsupported";
type ComputerSharedScreenBackend = "x11-ewmh" | "unsupported";

export interface ComputerSharedScreenSupport {
  readonly level: ComputerSharedScreenSupportLevel;
  readonly backend: ComputerSharedScreenBackend;
  readonly desktopEnvironment: string;
  readonly sessionType: "x11" | "wayland" | "unknown";
  readonly canCreateWorkspace: boolean;
  readonly canPlaceViewer: boolean;
  readonly canSwitchWorkspace: boolean;
  /** True only for mirrored/view-only presentation. Native desktop presentation is interactive. */
  readonly viewOnly: boolean;
  readonly missing: readonly string[];
  readonly reason: string;
}

interface ComputerSharedScreenOpenRequest {
  readonly screenId: string;
  readonly screenLeaseId: string;
  readonly ownerId: string;
  readonly ownerKind: ComputerExecutionOwnerKind;
  readonly runId: string;
  readonly name?: string | undefined;
  /** False by default so opening an Agent screen never steals the Human's current desktop. */
  readonly switchTo?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

interface ComputerSharedScreenView {
  readonly nodeId: string;
  readonly screenId: string;
  readonly workspaceName: string;
  readonly backend: Exclude<ComputerSharedScreenBackend, "unsupported">;
  /** True only for mirrored/view-only presentation. Native desktop presentation is interactive. */
  readonly viewOnly: boolean;
  /** Stable FRIDAY-owned presentation identity. It is safe to stop without matching arbitrary processes. */
  readonly viewerId: string;
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
  readonly runId: string;
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

export interface ComputerRunProcessCleanupRequest {
  readonly screenId: string;
  readonly screenLeaseId: string;
  readonly ownerId: string;
  readonly ownerKind: ComputerExecutionOwnerKind;
  readonly runId: string;
  readonly signal?: AbortSignal | undefined;
}

/** Platform implementation boundary. Phase 5/8 providers implement this contract. */
export interface ComputerNodeAdapter {
  readonly descriptor: ComputerNodeDescriptor;
  snapshot(signal?: AbortSignal): Promise<ComputerNodeRuntimeSnapshot>;
  observeScreen(
    screenId: string,
    controlGeneration: number,
    signal?: AbortSignal,
    request?: ComputerObservationRequest,
  ): Promise<ComputerObservation>;
  /** Execute an existing FRIDAY tool on this node without introducing a second tool/executor stack. */
  runTool?(request: ComputerNodeToolExecutionRequest): Promise<ComputerToolExecutionResult>;
  /** Idempotently terminate provider-owned background processes for one Agent run before that run settles. */
  cleanupRunProcesses?(request: ComputerRunProcessCleanupRequest): Promise<void>;
  /** Report whether this host can present an Agent-owned real desktop on a Human-switchable workspace. */
  sharedScreenSupport?(signal?: AbortSignal): Promise<ComputerSharedScreenSupport>;
  /** Present one leased Agent screen as a Human-switchable real desktop. */
  openSharedScreen?(request: ComputerSharedScreenOpenRequest): Promise<ComputerSharedScreenView>;
  /** Close only FRIDAY-owned desktop/browser presentations; never broad-kill unrelated processes. */
  closeSharedScreens?(signal?: AbortSignal): Promise<number>;
  runBrowserAction?(request: ComputerBrowserActionRequest): Promise<ComputerBrowserActionResult>;
  /** Explicit, bounded, on-demand visual crop. Providers must refuse protected/challenge regions. */
  visualProbe?(request: ComputerVisualProbeRequest): Promise<ComputerVisualProbeResult>;
  /** Provider-specific health details for Doctor. Must be bounded and secret-free. */
  doctor?(signal?: AbortSignal): Promise<readonly string[]>;
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
  /** Required pins to one screen; soft prefers it but may use another free Agent screen. */
  readonly preferredScreenMode?: "required" | "soft" | undefined;
  readonly requireBrowser?: boolean | undefined;
  readonly demand?: ComputerResourceDemand | undefined;
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

export type ComputerAgentControlResume =
  | Readonly<{
      readonly resumedAfterTakeover: false;
      readonly controlLease: ControlLease;
    }>
  | Readonly<{
      readonly resumedAfterTakeover: true;
      readonly controlLease: ControlLease;
      /** Fresh post-hand-back observation. The interrupted action was never replayed. */
      readonly observation: ComputerObservation;
    }>;

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
  readonly ready: boolean;
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
  /** Agent operations paused behind an active human ControlLease. */
  readonly waitingForControl: number;
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
  /**
   * Wait for a human takeover to hand the leased screen back to the original Agent.
   * A resumed result always carries the fresh hand-back observation; callers must replan and must not replay the interrupted action.
   */
  waitForAgentControl(
    screenLeaseId: string,
    ownerId: string,
    afterGeneration: number,
    signal?: AbortSignal,
  ): Promise<ComputerAgentControlResume>;
  assertAgentControl(screenLeaseId: string, ownerId: string, generation: number): ControlLease;
  observeScreen(
    screenLeaseId: string,
    ownerId: string,
    generation: number,
    signal?: AbortSignal,
    request?: ComputerObservationRequest,
  ): Promise<ComputerObservation>;
  runTool(
    binding: ComputerExecutionBinding,
    request: ComputerToolExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ComputerToolExecutionResult>;
  /** Idempotently clean provider-owned background processes scoped to this Computer Agent run. */
  cleanupRunProcesses(binding: ComputerExecutionBinding, signal?: AbortSignal): Promise<boolean>;
  sharedScreenSupport(nodeId: string, signal?: AbortSignal): Promise<ComputerSharedScreenSupport>;
  openSharedScreen(
    binding: ComputerExecutionBinding,
    options?: { readonly name?: string | undefined; readonly switchTo?: boolean | undefined },
    signal?: AbortSignal,
  ): Promise<ComputerSharedScreenView>;
  /** Close only FRIDAY-owned shared-screen presentation units. Returns the number of stopped views. */
  closeSharedScreens(nodeId?: string, signal?: AbortSignal): Promise<number>;
  runBrowserAction(
    screenLeaseId: string,
    ownerId: string,
    generation: number,
    action: ComputerBrowserAction,
    signal?: AbortSignal,
  ): Promise<ComputerBrowserActionResult>;
  visualProbe(
    screenLeaseId: string,
    ownerId: string,
    generation: number,
    request: Omit<ComputerVisualProbeRequest, "screenId" | "controlGeneration" | "signal">,
    signal?: AbortSignal,
  ): Promise<ComputerVisualProbeResult>;
  restartNode(nodeId: string, signal?: AbortSignal): Promise<ComputerNode>;
  updateNode(nodeId: string, signal?: AbortSignal): Promise<ComputerNode>;
  resetManagedState(nodeId: string, signal?: AbortSignal): Promise<ComputerNode>;
  doctor(): Promise<ComputerDoctorReport>;
  close(): Promise<void>;
}

export const COMPUTER_CAPABILITY: Capability<ComputerService> =
  defineCapability<ComputerService>("computer");
