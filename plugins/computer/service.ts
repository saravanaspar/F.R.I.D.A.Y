import { randomUUID } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import {
  type ComputerAdmissionPolicy,
  type ComputerAdmissionReason,
  type ComputerAutomationMode,
  type ComputerBrowserAction,
  type ComputerBrowserActionResult,
  type ComputerBrowserSupervisorSnapshot,
  type ComputerBrowserTabSnapshot,
  type ComputerBrowserWindowSnapshot,
  type ComputerDoctorNodeReport,
  type ComputerDoctorReport,
  type ComputerExecutionBinding,
  type ComputerExecutionToolName,
  type ComputerHandBackResult,
  type ComputerLeaseStatus,
  type ComputerNode,
  type ComputerNodeAdapter,
  type ComputerNodeCapabilities,
  type ComputerNodeDescriptor,
  type ComputerNodeRuntimeSnapshot,
  type ComputerObservation,
  type ComputerProcessObservation,
  type ComputerResolvedAdmissionPolicy,
  type ComputerResourceSnapshot,
  type ComputerScreenDescriptor,
  type ComputerScreenGrant,
  type ComputerScreenRequest,
  type ComputerScreenRequestResult,
  type ComputerService,
  type ComputerStatusSnapshot,
  type ComputerToolExecutionRequest,
  type ComputerToolExecutionResult,
  type ControlLease,
  type ScreenLease,
} from "./contract.js";

const DEFAULT_SCREEN_LEASE_TTL_MS = 30 * 60 * 1_000;
const MIN_SCREEN_LEASE_TTL_MS = 5_000;
const MAX_SCREEN_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_HAND_BACK_MS = 8_000;
const MIN_HAND_BACK_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_WAITERS = 256;
const MAX_NODES = 128;
const MAX_SCREENS_PER_NODE = 64;
const MAX_BROWSER_WINDOWS = 256;
const MAX_BROWSER_TABS = 512;
const MAX_TOOL_CONTENT_ITEMS = 64;
const MAX_TOOL_TEXT_CHARS = 8 * 1024 * 1024;
const MAX_TOOL_IMAGE_CHARS = 16 * 1024 * 1024;
const TRANSCRIPT_POLICY = Object.freeze({
  captureKeystrokes: false as const,
  captureSecrets: false as const,
  captureSensitiveScreenshots: false as const,
});

interface NodeState {
  readonly adapter: ComputerNodeAdapter;
  node: ComputerNode;
}

interface MutableScreenLease {
  id: string;
  nodeId: string;
  screenId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

interface MutableControlLease {
  id: string;
  screenLeaseId: string;
  nodeId: string;
  screenId: string;
  holder: "agent" | "human";
  holderId: string;
  agentOwnerId: string;
  generation: number;
  acquiredAt: string;
  lastActivityAt: string;
  handBackAfterMs: number | null;
}

interface WaitingRequest {
  readonly id: string;
  readonly request: ComputerScreenRequest;
  readonly resolve: (grant: ComputerScreenGrant) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal | undefined;
  readonly abortListener?: (() => void) | undefined;
}

export interface ComputerServiceOptions {
  readonly now?: (() => number) | undefined;
  readonly idFactory?: (() => string) | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly validateDevice?: ((deviceId: string) => void | Promise<void>) | undefined;
  readonly publishEvent?: ((type: string, subject: string, data?: Record<string, string | number | boolean | null>) => void) | undefined;
}

function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function id(value: unknown, label: string, maximum = 128): string {
  const normalized = text(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").replaceAll("\u0000", "�").trim();
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return normalized;
}

function boundedRawText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return value.replaceAll("\u0000", "�");
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("invalid timestamp");
  return timestamp;
}

function leaseTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_SCREEN_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < MIN_SCREEN_LEASE_TTL_MS || ttl > MAX_SCREEN_LEASE_TTL_MS) {
    throw new Error(`screen lease ttl must be between ${MIN_SCREEN_LEASE_TTL_MS} and ${MAX_SCREEN_LEASE_TTL_MS} ms`);
  }
  return ttl;
}

function handBackDelay(value: number | null | undefined): number | null {
  if (value === null) return null;
  const delay = value ?? DEFAULT_HAND_BACK_MS;
  if (!Number.isSafeInteger(delay) || delay < MIN_HAND_BACK_MS) {
    throw new Error(`hand-back delay must be at least ${MIN_HAND_BACK_MS} ms or null for manual-only`);
  }
  return delay;
}

function pollInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < 50 || interval > 60_000) {
    throw new Error("computer poll interval must be between 50 and 60000 ms");
  }
  return interval;
}

function normalizeAdmission(input: ComputerAdmissionPolicy | undefined): ComputerResolvedAdmissionPolicy {
  return Object.freeze({
    minAvailableMemoryMb: input?.minAvailableMemoryMb === undefined
      ? 0
      : finiteNumber(input.minAvailableMemoryMb, "admission.minAvailableMemoryMb", 0, Number.MAX_SAFE_INTEGER),
    maxCpuPercent: input?.maxCpuPercent === undefined
      ? 100
      : finiteNumber(input.maxCpuPercent, "admission.maxCpuPercent", 0, 100),
    maxBrowserRenderers: input?.maxBrowserRenderers === undefined
      ? Number.MAX_SAFE_INTEGER
      : nonNegativeInteger(input.maxBrowserRenderers, "admission.maxBrowserRenderers"),
    maxGpuPercent: input?.maxGpuPercent === undefined
      ? 100
      : finiteNumber(input.maxGpuPercent, "admission.maxGpuPercent", 0, 100),
    maxScreenWorkloadPercent: input?.maxScreenWorkloadPercent === undefined
      ? 100
      : finiteNumber(input.maxScreenWorkloadPercent, "admission.maxScreenWorkloadPercent", 0, 100),
  });
}

function normalizeCapabilities(input: ComputerNodeCapabilities): ComputerNodeCapabilities {
  const allowedOperations = new Set(["shell", "edit", "process", "git"]);
  const executionOperations = [...new Set(input.executionOperations)];
  for (const operation of executionOperations) {
    if (!allowedOperations.has(operation)) throw new Error(`unsupported Computer execution operation: ${String(operation)}`);
  }
  const values = [
    input.browser,
    input.playwright,
    input.accessibility,
    input.cdp,
    input.visualControl,
    input.screenCapture,
    input.rawInput,
    input.virtualDisplays,
    input.managedLifecycle,
  ];
  if (values.some((value) => typeof value !== "boolean")) throw new Error("Computer node capabilities must be booleans");
  if (input.playwright && !input.browser) throw new Error("playwright capability requires browser capability");
  if (input.cdp && !input.browser) throw new Error("cdp capability requires browser capability");
  return Object.freeze({
    executionOperations: Object.freeze(executionOperations),
    browser: input.browser,
    playwright: input.playwright,
    accessibility: input.accessibility,
    cdp: input.cdp,
    visualControl: input.visualControl,
    screenCapture: input.screenCapture,
    rawInput: input.rawInput,
    virtualDisplays: input.virtualDisplays,
    managedLifecycle: input.managedLifecycle,
  });
}

