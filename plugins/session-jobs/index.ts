import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FridayPlugin } from "../../src/plugin.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../channels/trusted-contract.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EVENTS_CAPABILITY } from "../events/contract.js";
import { ownerScopeAllows } from "../principal-scope.js";
import { TURN_INGRESS_HOOK } from "../turn-loop/contract.js";
import { isLifecycleRestartEnvironment, LIFECYCLE_HANDOFF_CONTRIBUTION } from "../lifecycle/contract.js";
import { SESSIONS_CAPABILITY } from "../sessions/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_ACTIVE_WORK_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION, type SystemActionExecutionContext, type SystemJsonObject } from "../system/contract.js";
import { SESSION_JOBS_CAPABILITY, type SessionJobRecord } from "./contract.js";
import { SessionJobManager } from "./manager.js";


function getFridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_HOME?.trim();
  return resolve(configured || join(homedir(), ".friday"));
}

function optionalString(input: Readonly<SystemJsonObject>, name: string, maximum = 512): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return normalized;
}

function optionalInteger(input: Readonly<SystemJsonObject>, name: string, fallback: number, maximum = 100): number {
  const value = input[name];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value as number;
}

function channelPrincipal(context: SystemActionExecutionContext) {
  const principal = context.turn.principal;
  if (principal.authority !== "channel") return undefined;
  return {
    channel: principal.channel,
    accountId: principal.accountId,
    conversationId: principal.conversationId,
    senderId: principal.senderId,
    ...(principal.threadId === undefined ? {} : { threadId: principal.threadId }),
  };
}

function sameOrigin(job: SessionJobRecord, context: SystemActionExecutionContext): boolean {
  const principal = context.turn.principal;
  return job.origin.authority === principal.authority
    && job.origin.channel === principal.channel
    && job.origin.accountId === principal.accountId
    && job.origin.conversationId === principal.conversationId
    && job.origin.senderId === principal.senderId
    && (job.origin.threadId ?? "") === (principal.threadId ?? "");
}

function jobSummary(job: SessionJobRecord): string {
  const age = job.startedAt ?? job.createdAt;
  return [
    `${job.id} — ${job.label}`,
    `status=${job.status}`,
    `started=${age}`,
    job.currentStatus ? `current=${job.currentStatus}` : undefined,
    job.requestPreview ? `request=${job.requestPreview}` : undefined,
  ].filter(Boolean).join(" | ");
}

function formatJobList(jobs: readonly SessionJobRecord[], includeCompleted: boolean): string {
  if (jobs.length === 0) {
    return includeCompleted ? "No background session jobs are recorded." : "No background session jobs are currently active.";
  }
  const heading = includeCompleted ? "Background session jobs:" : `I'm currently working on ${jobs.length} background ${jobs.length === 1 ? "task" : "tasks"}:`;
  return [
    heading,
    "",
    ...jobs.flatMap((job, index) => [
      `${index + 1}. ${job.label}`,
      `   ${job.status}${job.retryAttempt === undefined ? "" : ` · retry ${job.retryAttempt}/${job.retryMax ?? "?"}`}`,
      `   job: ${job.id}${job.sessionId === undefined ? "" : ` · session: ${job.sessionId}`}`,
      `   current: ${job.currentStatus ?? job.requestPreview}`,
      "",
    ]),
  ].join("\n").trimEnd();
}

function formatTranscript(
  info: { readonly id: string; readonly name?: string | undefined },
  items: readonly { readonly at: string; readonly type: string; readonly text: string; readonly kind?: string | undefined }[],
  job?: SessionJobRecord,
): string {
  const heading = [`Session transcript: ${info.name?.trim() || info.id}`, `session: ${info.id}`];
  if (job) heading.push(`job: ${job.id} · ${job.label} · ${job.status}`);
  const body = items.flatMap((entry) => {
    const speaker = entry.type === "user" ? "YOU" : entry.type === "assistant" ? "FRIDAY" : "PROGRESS";
    return [`[${entry.at}] ${speaker}${entry.kind ? ` (${entry.kind})` : ""}`, entry.text, ""];
  });
  if (body.length === 0) body.push("No visible transcript entries matched this request.", "");
  return [...heading, "", ...body, "Raw private reasoning is intentionally omitted."].join("\n").trim();
}

