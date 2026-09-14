import { createDesktopState, reduceDesktopState, type DesktopAction, type DesktopArtifact, type DesktopJob } from "./core.js";
import { parseDesktopDeepLink } from "./deep-links.js";
import { createDesktopNotifier } from "./notifications.js";
import { createDesktopStorage } from "./storage.js";
import { filterDesktopCommands, type DesktopCommand } from "./commands.js";

const cache = createDesktopStorage();
const notifier = createDesktopNotifier();
const cachedIdentity = cache.get<{ readonly conversationId?: unknown; readonly lastSequence?: unknown }>("session");
let state = createDesktopState(typeof cachedIdentity?.conversationId === "string" ? cachedIdentity.conversationId : undefined);
if (typeof cachedIdentity?.lastSequence === "number" && Number.isSafeInteger(cachedIdentity.lastSequence) && cachedIdentity.lastSequence >= 0) state = { ...state, lastSequence: cachedIdentity.lastSequence };
let paletteOpen = false;
let paletteQuery = "";
const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) throw new Error("desktop app root is missing");
const root: HTMLElement = appRoot;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function dispatch(action: DesktopAction): void {
  state = reduceDesktopState(state, action);
  cache.set("session", { conversationId: state.conversationId, lastSequence: state.lastSequence });
  render();
}

function statusLabel(status: DesktopJob["status"]): string {
  return status === "awaiting-approval" ? "Needs approval" : status.replaceAll("-", " ");
}

function latestJob(): DesktopJob | undefined { return state.jobs.at(-1); }

function renderJob(job: DesktopJob): string {
  const approval = job.status === "awaiting-approval" ? `<div class="approval"><span>Review requested</span><button data-action="approve" data-job-id="${escapeHtml(job.id)}">Approve</button></div>` : "";
  const artifact = job.artifactId ? `<span class="job-artifact">Artifact ready</span>` : "";
  return `<article class="job-card"><div class="job-top"><div><span class="eyebrow">Background job</span><h3>${escapeHtml(job.title)}</h3></div><span class="status status-${job.status}">${escapeHtml(statusLabel(job.status))}</span></div><div class="progress"><span style="width:${job.progress}%"></span></div><div class="job-meta"><span>${job.progress}% complete</span>${artifact}</div>${approval}</article>`;
}

function renderSurface(surface: import("./core.js").DesktopSurface): string {
  const labels: Record<import("./core.js").DesktopSurface, { readonly title: string; readonly description: string; readonly icon: string }> = {
    conversations: { title: "Conversations", description: "Shared threads stay attached to durable Sessions.", icon: "◈" },
    agents: { title: "Agents", description: "Persistent Agent Profiles and their authorized workspaces.", icon: "◌" },
    groups: { title: "Groups", description: "Collaborate with named teammates in shared Conversations.", icon: "◎" },
    projects: { title: "Projects", description: "Server-owned repositories and execution targets.", icon: "⌁" },
    routines: { title: "Routines", description: "Scheduled work will appear here when the Routines capability is enabled.", icon: "◷" },
    skills: { title: "Skills", description: "Reusable, validated capabilities available to Agents.", icon: "✦" },
    plugins: { title: "Plugins", description: "Inspect enabled integrations without exposing internal ownership.", icon: "⧉" },
    files: { title: "Files", description: "Artifacts and bounded previews from server-owned storage.", icon: "▤" },
    computer: { title: "Computer", description: "Live leased screens, browser state, and safe takeover.", icon: "▣" },
    approvals: { title: "Approvals", description: "Review protected actions with their exact originating context.", icon: "✓" },
    jobs: { title: "Jobs", description: "Background work continues on the server if this window closes.", icon: "⌛" },
    search: { title: "Search", description: "Search is permission-filtered and links back to source records.", icon: "⌕" },
    usage: { title: "Usage", description: "Usage and spending summaries from the observability services.", icon: "◒" },
    settings: { title: "Settings", description: "Gateway, device identity, notifications, and recovery controls.", icon: "⚙" },
    terminal: { title: "Terminal", description: "A bounded terminal view for the active Project target.", icon: "›_" },
    diff: { title: "Diff", description: "Review worktree changes before a server-authorized promotion.", icon: "Δ" },
  };
  const entry = labels[surface];
  if (surface === "computer") return `<div class="surface-page"><span class="surface-glyph">${entry.icon}</span><span class="eyebrow">Live surface</span><h2>${entry.title}</h2><p>${entry.description}</p><button class="primary-button" data-action="takeover">Take over the leased screen</button></div>`;
  return `<div class="surface-page"><span class="surface-glyph">${entry.icon}</span><span class="eyebrow">Workspace surface</span><h2>${entry.title}</h2><p>${entry.description}</p><div class="surface-note"><strong>Gateway-backed</strong><span>This client presents authoritative server state; it does not create a second Agent, job, or file store.</span></div></div>`;
}