function normalizeDescriptor(input: ComputerNodeDescriptor): Readonly<{
  id: string;
  label: string;
  platform: ComputerNodeDescriptor["platform"];
  deviceId?: string | undefined;
  capabilities: ComputerNodeCapabilities;
  admission: ComputerResolvedAdmissionPolicy;
}> {
  const platform = input.platform;
  if (platform !== "linux" && platform !== "windows" && platform !== "macos" && platform !== "test") {
    throw new Error(`unsupported Computer node platform: ${String(platform)}`);
  }
  return Object.freeze({
    id: id(input.id, "Computer node id"),
    label: text(input.label, "Computer node label", 160),
    platform,
    ...(input.deviceId === undefined ? {} : { deviceId: id(input.deviceId, "Computer device id") }),
    capabilities: normalizeCapabilities(input.capabilities),
    admission: normalizeAdmission(input.admission),
  });
}

function normalizeScreen(input: ComputerScreenDescriptor): ComputerScreenDescriptor {
  if (input.kind !== "human" && input.kind !== "agent") throw new Error(`unsupported screen kind: ${String(input.kind)}`);
  return Object.freeze({
    id: id(input.id, "Computer screen id"),
    label: text(input.label, "Computer screen label", 160),
    kind: input.kind,
    ...(input.width === undefined ? {} : { width: nonNegativeInteger(input.width, "screen width", 65_535) }),
    ...(input.height === undefined ? {} : { height: nonNegativeInteger(input.height, "screen height", 65_535) }),
    ...(input.scale === undefined ? {} : { scale: finiteNumber(input.scale, "screen scale", 0.1, 16) }),
  });
}

function normalizeResources(input: ComputerResourceSnapshot): ComputerResourceSnapshot {
  const totalMemoryMb = finiteNumber(input.totalMemoryMb, "resources.totalMemoryMb", 0, Number.MAX_SAFE_INTEGER);
  const availableMemoryMb = finiteNumber(input.availableMemoryMb, "resources.availableMemoryMb", 0, totalMemoryMb);
  return Object.freeze({
    totalMemoryMb,
    availableMemoryMb,
    cpuPercent: finiteNumber(input.cpuPercent, "resources.cpuPercent", 0, 100),
    browserRendererCount: nonNegativeInteger(input.browserRendererCount, "resources.browserRendererCount"),
    ...(input.gpuPercent === undefined ? {} : { gpuPercent: finiteNumber(input.gpuPercent, "resources.gpuPercent", 0, 100) }),
    screenWorkloadPercent: finiteNumber(input.screenWorkloadPercent, "resources.screenWorkloadPercent", 0, 100),
  });
}

function normalizeTab(input: ComputerBrowserTabSnapshot): ComputerBrowserTabSnapshot {
  return Object.freeze({
    id: id(input.id, "browser tab id"),
    title: boundedText(input.title, "browser tab title", 1_024),
    url: boundedText(input.url, "browser tab url", 4_096),
    active: Boolean(input.active),
  });
}

function normalizeWindow(input: ComputerBrowserWindowSnapshot, screens: ReadonlySet<string>): ComputerBrowserWindowSnapshot {
  if (input.owner !== "human" && input.owner !== "developer" && input.owner !== "research" && input.owner !== "friday") {
    throw new Error(`unsupported browser window owner: ${String(input.owner)}`);
  }
  const screenId = input.screenId === undefined ? undefined : id(input.screenId, "browser window screen id");
  if (screenId !== undefined && !screens.has(screenId)) throw new Error(`browser window references unavailable screen: ${screenId}`);
  return Object.freeze({
    id: id(input.id, "browser window id"),
    owner: input.owner,
    ...(screenId === undefined ? {} : { screenId }),
    tabIds: Object.freeze([...new Set(input.tabIds.map((tabId) => id(tabId, "browser window tab id")))]),
  });
}

function normalizeBrowser(input: ComputerBrowserSupervisorSnapshot, screens: ReadonlySet<string>): ComputerBrowserSupervisorSnapshot {
  if (input.windows.length > MAX_BROWSER_WINDOWS) throw new Error("browser supervisor exceeds window limit");
  if (input.tabs.length > MAX_BROWSER_TABS) throw new Error("browser supervisor exceeds tab limit");
  const tabs = Object.freeze(input.tabs.map(normalizeTab));
  const tabIds = new Set(tabs.map((tab) => tab.id));
  if (tabIds.size !== tabs.length) throw new Error("browser supervisor has duplicate tab ids");
  const windows = Object.freeze(input.windows.map((window) => normalizeWindow(window, screens)));
  const windowIds = new Set(windows.map((window) => window.id));
  if (windowIds.size !== windows.length) throw new Error("browser supervisor has duplicate window ids");
  for (const window of windows) {
    for (const tabId of window.tabIds) if (!tabIds.has(tabId)) throw new Error(`browser window references unavailable tab: ${tabId}`);
  }
  return Object.freeze({
    running: Boolean(input.running),
    profileId: id(input.profileId, "browser profile id", 160),
    persistentProfile: Boolean(input.persistentProfile),
    windows,
    tabs,
  });
}

function normalizeRuntimeSnapshot(input: ComputerNodeRuntimeSnapshot, capabilities: ComputerNodeCapabilities): ComputerNodeRuntimeSnapshot {
  if (input.availability !== "online" && input.availability !== "draining" && input.availability !== "offline" && input.availability !== "degraded") {
    throw new Error(`unsupported Computer node availability: ${String(input.availability)}`);
  }
  if (input.screens.length > MAX_SCREENS_PER_NODE) throw new Error("Computer node exceeds screen limit");
  const screens = Object.freeze(input.screens.map(normalizeScreen));
  const screenIds = new Set(screens.map((screen) => screen.id));
  if (screenIds.size !== screens.length) throw new Error("Computer node has duplicate screen ids");
  const browser = input.browser === undefined ? undefined : normalizeBrowser(input.browser, screenIds);
  if (browser !== undefined && !capabilities.browser) throw new Error("Computer node reported browser state without browser capability");
  return Object.freeze({
    availability: input.availability,
    resources: normalizeResources(input.resources),
    screens,
    ...(browser === undefined ? {} : { browser }),
  });
}

function cloneNode(node: ComputerNode): ComputerNode {
  return Object.freeze({
    ...node,
    capabilities: Object.freeze({ ...node.capabilities, executionOperations: Object.freeze([...node.capabilities.executionOperations]) }),
    admission: Object.freeze({ ...node.admission }),
    resources: Object.freeze({ ...node.resources }),
    screens: Object.freeze(node.screens.map((screen) => Object.freeze({ ...screen }))),
    ...(node.browser === undefined ? {} : {
      browser: Object.freeze({
        ...node.browser,
        windows: Object.freeze(node.browser.windows.map((window) => Object.freeze({ ...window, tabIds: Object.freeze([...window.tabIds]) }))),
        tabs: Object.freeze(node.browser.tabs.map((tab) => Object.freeze({ ...tab }))),
      }),
    }),
  });
}

function cloneScreenLease(lease: MutableScreenLease): ScreenLease {
  return Object.freeze({ ...lease });
}

function cloneControlLease(lease: MutableControlLease): ControlLease {
  return Object.freeze({ ...lease, transcriptPolicy: TRANSCRIPT_POLICY });
}

