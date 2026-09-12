import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import type {
  ComputerBrowserAction,
  ComputerBrowserActionRequest,
  ComputerBrowserActionResult,
  ComputerBrowserSupervisorSnapshot,
  ComputerBrowserTabSnapshot,
  ComputerBrowserWindowSnapshot,
  ComputerNodeAdapter,
  ComputerNodeRuntimeSnapshot,
  ComputerObservation,
  ComputerProcessObservation,
  ComputerResourceSnapshot,
  ComputerScreenDescriptor,
} from "../contract.js";

const DEFAULT_CDP_URL = "http://127.0.0.1:9222/";
const DEFAULT_NODE_ID = "linux-local";
const DEFAULT_NODE_LABEL = "Linux Computer";
const COMMAND_TIMEOUT_MS = 5_000;
const BROWSER_ACTION_TIMEOUT_MS = 5_000;
const BROWSER_ACTION_POLL_MS = 40;
const BROWSER_INPUT_SETTLE_MS = 50;
const MAX_DOM_SUMMARY = 12_000;
const MAX_PROCESSES = 128;
const MAX_TABS = 64;
const PROTECTED_TARGET = /(password|passwd|passcode|otp|one[-_ ]?time|verification|captcha|token|secret|pin)/i;
const SECRET_ASSIGNMENT = /\b(password|passwd|passcode|otp|one[- ]time(?: password| code)?|verification(?: code)?|captcha|token|secret|pin)\s*(?::|=|\bis\b)\s*("[^"]*"|'[^']*'|[^\s,;&#<>]+)/gi;
const SECRET_NEAR_LABEL = /\b(otp|one[- ]time(?: password| code)?|verification code|passcode|password|pin)\b(?:\s+(?:is|code))?\s*[:=#-]?\s*([A-Za-z0-9][A-Za-z0-9._-]{3,63})/gi;
const VALUE_ATTRIBUTE = /\bvalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const SENSITIVE_URL_KEY = /(access[_-]?token|auth|authorization|code|credential|key|otp|pass|password|pin|secret|session|token)/i;
const SENSITIVE_TITLE = /(captcha|one[- ]time|otp|passcode|password|verification code)/i;
const PAGE_STATE_EXPRESSION = String.raw`(() => ({ href: location.href, readyState: document.readyState }))()`;
const ACTIVE_ELEMENT_SAFETY_FUNCTION = String.raw`function (expectedSelector) {
  const el = document.activeElement;
  if (!el) return { protected: false, expected: expectedSelector === null };
  const expected = expectedSelector === null ? null : document.querySelector(expectedSelector);
  const signature = [el.getAttribute?.('type'), el.getAttribute?.('name'), el.getAttribute?.('id'), el.getAttribute?.('class'), el.getAttribute?.('autocomplete'), el.getAttribute?.('aria-label'), el.getAttribute?.('placeholder'), el.getAttribute?.('role')].filter(Boolean).join(' ');
  return {
    protected: /(?:password|passwd|passcode|otp|one[-_ ]?time|verification|captcha|token|secret|pin)/i.test(signature),
    expected: expected === null || el === expected,
  };
}`;
const ELEMENT_POINT_FUNCTION = String.raw`function (selector) {
  const el = document.querySelector(selector);
  if (!el) return { found: false, protected: false, actionable: false };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const signature = [el.getAttribute('type'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('class'), el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('role')].filter(Boolean).join(' ');
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const actionable = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true';
  return { found: true, protected: /(?:password|passwd|passcode|otp|one[-_ ]?time|verification|captcha|token|secret|pin)/i.test(signature), actionable, x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) };
}`;
const DOM_SUMMARY_EXPRESSION = String.raw`(() => {
  const protectedPattern = /(password|passwd|passcode|otp|one[-_ ]?time|verification|captcha|token|secret|pin)/i;
  const root = document.body ? document.body.cloneNode(true) : null;
  if (!root) return "";
  for (const node of root.querySelectorAll("script,style,noscript,svg,canvas,video,audio")) node.remove();
  for (const node of root.querySelectorAll("input,textarea,select,option")) {
    const signature = [node.getAttribute("type"), node.getAttribute("name"), node.getAttribute("id"), node.getAttribute("class"), node.getAttribute("autocomplete"), node.getAttribute("aria-label"), node.getAttribute("placeholder"), node.getAttribute("role")].filter(Boolean).join(" ");
    const replacement = document.createElement("span");
    replacement.textContent = protectedPattern.test(signature) ? "[PROTECTED INPUT OMITTED]" : "[INPUT VALUE OMITTED]";
    node.replaceWith(replacement);
  }
  for (const node of root.querySelectorAll("[id],[class],[name],[aria-label],[role]")) {
    const signature = [node.getAttribute("id"), node.getAttribute("class"), node.getAttribute("name"), node.getAttribute("aria-label"), node.getAttribute("role")].filter(Boolean).join(" ");
    if (protectedPattern.test(signature)) node.textContent = "[PROTECTED CONTENT OMITTED]";
  }
  const text = (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 12000);
})()`;

export interface LinuxCommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LinuxCdpTarget {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly type?: string | undefined;
  readonly webSocketDebuggerUrl?: string | undefined;
}

export interface LinuxCdpClient {
  targets(signal?: AbortSignal): Promise<readonly LinuxCdpTarget[]>;
  browserCommand(method: string, params?: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
  targetCommand(targetId: string, method: string, params?: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
}

interface SwayOutput {
  readonly name?: unknown;
  readonly make?: unknown;
  readonly model?: unknown;
  readonly serial?: unknown;
  readonly active?: unknown;
  readonly scale?: unknown;
  readonly rect?: Readonly<{ readonly x?: unknown; readonly y?: unknown; readonly width?: unknown; readonly height?: unknown }> | undefined;
}

interface OutputGeometry {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly kind: "human" | "agent";
}

interface BrowserPageState {
  readonly href?: unknown;
  readonly readyState?: unknown;
}

interface BrowserElementPoint {
  readonly found?: unknown;
  readonly protected?: unknown;
  readonly actionable?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
}

export interface LinuxSwayComputerAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly uid?: number | undefined;
  readonly runCommand?: ((command: string, args: readonly string[], signal?: AbortSignal) => Promise<LinuxCommandResult>) | undefined;
  readonly cdp?: LinuxCdpClient | undefined;
  readonly now?: (() => Date) | undefined;
  readonly readText?: ((path: string) => Promise<string>) | undefined;
  readonly listDirectory?: ((path: string) => Promise<readonly string[]>) | undefined;
  readonly executable?: ((command: string) => Promise<boolean>) | undefined;
  /** Optional override used by hosts/tests that provide their own tool facade. */
  readonly runTool?: ((request: import("../contract.js").ComputerNodeToolExecutionRequest) => Promise<import("../contract.js").ComputerToolExecutionResult>) | undefined;
  readonly cleanupRunProcesses?: ((request: import("../contract.js").ComputerRunProcessCleanupRequest) => Promise<void>) | undefined;
  readonly lifecycleCommand?: ((command: string, args: readonly string[], signal?: AbortSignal) => Promise<LinuxCommandResult>) | undefined;
}

function boundedId(value: string | undefined, fallback: string, label: string): string {
  const normalized = value?.trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function boundedLabel(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() || fallback;
  if (!normalized || normalized.length > 160 || /[\0\r\n]/.test(normalized)) throw new Error("Computer node label is invalid");
  return normalized;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`Computer numeric setting is invalid: ${value}`);
  return parsed;
}

function boundedPercent(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error(`Computer percentage setting is invalid: ${value}`);
  return parsed;
}

function configuredAgentOutputs(environment: NodeJS.ProcessEnv): ReadonlySet<string> {
  return new Set((environment.FRIDAY_COMPUTER_AGENT_OUTPUTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
}

function profileDirectory(environment: NodeJS.ProcessEnv): string {
  const configured = environment.FRIDAY_COMPUTER_BROWSER_PROFILE_DIR?.trim();
  return resolve(configured || join(environment.FRIDAY_HOME?.trim() || join(homedir(), ".friday"), "computer", "chromium-profile"));
}

function opaqueHash(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function cdpBaseUrl(environment: NodeJS.ProcessEnv): URL {
  const configuredUrl = environment.FRIDAY_COMPUTER_CDP_URL?.trim();
  const configuredPort = environment.FRIDAY_COMPUTER_CDP_PORT?.trim();
  const raw = configuredUrl || (configuredPort ? `http://127.0.0.1:${configuredPort}/` : DEFAULT_CDP_URL);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("FRIDAY_COMPUTER_CDP_URL must be a valid URL"); }
  if (url.protocol !== "http:") throw new Error("FRIDAY_COMPUTER_CDP_URL must use loopback HTTP");
  if (!loopbackHost(url.hostname)) {
    throw new Error("FRIDAY_COMPUTER_CDP_URL must use a loopback host");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function loopbackWebSocketUrl(raw: string, label: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be a valid WebSocket URL`); }
  if (url.protocol !== "ws:") throw new Error(`${label} must use loopback ws`);
  if (!loopbackHost(url.hostname)) throw new Error(`${label} must use a loopback host`);
  if (url.username || url.password) throw new Error(`${label} must not contain embedded credentials`);
  return url.toString();
}

function sanitizeText(value: string, maximum: number): string {
  let safe = value.normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  safe = safe.replace(SECRET_ASSIGNMENT, (_match, name: string) => `${name}=[REDACTED]`);
  safe = safe.replace(SECRET_NEAR_LABEL, (_match, name: string) => `${name}=[REDACTED]`);
  safe = safe.replace(VALUE_ATTRIBUTE, 'value="[REDACTED]"');
  safe = safe.replace(/\b(?:captcha|verification challenge)\b[^.!?\n]{0,160}/gi, "[CAPTCHA CONTENT OMITTED]");
  return safe.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_KEY.test(key)) url.searchParams.set(key, "REDACTED");
    }
    return sanitizeText(url.toString(), 4_096);
  } catch {
    return sanitizeText(raw.replace(/[#?].*$/s, ""), 4_096);
  }
}

function sanitizeTitle(raw: string): string {
  if (SENSITIVE_TITLE.test(raw)) return "[SENSITIVE PAGE TITLE OMITTED]";
  return sanitizeText(raw, 1_024);
}

function pageTarget(target: LinuxCdpTarget): boolean {
  return (target.type ?? "page") === "page" && Boolean(target.webSocketDebuggerUrl);
}

function commandRunner(environment: NodeJS.ProcessEnv): (command: string, args: readonly string[], signal?: AbortSignal) => Promise<LinuxCommandResult> {
  return (command, args, signal) => new Promise((resolveResult) => {
    execFile(command, [...args], {
      encoding: "utf8",
      env: { ...environment },
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    }, (error, stdout, stderr) => {
      resolveResult(Object.freeze({
        ok: error === null,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? error?.message ?? ""),
      }));
    });
  });
}

async function defaultExecutable(command: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  if (command.includes("/")) {
    try { await access(command, fsConstants.X_OK); return true; } catch { return false; }
  }
  for (const directory of (environment.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":")) {
    if (!directory) continue;
    try { await access(join(directory, command), fsConstants.X_OK); return true; } catch { continue; }
  }
  return false;
}

function websocketCommand(url: string, method: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolveCommand, reject) => {
    signal?.throwIfAborted();
    const ws = new WebSocket(url, { handshakeTimeout: COMMAND_TIMEOUT_MS });
    const id = 1;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`CDP command timed out: ${method}`));
    }, COMMAND_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finishError = (error: unknown): void => {
      cleanup();
      try { ws.close(); } catch { ws.terminate(); }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = (): void => finishError(signal?.reason ?? new Error("CDP command aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.once("error", finishError);
    ws.once("open", () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.on("message", (data) => {
      let message: unknown;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (!message || typeof message !== "object" || (message as { id?: unknown }).id !== id) return;
      const record = message as { error?: { message?: unknown }; result?: unknown };
      if (record.error) {
        finishError(new Error(typeof record.error.message === "string" ? record.error.message : `CDP command failed: ${method}`));
        return;
      }
      cleanup();
      try { ws.close(); } catch { ws.terminate(); }
      resolveCommand(record.result);
    });
  });
}

export function createHttpCdpClient(environment: NodeJS.ProcessEnv = process.env): LinuxCdpClient {
  const base = cdpBaseUrl(environment);
  const json = async (path: string, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(new URL(path, base), signal === undefined ? {} : { signal });
    if (!response.ok) throw new Error(`Chromium CDP HTTP ${response.status}`);
    return response.json();
  };
  const version = async (signal?: AbortSignal): Promise<{ readonly webSocketDebuggerUrl: string }> => {
    const value = await json("json/version", signal);
    if (!value || typeof value !== "object" || typeof (value as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl !== "string") {
      throw new Error("Chromium CDP version response is missing webSocketDebuggerUrl");
    }
    return { webSocketDebuggerUrl: loopbackWebSocketUrl(
      (value as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl,
      "Chromium browser debugger endpoint",
    ) };
  };
  const targets = async (signal?: AbortSignal): Promise<readonly LinuxCdpTarget[]> => {
    const value = await json("json/list", signal);
    if (!Array.isArray(value)) throw new Error("Chromium CDP target list is invalid");
    return Object.freeze(value.flatMap((entry): LinuxCdpTarget[] => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.url !== "string") return [];
      return [Object.freeze({
        id: row.id,
        title: row.title,
        url: row.url,
        ...(typeof row.type === "string" ? { type: row.type } : {}),
        ...(typeof row.webSocketDebuggerUrl === "string"
          ? { webSocketDebuggerUrl: loopbackWebSocketUrl(row.webSocketDebuggerUrl, "Chromium target debugger endpoint") }
          : {}),
      })];
    }));
  };
  return Object.freeze({
    targets,
    async browserCommand(
      method: string,
      params: Readonly<Record<string, unknown>> = {},
      signal?: AbortSignal,
    ) {
      const current = await version(signal);
      return websocketCommand(current.webSocketDebuggerUrl, method, params, signal);
    },
    async targetCommand(
      targetId: string,
      method: string,
      params: Readonly<Record<string, unknown>> = {},
      signal?: AbortSignal,
    ) {
      const target = (await targets(signal)).find((candidate) => candidate.id === targetId && pageTarget(candidate));
      if (!target?.webSocketDebuggerUrl) throw new Error(`Chromium CDP target is unavailable: ${targetId}`);
      return websocketCommand(target.webSocketDebuggerUrl, method, params, signal);
    },
  });
}

function numeric(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function outputLabel(output: SwayOutput): string {
  const parts = [output.make, output.model, output.serial]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return parts.join(" ").slice(0, 160);
}

function parseSwayOutputs(
  raw: string,
  environment: NodeJS.ProcessEnv,
): { readonly screens: readonly ComputerScreenDescriptor[]; readonly geometry: ReadonlyMap<string, OutputGeometry> } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("swaymsg returned invalid output JSON"); }
  if (!Array.isArray(parsed)) throw new Error("swaymsg output list is invalid");
  const explicitAgents = configuredAgentOutputs(environment);
  const active = parsed.filter((entry): entry is SwayOutput => Boolean(entry && typeof entry === "object" && (entry as SwayOutput).active !== false));
  const physical = active.filter((entry) => typeof entry.name === "string" && !entry.name.startsWith("HEADLESS-"));
  const requestedHuman = environment.FRIDAY_COMPUTER_HUMAN_OUTPUT?.trim();
  const humanName = requestedHuman || (typeof physical[0]?.name === "string" ? physical[0].name : undefined);
  const screens: ComputerScreenDescriptor[] = [];
  const geometry = new Map<string, OutputGeometry>();
  for (const output of active) {
    if (typeof output.name !== "string" || !output.name.trim()) continue;
    const name = output.name.trim();
    const kind = name === humanName && !explicitAgents.has(name)
      ? "human" as const
      : (name.startsWith("HEADLESS-") || explicitAgents.has(name))
        ? "agent" as const
        : "human" as const;
    const width = Math.max(0, Math.round(numeric(output.rect?.width)));
    const height = Math.max(0, Math.round(numeric(output.rect?.height)));
    const descriptor: ComputerScreenDescriptor = Object.freeze({
      id: name,
      label: outputLabel(output) || (kind === "human" ? `Human ${name}` : `Agent ${name}`),
      kind,
      ...(width > 0 ? { width } : {}),
      ...(height > 0 ? { height } : {}),
      ...(typeof output.scale === "number" && Number.isFinite(output.scale) && output.scale > 0 ? { scale: output.scale } : {}),
    });
    screens.push(descriptor);
    geometry.set(name, Object.freeze({
      id: name,
      x: Math.round(numeric(output.rect?.x)),
      y: Math.round(numeric(output.rect?.y)),
      width: width || 1_280,
      height: height || 720,
      kind,
    }));
  }
  return { screens: Object.freeze(screens), geometry };
}

async function readCpuPercent(readText: (path: string) => Promise<string>): Promise<number> {
  try {
    const first = (await readText("/proc/stat")).split(/\r?\n/u)[0]?.trim().split(/\s+/u) ?? [];
    const values = first.slice(1).map(Number).filter(Number.isFinite);
    if (first[0] !== "cpu" || values.length < 4) throw new Error("invalid /proc/stat");
    const idle = values[3]! + (values[4] ?? 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    if (total <= 0) throw new Error("empty /proc/stat");
    return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
  } catch {
    const cores = Math.max(1, cpus().length);
    return Math.max(0, Math.min(100, ((loadavg()[0] ?? 0) / cores) * 100));
  }
}

async function processSnapshot(
  listDirectory: (path: string) => Promise<readonly string[]>,
  readText: (path: string) => Promise<string>,
): Promise<{ readonly processes: readonly ComputerProcessObservation[]; readonly browserRenderers: number }> {
  const processes: ComputerProcessObservation[] = [];
  let browserRenderers = 0;
  let entries: readonly string[] = [];
  try { entries = await listDirectory("/proc"); } catch { return { processes: Object.freeze([]), browserRenderers: 0 }; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const name = (await readText(`/proc/${entry}/comm`)).trim().replace(/[\0\r\n]/g, "").slice(0, 160);
      if (name && processes.length < MAX_PROCESSES) processes.push(Object.freeze({ pid, name }));
      if (/^(chromium|chrome|google-chrome)$/i.test(name)) {
        try {
          const commandLine = await readText(`/proc/${entry}/cmdline`);
          if (commandLine.includes("--type=renderer")) browserRenderers += 1;
        } catch { continue; }
      }
    } catch { continue; }
  }
  return { processes: Object.freeze(processes), browserRenderers };
}

function cdpResultValue<T>(value: unknown): T | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object") return undefined;
  return (result as { value?: T }).value;
}

function cdpExceptionMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = (value as { exceptionDetails?: unknown }).exceptionDetails;
  if (!details || typeof details !== "object") return undefined;
  const record = details as {
    readonly text?: unknown;
    readonly exception?: Readonly<{ readonly description?: unknown }> | undefined;
  };
  if (typeof record.exception?.description === "string" && record.exception.description.trim()) return record.exception.description;
  if (typeof record.text === "string" && record.text.trim()) return record.text;
  return "browser page evaluation failed";
}

function navigationError(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const errorText = (value as { readonly errorText?: unknown }).errorText;
  return typeof errorText === "string" && errorText.trim() ? errorText.trim() : undefined;
}

function keyEventParams(key: string, type: "keyDown" | "keyUp"): Readonly<Record<string, unknown>> {
  const named: Readonly<Record<string, Readonly<{ code: string; virtualKeyCode: number }>>> = Object.freeze({
    Enter: Object.freeze({ code: "Enter", virtualKeyCode: 13 }),
    Tab: Object.freeze({ code: "Tab", virtualKeyCode: 9 }),
    Escape: Object.freeze({ code: "Escape", virtualKeyCode: 27 }),
    Backspace: Object.freeze({ code: "Backspace", virtualKeyCode: 8 }),
    Delete: Object.freeze({ code: "Delete", virtualKeyCode: 46 }),
    ArrowLeft: Object.freeze({ code: "ArrowLeft", virtualKeyCode: 37 }),
    ArrowUp: Object.freeze({ code: "ArrowUp", virtualKeyCode: 38 }),
    ArrowRight: Object.freeze({ code: "ArrowRight", virtualKeyCode: 39 }),
    ArrowDown: Object.freeze({ code: "ArrowDown", virtualKeyCode: 40 }),
    Home: Object.freeze({ code: "Home", virtualKeyCode: 36 }),
    End: Object.freeze({ code: "End", virtualKeyCode: 35 }),
    PageUp: Object.freeze({ code: "PageUp", virtualKeyCode: 33 }),
    PageDown: Object.freeze({ code: "PageDown", virtualKeyCode: 34 }),
    " ": Object.freeze({ code: "Space", virtualKeyCode: 32 }),
  });
  const known = named[key];
  const printable = Array.from(key).length === 1;
  return Object.freeze({
    type,
    key,
    ...(known === undefined ? {} : {
      code: known.code,
      windowsVirtualKeyCode: known.virtualKeyCode,
      nativeVirtualKeyCode: known.virtualKeyCode,
    }),
    ...(type === "keyDown" && printable ? { text: key, unmodifiedText: key } : {}),
  });
}

function safeNavigationUrl(raw: string): string {
  if (raw === "about:blank") return raw;
  let value: URL;
  try { value = new URL(raw); } catch { throw new Error("browser navigation URL is invalid"); }
  if (value.protocol !== "http:" && value.protocol !== "https:") throw new Error("browser navigation supports only HTTP(S) URLs");
  if (value.username || value.password) throw new Error("browser navigation URL must not contain embedded credentials");
  return value.toString();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    signal?.throwIfAborted();
    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createLinuxSwayComputerAdapter(options: LinuxSwayComputerAdapterOptions = {}): ComputerNodeAdapter {
  const environment = { ...(options.environment ?? process.env) };
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const runCommand = options.runCommand ?? commandRunner(environment);
  const lifecycleCommand = options.lifecycleCommand ?? runCommand;
  const now = options.now ?? (() => new Date());
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  const listDirectory = options.listDirectory ?? ((path: string) => readdir(path));
  const executable = options.executable ?? ((command: string) => defaultExecutable(command, environment));
  const cdp = options.cdp ?? createHttpCdpClient(environment);
  const browserProfileDirectory = profileDirectory(environment);
  const browserProfileId = opaqueHash("linux-profile", browserProfileDirectory);
  const contextId = opaqueHash("linux-context", cdpBaseUrl(environment).toString());
  const browserActionTimeoutMs = positiveInteger(
    environment.FRIDAY_COMPUTER_BROWSER_ACTION_TIMEOUT_MS,
    BROWSER_ACTION_TIMEOUT_MS,
    60_000,
  );
  const targetByScreen = new Map<string, string>();
  let outputGeometry = new Map<string, OutputGeometry>();
  let lastProcesses: readonly ComputerProcessObservation[] = Object.freeze([]);

  async function runExistingTool(request: import("../contract.js").ComputerNodeToolExecutionRequest): Promise<import("../contract.js").ComputerToolExecutionResult> {
    if (!options.runTool) throw new Error("Linux Computer tool execution is unavailable without the shared Tools capability");
    return options.runTool(request);
  }

  async function cleanupExistingRun(request: import("../contract.js").ComputerRunProcessCleanupRequest): Promise<void> {
    if (!options.cleanupRunProcesses) throw new Error("Linux Computer process cleanup is unavailable without the shared Execution capability");
    await options.cleanupRunProcesses(request);
  }

  async function lifecycle(action: "restart" | "update", signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const args = action === "restart"
      ? ["--user", "restart", "friday-computer-browser.service", "friday-computer-headless.service"]
      : ["--user", "try-restart", "friday-computer-browser.service", "friday-computer-headless.service"];
    const result = await lifecycleCommand("systemctl", args, signal);
    if (!result.ok) throw new Error(`Linux Computer ${action} failed: ${sanitizeText(result.stderr || result.stdout, 512)}`);
  }

  async function resetManagedState(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // Only remove the FRIDAY-owned browser profile. Never touch the user's OS,
    // home directory, or unrelated browser profiles.
    const home = resolve(environment.HOME?.trim() || homedir());
    if (browserProfileDirectory === "/" || browserProfileDirectory === home || browserProfileDirectory.length < 8) {
      throw new Error("Refusing to reset an unsafe Linux Computer browser profile path");
    }
    await rm(browserProfileDirectory, { recursive: true, force: true });
    await mkdir(browserProfileDirectory, { recursive: true, mode: 0o700 });
  }

  async function discoverSwaySocket(): Promise<string | undefined> {
    const explicit = environment.FRIDAY_COMPUTER_SWAYSOCK?.trim() || environment.SWAYSOCK?.trim();
    if (explicit) return explicit;
    const runtime = environment.XDG_RUNTIME_DIR?.trim();
    if (!runtime) return undefined;
    try {
      const names = (await listDirectory(runtime)).filter((name) => name.startsWith("sway-ipc.") && name.endsWith(".sock"));
      if (names.length === 0) return undefined;
      const candidates = await Promise.all(names.map(async (name) => {
        const path = join(runtime, name);
        try { return { path, mtime: (await stat(path)).mtimeMs }; } catch { return { path, mtime: 0 }; }
      }));
      return candidates.sort((a, b) => b.mtime - a.mtime)[0]?.path;
    } catch {
      return undefined;
    }
  }

  async function swayOutputs(signal?: AbortSignal): Promise<{ readonly screens: readonly ComputerScreenDescriptor[]; readonly geometry: ReadonlyMap<string, OutputGeometry> }> {
    const socket = await discoverSwaySocket();
    const args = [...(socket ? ["-s", socket] : []), "-t", "get_outputs", "-r"];
    const result = await runCommand("swaymsg", args, signal);
    if (!result.ok) throw new Error(sanitizeText(result.stderr || "swaymsg could not query outputs", 512));
    return parseSwayOutputs(result.stdout, environment);
  }

  async function browserTargets(signal?: AbortSignal): Promise<readonly LinuxCdpTarget[]> {
    return Object.freeze((await cdp.targets(signal)).filter(pageTarget).slice(0, MAX_TABS));
  }

  function browserSnapshot(targets: readonly LinuxCdpTarget[], screens: readonly ComputerScreenDescriptor[]): ComputerBrowserSupervisorSnapshot {
    const screenKinds = new Map(screens.map((screen) => [screen.id, screen.kind] as const));
    const humanScreen = screens.find((screen) => screen.kind === "human")?.id;
    const mappedTargetIds = new Set(targetByScreen.values());
    const tabs: ComputerBrowserTabSnapshot[] = targets.map((target) => Object.freeze({
      id: boundedId(target.id, target.id, "Chromium target id"),
      title: sanitizeTitle(target.title),
      url: sanitizeUrl(target.url),
      active: mappedTargetIds.has(target.id),
    }));
    const windows: ComputerBrowserWindowSnapshot[] = targets.map((target) => {
      const screenId = [...targetByScreen.entries()].find(([, targetId]) => targetId === target.id)?.[0];
      if (screenId && screenKinds.get(screenId) === "agent") {
        return Object.freeze({ id: `window:${target.id}`, owner: "friday" as const, screenId, tabIds: Object.freeze([target.id]) });
      }
      return Object.freeze({
        id: `window:${target.id}`,
        owner: "human" as const,
        ...(humanScreen === undefined ? {} : { screenId: humanScreen }),
        tabIds: Object.freeze([target.id]),
      });
    });
    return Object.freeze({
      running: true,
      profileId: browserProfileId,
      contextId,
      persistentProfile: true,
      windows: Object.freeze(windows),
      tabs: Object.freeze(tabs),
    });
  }

  async function resources(): Promise<ComputerResourceSnapshot> {
    const [cpuPercent, processes] = await Promise.all([
      readCpuPercent(readText),
      processSnapshot(listDirectory, readText),
    ]);
    lastProcesses = processes.processes;
    return Object.freeze({
      totalMemoryMb: Math.max(0, Math.round(totalmem() / 1024 / 1024)),
      availableMemoryMb: Math.max(0, Math.round(freemem() / 1024 / 1024)),
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      browserRendererCount: processes.browserRenderers,
      screenWorkloadPercent: 0,
    });
  }

  async function snapshot(signal?: AbortSignal): Promise<ComputerNodeRuntimeSnapshot> {
    signal?.throwIfAborted();
    const currentResources = await resources();
    if (platform !== "linux") {
      return Object.freeze({ availability: "offline", resources: currentResources, screens: Object.freeze([]) });
    }
    let screens: readonly ComputerScreenDescriptor[] = Object.freeze([]);
    let swayReady = false;
    try {
      const outputs = await swayOutputs(signal);
      screens = outputs.screens;
      outputGeometry = new Map(outputs.geometry);
      swayReady = true;
    } catch {
      outputGeometry = new Map();
    }
    let browser: ComputerBrowserSupervisorSnapshot = Object.freeze({
      running: false,
      profileId: browserProfileId,
      persistentProfile: true,
      windows: Object.freeze([]),
      tabs: Object.freeze([]),
    });
    let browserReady = false;
    try {
      const targets = await browserTargets(signal);
      browser = browserSnapshot(targets, screens);
      browserReady = true;
    } catch { browserReady = false; }
    const hasAgentScreen = screens.some((screen) => screen.kind === "agent");
    const root = uid === 0;
    const availability = !swayReady || root
      ? "degraded" as const
      : hasAgentScreen && browserReady
        ? "online" as const
        : "degraded" as const;
    return Object.freeze({ availability, resources: currentResources, screens, browser });
  }

  async function ensureTarget(screenId: string, signal?: AbortSignal): Promise<string> {
    const existing = targetByScreen.get(screenId);
    if (existing) {
      const targets = await browserTargets(signal);
      if (targets.some((target) => target.id === existing)) return existing;
      targetByScreen.delete(screenId);
    }
    const geometry = outputGeometry.get(screenId);
    if (!geometry || geometry.kind !== "agent") throw new Error(`Linux Computer Agent output is unavailable: ${screenId}`);
    const result = await cdp.browserCommand("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
      background: false,
      left: geometry.x,
      top: geometry.y,
      width: Math.max(640, geometry.width),
      height: Math.max(480, geometry.height),
    }, signal);
    if (!result || typeof result !== "object" || typeof (result as { targetId?: unknown }).targetId !== "string") {
      throw new Error("Chromium CDP did not return a target id");
    }
    const targetId = (result as { targetId: string }).targetId;
    targetByScreen.set(screenId, targetId);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await browserTargets(signal)).some((target) => target.id === targetId)) return targetId;
      await delay(25, signal);
    }
    throw new Error("Chromium CDP target did not become ready");
  }

  async function evaluateValue<T>(targetId: string, expression: string, signal?: AbortSignal): Promise<T | undefined> {
    const result = await cdp.targetCommand(targetId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, signal);
    const exception = cdpExceptionMessage(result);
    if (exception) throw new Error(`browser page evaluation failed: ${sanitizeText(exception, 256)}`);
    return cdpResultValue<T>(result);
  }

  async function callFunctionValue<T>(
    targetId: string,
    functionDeclaration: string,
    args: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const result = await cdp.targetCommand(targetId, "Runtime.callFunctionOn", {
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    }, signal);
    const exception = cdpExceptionMessage(result);
    if (exception) throw new Error(`browser page evaluation failed: ${sanitizeText(exception, 256)}`);
    return cdpResultValue<T>(result);
  }

  async function pageUrl(targetId: string, signal?: AbortSignal): Promise<string> {
    return await evaluateValue<string>(targetId, "location.href", signal) ?? "about:blank";
  }

  async function waitForPageReady(
    targetId: string,
    signal?: AbortSignal,
    options: {
      readonly previousUrl?: string | undefined;
      readonly requestedUrl?: string | undefined;
      readonly minimumDelayMs?: number | undefined;
    } = {},
  ): Promise<void> {
    const minimumDelayMs = options.minimumDelayMs ?? 0;
    if (minimumDelayMs > 0) await delay(minimumDelayMs, signal);
    const deadline = Date.now() + browserActionTimeoutMs;
    let lastState = "unknown";
    do {
      signal?.throwIfAborted();
      const state = await evaluateValue<BrowserPageState>(targetId, PAGE_STATE_EXPRESSION, signal);
      const href = typeof state?.href === "string" ? state.href : "";
      const readyState = typeof state?.readyState === "string" ? state.readyState : "";
      lastState = `${readyState || "unknown"} ${sanitizeUrl(href || "unknown")}`;
      const ready = readyState === "interactive" || readyState === "complete";
      const requestedReached = options.requestedUrl === undefined
        || href === options.requestedUrl
        || (options.previousUrl !== undefined && href !== options.previousUrl)
        || options.requestedUrl === options.previousUrl;
      if (ready && requestedReached) return;
      await delay(BROWSER_ACTION_POLL_MS, signal);
    } while (Date.now() < deadline);
    throw new Error(`browser action did not settle before timeout (${lastState})`);
  }

  async function elementPoint(
    targetId: string,
    selector: string,
    protectedMessage: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ x: number; y: number }>> {
    if (PROTECTED_TARGET.test(selector)) throw new Error(protectedMessage);
    const value = await callFunctionValue<BrowserElementPoint>(targetId, ELEMENT_POINT_FUNCTION, [selector], signal);
    if (value?.found !== true) throw new Error(`browser target was not found: ${selector}`);
    if (value.protected === true) throw new Error(protectedMessage);
    if (value.actionable !== true || typeof value.x !== "number" || !Number.isFinite(value.x)
      || typeof value.y !== "number" || !Number.isFinite(value.y)) {
      throw new Error(`browser target is not actionable: ${selector}`);
    }
    return Object.freeze({ x: value.x, y: value.y });
  }

  async function dispatchClick(targetId: string, point: Readonly<{ x: number; y: number }>, signal?: AbortSignal): Promise<void> {
    await cdp.targetCommand(targetId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    }, signal);
    await cdp.targetCommand(targetId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    }, signal);
    await cdp.targetCommand(targetId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    }, signal);
  }

  async function observeScreen(screenId: string, _controlGeneration: number, signal?: AbortSignal): Promise<ComputerObservation> {
    signal?.throwIfAborted();
    const targetId = await ensureTarget(screenId, signal);
    const [rawSummary, rawUrl, targets] = await Promise.all([
      evaluateValue<string>(targetId, DOM_SUMMARY_EXPRESSION, signal),
      pageUrl(targetId, signal),
      browserTargets(signal),
    ]);
    const target = targets.find((candidate) => candidate.id === targetId);
    const summary = rawSummary ?? "";
    const currentUrl = rawUrl || target?.url || "about:blank";
    const tabs = target ? Object.freeze([Object.freeze({
      id: target.id,
      title: sanitizeTitle(target.title),
      url: sanitizeUrl(target.url),
      active: true,
    })]) : Object.freeze([]);
    return Object.freeze({
      observedAt: now().toISOString(),
      screenId,
      safety: Object.freeze({
        protectedInputOmitted: true as const,
        keystrokesOmitted: true as const,
        captchaOmitted: true as const,
        sensitiveScreenshotOmitted: true as const,
      }),
      url: sanitizeUrl(currentUrl),
      domSummary: sanitizeText(summary, MAX_DOM_SUMMARY),
      tabs,
      processes: lastProcesses,
    });
  }

  async function assertActiveElementSafe(targetId: string, expectedSelector?: string, signal?: AbortSignal): Promise<void> {
    const value = await callFunctionValue<{ readonly protected?: unknown; readonly expected?: unknown }>(
      targetId,
      ACTIVE_ELEMENT_SAFETY_FUNCTION,
      [expectedSelector ?? null],
      signal,
    );
    if (value?.protected === true) throw new Error("protected browser input requires human takeover");
    if (expectedSelector !== undefined && value?.expected !== true) throw new Error(`browser target could not be focused: ${expectedSelector}`);
  }

  async function runBrowserAction(request: ComputerBrowserActionRequest): Promise<ComputerBrowserActionResult> {
    request.signal?.throwIfAborted();
    if (!request.automationOrder.includes("cdp")) throw new Error("Linux Sway provider requires CDP automation");
    const targetId = await ensureTarget(request.screenId, request.signal);
    const action: ComputerBrowserAction = request.action;
    if (action.kind === "navigate") {
      const requestedUrl = safeNavigationUrl(action.url);
      const previousUrl = await pageUrl(targetId, request.signal);
      const navigation = await cdp.targetCommand(targetId, "Page.navigate", { url: requestedUrl }, request.signal);
      const error = navigationError(navigation);
      if (error) throw new Error(`browser navigation failed: ${sanitizeText(error, 256)}`);
      await waitForPageReady(targetId, request.signal, { previousUrl, requestedUrl });
    } else if (action.kind === "click") {
      const previousUrl = await pageUrl(targetId, request.signal);
      const point = await elementPoint(targetId, action.target, "protected browser target requires human takeover", request.signal);
      await dispatchClick(targetId, point, request.signal);
      await waitForPageReady(targetId, request.signal, { previousUrl, minimumDelayMs: BROWSER_INPUT_SETTLE_MS });
    } else if (action.kind === "type") {
      if (action.sensitive === true) throw new Error("protected browser input requires human takeover");
      const point = await elementPoint(targetId, action.target, "protected browser input requires human takeover", request.signal);
      await dispatchClick(targetId, point, request.signal);
      await assertActiveElementSafe(targetId, action.target, request.signal);
      await cdp.targetCommand(targetId, "Input.insertText", { text: action.text }, request.signal);
      await delay(BROWSER_INPUT_SETTLE_MS, request.signal);
    } else if (action.kind === "press") {
      const key = action.key.trim();
      if (!key || key.length > 64 || /[\0\r\n]/.test(key)) throw new Error("browser key is invalid");
      await assertActiveElementSafe(targetId, undefined, request.signal);
      await cdp.targetCommand(targetId, "Input.dispatchKeyEvent", keyEventParams(key, "keyDown"), request.signal);
      await cdp.targetCommand(targetId, "Input.dispatchKeyEvent", keyEventParams(key, "keyUp"), request.signal);
      await delay(BROWSER_INPUT_SETTLE_MS, request.signal);
    }
    return Object.freeze({ mode: "cdp" as const, observation: await observeScreen(request.screenId, request.controlGeneration, request.signal) });
  }

  async function doctor(signal?: AbortSignal): Promise<readonly string[]> {
    const issues: string[] = [];
    if (platform !== "linux") return Object.freeze([`Linux Sway provider cannot run on ${platform}`]);
    if (uid === 0) issues.push("Agent Computer must run as an unprivileged user, not root");
    for (const command of ["sway", "swaymsg", "chromium"]) {
      if (!(await executable(command))) {
        if (command === "chromium" && await executable("chromium-browser")) continue;
        issues.push(`${command} is not installed or not executable`);
      }
    }
    try {
      const outputs = await swayOutputs(signal);
      if (!outputs.screens.some((screen) => screen.kind === "agent")) issues.push("Sway has no headless Agent output");
      if ((environment.FRIDAY_COMPUTER_SESSION_MODE?.trim() || "managed") !== "compatibility"
        && !outputs.screens.some((screen) => screen.kind === "human")) {
        issues.push("managed Sway session has no physical Human output");
      }
    } catch (error) {
      issues.push(`Sway session is unavailable: ${sanitizeText(error instanceof Error ? error.message : String(error), 256)}`);
    }
    try { await browserTargets(signal); } catch { issues.push("Chromium CDP browser supervisor is unavailable on loopback"); }
    return Object.freeze(issues.slice(0, 32));
  }

  const executionOperations: readonly ("shell" | "edit" | "process" | "git")[] = options.runTool === undefined
    ? Object.freeze([])
    : Object.freeze([
      "shell",
      "edit",
      "git",
      ...(options.cleanupRunProcesses === undefined ? [] : ["process" as const]),
    ]);

  return Object.freeze({
    descriptor: Object.freeze({
      id: boundedId(environment.FRIDAY_COMPUTER_NODE_ID, DEFAULT_NODE_ID, "FRIDAY_COMPUTER_NODE_ID"),
      label: boundedLabel(environment.FRIDAY_COMPUTER_NODE_LABEL, DEFAULT_NODE_LABEL),
      platform: "linux" as const,
      capabilities: Object.freeze({
        executionOperations,
        browser: true,
        playwright: false,
        accessibility: false,
        cdp: true,
        visualControl: false,
        screenCapture: false,
        rawInput: false,
        virtualDisplays: true,
        managedLifecycle: true,
      }),
      admission: Object.freeze({
        minAvailableMemoryMb: positiveInteger(environment.FRIDAY_COMPUTER_MIN_AVAILABLE_MEMORY_MB, 1_024, 1_048_576),
        maxCpuPercent: boundedPercent(environment.FRIDAY_COMPUTER_MAX_CPU_PERCENT, 90),
        maxBrowserRenderers: positiveInteger(environment.FRIDAY_COMPUTER_MAX_BROWSER_RENDERERS, 24, 10_000),
        maxGpuPercent: boundedPercent(environment.FRIDAY_COMPUTER_MAX_GPU_PERCENT, 95),
        maxScreenWorkloadPercent: boundedPercent(environment.FRIDAY_COMPUTER_MAX_SCREEN_WORKLOAD_PERCENT, 95),
      }),
    }),
    snapshot,
    observeScreen,
    runBrowserAction,
    ...(options.runTool === undefined ? {} : { runTool: runExistingTool }),
    ...(options.cleanupRunProcesses === undefined ? {} : { cleanupRunProcesses: cleanupExistingRun }),
    doctor,
    restart: (signal?: AbortSignal) => lifecycle("restart", signal),
    update: (signal?: AbortSignal) => lifecycle("update", signal),
    resetManagedState,
  });
}
