import { createDesktopState, reduceDesktopState, type DesktopAction, type DesktopSurface } from "./core.js";
import { createDesktopGatewayClient, type DesktopGatewayClient } from "./gateway.js";
import { createDesktopDeviceIdentity, restoreDesktopDeviceIdentity, type DesktopCredentialBridge, type DesktopDeviceIdentity } from "./identity.js";
import { createDesktopStorage } from "./storage.js";
import { parseDesktopDeepLink } from "./deep-links.js";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("desktop app root is missing");
const appRoot: HTMLElement = root;
const cache = createDesktopStorage();
const bridge = (window as Window & { fridayDesktop?: DesktopCredentialBridge }).fridayDesktop;
const saved = cache.get<{ gatewayUrl?: string; deviceId?: string; publicKey?: string; name?: string; conversationId?: string }>("connection");
let gatewayUrl = saved?.gatewayUrl ?? "http://127.0.0.1:8787";
let identity: DesktopDeviceIdentity | undefined;
let gateway: DesktopGatewayClient | undefined;
let disconnectStream: (() => void) | undefined;
let pendingPairing: { pairingId: string; expiresAt: string } | undefined;
let otherPairings: readonly { pairingId: string; device: { name: string; type: string }; expiresAt: string }[] = [];
let conversationTitle = "Conversation";
let profileId: string | undefined;
let screenLeaseId: string | undefined;
let plugins: readonly { id: string; name: string; version: string; builtIn: boolean; enabled: boolean }[] = [];
let sending = false;
let draft = "";
let state = createDesktopState(saved?.conversationId);

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function dispatch(action: DesktopAction): void {
  state = reduceDesktopState(state, action);
  render();
}
function report(error: unknown): void {
  dispatch({ type: "notice", message: error instanceof Error ? error.message : String(error) });
}
function client(): DesktopGatewayClient {
  if (!gateway) throw new Error("Pair this desktop in Settings, then connect to the Gateway.");
  return gateway;
}
function saveConnection(): void {
  cache.set("connection", { gatewayUrl, ...(identity ? { deviceId: identity.deviceId, publicKey: identity.publicKey, name: identity.name } : {}), conversationId: state.conversationId });
}
function messages(): string {
  if (state.messages.length === 0) return `<div class="empty-state"><h3>Start a thread</h3><p>Connect to the Gateway and send a message to start a real turn.</p></div>`;
  return state.messages.map((message) => `<div class="message message-${message.role}"><div class="avatar">${message.role === "user" ? "You" : "F"}</div><div><span class="message-author">${message.role === "user" ? "You" : "F.R.I.D.A.Y"}</span><p>${escapeHtml(message.text)}</p></div></div>`).join("");
}
function settings(): string {
  return `<section class="surface-page"><span class="eyebrow">Connection</span><h2>Gateway and device</h2><p>Enter the FRIDAY Gateway address. Approve the first device on the host with <code>friday device approve PAIRING_ID</code>.</p><label>Gateway URL <input id="gateway-url" value="${escapeHtml(gatewayUrl)}" /></label><button class="primary-button" data-action="save-gateway">Save and connect</button><div class="surface-note"><strong>Device identity</strong><span>${identity ? escapeHtml(identity.deviceId) : "No device identity stored in this host"}</span></div>${pendingPairing ? `<div class="surface-note"><strong>Pairing pending until ${escapeHtml(pendingPairing.expiresAt)}</strong><span>Approve pairing ID <code>${escapeHtml(pendingPairing.pairingId)}</code>, then select Reconnect.</span></div>` : ""}<button class="primary-button" data-action="pair">Request pairing</button>${state.connection === "online" ? `<h3>Pending devices</h3>${otherPairings.map((pairing) => `<div class="plugin-row"><div><strong>${escapeHtml(pairing.device.name)}</strong><small>${escapeHtml(pairing.device.type)} · ${escapeHtml(pairing.pairingId)}</small></div><button data-action="approve-pairing" data-pairing-id="${escapeHtml(pairing.pairingId)}">Approve</button></div>`).join("") || "<p>No pending pairings.</p>"}<button class="ghost-button" data-action="refresh-pairings">Refresh</button>` : ""}</section>`;
}
function computer(): string {
  return `<section class="surface-page"><span class="eyebrow">Computer</span><h2>Leased screen</h2><p>${screenLeaseId ? `Lease ${escapeHtml(screenLeaseId)} · ${escapeHtml(state.computer.control)} control` : "No leased screen is available. Start a Computer task on the host first."}</p>${screenLeaseId ? `<button class="primary-button" data-action="${state.computer.control === "human" ? "hand-back" : "takeover"}">${state.computer.control === "human" ? "Hand control back" : "Take control"}</button>` : ""}<button class="ghost-button" data-action="refresh-computer">Refresh leases</button><div class="surface-note">The Gateway reports control state. Screen pixels are not streamed in this client yet.</div></section>`;
}
function surface(): string {
  if (state.activeSurface === "settings") return settings();
  if (state.activeSurface === "computer") return computer();
  if (state.activeSurface === "plugins") return `<section class="surface-page"><span class="eyebrow">Plugins</span><h2>Installed packages</h2><p>Changes take effect after FRIDAY restarts. Built-in plugins ship with Core; installed packages load from the host.</p>${plugins.map((plugin) => `<div class="plugin-row"><div><strong>${escapeHtml(plugin.name)}</strong><small>${escapeHtml(plugin.id)} · ${plugin.builtIn ? "Built-in" : escapeHtml(plugin.version)}</small></div><button data-action="toggle-plugin" data-plugin-id="${escapeHtml(plugin.id)}" data-enabled="${plugin.enabled}" ${plugin.id === "capabilities" ? "disabled" : ""}>${plugin.enabled ? "Disable" : "Enable"}</button></div>`).join("") || `<p>${state.connection === "online" ? "No plugins found." : "Connect to see installed plugins."}</p>`}<button class="ghost-button" data-action="refresh-plugins">Refresh</button></section>`;
  return `<section class="surface-page"><span class="eyebrow">${escapeHtml(state.activeSurface)}</span><h2>${escapeHtml(state.activeSurface)}</h2><p>This surface is waiting for a Gateway-backed view.</p></section>`;
}
function render(): void {
  const tabs: readonly DesktopSurface[] = ["conversations", "computer", "plugins", "settings"];
  const body = state.activeSurface === "conversations" ? messages() : surface();
  const composer = state.activeSurface === "conversations" ? `<div class="composer"><div class="composer-box"><textarea id="composer-input" rows="2" placeholder="Ask F.R.I.D.A.Y…" ${sending || state.connection !== "online" ? "disabled" : ""}>${escapeHtml(draft)}</textarea><button class="send-button" data-action="send" ${sending || state.connection !== "online" ? "disabled" : ""}>↑</button></div><div class="composer-hint">${sending ? "Waiting for the server turn…" : "Enter to send · Shift+Enter for a new line"}</div></div>` : "";
  appRoot.innerHTML = `<div class="app-shell"><header class="topbar"><div class="brand"><span class="brand-mark">F</span> F.R.I.D.A.Y <span class="brand-context">/ desktop</span></div><div class="top-actions"><span class="connection connection-${state.connection}"><i></i>${state.connection === "online" ? "Gateway online" : state.connection === "connecting" ? "Connecting…" : "Gateway offline"}</span><button class="ghost-button" data-action="reconnect">↻ Reconnect</button></div></header><div class="workspace"><nav class="sidebar"><span class="side-label">Workspace</span>${tabs.map((tab) => `<button class="nav-item ${state.activeSurface === tab ? "active" : ""}" data-surface="${tab}">${tab[0]?.toUpperCase()}${tab.slice(1)}</button>`).join("")}<div class="sidebar-footer">${identity ? `Device ${escapeHtml(identity.name)}` : "Pair a device in Settings"}</div></nav><main class="conversation"><div class="conversation-head"><div><span class="eyebrow">${escapeHtml(state.activeSurface)}</span><h1>${escapeHtml(state.activeSurface === "conversations" ? conversationTitle : state.activeSurface)}</h1><p>${state.connection === "online" ? "Connected to FRIDAY Core" : "Connect in Settings to use FRIDAY"}</p></div></div><div class="message-list">${body}</div>${composer}</main><aside class="activity-panel"><div class="panel-heading"><div><span class="eyebrow">Gateway events</span><h2>Activity</h2></div></div><div class="activity-timeline"><div class="timeline-item"><span class="timeline-dot ${state.connection === "online" ? "done" : ""}"></span><div><strong>${state.connection === "online" ? "Stream connected" : "Waiting for Gateway"}</strong><small>Last event sequence ${state.lastSequence}</small></div></div>${state.jobs.slice(-3).map((job) => `<div class="timeline-item"><span class="timeline-dot"></span><div><strong>${escapeHtml(job.title)}</strong><small>${escapeHtml(job.status)}</small></div></div>`).join("")}</div></aside></div>${state.notice ? `<div class="toast" role="status">${escapeHtml(state.notice)}<button data-action="clear-notice">×</button></div>` : ""}</div>`;
  appRoot.querySelectorAll<HTMLElement>("[data-surface]").forEach((el) => el.addEventListener("click", () => {
    const selected = el.dataset.surface as DesktopSurface;
    dispatch({ type: "surface", surface: selected });
    if (selected === "computer") void refreshComputer().catch(report);
    if (selected === "plugins") void refreshPlugins().catch(report);
    if (selected === "settings" && state.connection === "online") void refreshPairings().catch(report);
  }));
  appRoot.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => el.addEventListener("click", () => {
    const action = el.dataset.action;
    if (action === "clear-notice") dispatch({ type: "notice" });
    else if (action === "save-gateway") void saveGateway().catch(report);
    else if (action === "pair") void pair().catch(report);
    else if (action === "reconnect") void connect().catch(report);
    else if (action === "send") void send().catch(report);
    else if (action === "refresh-computer") void refreshComputer().catch(report);
    else if (action === "refresh-plugins") void refreshPlugins().catch(report);
    else if (action === "toggle-plugin") void togglePlugin(el.dataset.pluginId, el.dataset.enabled === "true").catch(report);
    else if (action === "refresh-pairings") void refreshPairings().catch(report);
    else if (action === "approve-pairing") void approvePairing(el.dataset.pairingId).catch(report);
    else if (action === "takeover" || action === "hand-back") void changeControl(action).catch(report);
  }));
  appRoot.querySelector<HTMLTextAreaElement>("#composer-input")?.addEventListener("input", (event) => { draft = (event.target as HTMLTextAreaElement).value; });
  appRoot.querySelector<HTMLTextAreaElement>("#composer-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send().catch(report); }
  });
}
async function saveGateway(): Promise<void> {
  const value = appRoot.querySelector<HTMLInputElement>("#gateway-url")?.value.trim() ?? "";
  // The transport validates HTTPS outside loopback before this address is stored.
  createDesktopGatewayClient({ baseUrl: value, deviceId: identity?.deviceId ?? "validation", sign: async () => "" });
  gatewayUrl = value;
  saveConnection();
  await connect();
}
async function pair(): Promise<void> {
  if (!bridge) throw new Error("Pairing requires the Electron host with OS credential storage.");
  if (!identity) identity = await createDesktopDeviceIdentity("FRIDAY desktop", bridge);
  saveConnection();
  const pairingClient = createDesktopGatewayClient({ baseUrl: gatewayUrl, deviceId: identity.deviceId, sign: identity.sign });
  pendingPairing = await pairingClient.beginPairing(identity);
  dispatch({ type: "notice", message: `Pairing requested: ${pendingPairing.pairingId}. Approve it on the host.` });
}
async function connect(): Promise<void> {
  disconnectStream?.();
  disconnectStream = undefined;
  gateway = undefined;
  dispatch({ type: "connection", status: "connecting" });
  try {
    if (!identity) {
      if (!bridge || !saved?.deviceId || !saved.publicKey) throw new Error("Request pairing in Settings on the Electron host.");
      identity = await restoreDesktopDeviceIdentity(saved.deviceId, saved.publicKey, bridge, saved.name);
      if (!identity) throw new Error("Device credential is missing. Request pairing again.");
    }
    const next = createDesktopGatewayClient({ baseUrl: gatewayUrl, deviceId: identity.deviceId, sign: identity.sign });
    await next.health();
    const replay = await next.request<{ events: readonly { event: { sequence: number; type: string; data: unknown } }[] }>("/v1/events/replay", { afterSequence: state.lastSequence });
    gateway = next;
    dispatch({ type: "gateway-events", events: replay.events.map(({ event }) => event) });
    const profiles = await next.request<{ profiles: readonly { id: string }[] }>("/v1/agent-profiles/list");
    profileId = profiles.profiles[0]?.id;
    const listed = await next.request<{ conversations: readonly { id: string; title: string }[] }>("/v1/conversations/list");
    let conversation = listed.conversations.find((entry) => entry.id === state.conversationId) ?? listed.conversations[0];
    if (!conversation) {
      const created = await next.request<{ conversation: { id: string; title: string } }>("/v1/conversations/create", { type: "direct", title: "Desktop conversation", participants: [{ kind: "user", id: identity.deviceId }, ...(profileId ? [{ kind: "agent", id: profileId }] : [])] });
      conversation = created.conversation;
    }
    if (state.conversationId !== conversation.id) dispatch({ type: "conversation-selected", conversationId: conversation.id });
    conversationTitle = conversation.title;
    saveConnection();
    pendingPairing = undefined;
    disconnectStream = next.stream(state.lastSequence, (event) => dispatch({ type: "gateway-events", events: [event] }), ({ status }) => dispatch({ type: "connection", status }));
    render();
  } catch (error) {
    dispatch({ type: "connection", status: "offline" });
    throw error;
  }
}
async function send(): Promise<void> {
  if (sending || state.connection !== "online") return;
  const input = appRoot.querySelector<HTMLTextAreaElement>("#composer-input");
  const value = input?.value.trim() ?? "";
  if (!value) return;
  sending = true;
  render();
  let accepted = false;
  try {
    const result = await client().request<{ reply?: string }>("/v1/turns", { conversationId: state.conversationId, text: value, ...(profileId ? { agentProfileId: profileId } : {}) });
    accepted = true;
    draft = "";
    dispatch({ type: "message-received", text: value, role: "user" });
    if (result.reply) dispatch({ type: "message-received", text: result.reply, role: "assistant" });
  } finally {
    sending = false;
    render();
    if (!accepted) draft = value;
  }
}
async function refreshComputer(): Promise<void> {
  const { leases } = await client().request<{ leases: readonly { screenLeaseId: string; nodeId: string; screenId: string; control?: { holder: "agent" | "human" } }[] }>("/v1/computer/leases");
  const lease = leases[0];
  screenLeaseId = lease?.screenLeaseId;
  dispatch({ type: "computer-state", nodeLabel: lease?.nodeId ?? "Computer node", screenLabel: lease?.screenId ?? "Screen", url: "", control: lease?.control?.holder ?? "agent" });
}
async function changeControl(action: "takeover" | "hand-back"): Promise<void> {
  if (!screenLeaseId) throw new Error("No screen lease is available.");
  await client().request(action === "takeover" ? "/v1/computer/takeover" : "/v1/computer/hand-back", { screenLeaseId });
  await refreshComputer();
}
async function refreshPlugins(): Promise<void> {
  const response = await client().request<{ plugins: typeof plugins }>("/v1/plugins/list");
  plugins = response.plugins;
  render();
}
async function togglePlugin(id: string | undefined, enabled: boolean): Promise<void> {
  if (!id) return;
  const response = await client().request<{ plugins: typeof plugins }>("/v1/plugins/set-enabled", { id, enabled: !enabled });
  plugins = response.plugins;
  dispatch({ type: "notice", message: `${id} ${enabled ? "disabled" : "enabled"}. Restart FRIDAY to apply.` });
}
async function refreshPairings(): Promise<void> {
  const response = await client().request<{ pairings: typeof otherPairings }>("/v1/pairings/pending");
  otherPairings = response.pairings;
  render();
}
async function approvePairing(id: string | undefined): Promise<void> {
  if (!id) return;
  await client().request("/v1/pairings/approve", { pairingId: id });
  await refreshPairings();
  dispatch({ type: "notice", message: "Device approved. It can now reconnect." });
}
const initialLink = parseDesktopDeepLink(globalThis.location.href);
if (initialLink) state = reduceDesktopState(state, { type: "surface", surface: initialLink.kind === "computer" ? "computer" : "conversations" });
render();
if (saved?.deviceId) void connect().catch(report);