function normalizeObservation(input: ComputerObservation, expectedScreenId: string): ComputerObservation {
  const screenId = id(input.screenId, "observation screen id");
  if (screenId !== expectedScreenId) throw new Error(`Computer observation returned the wrong screen: ${screenId}`);
  const observedAt = text(input.observedAt, "observation timestamp", 64);
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("observation timestamp is invalid");
  if (input.tabs.length > MAX_BROWSER_TABS) throw new Error("Computer observation exceeds tab limit");
  if (input.processes.length > 512) throw new Error("Computer observation exceeds process limit");
  const processes: readonly ComputerProcessObservation[] = Object.freeze(input.processes.map((process) => Object.freeze({
    pid: nonNegativeInteger(process.pid, "observation process pid"),
    name: text(process.name, "observation process name", 256),
  })));
  return Object.freeze({
    observedAt,
    screenId,
    ...(input.url === undefined ? {} : { url: boundedText(input.url, "observation url", 4_096) }),
    ...(input.domSummary === undefined ? {} : { domSummary: boundedText(input.domSummary, "observation DOM summary", 32_000) }),
    ...(input.accessibilitySummary === undefined ? {} : { accessibilitySummary: boundedText(input.accessibilitySummary, "observation accessibility summary", 32_000) }),
    tabs: Object.freeze(input.tabs.map(normalizeTab)),
    ...(input.screenshotArtifactRef === undefined ? {} : { screenshotArtifactRef: id(input.screenshotArtifactRef, "observation screenshot artifact ref", 256) }),
    processes,
  });
}

function executionOperationForTool(tool: ComputerExecutionToolName): "shell" | "edit" | "process" {
  if (tool === "bash" || tool === "ipython") return "shell";
  if (tool === "edit") return "edit";
  if (tool === "process") return "process";
  throw new Error(`unsupported Computer execution tool: ${String(tool)}`);
}

function normalizeToolRequest(input: ComputerToolExecutionRequest): ComputerToolExecutionRequest {
  const tool = input.tool;
  executionOperationForTool(tool);
  if (!input.input || typeof input.input !== "object" || Array.isArray(input.input)) {
    throw new Error("Computer tool input must be an object");
  }
  return Object.freeze({
    workspace: text(input.workspace, "Computer execution workspace", 4_096),
    tool,
    input: Object.freeze({ ...input.input }),
  });
}

