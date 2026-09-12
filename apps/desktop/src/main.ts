import { createDesktopState, reduceDesktopState, type DesktopAction, type DesktopArtifact, type DesktopJob } from "./core.js";

let state = createDesktopState();
const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) throw new Error("desktop app root is missing");
const root: HTMLElement = appRoot;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function dispatch(action: DesktopAction): void {
  state = reduceDesktopState(state, action);
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

function render(): void {
  const job = latestJob();
  const artifacts = state.artifacts.map((artifact) => `<article class="artifact-card"><div class="artifact-icon">${artifact.kind === "diff" ? "Δ" : "▤"}</div><div><strong>${escapeHtml(artifact.name)}</strong><p>${escapeHtml(artifact.summary)}</p><small>${escapeHtml(artifact.kind)} · just now</small></div><button class="icon-button" aria-label="Open artifact">↗</button></article>`).join("");
  const messages = state.messages.length === 0
    ? `<div class="empty-state"><span class="pulse-dot"></span><h3>Start a thread</h3><p>Ask F.R.I.D.A.Y to do something useful. Long-running work will appear here with approvals and artifacts.</p></div>`
    : state.messages.map((message) => `<div class="message message-${message.role}"><div class="avatar">${message.role === "user" ? "SP" : "F"}</div><div><span class="message-author">${message.role === "user" ? "You" : "F.R.I.D.A.Y"}</span><p>${escapeHtml(message.text)}</p></div></div>`).join("");
  const panel = state.computer.open ? `<aside class="computer-panel"><div class="panel-heading"><div><span class="eyebrow">Live surface</span><h2>Computer</h2></div><button class="icon-button" data-action="computer-toggle" aria-label="Close computer panel">×</button></div><div class="screen-preview"><div class="browser-bar"><span class="traffic red"></span><span class="traffic yellow"></span><span class="traffic green"></span><span class="address">${escapeHtml(state.computer.url)}</span></div><div class="screen-copy"><span class="scan-line"></span><strong>${state.computer.control === "human" ? "Human takeover" : "Agent seat ready"}</strong><small>${escapeHtml(state.computer.screenLabel)} · ${escapeHtml(state.computer.nodeLabel)}</small></div></div><div class="control-row"><span class="control-pill control-${state.computer.control}">${state.computer.control === "human" ? "Human control" : "Agent control"}</span>${state.computer.control === "human" ? `<button data-action="hand-back">Hand back</button>` : `<button data-action="takeover">Take over</button>`}</div><div class="panel-list"><div><span>Browser</span><strong>Connected</strong></div><div><span>Screen lease</span><strong>Generation 4</strong></div><div><span>Observation</span><strong>Secrets omitted</strong></div></div></aside>` : "";
  root.innerHTML = `<div class="app-shell"><header class="topbar"><div class="brand"><span class="brand-mark">F</span><span>F.R.I.D.A.Y</span><span class="brand-context">/ desktop</span></div><div class="top-actions"><span class="connection connection-${state.connection}"><i></i>${state.connection === "online" ? "Gateway online" : state.connection === "connecting" ? "Connecting…" : "Demo cache"}</span><button class="ghost-button" data-action="reconnect">↻ Reconnect</button><button class="avatar-button">SP</button></div></header><div class="workspace"><nav class="sidebar"><div class="side-section"><span class="side-label">Workspace</span><button class="nav-item active"><span class="nav-icon">◈</span> Conversations <span class="count">1</span></button><button class="nav-item"><span class="nav-icon">◌</span> Agents</button><button class="nav-item"><span class="nav-icon">⌁</span> Projects</button></div><div class="side-section"><span class="side-label">Surfaces</span><button class="nav-item" data-action="computer-toggle"><span class="nav-icon">▣</span> Computer ${state.computer.open ? "· open" : ""}</button><button class="nav-item"><span class="nav-icon">▤</span> Files</button><button class="nav-item"><span class="nav-icon">✓</span> Approvals</button></div><div class="sidebar-footer"><span class="pulse-dot"></span><span>Local-first client</span></div></nav><main class="conversation"><div class="conversation-head"><div><span class="eyebrow">Conversation</span><h1>Build a release checklist</h1><p>Developer · Project Atlas</p></div><button class="icon-button" aria-label="Conversation options">•••</button></div><div class="message-list">${messages}${job ? renderJob(job) : ""}${artifacts ? `<div class="artifact-stack"><span class="eyebrow">Artifacts</span>${artifacts}</div>` : ""}</div><div class="composer"><div class="composer-tools"><span class="context-chip">⌁ Project Atlas</span><span class="context-chip">⌘ Developer</span></div><div class="composer-box"><textarea id="composer-input" rows="2" placeholder="Ask F.R.I.D.A.Y to make progress…"></textarea><button class="send-button" data-action="send">↑</button></div><div class="composer-hint"><span>Enter to send · Shift+Enter for a new line</span><span>Protected actions always ask first</span></div></div></main>${panel || `<aside class="activity-panel"><div class="panel-heading"><div><span class="eyebrow">Workspace pulse</span><h2>Activity</h2></div><span class="live-badge">LIVE</span></div><div class="activity-timeline"><div class="timeline-item"><span class="timeline-dot done"></span><div><strong>Conversation synced</strong><small>Sequence ${state.lastSequence || "—"}</small></div></div><div class="timeline-item"><span class="timeline-dot"></span><div><strong>Jobs stay server-side</strong><small>Close the app safely anytime</small></div></div><div class="timeline-item"><span class="timeline-dot"></span><div><strong>Computer is ready</strong><small>Take over only when you choose</small></div></div></div><div class="activity-tip"><span>✦</span><div><strong>First slice</strong><p>Chat, durable work, approvals, artifacts, and computer control share one clear surface.</p></div></div></aside>`}</div>${state.notice ? `<div class="toast" role="status">${escapeHtml(state.notice)}<button data-action="clear-notice" aria-label="Dismiss">×</button></div>` : ""}</div>`;
  bindEvents();
}

function bindEvents(): void {
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

render();