function render(): void {
  const job = latestJob();
  const artifacts = state.artifacts.map((artifact) => `<article class="artifact-card"><div class="artifact-icon">${artifact.kind === "diff" ? "Δ" : "▤"}</div><div><strong>${escapeHtml(artifact.name)}</strong><p>${escapeHtml(artifact.summary)}</p><small>${escapeHtml(artifact.kind)} · just now</small></div><button class="icon-button" aria-label="Open artifact">↗</button></article>`).join("");
  const messages = state.messages.length === 0
    ? `<div class="empty-state"><span class="pulse-dot"></span><h3>Start a thread</h3><p>Ask F.R.I.D.A.Y to do something useful. Long-running work will appear here with approvals and artifacts.</p></div>`
    : state.messages.map((message) => `<div class="message message-${message.role}"><div class="avatar">${message.role === "user" ? "SP" : "F"}</div><div><span class="message-author">${message.role === "user" ? "You" : "F.R.I.D.A.Y"}</span><p>${escapeHtml(message.text)}</p></div></div>`).join("");
  const panel = state.computer.open && state.activeSurface === "computer" ? `<aside class="computer-panel"><div class="panel-heading"><div><span class="eyebrow">Live surface</span><h2>Computer</h2></div><button class="icon-button" data-action="computer-toggle" aria-label="Close computer panel">×</button></div><div class="screen-preview"><div class="browser-bar"><span class="traffic red"></span><span class="traffic yellow"></span><span class="traffic green"></span><span class="address">${escapeHtml(state.computer.url)}</span></div><div class="screen-copy"><span class="scan-line"></span><strong>${state.computer.control === "human" ? "Human takeover" : "Agent seat ready"}</strong><small>${escapeHtml(state.computer.screenLabel)} · ${escapeHtml(state.computer.nodeLabel)}</small></div></div><div class="control-row"><span class="control-pill control-${state.computer.control}">${state.computer.control === "human" ? "Human control" : "Agent control"}</span>${state.computer.control === "human" ? `<button data-action="hand-back">Hand back</button>` : `<button data-action="takeover">Take over</button>`}</div><div class="panel-list"><div><span>Browser</span><strong>Connected</strong></div><div><span>Screen lease</span><strong>Generation 4</strong></div><div><span>Observation</span><strong>Secrets omitted</strong></div></div></aside>` : "";
  const conversationBody = state.activeSurface === "conversations" ? `${messages}${job ? renderJob(job) : ""}${artifacts ? `<div class="artifact-stack"><span class="eyebrow">Artifacts</span>${artifacts}</div>` : ""}` : renderSurface(state.activeSurface);
  const composer = state.activeSurface === "conversations" ? `<div class="composer"><div class="composer-tools"><span class="context-chip">⌁ Project Atlas</span><span class="context-chip">⌘ Developer</span></div><div class="composer-box"><textarea id="composer-input" rows="2" placeholder="Ask F.R.I.D.A.Y to make progress…"></textarea><button class="send-button" data-action="send">↑</button></div><div class="composer-hint"><span>Enter to send · Shift+Enter for a new line</span><span>Protected actions always ask first</span></div></div>` : "";
  root.innerHTML = `<div class="app-shell"><header class="topbar"><div class="brand"><span class="brand-mark">F</span><span>F.R.I.D.A.Y</span><span class="brand-context">/ desktop</span></div><div class="top-actions"><span class="connection connection-${state.connection}"><i></i>${state.connection === "online" ? "Gateway online" : state.connection === "connecting" ? "Connecting…" : "Demo cache"}</span><button class="ghost-button" data-action="reconnect">↻ Reconnect</button><button class="avatar-button">SP</button></div></header><div class="workspace"><nav class="sidebar"><div class="side-section"><span class="side-label">Workspace</span><button class="nav-item ${state.activeSurface === "conversations" ? "active" : ""}" data-surface="conversations"><span class="nav-icon">◈</span> Conversations <span class="count">1</span></button><button class="nav-item ${state.activeSurface === "agents" ? "active" : ""}" data-surface="agents"><span class="nav-icon">◌</span> Agents</button><button class="nav-item ${state.activeSurface === "groups" ? "active" : ""}" data-surface="groups"><span class="nav-icon">◎</span> Groups</button><button class="nav-item ${state.activeSurface === "projects" ? "active" : ""}" data-surface="projects"><span class="nav-icon">⌁</span> Projects</button><button class="nav-item ${state.activeSurface === "routines" ? "active" : ""}" data-surface="routines"><span class="nav-icon">◷</span> Routines</button></div><div class="side-section"><span class="side-label">Surfaces</span><button class="nav-item ${state.activeSurface === "computer" ? "active" : ""}" data-surface="computer"><span class="nav-icon">▣</span> Computer</button><button class="nav-item ${state.activeSurface === "files" ? "active" : ""}" data-surface="files"><span class="nav-icon">▤</span> Files</button><button class="nav-item ${state.activeSurface === "approvals" ? "active" : ""}" data-surface="approvals"><span class="nav-icon">✓</span> Approvals</button><button class="nav-item ${state.activeSurface === "jobs" ? "active" : ""}" data-surface="jobs"><span class="nav-icon">⌛</span> Jobs</button><button class="nav-item ${state.activeSurface === "search" ? "active" : ""}" data-surface="search"><span class="nav-icon">⌕</span> Search</button></div><div class="side-section"><span class="side-label">Configure</span><button class="nav-item ${state.activeSurface === "skills" ? "active" : ""}" data-surface="skills"><span class="nav-icon">✦</span> Skills</button><button class="nav-item ${state.activeSurface === "plugins" ? "active" : ""}" data-surface="plugins"><span class="nav-icon">⧉</span> Plugins</button><button class="nav-item ${state.activeSurface === "usage" ? "active" : ""}" data-surface="usage"><span class="nav-icon">◒</span> Usage</button><button class="nav-item ${state.activeSurface === "settings" ? "active" : ""}" data-surface="settings"><span class="nav-icon">⚙</span> Settings</button></div><div class="sidebar-footer"><span class="pulse-dot"></span><span>Local-first client</span></div></nav><main class="conversation"><div class="conversation-head"><div><span class="eyebrow">${state.activeSurface === "conversations" ? "Conversation" : "Workspace"}</span><h1>${state.activeSurface === "conversations" ? "Build a release checklist" : state.activeSurface.charAt(0).toUpperCase() + state.activeSurface.slice(1)}</h1><p>${state.activeSurface === "conversations" ? "Developer · Project Atlas" : "F.R.I.D.A.Y desktop"}</p></div><button class="icon-button" aria-label="Conversation options">•••</button></div><div class="message-list">${conversationBody}</div>${composer}</main>${panel || `<aside class="activity-panel"><div class="panel-heading"><div><span class="eyebrow">Workspace pulse</span><h2>Activity</h2></div><span class="live-badge">LIVE</span></div><div class="activity-timeline"><div class="timeline-item"><span class="timeline-dot done"></span><div><strong>Conversation synced</strong><small>Sequence ${state.lastSequence || "—"}</small></div></div><div class="timeline-item"><span class="timeline-dot"></span><div><strong>Jobs stay server-side</strong><small>Close the app safely anytime</small></div></div><div class="timeline-item"><span class="timeline-dot"></span><div><strong>Computer is ready</strong><small>Take over only when you choose</small></div></div></div><div class="activity-tip"><span>✦</span><div><strong>Connected workspace</strong><p>Chat, durable work, approvals, artifacts, and computer control share one clear surface.</p></div></div></aside>`}</div>${state.notice ? `<div class="toast" role="status">${escapeHtml(state.notice)}<button data-action="clear-notice" aria-label="Dismiss">×</button></div>` : ""}</div>`;
  if (paletteOpen) renderPalette();
  bindEvents();
}