function selectByReply(matches: readonly SessionJobRecord[], reply: string): SessionJobRecord | undefined {
  const trimmed = reply.trim();
  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= matches.length && String(numeric) === trimmed) {
    return matches[numeric - 1];
  }
  const byId = matches.find((job) => job.id === trimmed);
  if (byId) return byId;
  const selector = trimmed
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(?:cancel|stop|abort|session|job|task|work|the|a|an)\b/g, " ")
    .replace(/[^\p{L}\p{N}_:-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (selector.length < 2) return undefined;
  const naturalMatches = matches.filter((job) => {
    const haystack = `${job.label} ${job.requestPreview} ${job.destinationId}`.normalize("NFKC").toLowerCase();
    return haystack.includes(selector);
  });
  return naturalMatches.length === 1 ? naturalMatches[0] : undefined;
}

const MAX_TRANSCRIPT_ENTRY_CHARS = 8_192;

function clipTranscriptText(value: string): string {
  const normalized = value.replaceAll("\u0000", "\ufffd").trim();
  return normalized.length <= MAX_TRANSCRIPT_ENTRY_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_TRANSCRIPT_ENTRY_CHARS - 1)}\u2026`;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return clipTranscriptText(content);
  if (!Array.isArray(content)) return "";
  const text = content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const item = part as { type?: unknown; text?: unknown };
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("").trim();
  return clipTranscriptText(text);
}

export interface SessionJobsPluginOptions {
  readonly home?: string | undefined;
  readonly progressNotifyIntervalMs?: number | undefined;
}

export function createSessionJobsPlugin(options: SessionJobsPluginOptions = {}): FridayPlugin {
  return definePlugin({
    id: "session-jobs",
    requires: [EVENTS_CAPABILITY, SESSIONS_CAPABILITY],
    optional: [CHANNELS_TRUSTED_CAPABILITY],
    provides: [SESSION_JOBS_CAPABILITY],
  }, async (ctx) => {
    const home = options.home ?? getFridayHome();
    const sessions = ctx.services.require(SESSIONS_CAPABILITY).api;
    const events = ctx.services.require(EVENTS_CAPABILITY);
    const sessionsDir = join(home, "sessions");
    const restartSuccessor = isLifecycleRestartEnvironment();
    const manager = await SessionJobManager.open({
      stateDir: join(home, "session-jobs"),
      events,
      progressNotifyIntervalMs: options.progressNotifyIntervalMs,
      recoverInterrupted: !restartSuccessor,
      startSuspended: restartSuccessor,
      async resolveLabel(destinationId, text, origin) {
        if (destinationId === "session:new") return text.trim().slice(0, 80) || "new session";
        if (!destinationId.startsWith("session:")) return destinationId;
        const sessionId = destinationId.slice("session:".length);
        const candidate = (await sessions.SessionManager.listAll(undefined, sessionsDir))
          .filter((entry) => ownerScopeAllows(entry.ownerScope, origin))
          .find((entry) => entry.id === sessionId);
        return candidate?.name?.trim() || candidate?.firstMessage?.trim().slice(0, 80) || `session ${sessionId}`;
      },
    });
    ctx.services.provide(SESSION_JOBS_CAPABILITY, manager);
    ctx.effect(() => manager.close());

    const publishResumeRequests = (): void => {
      for (const job of manager.resumable()) {
        events.publish({
          id: `session-job:${job.id}:resume-requested`,
          type: "session-job.resume-requested",
          source: "session-jobs",
          subject: `job:${job.id}`,
          data: { jobId: job.id },
        });
      }
    };

    const registerResumeConsumer = typeof events.registerConsumer === "function"
      ? events.registerConsumer.bind(events)
      : undefined;
    const unregisterResumeConsumer = registerResumeConsumer ? registerResumeConsumer({
      id: "session-jobs.restart-resume.v1",
      types: ["session-job.resume-requested"],
      startAt: "beginning",
      retry: { maxAttempts: 100, initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 60_000 },
    }, async ({ event, signal }) => {
      signal?.throwIfAborted();
      const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
        ? event.data as Record<string, unknown>
        : undefined;
      const jobId = typeof data?.jobId === "string" ? data.jobId : undefined;
      if (!jobId) throw new Error("session-job resume event is missing jobId");
      const job = manager.resumable().find((entry) => entry.id === jobId);
      if (!job) return;
      const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
      if (!channels) throw new Error(`Cannot resume ${job.id}: trusted channels capability is unavailable`);
      const turnId = `session-job-resume:${job.id}`;
      const continuationText = [
        "Continue the user request that was interrupted by a FRIDAY restart.",
        "Resume from the last durable session transcript and persisted tool outputs. Do not repeat successful side effects already recorded in that transcript.",
        "Any private model thinking that had not yet been written to the transcript was intentionally not preserved.",
        "",
        "Original user request:",
        job.requestText,
      ].join("\n");
      await ctx.emit(TURN_INGRESS_HOOK, Object.freeze({
        id: turnId,
        principal: Object.freeze({ ...job.origin }),
        text: continuationText,
        timestamp: Date.now(),
        resumeDestinationId: job.destinationId,
        resumedJobId: job.id,
        reply: async (text: string) => {
          await channels.send({
            channel: job.origin.channel,
            accountId: job.origin.accountId,
            conversationId: job.origin.conversationId,
            ...(job.origin.threadId === undefined ? {} : { threadId: job.origin.threadId }),
          }, text);
        },
      }));
      await manager.markResumed(job.id, turnId);
    }) : () => undefined;
    ctx.effect(unregisterResumeConsumer);

    ctx.contribute(SYSTEM_ACTIVE_WORK_CONTRIBUTION, {
      id: "session-jobs",
      snapshot: (query) => ({
        backgroundSessions: manager.list({ activeOnly: true, limit: 128 })
          .filter((job) => job.id !== query.excludeJobId).length,
      }),
    });

    ctx.contribute(LIFECYCLE_HANDOFF_CONTRIBUTION, {
      id: "session-jobs",
      activate: async () => {
        await manager.activate();
        publishResumeRequests();
      },
      quiesce: () => manager.quiesce(),
    });
    if (!restartSuccessor) ctx.afterReady(() => publishResumeRequests());

    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "session-jobs",
      label: "Background session jobs",
      snapshot: () => {
        const active = manager.list({ activeOnly: true, limit: 100 });
        return {
          active: active.length,
          queued: active.filter((job) => job.status === "queued").length,
          running: active.filter((job) => job.status === "running").length,
          retrying: active.filter((job) => job.status === "retrying").length,
        };
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "session.jobs.list",
      label: "Current background work",
      description: "List FRIDAY background session jobs. Use this for questions like what are you working on, current tasks, active work, or job status.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          includeCompleted: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      }),
      permission() {
        return { id: "session.jobs.list", effect: "private-read", resource: "session-jobs:origin", network: false };
      },
      execute(input, context) {
        const includeCompleted = input.includeCompleted === true;
        const limit = optionalInteger(input, "limit", 20, 100);
        const jobs = manager.list({ activeOnly: !includeCompleted, limit: 100 })
          .filter((job) => sameOrigin(job, context))
          .slice(0, limit);
        return formatJobList(jobs, includeCompleted);
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "session.jobs.cancel",
      label: "Cancel background session work",
      description: "Resolve a natural-language job/session selector, disambiguate similar active jobs, require confirmation bound to the originating channel principal, then cancel only that exact running or queued job. This never deletes session history.",
      parameters: Object.freeze({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      }),
      permission(input) {
        const query = optionalString(input, "query") ?? "active";
        return { id: "session.jobs.cancel", effect: "system-write", resource: `session-job:${query}`, network: false };
      },
      async execute(input, context) {
        const query = optionalString(input, "query") ?? "";
        const matches = manager.find(query, { activeOnly: true }).filter((job) => sameOrigin(job, context));
        if (matches.length === 0) return `No active background job matches ${JSON.stringify(query)}.`;
        const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
        const principal = channelPrincipal(context);
        let selected: SessionJobRecord | undefined;
        if (matches.length === 1) selected = matches[0];
        else if (channels && principal) {
          const response = await channels.requestPrompt({
            principal,
            message: [
              `I found ${matches.length} active jobs matching ${JSON.stringify(query)}:`,
              ...matches.slice(0, 10).map((job, index) => `${index + 1}. ${jobSummary(job)}`),
              "Reply with the number, exact job id, or a unique label such as brain/training to choose which one to cancel.",
            ].join("\n"),
            placeholder: "1",
            maxLength: 96,
          });
          selected = selectByReply(matches.slice(0, 10), response);
          if (!selected) return "Cancellation selection was not recognized; nothing was cancelled.";
        } else {
          return [
            "Multiple active jobs match. Specify the exact job id:",
            ...matches.slice(0, 10).map((job, index) => `${index + 1}. ${jobSummary(job)}`),
          ].join("\n");
        }

        if (!selected) return "No job selected; nothing was cancelled.";
        if (channels && principal) {
          const approved = await channels.requestApproval({
            principal,
            actionId: "session.jobs.cancel",
            effect: "system-write",
            resource: `job:${selected.id}`,
            reason: `Cancel ${selected.label}. ${selected.currentStatus ?? selected.requestPreview}`,
          });
          if (!approved) return `Cancellation denied. ${selected.label} (${selected.id}) is still running.`;
        } else {
          return `Cancellation requires protected channel confirmation. ${selected.label} (${selected.id}) is still running.`;
        }
        const cancelled = await manager.cancel(selected.id, "Cancelled by confirmed user request");
        if (cancelled.status !== "cancelled") {
          return `${cancelled.label} (${cancelled.id}) finished before cancellation was applied; nothing was cancelled.`;
        }
        return `Cancelled ${cancelled.label} (${cancelled.id}). Session history was preserved.`;
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "session.transcript",
      label: "Session transcript",
      description: "Show a bounded visible transcript for a session or background job, including user prompts, assistant text answers, and FRIDAY progress/retry records. Raw private chain-of-thought is never exposed.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
        additionalProperties: false,
      }),
      permission() {
        return { id: "session.transcript", effect: "private-read", resource: "sessions:origin", network: false };
      },
      async execute(input, context) {
        const query = optionalString(input, "query") ?? "";
        const limit = optionalInteger(input, "limit", 20, 100);
        const jobMatches = manager.find(query, { activeOnly: false }).filter((entry) => sameOrigin(entry, context));
        let sessionId = jobMatches.length === 1 ? jobMatches[0]?.sessionId : undefined;
        let job = jobMatches.length === 1 ? jobMatches[0] : undefined;
        const all = (await sessions.SessionManager.listAll(undefined, sessionsDir))
          .filter((entry) => ownerScopeAllows(entry.ownerScope, context.turn.principal));
        if (!sessionId) {
          const normalized = query.replace(/^session:/i, "").trim().toLowerCase();
          const sessionMatches = all.filter((entry) =>
            entry.id.toLowerCase() === normalized
            || entry.name?.toLowerCase().includes(normalized)
            || entry.firstMessage.toLowerCase().includes(normalized),
          );
          if (sessionMatches.length !== 1) {
            return {
              found: false,
              ambiguous: sessionMatches.length > 1 || jobMatches.length > 1,
              jobCandidates: jobMatches.slice(0, 10),
              sessionCandidates: sessionMatches.slice(0, 10).map((entry) => ({ id: entry.id, name: entry.name, firstMessage: entry.firstMessage, modified: entry.modified.toISOString() })),
            };
          }
          sessionId = sessionMatches[0]!.id;
        }
        const info = all.find((entry) => entry.id === sessionId);
        if (!info) return { found: false, message: `Session ${sessionId} was not found.` };
        const session = sessions.SessionManager.open(info.path, sessionsDir);
        const items = session.getEntries().flatMap((entry) => {
          if (entry.type === "message") {
            const role = entry.message.role;
            if (role !== "user" && role !== "assistant") return [];
            const text = messageText(entry.message);
            if (!text) return [];
            return [{ at: entry.timestamp, type: role, text }];
          }
          if (entry.type === "custom" && entry.customType === "session-job.progress") {
            const data = entry.data as { kind?: unknown; message?: unknown } | undefined;
            if (typeof data?.message !== "string") return [];
            return [{ at: entry.timestamp, type: "progress", text: clipTranscriptText(data.message), kind: typeof data.kind === "string" ? data.kind : undefined }];
          }
          return [];
        }).slice(-limit);
        return formatTranscript({ id: info.id, name: info.name }, items, job);
      },
    });
  });
}

export default createSessionJobsPlugin();
export * from "./contract.js";
export { SessionJobManager, type SessionJobManagerOptions } from "./manager.js";
