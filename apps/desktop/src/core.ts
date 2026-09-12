export type DesktopConnection = "offline" | "connecting" | "online";
export type DesktopJobStatus = "queued" | "running" | "awaiting-approval" | "approved" | "completed" | "failed";
export type DesktopMessageRole = "user" | "assistant" | "system";

export interface DesktopMessage {
  readonly id: string;
  readonly role: DesktopMessageRole;
  readonly text: string;
  readonly createdAt: string;
}

export interface DesktopJob {
  readonly id: string;
  readonly title: string;
  readonly status: DesktopJobStatus;
  readonly progress: number;
  readonly approvalLabel?: string;
  readonly artifactId?: string;
}

export interface DesktopArtifact {
  readonly id: string;
  readonly name: string;
  readonly kind: "diff" | "document" | "report";
  readonly summary: string;
  readonly createdAt: string;
}

export interface DesktopComputerPanel {
  readonly open: boolean;
  readonly nodeLabel: string;
  readonly screenLabel: string;
  readonly url: string;
  readonly control: "agent" | "human";
}

export interface DesktopEvent {
  readonly sequence: number;
  readonly type: string;
  readonly data: unknown;
}

export interface DesktopState {
  readonly connection: DesktopConnection;
  readonly lastSequence: number;
  readonly conversationId: string;
  readonly messages: readonly DesktopMessage[];
  readonly jobs: readonly DesktopJob[];
  readonly artifacts: readonly DesktopArtifact[];
  readonly computer: DesktopComputerPanel;
  readonly notice?: string;
}

export type DesktopAction =
  | { readonly type: "connection"; readonly status: DesktopConnection }
  | { readonly type: "send-message"; readonly text: string; readonly now?: string; readonly messageId?: string; readonly jobId?: string }
  | { readonly type: "job-update"; readonly jobId: string; readonly status: DesktopJobStatus; readonly progress: number; readonly approvalLabel?: string; readonly artifactId?: string }
  | { readonly type: "artifact-added"; readonly artifact: DesktopArtifact }
  | { readonly type: "computer-toggle" }
  | { readonly type: "computer-takeover" }
  | { readonly type: "computer-hand-back" }
  | { readonly type: "notice"; readonly message?: string }
  | { readonly type: "gateway-events"; readonly events: readonly DesktopEvent[] };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function eventRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function eventMessage(state: DesktopState, event: DesktopEvent): DesktopState {
  const data = eventRecord(event.data);
  const messageText = text(data?.text);
  if (!messageText) return state;
  const role = data?.role === "user" || data?.role === "system" ? data.role : "assistant";
  return {
    ...state,
    messages: [...state.messages, { id: text(data?.messageId) ?? `event-${event.sequence}`, role, text: messageText, createdAt: text(data?.createdAt) ?? new Date().toISOString() }],
  };
}

function eventJob(state: DesktopState, event: DesktopEvent): DesktopState {
  const data = eventRecord(event.data);
  const jobId = text(data?.jobId);
  const status = data?.status;
  if (!jobId || status !== "queued" && status !== "running" && status !== "awaiting-approval" && status !== "approved" && status !== "completed" && status !== "failed") return state;
  const update: DesktopAction = {
    type: "job-update",
    jobId,
    status,
    progress: typeof data?.progress === "number" && Number.isFinite(data.progress) ? Math.max(0, Math.min(100, data.progress)) : 0,
    ...(text(data?.approvalLabel) === undefined ? {} : { approvalLabel: text(data?.approvalLabel) as string }),
    ...(text(data?.artifactId) === undefined ? {} : { artifactId: text(data?.artifactId) as string }),
  };
  return reduceDesktopState(state, update);
}

export function createDesktopState(conversationId = "conversation-demo"): DesktopState {
  return Object.freeze({
    connection: "offline",
    lastSequence: 0,
    conversationId,
    messages: Object.freeze([]),
    jobs: Object.freeze([]),
    artifacts: Object.freeze([]),
    computer: Object.freeze({ open: false, nodeLabel: "Linux Computer", screenLabel: "Developer seat", url: "about:blank", control: "agent" }),
  });
}

export function reduceDesktopState(state: DesktopState, action: DesktopAction): DesktopState {
  switch (action.type) {
    case "connection": return { ...state, connection: action.status };
    case "notice": {
      if (action.message !== undefined) return { ...state, notice: action.message };
      const { notice: _notice, ...withoutNotice } = state;
      return withoutNotice;
    }
    case "send-message": {
      const messageId = action.messageId ?? `message-${Date.now()}`;
      const jobId = action.jobId ?? `job-${Date.now()}`;
      const createdAt = action.now ?? new Date().toISOString();
      return {
        ...state,
        messages: [...state.messages, { id: messageId, role: "user", text: action.text.trim(), createdAt }],
        jobs: [...state.jobs, { id: jobId, title: "F.R.I.D.A.Y is working", status: "queued", progress: 8 }],
        notice: "Job queued. The server remains the source of truth for execution.",
      };
    }
    case "job-update": {
      const exists = state.jobs.some((job) => job.id === action.jobId);
      const nextJob: DesktopJob = {
        id: action.jobId,
        title: exists ? state.jobs.find((job) => job.id === action.jobId)?.title ?? "F.R.I.D.A.Y job" : "F.R.I.D.A.Y job",
        status: action.status,
        progress: Math.max(0, Math.min(100, action.progress)),
        ...(action.approvalLabel === undefined ? {} : { approvalLabel: action.approvalLabel }),
        ...(action.artifactId === undefined ? {} : { artifactId: action.artifactId }),
      };
      return { ...state, jobs: exists ? state.jobs.map((job) => job.id === action.jobId ? nextJob : job) : [...state.jobs, nextJob] };
    }
    case "artifact-added": {
      if (state.artifacts.some((artifact) => artifact.id === action.artifact.id)) return state;
      return { ...state, artifacts: [...state.artifacts, action.artifact] };
    }
    case "computer-toggle": return { ...state, computer: { ...state.computer, open: !state.computer.open } };
    case "computer-takeover": return { ...state, computer: { ...state.computer, open: true, control: "human" }, notice: "Human takeover active. Agent input is paused." };
    case "computer-hand-back": return { ...state, computer: { ...state.computer, control: "agent" }, notice: "Control handed back after a fresh observation." };
    case "gateway-events": {
      let next = state;
      for (const event of [...action.events].sort((left, right) => left.sequence - right.sequence)) {
        if (!Number.isSafeInteger(event.sequence) || event.sequence <= next.lastSequence) continue;
        const type = event.type.toLowerCase();
        if (type.includes("message")) next = eventMessage(next, event);
        else if (type.includes("job")) next = eventJob(next, event);
        next = { ...next, lastSequence: event.sequence };
      }
      return next;
    }
  }
}