const commands: readonly DesktopCommand[] = [
  { id: "new-conversation", label: "New conversation", hint: "Start a fresh thread", run: () => dispatch({ type: "surface", surface: "conversations" }) },
  { id: "open-computer", label: "Open Computer", hint: "View the leased screen", run: () => dispatch({ type: "surface", surface: "computer" }) },
  { id: "open-jobs", label: "Open Jobs", hint: "Review background work", run: () => dispatch({ type: "surface", surface: "jobs" }) },
  { id: "open-settings", label: "Open Settings", hint: "Gateway and device settings", run: () => dispatch({ type: "surface", surface: "settings" }) },
];

function renderPalette(): void {
  const matches = filterDesktopCommands(commands, paletteQuery);
  const overlay = document.createElement("div");
  overlay.className = "palette-overlay";
  overlay.innerHTML = `<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette"><input id="palette-input" autofocus placeholder="Search commands…" value="${escapeHtml(paletteQuery)}" /><div class="palette-results">${matches.map((command) => `<button data-command-id="${escapeHtml(command.id)}"><strong>${escapeHtml(command.label)}</strong><span>${escapeHtml(command.hint)}</span></button>`).join("") || "<p>No commands found.</p>"}</div><small>Esc to close · ↑↓ to navigate · Enter to run</small></div>`;
  root.append(overlay);
  const input = overlay.querySelector<HTMLInputElement>("#palette-input");
  input?.focus();
  input?.addEventListener("input", () => { paletteQuery = input.value; render(); });
  overlay.addEventListener("click", (event) => { if (event.target === overlay) { paletteOpen = false; render(); } });
  overlay.querySelectorAll<HTMLButtonElement>("[data-command-id]").forEach((button) => button.addEventListener("click", () => {
    const command = commands.find((entry) => entry.id === button.dataset.commandId);
    paletteOpen = false;
    if (command) void command.run();
    render();
  }));
}

