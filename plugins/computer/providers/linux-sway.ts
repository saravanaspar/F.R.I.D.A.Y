import { createHash, randomUUID } from "node:crypto";
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
  ComputerBoundingBox,
  ComputerElement,
  ComputerElementAction,
  ComputerNodeAdapter,
  ComputerNodeRuntimeSnapshot,
  ComputerObservation,
  ComputerObservationDelta,
  ComputerObservationRequest,
  ComputerProcessObservation,
  ComputerResourceSnapshot,
  ComputerScreenDescriptor,
  ComputerVisualProbeRequest,
  ComputerVisualProbeResult,
} from "../contract.js";

const DEFAULT_CDP_URL = "http://127.0.0.1:9222/";
const DEFAULT_NODE_ID = "linux-local";
const DEFAULT_NODE_LABEL = "Linux Computer";
const COMMAND_TIMEOUT_MS = 5_000;
const BROWSER_ACTION_TIMEOUT_MS = 5_000;
const BROWSER_ACTION_POLL_MS = 40;
const BROWSER_INPUT_SETTLE_MS = 50;
const MAX_DOM_SUMMARY = 12_000;
const MAX_STRUCTURED_ELEMENTS = 256;
const MAX_VISUAL_TEXT_ITEMS = 32;
const ACTION_CONFIDENCE_THRESHOLD = 0.82;
const VISUAL_PROBE_TOKEN_TTL_MS = 30_000;
const MAX_PROCESSES = 128;
const MAX_TABS = 64;
const PROTECTED_TARGET = /(password|passwd|passcode|otp|one[-_ ]?time|verification|captcha|token|secret|pin)/i;
const SECRET_ASSIGNMENT = /\b(password|passwd|passcode|otp|one[- ]time(?: password| code)?|verification(?: code)?|captcha|token|secret|pin)\s*(?::|=|\bis\b)\s*("[^"]*"|'[^']*'|[^\s,;&#<>]+)/gi;
const SECRET_NEAR_LABEL = /\b(otp|one[- ]time(?: password| code)?|verification code|passcode|password|pin)\b(?:\s+(?:is|code))?\s*[:=#-]?\s*([A-Za-z0-9][A-Za-z0-9._-]{3,63})/gi;
const VALUE_ATTRIBUTE = /\bvalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const SENSITIVE_URL_KEY = /(access[_-]?token|auth|authorization|code|credential|key|otp|pass|password|pin|secret|session|token)/i;
const SENSITIVE_TITLE = /(captcha|one[- ]time|otp|passcode|password|verification code)/i;
const HIGH_IMPACT_ACTION = /\b(place\s+order|buy(?:\s+now)?|pay|submit\s+payment|confirm\s+purchase|delete|send|transfer|checkout)\b/i;
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

const STRUCTURED_ELEMENTS_FUNCTION = String.raw`function (input) {
  const protectedPattern = /(password|passwd|passcode|otp|one[-_ ]?time|verification|captcha|token|secret|pin)/i;
  const interactiveSelector = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select', 'option',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="combobox"]', '[role="textbox"]', '[role="menuitem"]', '[role="tab"]',
    '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const cssEscape = (value) => globalThis.CSS?.escape ? globalThis.CSS.escape(value) : String(value).replace(/[^A-Za-z0-9_-]/g, (ch) => String.fromCharCode(92) + ch);
  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const selectorFor = (el) => {
    if (el.id) {
      const selector = '#' + cssEscape(el.id);
      if (unique(selector)) return selector;
    }
    for (const attr of ['data-testid', 'data-test', 'aria-label', 'name']) {
      const value = el.getAttribute(attr);
      if (!value || value.length > 160) continue;
      const selector = el.tagName.toLowerCase() + '[' + attr + '=' + JSON.stringify(value) + ']';
      if (unique(selector)) return selector;
    }
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const siblings = [...parent.children].filter((candidate) => candidate.tagName === node.tagName);
      const index = siblings.indexOf(node) + 1;
      parts.unshift(tag + ':nth-of-type(' + Math.max(1, index) + ')');
      const selector = parts.join(' > ');
      if (unique(selector)) return selector;
      node = parent;
    }
    return parts.join(' > ');
  };
  const rectVisible = (rect, style) => rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  const roleFor = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      return 'textbox';
    }
    return tag;
  };
  const clean = (value, max = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const nameFor = (el) => clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.labels?.[0]?.innerText || el.innerText || el.textContent || el.getAttribute('alt') || el.getAttribute('name') || '', 240);
  const contextFor = (el, name) => {
    const parent = el.closest('li,article,tr,section,form,[role="row"],[role="listitem"],[role="dialog"]') || el.parentElement;
    const text = clean(parent?.innerText || parent?.textContent || '', 360);
    if (!text || text === name) return '';
    return text;
  };
  const actionsFor = (el, role, editable, clickable, scrollable) => {
    const actions = [];
    if (clickable) actions.push('click');
    if (editable) actions.push('type');
    if (role === 'checkbox' || role === 'radio') actions.push('toggle');
    if (role === 'combobox' || role === 'option') actions.push('select');
    if (el.hasAttribute('aria-expanded')) actions.push('expand');
    if (scrollable) actions.push('scroll');
    return [...new Set(actions)];
  };
  const candidates = [...document.querySelectorAll(input.scope === 'all' ? 'body *' : interactiveSelector)];
  const near = input.nearSelector ? document.querySelector(input.nearSelector) : null;
  const nearRect = near?.getBoundingClientRect();
  const query = clean(input.query || '', 512).toLowerCase();
  const rows = [];
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = rectVisible(rect, style);
    if (!visible && input.scope !== 'all') continue;
    const signature = [el.getAttribute('type'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('class'), el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('role')].filter(Boolean).join(' ');
    const isProtected = protectedPattern.test(signature);
    const role = roleFor(el);
    const name = isProtected ? '[PROTECTED INPUT]' : nameFor(el);
    const context = isProtected ? '' : contextFor(el, name);
    const haystack = [role, name, context].join(' ').toLowerCase();
    if (query && !haystack.includes(query)) continue;
    const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
    const editable = !isProtected && (el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]),textarea,[contenteditable="true"],[role="textbox"]'));
    const clickable = !isProtected && (el.matches(interactiveSelector) || typeof el.onclick === 'function');
    const selectable = !isProtected && (role === 'combobox' || role === 'option' || role === 'radio');
    const scrollable = !isProtected && ((el.scrollHeight > el.clientHeight + 2) || (el.scrollWidth > el.clientWidth + 2));
    const draggable = !isProtected && (el.draggable === true || el.getAttribute('aria-grabbed') === 'true');
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const top = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, centerX)), Math.max(0, Math.min(innerHeight - 1, centerY)));
    const obscured = Boolean(top && top !== el && !el.contains(top) && !top.contains(el));
    let distance = 0;
    if (nearRect) {
      const dx = centerX - (nearRect.left + nearRect.width / 2);
      const dy = centerY - (nearRect.top + nearRect.height / 2);
      distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > 700) continue;
    }
    const selector = selectorFor(el);
    if (!selector) continue;
    const value = isProtected ? undefined : (editable || role === 'combobox' ? clean(el.value || el.getAttribute('aria-valuetext') || '', 240) : undefined);
    rows.push({
      selector, role, name, context, value,
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      pageLeft: rect.left + scrollX, pageTop: rect.top + scrollY,
      pageRight: rect.right + scrollX, pageBottom: rect.bottom + scrollY,
      visible, enabled: !disabled, focused: document.activeElement === el,
      interactive: clickable || editable || selectable || scrollable,
      clickable, editable, selectable, scrollable, draggable,
      selected: el.getAttribute('aria-selected') === null ? undefined : el.getAttribute('aria-selected') === 'true',
      checked: typeof el.checked === 'boolean' ? el.checked : (el.getAttribute('aria-checked') === null ? undefined : el.getAttribute('aria-checked') === 'true'),
      expanded: el.getAttribute('aria-expanded') === null ? undefined : el.getAttribute('aria-expanded') === 'true',
      protected: isProtected, obscured, distance,
      actions: isProtected ? [] : actionsFor(el, role, editable, clickable, scrollable),
    });
  }
  rows.sort((a, b) => (a.distance - b.distance) || (a.top - b.top) || (a.left - b.left));
  return rows.slice(0, Math.max(1, Math.min(256, Number(input.maxElements) || 80)));
}`;

const ELEMENT_VALIDATION_FUNCTION = String.raw`function (input) {
  const protectedPattern = /(password|passwd|passcode|otp|one[-_ ]?time|verification|captcha|token|secret|pin)/i;
  let el;
  try { el = document.querySelector(input.selector); } catch { return { found: false }; }
  if (!el) return { found: false };
  const clean = (value, max = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const signature = [el.getAttribute('type'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('class'), el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('role')].filter(Boolean).join(' ');
  const protectedTarget = protectedPattern.test(signature);
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  const enabled = !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true';
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const top = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, centerX)), Math.max(0, Math.min(innerHeight - 1, centerY)));
  const obscured = Boolean(top && top !== el && !el.contains(top) && !top.contains(el));
  const name = protectedTarget ? '[PROTECTED INPUT]' : clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.labels?.[0]?.innerText || el.innerText || el.textContent || el.getAttribute('alt') || el.getAttribute('name') || '', 240);
  const parent = el.closest('li,article,tr,section,form,[role="row"],[role="listitem"],[role="dialog"]') || el.parentElement;
  const context = protectedTarget ? '' : clean(parent?.innerText || parent?.textContent || '', 360);
  return {
    found: true, protected: protectedTarget, visible, enabled, obscured,
    name, context: context && context !== name ? context : '', role: el.getAttribute('role') || input.role || el.tagName.toLowerCase(),
    x: centerX, y: centerY,
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
    pageLeft: rect.left + scrollX, pageTop: rect.top + scrollY,
    pageRight: rect.right + scrollX, pageBottom: rect.bottom + scrollY,
  };
}`;

const PROBE_REGION_FUNCTION = String.raw`function (input) {
  const protectedPattern = /(password|passwd|passcode|otp|one[-_ ]?time|verification|captcha|token|secret|pin)/i;
  const region = input.bbox;
  const regionArea = Math.max(1, (region.right - region.left) * (region.bottom - region.top));
  const intersects = (rect) => rect.right > region.left && rect.left < region.right && rect.bottom > region.top && rect.top < region.bottom;
  const text = [];
  let unsafe = false;
  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect();
    if (!intersects(rect) || rect.width <= 0 || rect.height <= 0) continue;
    const tag = el.tagName.toLowerCase();
    const rectArea = rect.width * rect.height;
    const directControl = ['input', 'textarea', 'select', 'button', 'a', 'label', 'iframe', 'img', 'canvas'].includes(tag)
      || el.hasAttribute('role') || el.hasAttribute('contenteditable') || el.hasAttribute('aria-label') || el.hasAttribute('title');
    // Ignore giant layout ancestors so an unrelated password label elsewhere on the page cannot poison a tiny crop.
    if (!directControl && el.children.length > 0 && rectArea > regionArea * 4) continue;
    const signature = [tag, el.getAttribute('type'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('class'), el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('role'), el.getAttribute('src'), el.getAttribute('title')].filter(Boolean).join(' ');
    const value = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 512);
    const nearby = tag === 'canvas' || tag === 'iframe' ? String(el.parentElement?.innerText || el.parentElement?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 512) : '';
    if (protectedPattern.test(signature) || protectedPattern.test(value) || protectedPattern.test(nearby)) { unsafe = true; break; }
    if (value && value.length <= 240 && !text.includes(value)) text.push(value);
    if (text.length >= 32) break;
  }
  return { unsafe, text: text.slice(0, 32), scrollX, scrollY, innerWidth, innerHeight };
}`;

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

interface BrowserStructuredElement {
  readonly selector?: unknown;
  readonly role?: unknown;
  readonly name?: unknown;
  readonly value?: unknown;
  readonly context?: unknown;
  readonly left?: unknown;
  readonly top?: unknown;
  readonly right?: unknown;
  readonly bottom?: unknown;
  readonly pageLeft?: unknown;
  readonly pageTop?: unknown;
  readonly pageRight?: unknown;
  readonly pageBottom?: unknown;
  readonly visible?: unknown;
  readonly enabled?: unknown;
  readonly focused?: unknown;
  readonly interactive?: unknown;
  readonly clickable?: unknown;
  readonly editable?: unknown;
  readonly selectable?: unknown;
  readonly scrollable?: unknown;
  readonly draggable?: unknown;
  readonly selected?: unknown;
  readonly checked?: unknown;
  readonly expanded?: unknown;
  readonly protected?: unknown;
  readonly obscured?: unknown;
  readonly actions?: unknown;
}

interface BrowserElementValidation {
  readonly found?: unknown;
  readonly protected?: unknown;
  readonly visible?: unknown;
  readonly enabled?: unknown;
  readonly obscured?: unknown;
  readonly name?: unknown;
  readonly context?: unknown;
  readonly role?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly left?: unknown;
  readonly top?: unknown;
  readonly right?: unknown;
  readonly bottom?: unknown;
  readonly pageLeft?: unknown;
  readonly pageTop?: unknown;
  readonly pageRight?: unknown;
  readonly pageBottom?: unknown;
}

interface ProviderElementRecord {
  readonly element: ComputerElement;
  readonly selector: string;
  readonly pageBbox: ComputerBoundingBox;
}

interface ScreenObservationState {
  readonly observationId: string;
  readonly requestKey: string;
  readonly request: ComputerObservationRequest;
  readonly elementsById: ReadonlyMap<string, ProviderElementRecord>;
  readonly idsBySelector: ReadonlyMap<string, string>;
  readonly observation: ComputerObservation;
}

interface VisualProbeTokenRecord {
  readonly screenId: string;
  readonly ref: string;
  readonly expiresAt: number;
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

function finiteBrowserNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function browserBoundingBox(input: BrowserStructuredElement | BrowserElementValidation, page = false): ComputerBoundingBox | undefined {
  const left = finiteBrowserNumber(page ? input.pageLeft : input.left);
  const top = finiteBrowserNumber(page ? input.pageTop : input.top);
  const right = finiteBrowserNumber(page ? input.pageRight : input.right);
  const bottom = finiteBrowserNumber(page ? input.pageBottom : input.bottom);
  if (left === undefined || top === undefined || right === undefined || bottom === undefined || right < left || bottom < top) return undefined;
  return Object.freeze({ left, top, right, bottom });
}

function providerObservationRequest(input: ComputerObservationRequest | undefined): ComputerObservationRequest {
  const scope = input?.scope === "all" ? "all" as const : "interactive" as const;
  const maxElements = Math.max(1, Math.min(MAX_STRUCTURED_ELEMENTS, input?.maxElements ?? 80));
  const query = input?.query?.trim().slice(0, 512);
  const near = input?.near?.trim().slice(0, 256);
  return Object.freeze({
    scope,
    ...(query ? { query } : {}),
    ...(near ? { near } : {}),
    maxElements,
  });
}

function elementConfidence(input: {
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly interactive: boolean;
  readonly name?: string | undefined;
  readonly context?: string | undefined;
  readonly bbox?: ComputerBoundingBox | undefined;
  readonly obscured: boolean;
  readonly actions: readonly ComputerElementAction[];
  readonly protected: boolean;
}): number {
  if (input.protected) return 0;
  let score = 0;
  if (input.visible) score += 0.15;
  if (input.enabled) score += 0.1;
  if (input.interactive) score += 0.2;
  if (input.actions.length > 0) score += 0.15;
  if (input.name?.trim()) score += 0.15;
  if (input.context?.trim()) score += 0.05;
  if (input.bbox && input.bbox.right > input.bbox.left && input.bbox.bottom > input.bbox.top) score += 0.1;
  if (!input.obscured) score += 0.1;
  else score -= 0.25;
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

function elementFingerprint(element: ComputerElement): string {
  return JSON.stringify({
    id: element.id,
    role: element.role,
    name: element.name,
    value: element.value,
    bbox: element.bbox,
    visible: element.visible,
    enabled: element.enabled,
    focused: element.focused,
    interactive: element.interactive,
    clickable: element.clickable,
    editable: element.editable,
    selectable: element.selectable,
    scrollable: element.scrollable,
    draggable: element.draggable,
    selected: element.selected,
    checked: element.checked,
    expanded: element.expanded,
    protected: element.protected,
    context: element.context,
    actions: element.actions,
    source: element.source,
    confidence: element.confidence,
  });
}

function probeMaxSide(request: ComputerVisualProbeRequest): number {
  const preset = request.size === "tiny" ? 128
    : request.size === "medium" ? 512
      : request.size === "window" ? 1_024
        : request.size === "full" ? 2_048
          : 256;
  return Math.max(64, Math.min(2_048, request.maxSide ?? preset));
}

function clampProbeBox(box: ComputerBoundingBox, width: number, height: number, margin: number): ComputerBoundingBox {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const left = Math.max(0, Math.min(safeWidth - 1, box.left - margin));
  const top = Math.max(0, Math.min(safeHeight - 1, box.top - margin));
  const right = Math.max(left + 1, Math.min(safeWidth, box.right + margin));
  const bottom = Math.max(top + 1, Math.min(safeHeight, box.bottom + margin));
  return Object.freeze({ left, top, right, bottom });
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
  const observationStateByScreen = new Map<string, ScreenObservationState>();
  const nextElementIdByScreen = new Map<string, number>();
  const visualProbeTokens = new Map<string, VisualProbeTokenRecord>();
  let observationSequence = 0;
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
      observationStateByScreen.delete(screenId);
      nextElementIdByScreen.delete(screenId);
      for (const [token, record] of visualProbeTokens.entries()) {
        if (record.screenId === screenId) visualProbeTokens.delete(token);
      }
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

  async function evaluateFunctionValue<T>(
    targetId: string,
    functionDeclaration: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    return evaluateValue<T>(targetId, `(${functionDeclaration})(${JSON.stringify(input)})`, signal);
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

  function currentSemanticRecord(screenId: string, ref: string): Readonly<{ state: ScreenObservationState; record: ProviderElementRecord }> | undefined {
    if (!/^obs-\d+:e\d+$/.test(ref)) return undefined;
    const state = observationStateByScreen.get(screenId);
    if (!state || !ref.startsWith(`${state.observationId}:`)) {
      throw new Error(`STALE_REF: ${ref}; reinspect_required=true`);
    }
    const elementId = ref.slice(state.observationId.length + 1);
    const record = state.elementsById.get(elementId);
    if (!record || record.element.ref !== ref) throw new Error(`STALE_REF: ${ref}; reinspect_required=true`);
    return Object.freeze({ state, record });
  }

  function resolveNearSelector(screenId: string, near: string | undefined): string | undefined {
    if (near === undefined) return undefined;
    const resolved = currentSemanticRecord(screenId, near);
    if (!resolved) throw new Error("Computer observation near must be a current semantic element ref");
    return resolved.record.selector;
  }

  function nextElementId(screenId: string): string {
    const next = (nextElementIdByScreen.get(screenId) ?? 0) + 1;
    nextElementIdByScreen.set(screenId, next);
    return `e${next}`;
  }

  async function structuredObservation(
    screenId: string,
    targetId: string,
    observationId: string,
    request: ComputerObservationRequest,
    nearSelector: string | undefined,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    elements: readonly ComputerElement[];
    records: ReadonlyMap<string, ProviderElementRecord>;
    idsBySelector: ReadonlyMap<string, string>;
  }>> {
    const rawElements = await evaluateFunctionValue<readonly BrowserStructuredElement[]>(targetId, STRUCTURED_ELEMENTS_FUNCTION, {
      scope: request.scope ?? "interactive",
      query: request.query ?? "",
      nearSelector: nearSelector ?? null,
      maxElements: request.maxElements ?? 80,
    }, signal) ?? [];
    if (!Array.isArray(rawElements)) throw new Error("browser structured inspection returned an invalid element list");
    const previous = observationStateByScreen.get(screenId);
    const elements: ComputerElement[] = [];
    const records = new Map<string, ProviderElementRecord>();
    const idsBySelector = new Map<string, string>();
    for (const raw of rawElements.slice(0, MAX_STRUCTURED_ELEMENTS)) {
      if (!raw || typeof raw !== "object") continue;
      const selector = typeof raw.selector === "string" ? raw.selector.trim().slice(0, 2_048) : "";
      const bbox = browserBoundingBox(raw);
      const pageBbox = browserBoundingBox(raw, true);
      if (!selector || !bbox || !pageBbox) continue;
      const previousId = previous?.idsBySelector.get(selector);
      const elementId = previousId ?? nextElementId(screenId);
      const role = sanitizeText(typeof raw.role === "string" ? raw.role : "element", 128) || "element";
      const isProtected = raw.protected === true;
      const name = sanitizeText(typeof raw.name === "string" ? raw.name : "", 1_024);
      const context = sanitizeText(typeof raw.context === "string" ? raw.context : "", 2_048);
      const value = isProtected ? "" : sanitizeText(typeof raw.value === "string" ? raw.value : "", 2_048);
      const allowedActions = new Set<ComputerElementAction>(["click", "type", "toggle", "select", "expand", "scroll"]);
      const actions: ComputerElementAction[] = [];
      if (Array.isArray(raw.actions)) {
        for (const candidate of raw.actions as readonly unknown[]) {
          if (typeof candidate !== "string" || !allowedActions.has(candidate as ComputerElementAction)) continue;
          const action = candidate as ComputerElementAction;
          if (!actions.includes(action)) actions.push(action);
        }
      }
      const visible = raw.visible === true;
      const enabled = raw.enabled !== false;
      const interactive = raw.interactive === true;
      const confidence = elementConfidence({
        visible,
        enabled,
        interactive,
        ...(name ? { name } : {}),
        ...(context ? { context } : {}),
        bbox,
        obscured: raw.obscured === true,
        actions,
        protected: isProtected,
      });
      const element = Object.freeze({
        id: elementId,
        ref: `${observationId}:${elementId}`,
        role,
        ...(name ? { name } : {}),
        ...(value ? { value } : {}),
        bbox,
        visible,
        enabled,
        focused: raw.focused === true,
        interactive,
        clickable: raw.clickable === true,
        editable: raw.editable === true,
        selectable: raw.selectable === true,
        scrollable: raw.scrollable === true,
        draggable: raw.draggable === true,
        ...(typeof raw.selected === "boolean" ? { selected: raw.selected } : {}),
        ...(typeof raw.checked === "boolean" ? { checked: raw.checked } : {}),
        ...(typeof raw.expanded === "boolean" ? { expanded: raw.expanded } : {}),
        ...(isProtected ? { protected: true } : {}),
        ...(context ? { context } : {}),
        actions: Object.freeze(isProtected ? [] : actions),
        source: "dom" as const,
        confidence,
      } satisfies ComputerElement);
      elements.push(element);
      records.set(elementId, Object.freeze({ element, selector, pageBbox }));
      idsBySelector.set(selector, elementId);
    }
    return Object.freeze({
      elements: Object.freeze(elements),
      records,
      idsBySelector,
    });
  }

  function observationDelta(
    previous: ScreenObservationState | undefined,
    requestKey: string,
    elements: readonly ComputerElement[],
    records: ReadonlyMap<string, ProviderElementRecord>,
  ): ComputerObservationDelta | undefined {
    if (!previous || previous.requestKey !== requestKey) return undefined;
    const added: ComputerElement[] = [];
    const updated: { previousRef: string; element: ComputerElement }[] = [];
    let retained = 0;
    for (const element of elements) {
      const before = previous.elementsById.get(element.id)?.element;
      if (!before) {
        added.push(element);
      } else if (elementFingerprint(before) !== elementFingerprint(element)) {
        updated.push(Object.freeze({ previousRef: before.ref, element }));
      } else {
        retained += 1;
      }
    }
    const removedIds = [...previous.elementsById.keys()].filter((id) => !records.has(id));
    return Object.freeze({
      baseObservationId: previous.observationId,
      added: Object.freeze(added),
      updated: Object.freeze(updated),
      removedIds: Object.freeze(removedIds),
      retained,
    });
  }

  async function observeScreen(
    screenId: string,
    _controlGeneration: number,
    signal?: AbortSignal,
    rawRequest?: ComputerObservationRequest,
  ): Promise<ComputerObservation> {
    signal?.throwIfAborted();
    const targetId = await ensureTarget(screenId, signal);
    const request = providerObservationRequest(rawRequest);
    const nearSelector = resolveNearSelector(screenId, request.near);
    const requestKey = JSON.stringify({
      scope: request.scope,
      query: request.query ?? "",
      nearSelector: nearSelector ?? "",
      maxElements: request.maxElements,
    });
    const previous = observationStateByScreen.get(screenId);
    const observationId = `obs-${++observationSequence}`;
    const [rawSummary, rawUrl, targets, structured] = await Promise.all([
      rawRequest === undefined ? evaluateValue<string>(targetId, DOM_SUMMARY_EXPRESSION, signal) : Promise.resolve(undefined),
      pageUrl(targetId, signal),
      browserTargets(signal),
      structuredObservation(screenId, targetId, observationId, request, nearSelector, signal),
    ]);
    const target = targets.find((candidate) => candidate.id === targetId);
    const currentUrl = rawUrl || target?.url || "about:blank";
    const tabs = target ? Object.freeze([Object.freeze({
      id: target.id,
      title: sanitizeTitle(target.title),
      url: sanitizeUrl(target.url),
      active: true,
    })]) : Object.freeze([]);
    const delta = observationDelta(previous, requestKey, structured.elements, structured.records);
    const observation = Object.freeze({
      observedAt: now().toISOString(),
      screenId,
      observationId,
      safety: Object.freeze({
        protectedInputOmitted: true as const,
        keystrokesOmitted: true as const,
        captchaOmitted: true as const,
        sensitiveScreenshotOmitted: true as const,
      }),
      url: sanitizeUrl(currentUrl),
      ...(rawSummary === undefined ? {} : { domSummary: sanitizeText(rawSummary, MAX_DOM_SUMMARY) }),
      tabs,
      elements: structured.elements,
      ...(delta === undefined ? {} : { delta }),
      processes: lastProcesses,
    } satisfies ComputerObservation);
    observationStateByScreen.set(screenId, Object.freeze({
      observationId,
      requestKey,
      request,
      elementsById: structured.records,
      idsBySelector: structured.idsBySelector,
      observation,
    }));
    return observation;
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

  async function validateStructuredTarget(
    targetId: string,
    record: ProviderElementRecord,
    action: ComputerElementAction,
    signal?: AbortSignal,
  ): Promise<Readonly<{ selector: string; point: Readonly<{ x: number; y: number }>; bbox: ComputerBoundingBox; confidence: number }>> {
    if (!record.element.actions.includes(action)) throw new Error(`semantic target does not support ${action}: ${record.element.ref}`);
    const live = await evaluateFunctionValue<BrowserElementValidation>(targetId, ELEMENT_VALIDATION_FUNCTION, {
      selector: record.selector,
      role: record.element.role,
    }, signal);
    if (live?.found !== true) throw new Error(`STALE_REF: ${record.element.ref}; reinspect_required=true`);
    if (live.protected === true) throw new Error("protected browser target requires human takeover");
    if (live.visible !== true || live.enabled !== true) throw new Error(`STALE_REF: ${record.element.ref}; target_not_actionable=true`);
    const liveName = sanitizeText(typeof live.name === "string" ? live.name : "", 1_024);
    const liveContext = sanitizeText(typeof live.context === "string" ? live.context : "", 2_048);
    const expectedName = record.element.name ?? "";
    const expectedContext = record.element.context ?? "";
    if (expectedName !== liveName || expectedContext !== liveContext) {
      throw new Error(`STALE_REF: ${record.element.ref}; semantic_target_changed=true`);
    }
    const x = finiteBrowserNumber(live.x);
    const y = finiteBrowserNumber(live.y);
    const bbox = browserBoundingBox(live);
    if (x === undefined || y === undefined || !bbox) throw new Error(`STALE_REF: ${record.element.ref}; target_geometry_missing=true`);
    const confidence = elementConfidence({
      visible: true,
      enabled: true,
      interactive: record.element.interactive,
      ...(record.element.name ? { name: record.element.name } : {}),
      ...(record.element.context ? { context: record.element.context } : {}),
      bbox,
      obscured: live.obscured === true,
      actions: record.element.actions,
      protected: false,
    });
    return Object.freeze({ selector: record.selector, point: Object.freeze({ x, y }), bbox, confidence: Math.min(record.element.confidence, confidence) });
  }

  function pruneVisualProbeTokens(): void {
    const time = Date.now();
    for (const [token, record] of visualProbeTokens.entries()) {
      if (record.expiresAt <= time) visualProbeTokens.delete(token);
    }
  }

  function consumeVisualProbeToken(token: string, screenId: string, ref: string): void {
    pruneVisualProbeTokens();
    const record = visualProbeTokens.get(token);
    if (!record || record.screenId !== screenId || record.ref !== ref) throw new Error("VISUAL_PROBE_TOKEN_INVALID");
    visualProbeTokens.delete(token);
  }

  function gatedSemanticAction(
    screenId: string,
    resolved: Readonly<{ state: ScreenObservationState; record: ProviderElementRecord }>,
    confidence: number,
    highImpactEligible: boolean,
    probeToken: string | undefined,
  ): ComputerBrowserActionResult | undefined {
    const highImpact = highImpactEligible && HIGH_IMPACT_ACTION.test(`${resolved.record.element.name ?? ""} ${resolved.record.element.context ?? ""}`);
    const lowConfidence = confidence < ACTION_CONFIDENCE_THRESHOLD;
    if (!highImpact && !lowConfidence) {
      if (probeToken !== undefined) consumeVisualProbeToken(probeToken, screenId, resolved.record.element.ref);
      return undefined;
    }
    if (probeToken !== undefined) {
      consumeVisualProbeToken(probeToken, screenId, resolved.record.element.ref);
      return undefined;
    }
    return Object.freeze({
      mode: "cdp" as const,
      performed: false,
      confidence,
      visualProbeRequired: Object.freeze({
        ref: resolved.record.element.ref,
        reason: highImpact ? "high-impact-action" as const : "low-confidence" as const,
        recommendedSize: highImpact ? "small" as const : "tiny" as const,
      }),
      observation: resolved.state.observation,
    });
  }

  async function runBrowserAction(request: ComputerBrowserActionRequest): Promise<ComputerBrowserActionResult> {
    request.signal?.throwIfAborted();
    if (!request.automationOrder.includes("cdp")) throw new Error("Linux Sway provider requires CDP automation");
    const targetId = await ensureTarget(request.screenId, request.signal);
    const beforeState = observationStateByScreen.get(request.screenId);
    const beforeUrl = beforeState?.observation.url ?? await pageUrl(targetId, request.signal);
    const action: ComputerBrowserAction = request.action;
    let actionConfidence: number | undefined;
    if (action.kind === "navigate") {
      const requestedUrl = safeNavigationUrl(action.url);
      const previousUrl = await pageUrl(targetId, request.signal);
      const navigation = await cdp.targetCommand(targetId, "Page.navigate", { url: requestedUrl }, request.signal);
      const error = navigationError(navigation);
      if (error) throw new Error(`browser navigation failed: ${sanitizeText(error, 256)}`);
      await waitForPageReady(targetId, request.signal, { previousUrl, requestedUrl });
    } else if (action.kind === "click" || action.kind === "type") {
      const semantic = currentSemanticRecord(request.screenId, action.target);
      let selector = action.target;
      let point: Readonly<{ x: number; y: number }>;
      if (semantic) {
        const validated = await validateStructuredTarget(targetId, semantic.record, action.kind === "click" ? "click" : "type", request.signal);
        selector = validated.selector;
        point = validated.point;
        actionConfidence = validated.confidence;
        const gated = gatedSemanticAction(request.screenId, semantic, validated.confidence, action.kind === "click", action.visualProbeToken);
        if (gated) return gated;
      } else {
        point = await elementPoint(targetId, selector, action.kind === "click" ? "protected browser target requires human takeover" : "protected browser input requires human takeover", request.signal);
      }
      if (action.kind === "click") {
        const previousUrl = await pageUrl(targetId, request.signal);
        await dispatchClick(targetId, point, request.signal);
        await waitForPageReady(targetId, request.signal, { previousUrl, minimumDelayMs: BROWSER_INPUT_SETTLE_MS });
      } else {
        if (action.sensitive === true) throw new Error("protected browser input requires human takeover");
        await dispatchClick(targetId, point, request.signal);
        await assertActiveElementSafe(targetId, selector, request.signal);
        await cdp.targetCommand(targetId, "Input.insertText", { text: action.text }, request.signal);
        await delay(BROWSER_INPUT_SETTLE_MS, request.signal);
      }
    } else if (action.kind === "press") {
      const key = action.key.trim();
      if (!key || key.length > 64 || /[\0\r\n]/.test(key)) throw new Error("browser key is invalid");
      const activationKey = /^(enter|numpadenter|space|spacebar)$/i.test(key);
      if (activationKey && !action.target) throw new Error("browser activation key requires a current target ref");
      if (action.target) {
        const semantic = currentSemanticRecord(request.screenId, action.target);
        if (semantic) {
          const validationAction = semantic.record.element.actions.includes("click") ? "click"
            : semantic.record.element.actions.includes("type") ? "type"
              : semantic.record.element.actions.includes("scroll") ? "scroll"
                : semantic.record.element.actions[0];
          if (!validationAction) throw new Error(`semantic target is not actionable: ${action.target}`);
          const validated = await validateStructuredTarget(targetId, semantic.record, validationAction, request.signal);
          actionConfidence = validated.confidence;
          const gated = gatedSemanticAction(request.screenId, semantic, validated.confidence, activationKey, action.visualProbeToken);
          if (gated) return gated;
          await assertActiveElementSafe(targetId, validated.selector, request.signal);
        } else {
          await assertActiveElementSafe(targetId, action.target, request.signal);
        }
      } else {
        await assertActiveElementSafe(targetId, undefined, request.signal);
      }
      await cdp.targetCommand(targetId, "Input.dispatchKeyEvent", keyEventParams(key, "keyDown"), request.signal);
      await cdp.targetCommand(targetId, "Input.dispatchKeyEvent", keyEventParams(key, "keyUp"), request.signal);
      await delay(BROWSER_INPUT_SETTLE_MS, request.signal);
    } else if (action.kind === "scroll") {
      let point: Readonly<{ x: number; y: number }> = Object.freeze({ x: 640, y: 360 });
      if (action.target) {
        const semantic = currentSemanticRecord(request.screenId, action.target);
        if (semantic) {
          const validated = await validateStructuredTarget(targetId, semantic.record, "scroll", request.signal);
          actionConfidence = validated.confidence;
          const gated = gatedSemanticAction(request.screenId, semantic, validated.confidence, false, action.visualProbeToken);
          if (gated) return gated;
          point = validated.point;
        } else {
          point = await elementPoint(targetId, action.target, "protected browser target requires human takeover", request.signal);
        }
      } else {
        const viewport = await evaluateValue<{ readonly width?: unknown; readonly height?: unknown }>(targetId, "({width: innerWidth, height: innerHeight})", request.signal);
        const width = finiteBrowserNumber(viewport?.width) ?? 1_280;
        const height = finiteBrowserNumber(viewport?.height) ?? 720;
        point = Object.freeze({ x: width / 2, y: height / 2 });
      }
      await cdp.targetCommand(targetId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX: action.deltaX ?? 0,
        deltaY: action.deltaY,
      }, request.signal);
      await delay(BROWSER_INPUT_SETTLE_MS, request.signal);
    }
    const observation = await observeScreen(
      request.screenId,
      request.controlGeneration,
      request.signal,
      beforeState?.request,
    );
    const afterUrl = observation.url;
    const delta = observation.delta;
    const structuralChange = Boolean(delta && (delta.added.length > 0 || delta.updated.length > 0 || delta.removedIds.length > 0));
    return Object.freeze({
      mode: "cdp" as const,
      performed: true,
      ...(actionConfidence === undefined ? {} : { confidence: actionConfidence }),
      verification: Object.freeze({ structuralChange, urlChanged: beforeUrl !== afterUrl }),
      observation,
    });
  }

  async function visualProbe(request: ComputerVisualProbeRequest): Promise<ComputerVisualProbeResult> {
    request.signal?.throwIfAborted();
    const targetId = await ensureTarget(request.screenId, request.signal);
    let state = observationStateByScreen.get(request.screenId);
    if (!state) {
      await observeScreen(request.screenId, request.controlGeneration, request.signal, providerObservationRequest(undefined));
      state = observationStateByScreen.get(request.screenId);
    }
    if (!state) throw new Error("Computer visual probe could not establish an observation");
    let sourceBox: ComputerBoundingBox;
    let ref: string | undefined;
    let confidence = 1;
    if (request.ref !== undefined) {
      const semantic = currentSemanticRecord(request.screenId, request.ref);
      if (!semantic) throw new Error("Computer visual probe ref must be a current semantic element ref");
      const action = semantic.record.element.actions.includes("click") ? "click"
        : semantic.record.element.actions.includes("type") ? "type"
          : semantic.record.element.actions.includes("scroll") ? "scroll"
            : semantic.record.element.actions[0];
      if (!action) throw new Error(`semantic target is not probeable: ${request.ref}`);
      const live = await validateStructuredTarget(targetId, semantic.record, action, request.signal);
      sourceBox = live.bbox;
      ref = request.ref;
      confidence = live.confidence;
    } else if (request.bbox !== undefined) {
      sourceBox = request.bbox;
    } else {
      throw new Error("Computer visual probe requires ref or bbox");
    }
    const viewport = await evaluateValue<{ readonly width?: unknown; readonly height?: unknown }>(targetId, "({width: innerWidth, height: innerHeight})", request.signal);
    const viewportWidth = Math.max(1, finiteBrowserNumber(viewport?.width) ?? outputGeometry.get(request.screenId)?.width ?? 1_280);
    const viewportHeight = Math.max(1, finiteBrowserNumber(viewport?.height) ?? outputGeometry.get(request.screenId)?.height ?? 720);
    const fullWindow = request.size === "window" || request.size === "full";
    const crop = fullWindow
      ? Object.freeze({ left: 0, top: 0, right: viewportWidth, bottom: viewportHeight })
      : clampProbeBox(sourceBox, viewportWidth, viewportHeight, request.includeContext === false ? 8 : 32);
    const region = await evaluateFunctionValue<{
      readonly unsafe?: unknown;
      readonly text?: unknown;
      readonly scrollX?: unknown;
      readonly scrollY?: unknown;
    }>(targetId, PROBE_REGION_FUNCTION, { bbox: crop }, request.signal);
    if (region?.unsafe === true) throw new Error("protected or challenge visual region requires human takeover");
    const visibleText = Array.isArray(region?.text)
      ? Object.freeze(region.text.filter((value): value is string => typeof value === "string").map((value) => sanitizeText(value, 1_024)).filter(Boolean).slice(0, MAX_VISUAL_TEXT_ITEMS))
      : Object.freeze([]);
    const maxSide = probeMaxSide(request);
    const cropWidth = Math.max(1, crop.right - crop.left);
    const cropHeight = Math.max(1, crop.bottom - crop.top);
    const scale = Math.min(1, maxSide / Math.max(cropWidth, cropHeight));
    let image: ComputerVisualProbeResult["image"];
    if (request.return === "image") {
      const scrollX = finiteBrowserNumber(region?.scrollX) ?? 0;
      const scrollY = finiteBrowserNumber(region?.scrollY) ?? 0;
      const raw = await cdp.targetCommand(targetId, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
        clip: {
          x: crop.left + scrollX,
          y: crop.top + scrollY,
          width: cropWidth,
          height: cropHeight,
          scale,
        },
      }, request.signal);
      const data = raw && typeof raw === "object" && typeof (raw as { data?: unknown }).data === "string"
        ? (raw as { data: string }).data
        : "";
      if (!data) throw new Error("Chromium CDP did not return visual probe image data");
      image = Object.freeze({ data, mimeType: "image/png" as const });
    }
    let probeToken: string | undefined;
    if (ref) {
      pruneVisualProbeTokens();
      probeToken = `probe-${randomUUID()}`;
      visualProbeTokens.set(probeToken, Object.freeze({
        screenId: request.screenId,
        ref,
        expiresAt: Date.now() + VISUAL_PROBE_TOKEN_TTL_MS,
      }));
    }
    return Object.freeze({
      observationId: state.observationId,
      safety: Object.freeze({ protectedRegionOmitted: true as const, challengeRegionOmitted: true as const }),
      ...(ref === undefined ? {} : { ref }),
      bbox: crop,
      width: Math.max(1, Math.round(cropWidth * scale)),
      height: Math.max(1, Math.round(cropHeight * scale)),
      targetMatch: true,
      confidence,
      visibleText,
      ...(probeToken === undefined ? {} : { probeToken }),
      ...(image === undefined ? {} : { image }),
    });
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
        screenCapture: true,
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
    visualProbe,
    ...(options.runTool === undefined ? {} : { runTool: runExistingTool }),
    ...(options.cleanupRunProcesses === undefined ? {} : { cleanupRunProcesses: cleanupExistingRun }),
    doctor,
    restart: (signal?: AbortSignal) => lifecycle("restart", signal),
    update: (signal?: AbortSignal) => lifecycle("update", signal),
    resetManagedState,
  });
}