function normalizeToolResult(input: ComputerToolExecutionResult): ComputerToolExecutionResult {
  if (!input || typeof input !== "object" || !Array.isArray(input.content)) throw new Error("Computer provider returned an invalid tool result");
  if (input.content.length > MAX_TOOL_CONTENT_ITEMS) throw new Error("Computer provider returned too many tool content items");
  const content = input.content.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Computer provider tool content ${index} is invalid`);
    if (item.type === "text") {
      return Object.freeze({ type: "text" as const, text: boundedRawText(item.text, `Computer tool text ${index}`, MAX_TOOL_TEXT_CHARS) });
    }
    if (item.type === "image") {
      return Object.freeze({
        type: "image" as const,
        data: boundedRawText(item.data, `Computer tool image ${index}`, MAX_TOOL_IMAGE_CHARS),
        mimeType: text(item.mimeType, `Computer tool image mime type ${index}`, 128),
      });
    }
    throw new Error(`Computer provider returned unsupported tool content type: ${String((item as { type?: unknown }).type)}`);
  });
  return Object.freeze({
    content: Object.freeze(content),
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.terminate === undefined ? {} : { terminate: Boolean(input.terminate) }),
  });
}

function normalizeExecutionBinding(input: ComputerExecutionBinding): ComputerExecutionBinding {
  const ownerKind = input.ownerKind;
  if (ownerKind !== "main-agent" && ownerKind !== "subagent") throw new Error(`unsupported Computer execution owner kind: ${String(ownerKind)}`);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error("Computer control generation must be a positive integer");
  return Object.freeze({
    nodeId: id(input.nodeId, "Computer execution node id"),
    screenId: id(input.screenId, "Computer execution screen id"),
    screenLeaseId: id(input.screenLeaseId, "Computer execution screen lease id"),
    ownerId: id(input.ownerId, "Computer execution owner id", 160),
    ownerKind,
    generation: input.generation,
  });
}

function normalizeBrowserAction(action: ComputerBrowserAction): ComputerBrowserAction {
  if (action.kind === "navigate") {
    const raw = boundedText(action.url, "browser URL", 4_096);
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error("browser URL must be absolute"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("browser navigation supports only http/https URLs");
    return Object.freeze({ kind: "navigate", url: url.toString() });
  }
  if (action.kind === "click") return Object.freeze({ kind: "click", target: text(action.target, "browser click target", 4_096) });
  if (action.kind === "press") return Object.freeze({ kind: "press", key: text(action.key, "browser key", 128) });
  if (action.kind === "type") {
    if (action.sensitive === true) throw new Error("sensitive browser input requires human takeover or a dedicated protected-credential flow");
    return Object.freeze({
      kind: "type",
      target: text(action.target, "browser type target", 4_096),
      text: boundedText(action.text, "browser type text", 16_384),
      ...(action.sensitive === undefined ? {} : { sensitive: false }),
    });
  }
  throw new Error(`unsupported browser action: ${String((action as { kind?: unknown }).kind)}`);
}

function automationOrder(capabilities: ComputerNodeCapabilities): readonly ComputerAutomationMode[] {
  const modes: ComputerAutomationMode[] = [];
  if (capabilities.playwright) modes.push("playwright-dom");
  if (capabilities.accessibility) modes.push("accessibility");
  if (capabilities.cdp) modes.push("cdp");
  if (capabilities.visualControl) modes.push("visual");
  return Object.freeze(modes);
}

function linkAbort(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (source === undefined) return undefined;
  source.throwIfAborted();
  const listener = () => target.abort(source.reason);
  source.addEventListener("abort", listener, { once: true });
  return () => source.removeEventListener("abort", listener);
}

export function createComputerService(options: ComputerServiceOptions = {}): ComputerService {
  const now = options.now ?? (() => Date.now());
  const idFactory = options.idFactory ?? randomUUID;
  const intervalMs = pollInterval(options.pollIntervalMs);
  const nodes = new Map<string, NodeState>();
  const screenLeases = new Map<string, MutableScreenLease>();
  const ownerLeaseIds = new Map<string, string>();
  const controlLeases = new Map<string, MutableControlLease>();
  const actionsByScreenLease = new Map<string, Set<AbortController>>();
  const waiters = new Map<string, WaitingRequest>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let mutationTail: Promise<void> = Promise.resolve();
  let waiterDrain: Promise<void> | undefined;

  const publish = (type: string, subject: string, data?: Record<string, string | number | boolean | null>): void => {
    options.publishEvent?.(type, subject, data);
  };

  const serialize = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const assertOpen = (): void => {
    if (closed) throw new Error("computer service is closed");
  };

  const abortScreenActions = (screenLeaseId: string, reason: string): void => {
    const controllers = actionsByScreenLease.get(screenLeaseId);
    if (!controllers) return;
    for (const controller of controllers) controller.abort(new Error(reason));
    actionsByScreenLease.delete(screenLeaseId);
  };

  const beginScreenAction = (
    screenLeaseId: string,
    signal?: AbortSignal,
  ): Readonly<{ controller: AbortController; unlink?: (() => void) | undefined }> => {
    const controller = new AbortController();
    const unlink = linkAbort(signal, controller);
    const active = actionsByScreenLease.get(screenLeaseId) ?? new Set<AbortController>();
    active.add(controller);
    actionsByScreenLease.set(screenLeaseId, active);
    return Object.freeze({ controller, ...(unlink === undefined ? {} : { unlink }) });
  };

  const finishScreenAction = (screenLeaseId: string, controller: AbortController, unlink?: () => void): void => {
    unlink?.();
    const active = actionsByScreenLease.get(screenLeaseId);
    active?.delete(controller);
    if (active?.size === 0) actionsByScreenLease.delete(screenLeaseId);
  };

  const nodeLeaseCount = (nodeId: string): number => [...screenLeases.values()].filter((lease) => lease.nodeId === nodeId).length;

  const activeScreenIds = (nodeId: string): ReadonlySet<string> => new Set(
    [...screenLeases.values()].filter((lease) => lease.nodeId === nodeId).map((lease) => lease.screenId),
  );

  const hasTimerWork = (): boolean => screenLeases.size > 0 || waiters.size > 0 || [...controlLeases.values()].some((lease) => lease.holder === "human" && lease.handBackAfterMs !== null);

  const stopTimerIfIdle = (): void => {
    if (timer !== undefined && !hasTimerWork()) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const ensureTimer = (): void => {
    if (timer !== undefined || closed || !hasTimerWork()) return;
    timer = setInterval(() => {
      void service.expireLeases().catch((error: unknown) => {
        reportOperationalError({ component: "computer", operation: "expire Computer screen leases", error, severity: "warn" });
      });
      void service.sweepIdleTakeovers().catch((error: unknown) => {
        reportOperationalError({ component: "computer", operation: "sweep idle Computer takeovers", error, severity: "warn" });
      });
      if (waiters.size > 0) {
        void drainWaiters().catch((error: unknown) => {
          reportOperationalError({ component: "computer", operation: "retry waiting Computer admission", error, severity: "warn" });
        });
      }
    }, intervalMs);
    timer.unref?.();
  };

  const refreshState = async (state: NodeState, signal?: AbortSignal): Promise<ComputerNode> => {
    signal?.throwIfAborted();
    try {
      const snapshot = normalizeRuntimeSnapshot(await state.adapter.snapshot(signal), state.node.capabilities);
      const updatedAt = iso(now());
      state.node = Object.freeze({
        ...state.node,
        availability: snapshot.availability,
        resources: snapshot.resources,
        screens: snapshot.screens,
        ...(snapshot.browser === undefined ? { browser: undefined } : { browser: snapshot.browser }),
        updatedAt,
      });
      return cloneNode(state.node);
    } catch (error) {
      const updatedAt = iso(now());
      state.node = Object.freeze({ ...state.node, availability: "degraded", updatedAt });
      publish("computer.node.refresh-failed", `computer:${state.node.id}`, { nodeId: state.node.id });
      if (error instanceof Error && error.name === "AbortError") throw error;
      return cloneNode(state.node);
    }
  };

  const requestReasonsForNode = (state: NodeState, request: ComputerScreenRequest): readonly ComputerAdmissionReason[] => {
    const reasons: ComputerAdmissionReason[] = [];
    const node = state.node;
    if (node.availability !== "online") reasons.push("node-unavailable");
    if (request.requireBrowser === true && !node.capabilities.browser) reasons.push("browser-unavailable");
    const demandMemory = request.demand?.memoryMb ?? 0;
    const demandRenderers = request.demand?.browserRenderers ?? 0;
    if (!Number.isFinite(demandMemory) || demandMemory < 0) throw new Error("computer demand.memoryMb must be non-negative");
    if (!Number.isSafeInteger(demandRenderers) || demandRenderers < 0) throw new Error("computer demand.browserRenderers must be a non-negative integer");
    if (node.resources.availableMemoryMb - demandMemory < node.admission.minAvailableMemoryMb) reasons.push("memory-pressure");
    if (node.resources.cpuPercent > node.admission.maxCpuPercent) reasons.push("cpu-pressure");
    if (node.resources.browserRendererCount + demandRenderers > node.admission.maxBrowserRenderers) reasons.push("browser-renderer-pressure");
    if (request.demand?.gpu === true && node.resources.gpuPercent !== undefined && node.resources.gpuPercent > node.admission.maxGpuPercent) reasons.push("gpu-pressure");
    if (node.resources.screenWorkloadPercent > node.admission.maxScreenWorkloadPercent) reasons.push("screen-pressure");
    const occupied = activeScreenIds(node.id);
    const candidateScreens = node.screens.filter((screen) => screen.kind === "agent" && !occupied.has(screen.id));
    if (request.preferredScreenId !== undefined) {
      const preferredScreenId = id(request.preferredScreenId, "preferred screen id");
      if (!candidateScreens.some((screen) => screen.id === preferredScreenId)) reasons.push("screen-unavailable");
    } else if (candidateScreens.length === 0) {
      reasons.push("screen-unavailable");
    }
    return Object.freeze([...new Set(reasons)]);
  };

  const grantFromExisting = (request: ComputerScreenRequest): ComputerScreenGrant | undefined => {
    const existingId = ownerLeaseIds.get(request.ownerId);
    if (!existingId) return undefined;
    const screenLease = screenLeases.get(existingId);
    const controlLease = controlLeases.get(existingId);
    if (!screenLease || !controlLease) return undefined;
    if (request.preferredNodeId !== undefined && id(request.preferredNodeId, "preferred node id") !== screenLease.nodeId) {
      throw new Error(`Computer owner ${request.ownerId} already holds a screen on ${screenLease.nodeId}`);
    }
    if (request.preferredScreenId !== undefined && id(request.preferredScreenId, "preferred screen id") !== screenLease.screenId) {
      throw new Error(`Computer owner ${request.ownerId} already holds screen ${screenLease.screenId}`);
    }
    return Object.freeze({ state: "acquired", screenLease: cloneScreenLease(screenLease), controlLease: cloneControlLease(controlLease) });
  };

  const tryAcquire = (rawRequest: ComputerScreenRequest): ComputerScreenRequestResult => {
    assertOpen();
    const request: ComputerScreenRequest = Object.freeze({
      ownerId: id(rawRequest.ownerId, "Computer screen owner id", 160),
      ...(rawRequest.preferredNodeId === undefined ? {} : { preferredNodeId: id(rawRequest.preferredNodeId, "preferred node id") }),
      ...(rawRequest.preferredScreenId === undefined ? {} : { preferredScreenId: id(rawRequest.preferredScreenId, "preferred screen id") }),
      ...(rawRequest.requireBrowser === undefined ? {} : { requireBrowser: Boolean(rawRequest.requireBrowser) }),
      ...(rawRequest.demand === undefined ? {} : { demand: Object.freeze({ ...rawRequest.demand }) }),
      ...(rawRequest.leaseTtlMs === undefined ? {} : { leaseTtlMs: leaseTtl(rawRequest.leaseTtlMs) }),
    });
    const existing = grantFromExisting(request);
    if (existing) return existing;

    const states = [...nodes.values()]
      .filter((state) => request.preferredNodeId === undefined || state.node.id === request.preferredNodeId)
      .sort((left, right) => left.node.id.localeCompare(right.node.id));
    const aggregateReasons: ComputerAdmissionReason[] = [];
    for (const state of states) {
      const reasons = requestReasonsForNode(state, request);
      aggregateReasons.push(...reasons);
      if (reasons.length > 0) continue;
      const occupied = activeScreenIds(state.node.id);
      const screen = state.node.screens.find((candidate) =>
        candidate.kind === "agent"
        && !occupied.has(candidate.id)
        && (request.preferredScreenId === undefined || candidate.id === request.preferredScreenId));
      if (!screen) continue;
      const timestamp = now();
      const acquiredAt = iso(timestamp);
      const ttl = leaseTtl(request.leaseTtlMs);
      const screenLease: MutableScreenLease = {
        id: id(idFactory(), "screen lease id"),
        nodeId: state.node.id,
        screenId: screen.id,
        ownerId: request.ownerId,
        acquiredAt,
        expiresAt: iso(timestamp + ttl),
      };
      const controlLease: MutableControlLease = {
        id: id(idFactory(), "control lease id"),
        screenLeaseId: screenLease.id,
        nodeId: screenLease.nodeId,
        screenId: screenLease.screenId,
        holder: "agent",
        holderId: request.ownerId,
        agentOwnerId: request.ownerId,
        generation: 1,
        acquiredAt,
        lastActivityAt: acquiredAt,
        handBackAfterMs: null,
      };
      screenLeases.set(screenLease.id, screenLease);
      ownerLeaseIds.set(request.ownerId, screenLease.id);
      controlLeases.set(screenLease.id, controlLease);
      publish("computer.screen.leased", `computer:${screenLease.nodeId}:screen:${screenLease.screenId}`, {
        nodeId: screenLease.nodeId,
        screenId: screenLease.screenId,
        screenLeaseId: screenLease.id,
        ownerId: request.ownerId,
      });
      ensureTimer();
      return Object.freeze({ state: "acquired", screenLease: cloneScreenLease(screenLease), controlLease: cloneControlLease(controlLease) });
    }
    const reasons = aggregateReasons.length > 0 ? [...new Set(aggregateReasons)] : ["node-unavailable" as const];
    return Object.freeze({
      state: "waiting",
      code: "WAITING_FOR_COMPUTER",
      ownerId: request.ownerId,
      reasons: Object.freeze(reasons),
    });
  };

  const removeWaiter = (waiter: WaitingRequest): void => {
    waiters.delete(waiter.id);
    if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener("abort", waiter.abortListener);
    stopTimerIfIdle();
  };

  const drainWaiters = async (): Promise<void> => {
    if (waiterDrain) return waiterDrain;
    waiterDrain = (async () => {
      if (closed || waiters.size === 0) return;
      await service.refreshAll().catch(() => Object.freeze([]));
      for (const waiter of [...waiters.values()]) {
        if (waiter.signal?.aborted) {
          removeWaiter(waiter);
          waiter.reject(waiter.signal.reason ?? new Error("Computer screen wait aborted"));
          continue;
        }
        const result = await serialize(() => tryAcquire(waiter.request));
        if (result.state === "acquired") {
          removeWaiter(waiter);
          waiter.resolve(result);
        }
      }
    })().finally(() => { waiterDrain = undefined; });
    return waiterDrain;
  };

  const releaseInternal = (screenLeaseId: string, reason: "released" | "expired" | "node-unregistered"): boolean => {
    const lease = screenLeases.get(screenLeaseId);
    if (!lease) return false;
    abortScreenActions(screenLeaseId, `Computer screen lease ${reason}`);
    screenLeases.delete(screenLeaseId);
    ownerLeaseIds.delete(lease.ownerId);
    controlLeases.delete(screenLeaseId);
    publish(`computer.screen.${reason}`, `computer:${lease.nodeId}:screen:${lease.screenId}`, {
      nodeId: lease.nodeId,
      screenId: lease.screenId,
      screenLeaseId: lease.id,
      ownerId: lease.ownerId,
    });
    stopTimerIfIdle();
    return true;
  };

  const requireNodeState = (nodeIdInput: string): NodeState => {
    const nodeId = id(nodeIdInput, "Computer node id");
    const state = nodes.get(nodeId);
    if (!state) throw new Error(`Computer node not found: ${nodeId}`);
    return state;
  };

  const requireScreenLease = (leaseIdInput: string): MutableScreenLease => {
    const leaseId = id(leaseIdInput, "screen lease id");
    const lease = screenLeases.get(leaseId);
    if (!lease) throw new Error(`Computer screen lease not found: ${leaseId}`);
    return lease;
  };

  const requireControlLease = (screenLeaseIdInput: string): MutableControlLease => {
    const screenLeaseId = id(screenLeaseIdInput, "screen lease id");
    const lease = controlLeases.get(screenLeaseId);
    if (!lease) throw new Error(`Computer control lease not found for screen lease: ${screenLeaseId}`);
    return lease;
  };

  const assertNoActiveNodeLeases = (nodeId: string): void => {
    const count = nodeLeaseCount(nodeId);
    if (count > 0) throw new Error(`Computer node ${nodeId} has ${count} active screen lease${count === 1 ? "" : "s"}`);
  };

  const refreshAfterLifecycle = async (state: NodeState, signal?: AbortSignal): Promise<ComputerNode> => {
    return refreshState(state, signal);
  };

  const service: ComputerService = {
    async registerNode(adapter) {
      assertOpen();
      const descriptor = normalizeDescriptor(adapter.descriptor);
      if (descriptor.deviceId !== undefined) await options.validateDevice?.(descriptor.deviceId);
      const snapshot = normalizeRuntimeSnapshot(await adapter.snapshot(), descriptor.capabilities);
      return serialize(() => {
        assertOpen();
        if (nodes.has(descriptor.id)) throw new Error(`Computer node already registered: ${descriptor.id}`);
        if (nodes.size >= MAX_NODES) throw new Error(`Computer node limit reached (${MAX_NODES})`);
        const timestamp = iso(now());
        const node: ComputerNode = Object.freeze({
          id: descriptor.id,
          label: descriptor.label,
          platform: descriptor.platform,
          ...(descriptor.deviceId === undefined ? {} : { deviceId: descriptor.deviceId }),
          capabilities: descriptor.capabilities,
          admission: descriptor.admission,
          availability: snapshot.availability,
          resources: snapshot.resources,
          screens: snapshot.screens,
          ...(snapshot.browser === undefined ? {} : { browser: snapshot.browser }),
          registeredAt: timestamp,
          updatedAt: timestamp,
        });
        nodes.set(node.id, { adapter, node });
        publish("computer.node.registered", `computer:${node.id}`, { nodeId: node.id, platform: node.platform });
        void drainWaiters();
        return cloneNode(node);
      });
    },

    async unregisterNode(nodeIdInput, unregisterOptions = {}) {
      const nodeId = id(nodeIdInput, "Computer node id");
      let adapter: ComputerNodeAdapter | undefined;
      const removed = await serialize(() => {
        const state = nodes.get(nodeId);
        if (!state) return false;
        const active = [...screenLeases.values()].filter((lease) => lease.nodeId === nodeId);
        if (active.length > 0 && unregisterOptions.force !== true) {
          throw new Error(`Computer node ${nodeId} still has active screen leases`);
        }
        for (const lease of active) releaseInternal(lease.id, "node-unregistered");
        nodes.delete(nodeId);
        adapter = state.adapter;
        publish("computer.node.unregistered", `computer:${nodeId}`, { nodeId });
        return true;
      });
      if (removed) await adapter?.close?.();
      void drainWaiters();
      return removed;
    },

    async refreshNode(nodeIdInput, signal) {
      assertOpen();
      const state = requireNodeState(nodeIdInput);
      const refreshed = await refreshState(state, signal);
      void drainWaiters();
      return refreshed;
    },

    async refreshAll(signal) {
      assertOpen();
      const result: ComputerNode[] = [];
      for (const state of nodes.values()) {
        signal?.throwIfAborted();
        result.push(await refreshState(state, signal));
      }
      return Object.freeze(result);
    },

    node(nodeIdInput) {
      const state = nodes.get(id(nodeIdInput, "Computer node id"));
      return state ? cloneNode(state.node) : undefined;
    },

    nodes() {
      return Object.freeze([...nodes.values()].map((state) => cloneNode(state.node)).sort((left, right) => left.id.localeCompare(right.id)));
    },

    status(): ComputerStatusSnapshot {
      const activeLeases = [...screenLeases.values()];
      const nodeValues = [...nodes.values()].map((state) => state.node).sort((left, right) => left.id.localeCompare(right.id));
      return Object.freeze({
        nodes: nodeValues.length,
        online: nodeValues.filter((node) => node.availability === "online").length,
        degraded: nodeValues.filter((node) => node.availability === "degraded").length,
        offline: nodeValues.filter((node) => node.availability === "offline").length,
        activeScreenLeases: activeLeases.length,
        humanTakeovers: activeLeases.filter((lease) => controlLeases.get(lease.id)?.holder === "human").length,
        waitingRequests: waiters.size,
        nodeStatus: Object.freeze(nodeValues.map((node) => Object.freeze({
          id: node.id,
          label: node.label,
          platform: node.platform,
          availability: node.availability,
          agentScreens: node.screens.filter((screen) => screen.kind === "agent").length,
          leasedScreens: activeLeases.filter((lease) => lease.nodeId === node.id).length,
          browser: node.browser === undefined
            ? Object.freeze({ available: node.capabilities.browser, running: false })
            : Object.freeze({
              available: node.capabilities.browser,
              running: node.browser.running,
              persistentProfile: node.browser.persistentProfile,
              windows: node.browser.windows.length,
              tabs: node.browser.tabs.length,
            }),
          resources: Object.freeze({ ...node.resources }),
        }))),
      });
    },

    leaseStatus(): readonly ComputerLeaseStatus[] {
      return Object.freeze([...screenLeases.values()]
        .sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt) || left.id.localeCompare(right.id))
        .map((lease) => {
          const control = controlLeases.get(lease.id);
          return Object.freeze({
            screenLeaseId: lease.id,
            nodeId: lease.nodeId,
            screenId: lease.screenId,
            ownerId: lease.ownerId,
            acquiredAt: lease.acquiredAt,
            expiresAt: lease.expiresAt,
            ...(control === undefined ? {} : {
              control: Object.freeze({
                holder: control.holder,
                generation: control.generation,
                acquiredAt: control.acquiredAt,
                lastActivityAt: control.lastActivityAt,
                handBackAfterMs: control.handBackAfterMs,
                transcriptPolicy: TRANSCRIPT_POLICY,
              }),
            }),
          });
        }));
    },

    screenLeases() {
      return Object.freeze([...screenLeases.values()].map(cloneScreenLease).sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt)));
    },

    controlLease(screenLeaseIdInput) {
      const lease = controlLeases.get(id(screenLeaseIdInput, "screen lease id"));
      return lease ? cloneControlLease(lease) : undefined;
    },

    async requestScreen(request) {
      assertOpen();
      await service.expireLeases();
      await service.refreshAll().catch(() => Object.freeze([]));
      return serialize(() => tryAcquire(request));
    },

    async waitForScreen(request, signal, onWaiting) {
      signal?.throwIfAborted();
      const immediate = await service.requestScreen(request);
      if (immediate.state === "acquired") return immediate;
      await onWaiting?.(immediate);
      signal?.throwIfAborted();
      if (waiters.size >= MAX_WAITERS) throw new Error(`Computer wait queue limit reached (${MAX_WAITERS})`);
      return new Promise<ComputerScreenGrant>((resolve, reject) => {
        const waiterId = id(idFactory(), "Computer waiter id");
        const abortListener = signal === undefined ? undefined : () => {
          const waiter = waiters.get(waiterId);
          if (!waiter) return;
          removeWaiter(waiter);
          reject(signal.reason ?? new Error("Computer screen wait aborted"));
        };
        const waiter: WaitingRequest = Object.freeze({
          id: waiterId,
          request: Object.freeze({ ...request }),
          resolve,
          reject,
          ...(signal === undefined ? {} : { signal }),
          ...(abortListener === undefined ? {} : { abortListener }),
        });
        waiters.set(waiterId, waiter);
        signal?.addEventListener("abort", abortListener!, { once: true });
        publish("computer.admission.waiting", `computer-wait:${waiterId}`, { ownerId: request.ownerId, code: "WAITING_FOR_COMPUTER" });
        ensureTimer();
        void drainWaiters();
      });
    },

    async renewScreenLease(screenLeaseIdInput, ownerIdInput, ttlMs) {
      const ownerId = id(ownerIdInput, "Computer screen owner id", 160);
      const ttl = leaseTtl(ttlMs);
      return serialize(() => {
        const lease = requireScreenLease(screenLeaseIdInput);
        if (lease.ownerId !== ownerId) throw new Error("Computer screen lease owner mismatch");
        lease.expiresAt = iso(now() + ttl);
        publish("computer.screen.renewed", `computer:${lease.nodeId}:screen:${lease.screenId}`, { screenLeaseId: lease.id, ownerId });
        ensureTimer();
        return cloneScreenLease(lease);
      });
    },

    async releaseScreen(screenLeaseIdInput, ownerIdInput) {
      const ownerId = id(ownerIdInput, "Computer screen owner id", 160);
      const released = await serialize(() => {
        const lease = screenLeases.get(id(screenLeaseIdInput, "screen lease id"));
        if (!lease) return false;
        if (lease.ownerId !== ownerId) throw new Error("Computer screen lease owner mismatch");
        return releaseInternal(lease.id, "released");
      });
      if (released) void drainWaiters();
      return released;
    },

    async expireLeases(timestamp = now()) {
      if (!Number.isFinite(timestamp)) throw new Error("lease expiry timestamp is invalid");
      const expired = await serialize(() => {
        let count = 0;
        for (const lease of [...screenLeases.values()]) {
          if (parseTimestamp(lease.expiresAt) <= timestamp && releaseInternal(lease.id, "expired")) count += 1;
        }
        return count;
      });
      if (expired > 0) void drainWaiters();
      return expired;
    },

    async takeOver(screenLeaseIdInput, humanOwnerIdInput, handBackAfterMs) {
      const humanOwnerId = id(humanOwnerIdInput, "human control owner id", 160);
      const delay = handBackDelay(handBackAfterMs);
      return serialize(() => {
        const screenLease = requireScreenLease(screenLeaseIdInput);
        const control = requireControlLease(screenLease.id);
        if (control.holder === "human" && control.holderId !== humanOwnerId) throw new Error("Computer screen is already under another human takeover");
        abortScreenActions(screenLease.id, "Human takeover invalidated pending Computer actions");
        const timestamp = iso(now());
        control.holder = "human";
        control.holderId = humanOwnerId;
        control.generation += 1;
        control.acquiredAt = timestamp;
        control.lastActivityAt = timestamp;
        control.handBackAfterMs = delay;
        publish("computer.control.taken-over", `computer:${control.nodeId}:screen:${control.screenId}`, {
          nodeId: control.nodeId,
          screenId: control.screenId,
          screenLeaseId: control.screenLeaseId,
          generation: control.generation,
          manualHandBack: delay === null,
        });
        ensureTimer();
        return cloneControlLease(control);
      });
    },

    async recordHumanActivity(screenLeaseIdInput, humanOwnerIdInput) {
      const humanOwnerId = id(humanOwnerIdInput, "human control owner id", 160);
      return serialize(() => {
        const screenLease = requireScreenLease(screenLeaseIdInput);
        const control = requireControlLease(screenLease.id);
        if (control.holder !== "human" || control.holderId !== humanOwnerId) throw new Error("human control lease owner mismatch");
        control.generation += 1;
        control.lastActivityAt = iso(now());
        return cloneControlLease(control);
      });
    },

    async handBack(screenLeaseIdInput, humanOwnerIdInput, signal) {
      signal?.throwIfAborted();
      const humanOwnerId = id(humanOwnerIdInput, "human control owner id", 160);
      const prepared = await serialize(() => {
        const screenLease = requireScreenLease(screenLeaseIdInput);
        const control = requireControlLease(screenLease.id);
        if (control.holder !== "human" || control.holderId !== humanOwnerId) throw new Error("human control lease owner mismatch");
        const state = requireNodeState(screenLease.nodeId);
        abortScreenActions(screenLease.id, "Computer hand-back invalidated pending actions");
        control.generation += 1;
        control.lastActivityAt = iso(now());
        return Object.freeze({
          screenLeaseId: screenLease.id,
          screenId: screenLease.screenId,
          generation: control.generation,
          activityAt: control.lastActivityAt,
          adapter: state.adapter,
        });
      });

      const observation = normalizeObservation(
        await prepared.adapter.observeScreen(prepared.screenId, prepared.generation, signal),
        prepared.screenId,
      );
      const controlLease = await serialize(() => {
        const screenLease = requireScreenLease(prepared.screenLeaseId);
        const control = requireControlLease(screenLease.id);
        if (control.holder !== "human" || control.holderId !== humanOwnerId) throw new Error("Computer control changed during hand-back");
        if (control.generation !== prepared.generation || control.lastActivityAt !== prepared.activityAt) {
          throw new Error("Human activity resumed during Computer hand-back; fresh re-observation is required");
        }
        const timestamp = iso(now());
        control.holder = "agent";
        control.holderId = control.agentOwnerId;
        control.acquiredAt = timestamp;
        control.lastActivityAt = timestamp;
        control.handBackAfterMs = null;
        publish("computer.control.handed-back", `computer:${control.nodeId}:screen:${control.screenId}`, {
          nodeId: control.nodeId,
          screenId: control.screenId,
          screenLeaseId: control.screenLeaseId,
          generation: control.generation,
        });
        stopTimerIfIdle();
        return cloneControlLease(control);
      });
      return Object.freeze({ controlLease, observation });
    },

    async sweepIdleTakeovers(timestamp = now()) {
      if (!Number.isFinite(timestamp)) throw new Error("idle hand-back timestamp is invalid");
      const candidates = await serialize(() => [...controlLeases.values()]
        .filter((control) => control.holder === "human" && control.handBackAfterMs !== null
          && parseTimestamp(control.lastActivityAt) + control.handBackAfterMs <= timestamp)
        .map((control) => ({ screenLeaseId: control.screenLeaseId, humanOwnerId: control.holderId })));
      let handedBack = 0;
      for (const candidate of candidates) {
        try {
          await service.handBack(candidate.screenLeaseId, candidate.humanOwnerId);
          handedBack += 1;
        } catch (error) {
          // Fail closed: the human keeps control until a fresh hand-back can re-observe successfully.
          reportOperationalError({ component: "computer", operation: "hand back idle Computer control", error, severity: "warn" });
        }
      }
      stopTimerIfIdle();
      return handedBack;
    },

    assertAgentControl(screenLeaseIdInput, ownerIdInput, generation) {
      const screenLease = requireScreenLease(screenLeaseIdInput);
      const ownerId = id(ownerIdInput, "Computer screen owner id", 160);
      const control = requireControlLease(screenLease.id);
      if (screenLease.ownerId !== ownerId || control.agentOwnerId !== ownerId) throw new Error("Computer screen lease owner mismatch");
      if (control.holder !== "agent" || control.holderId !== ownerId) throw new Error("Computer screen is under human control");
      if (!Number.isSafeInteger(generation) || control.generation !== generation) throw new Error("stale Computer control generation; re-observe and replan before acting");
      if (parseTimestamp(screenLease.expiresAt) <= now()) throw new Error("Computer screen lease has expired");
      return cloneControlLease(control);
    },

    async runTool(rawBinding, rawRequest, signal) {
      signal?.throwIfAborted();
      const binding = normalizeExecutionBinding(rawBinding);
      const request = normalizeToolRequest(rawRequest);
      const operation = executionOperationForTool(request.tool);
      const prepared = await serialize(() => {
        const control = service.assertAgentControl(binding.screenLeaseId, binding.ownerId, binding.generation);
        const screenLease = requireScreenLease(control.screenLeaseId);
        if (screenLease.nodeId !== binding.nodeId || screenLease.screenId !== binding.screenId) {
          throw new Error("Computer execution binding does not match the active screen lease");
        }
        const state = requireNodeState(screenLease.nodeId);
        if (!state.node.capabilities.executionOperations.includes(operation)) {
          throw new Error(`Computer node ${state.node.id} does not support ${operation} execution`);
        }
        if (!state.adapter.runTool) throw new Error(`Computer node ${state.node.id} does not provide tool execution`);
        const action = beginScreenAction(screenLease.id, signal);
        return Object.freeze({
          screenLeaseId: screenLease.id,
          screenId: screenLease.screenId,
          nodeId: screenLease.nodeId,
          adapter: state.adapter,
          controller: action.controller,
          ...(action.unlink === undefined ? {} : { unlink: action.unlink }),
        });
      });
      try {
        const result = await prepared.adapter.runTool!({
          workspace: request.workspace,
          tool: request.tool,
          operation,
          input: request.input,
          screenId: prepared.screenId,
          screenLeaseId: prepared.screenLeaseId,
          ownerId: binding.ownerId,
          ownerKind: binding.ownerKind,
          controlGeneration: binding.generation,
          signal: prepared.controller.signal,
        });
        prepared.controller.signal.throwIfAborted();
        service.assertAgentControl(prepared.screenLeaseId, binding.ownerId, binding.generation);
        const normalized = normalizeToolResult(result);
        publish("computer.tool.executed", `computer:${prepared.nodeId}:screen:${prepared.screenId}`, {
          nodeId: prepared.nodeId,
          screenId: prepared.screenId,
          tool: request.tool,
          operation,
          generation: binding.generation,
        });
        return normalized;
      } finally {
        finishScreenAction(prepared.screenLeaseId, prepared.controller, prepared.unlink);
      }
    },

    async observeScreen(screenLeaseIdInput, ownerIdInput, generation, signal) {
      signal?.throwIfAborted();
      const prepared = await serialize(() => {
        const control = service.assertAgentControl(screenLeaseIdInput, ownerIdInput, generation);
        const screenLease = requireScreenLease(control.screenLeaseId);
        const state = requireNodeState(screenLease.nodeId);
        const action = beginScreenAction(screenLease.id, signal);
        return Object.freeze({
          screenLeaseId: screenLease.id,
          screenId: screenLease.screenId,
          nodeId: screenLease.nodeId,
          adapter: state.adapter,
          controller: action.controller,
          ...(action.unlink === undefined ? {} : { unlink: action.unlink }),
        });
      });
      try {
        const observation = normalizeObservation(
          await prepared.adapter.observeScreen(prepared.screenId, generation, prepared.controller.signal),
          prepared.screenId,
        );
        prepared.controller.signal.throwIfAborted();
        service.assertAgentControl(prepared.screenLeaseId, ownerIdInput, generation);
        publish("computer.screen.observed", `computer:${prepared.nodeId}:screen:${prepared.screenId}`, {
          nodeId: prepared.nodeId,
          screenId: prepared.screenId,
          generation,
        });
        return observation;
      } finally {
        finishScreenAction(prepared.screenLeaseId, prepared.controller, prepared.unlink);
      }
    },

    async runBrowserAction(screenLeaseIdInput, ownerIdInput, generation, rawAction, signal) {
      signal?.throwIfAborted();
      const action = normalizeBrowserAction(rawAction);
      const prepared = await serialize(() => {
        const control = service.assertAgentControl(screenLeaseIdInput, ownerIdInput, generation);
        const screenLease = requireScreenLease(control.screenLeaseId);
        const state = requireNodeState(screenLease.nodeId);
        if (!state.node.capabilities.browser || !state.adapter.runBrowserAction) throw new Error(`Computer node ${state.node.id} does not provide browser automation`);
        const order = automationOrder(state.node.capabilities);
        if (order.length === 0) throw new Error(`Computer node ${state.node.id} has no browser automation mode`);
        const pending = beginScreenAction(screenLease.id, signal);
        return Object.freeze({
          screenLeaseId: screenLease.id,
          screenId: screenLease.screenId,
          nodeId: screenLease.nodeId,
          adapter: state.adapter,
          order,
          controller: pending.controller,
          ...(pending.unlink === undefined ? {} : { unlink: pending.unlink }),
        });
      });
      try {
        const result = await prepared.adapter.runBrowserAction!({
          screenId: prepared.screenId,
          controlGeneration: generation,
          action,
          automationOrder: prepared.order,
          signal: prepared.controller.signal,
        });
        prepared.controller.signal.throwIfAborted();
        if (!prepared.order.includes(result.mode)) throw new Error(`Computer provider used disallowed browser automation mode: ${result.mode}`);
        service.assertAgentControl(prepared.screenLeaseId, ownerIdInput, generation);
        const normalizedResult: ComputerBrowserActionResult = Object.freeze({
          mode: result.mode,
          observation: normalizeObservation(result.observation, prepared.screenId),
        });
        publish("computer.browser.action-completed", `computer:${prepared.nodeId}:screen:${prepared.screenId}`, {
          nodeId: prepared.nodeId,
          screenId: prepared.screenId,
          action: action.kind,
          mode: result.mode,
          generation,
        });
        return normalizedResult;
      } finally {
        finishScreenAction(prepared.screenLeaseId, prepared.controller, prepared.unlink);
      }
    },

    async restartNode(nodeIdInput, signal) {
      const state = requireNodeState(nodeIdInput);
      assertNoActiveNodeLeases(state.node.id);
      if (!state.node.capabilities.managedLifecycle || !state.adapter.restart) throw new Error(`Computer node ${state.node.id} does not support managed restart`);
      publish("computer.node.restart-requested", `computer:${state.node.id}`, { nodeId: state.node.id });
      await state.adapter.restart(signal);
      const node = await refreshAfterLifecycle(state, signal);
      publish("computer.node.restarted", `computer:${state.node.id}`, { nodeId: state.node.id });
      return node;
    },

    async updateNode(nodeIdInput, signal) {
      const state = requireNodeState(nodeIdInput);
      assertNoActiveNodeLeases(state.node.id);
      if (!state.node.capabilities.managedLifecycle || !state.adapter.update) throw new Error(`Computer node ${state.node.id} does not support managed update`);
      publish("computer.node.update-requested", `computer:${state.node.id}`, { nodeId: state.node.id });
      await state.adapter.update(signal);
      const node = await refreshAfterLifecycle(state, signal);
      publish("computer.node.updated", `computer:${state.node.id}`, { nodeId: state.node.id });
      return node;
    },

    async resetManagedState(nodeIdInput, signal) {
      const state = requireNodeState(nodeIdInput);
      assertNoActiveNodeLeases(state.node.id);
      if (!state.node.capabilities.managedLifecycle || !state.adapter.resetManagedState) throw new Error(`Computer node ${state.node.id} does not support managed reset`);
      publish("computer.node.reset-requested", `computer:${state.node.id}`, { nodeId: state.node.id, scope: "friday-managed-agent-state" });
      await state.adapter.resetManagedState(signal);
      const node = await refreshAfterLifecycle(state, signal);
      publish("computer.node.reset", `computer:${state.node.id}`, { nodeId: state.node.id, scope: "friday-managed-agent-state" });
      return node;
    },

    async doctor() {
      if (!closed) await service.refreshAll().catch(() => Object.freeze([]));
      const reports: ComputerDoctorNodeReport[] = service.nodes().map((node) => {
        const issues: string[] = [];
        if (node.availability !== "online") issues.push(`node is ${node.availability}`);
        const availableAgentScreens = node.screens.filter((screen) => screen.kind === "agent" && !activeScreenIds(node.id).has(screen.id)).length;
        if (node.screens.every((screen) => screen.kind !== "agent")) issues.push("node has no Agent screen");
        if (node.capabilities.browser && node.browser?.persistentProfile !== true) issues.push("persistent browser profile is not ready");
        if (node.resources.availableMemoryMb < node.admission.minAvailableMemoryMb) issues.push("available memory is below admission threshold");
        if (node.resources.cpuPercent > node.admission.maxCpuPercent) issues.push("CPU utilization exceeds admission threshold");
        if (node.resources.browserRendererCount > node.admission.maxBrowserRenderers) issues.push("browser renderer count exceeds admission threshold");
        if (node.resources.gpuPercent !== undefined && node.resources.gpuPercent > node.admission.maxGpuPercent) issues.push("GPU utilization exceeds admission threshold");
        if (node.resources.screenWorkloadPercent > node.admission.maxScreenWorkloadPercent) issues.push("screen workload exceeds admission threshold");
        const status = node.availability === "offline" ? "unavailable" as const : issues.length > 0 ? "degraded" as const : "ok" as const;
        return Object.freeze({
          nodeId: node.id,
          status,
          issues: Object.freeze(issues),
          availableAgentScreens,
          activeScreenLeases: nodeLeaseCount(node.id),
        });
      });
      const status = reports.length === 0
        ? "unavailable" as const
        : reports.some((report) => report.status === "unavailable")
          ? "degraded" as const
          : reports.some((report) => report.status === "degraded")
            ? "degraded" as const
            : "ok" as const;
      const report: ComputerDoctorReport = Object.freeze({ status, nodes: Object.freeze(reports), waitingRequests: waiters.size });
      return report;
    },

    async close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      for (const controllers of actionsByScreenLease.values()) for (const controller of controllers) controller.abort(new Error("computer service is closing"));
      actionsByScreenLease.clear();
      for (const waiter of [...waiters.values()]) {
        removeWaiter(waiter);
        waiter.reject(new Error("computer service is closing"));
      }
      await Promise.allSettled([...nodes.values()].map((state) => Promise.resolve(state.adapter.close?.())));
      nodes.clear();
      screenLeases.clear();
      ownerLeaseIds.clear();
      controlLeases.clear();
    },
  };

  return Object.freeze(service);
}