function bindEvents(): void {
  root.querySelectorAll<HTMLElement>("[data-surface]").forEach((element) => element.addEventListener("click", () => {
    const surface = element.dataset.surface as import("./core.js").DesktopSurface | undefined;
    if (surface) dispatch({ type: "surface", surface });
  }));
  root.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => element.addEventListener("click", () => {
    const action = element.dataset.action;
    if (action === "computer-toggle") dispatch({ type: "computer-toggle" });
    if (action === "takeover") dispatch({ type: "computer-takeover" });
    if (action === "hand-back") dispatch({ type: "computer-hand-back" });
    if (action === "clear-notice") dispatch({ type: "notice" });
    if (action === "reconnect") {
      dispatch({ type: "connection", status: "online" });
      dispatch({ type: "gateway-events", events: [{ sequence: state.lastSequence + 1, type: "conversation.synced", data: {} }] });
      dispatch({ type: "notice", message: "Reconnected and resumed from the last event sequence." });
    }
    if (action === "approve") {
      const jobId = element.dataset.jobId;
      if (!jobId) return;
      dispatch({ type: "job-update", jobId, status: "approved", progress: 65 });
      window.setTimeout(() => {
        const artifact: DesktopArtifact = { id: `artifact-${jobId}`, name: "release-checklist.md", kind: "document", summary: "A reviewed checklist with build, test, and rollback steps.", createdAt: new Date().toISOString() };
        dispatch({ type: "artifact-added", artifact });
        dispatch({ type: "job-update", jobId, status: "completed", progress: 100, artifactId: artifact.id });
        notifier.notify("F.R.I.D.A.Y job completed", "release-checklist.md is ready to inspect.", artifact.id);
        dispatch({ type: "notice", message: "Job completed and the artifact is ready to inspect." });
      }, 550);
    }
    if (action === "send") sendMessage();
  }));
  root.querySelector<HTMLTextAreaElement>("#composer-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); }
  });
}

function sendMessage(): void {
  const input = root.querySelector<HTMLTextAreaElement>("#composer-input");
  const value = input?.value.trim() ?? "";
  if (!value) return;
  dispatch({ type: "send-message", text: value });
  window.setTimeout(() => {
    const job = latestJob();
    if (!job) return;
    dispatch({ type: "job-update", jobId: job.id, status: "awaiting-approval", progress: 48, approvalLabel: "Create release checklist" });
    dispatch({ type: "notice", message: "F.R.I.D.A.Y needs your approval before creating the artifact." });
  }, 500);
}

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    paletteOpen = !paletteOpen;
    paletteQuery = "";
    render();
  }
  if (event.key === "Escape" && paletteOpen) { paletteOpen = false; render(); }
});

const initialLink = parseDesktopDeepLink(globalThis.location.href);
if (initialLink) {
  const surface = initialLink.kind === "conversation" ? "conversations" : initialLink.kind === "job" ? "jobs" : initialLink.kind === "artifact" ? "files" : initialLink.kind;
  state = reduceDesktopState(state, { type: "surface", surface });
}

render();
