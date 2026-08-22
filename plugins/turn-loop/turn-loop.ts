import { createHash } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import type { EventsService } from "../events/contract.js";
import type { ObservabilityService } from "../observability/contract.js";
import type { PermissionsTrustedService } from "../permissions/trusted-contract.js";
import type { RoutingService } from "../routing/contract.js";
import type { SessionJobsService } from "../session-jobs/contract.js";
import type {
  InboundTurn,
  TurnAttachment,
  TurnExecutionResult,
  TurnExecutor,
  TurnResult,
  TurnRuntimeService,
  TurnRuntimeStatus,
  TurnSubmitOptions,
} from "./contract.js";

const MAX_ID_CHARS = 256;
const MAX_TEXT_CHARS = 128_000;
const MAX_PRINCIPAL_CHARS = 256;
const MAX_COMPLETED_IN_PROCESS = 2_048;
const MAX_ATTACHMENTS = 64;
const SAFE_FAILURE_REPLY = "FRIDAY could not complete this turn.";
const ATTACHMENT_KINDS = new Set<TurnAttachment["kind"]>(["image", "audio", "video", "document", "sticker", "other"]);

export interface TurnRuntimeOptions {
  readonly routing: RoutingService;
  readonly permissions: PermissionsTrustedService;
  readonly events: EventsService;
  readonly executors: () => readonly TurnExecutor[];
  readonly observability?: (() => ObservabilityService | undefined) | undefined;
  readonly sessionJobs?: (() => SessionJobsService | undefined) | undefined;
}

function boundedText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.replaceAll("\u0000", "\ufffd");
  if (!normalized.trim()) throw new Error(`${label} must not be empty`);
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return normalized;
}

function boundedOpaque(value: string, label: string, maximum = MAX_PRINCIPAL_CHARS): string {
  const normalized = boundedText(value, label, maximum).trim();
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} contains control characters`);
  return normalized;
}

function normalizeAuthority(value: InboundTurn["principal"]["authority"]): "local" | "channel" {
  if (value === "local" || value === "channel") return value;
  throw new Error("turn principal authority must be local or channel");
}

function optionalAttachmentText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return boundedOpaque(value, label, maximum);
}

function normalizeAttachments(value: InboundTurn["attachments"]): readonly TurnAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("turn attachments must be an array");
  if (value.length > MAX_ATTACHMENTS) throw new Error(`turn attachments exceed ${MAX_ATTACHMENTS} items`);
  return Object.freeze(value.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      throw new Error(`turn attachment ${index} must be an object`);
    }
    if (!ATTACHMENT_KINDS.has(attachment.kind)) throw new Error(`turn attachment ${index} kind is invalid`);
    const sizeBytes = attachment.sizeBytes;
    if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
      throw new Error(`turn attachment ${index} sizeBytes must be a non-negative safe integer`);
    }
    return Object.freeze({
      kind: attachment.kind,
      externalId: boundedOpaque(attachment.externalId, `turn attachment ${index} externalId`, 256),
      ...(attachment.mimeType === undefined ? {} : { mimeType: optionalAttachmentText(attachment.mimeType, `turn attachment ${index} mimeType`, 128)! }),
      ...(attachment.fileName === undefined ? {} : { fileName: optionalAttachmentText(attachment.fileName, `turn attachment ${index} fileName`, 512)! }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      ...(attachment.downloadUrl === undefined ? {} : { downloadUrl: optionalAttachmentText(attachment.downloadUrl, `turn attachment ${index} downloadUrl`, 4_096)! }),
      ...(attachment.artifactRef === undefined ? {} : { artifactRef: optionalAttachmentText(attachment.artifactRef, `turn attachment ${index} artifactRef`, 512)! }),
    });
  }));
}

function normalizeTurn(turn: InboundTurn): InboundTurn {
  if (!turn || typeof turn !== "object") throw new Error("turn is required");
  if (typeof turn.reply !== "function") throw new Error("turn reply port is required");
  const attachments = normalizeAttachments(turn.attachments);
  return Object.freeze({
    id: boundedOpaque(turn.id, "turn id", MAX_ID_CHARS),
    principal: Object.freeze({
      authority: normalizeAuthority(turn.principal.authority),
      channel: boundedOpaque(turn.principal.channel, "turn principal channel", 64),
      accountId: boundedOpaque(turn.principal.accountId, "turn principal accountId"),
      conversationId: boundedOpaque(turn.principal.conversationId, "turn principal conversationId"),
      senderId: boundedOpaque(turn.principal.senderId, "turn principal senderId"),
      ...(turn.principal.threadId === undefined
        ? {}
        : { threadId: boundedOpaque(turn.principal.threadId, "turn principal threadId") }),
    }),
    text: boundedText(turn.text, "turn text", MAX_TEXT_CHARS),
    ...(attachments === undefined ? {} : { attachments }),
    timestamp: Number.isFinite(turn.timestamp) && !Number.isNaN(new Date(turn.timestamp).getTime())
      ? turn.timestamp
      : Date.now(),
    ...(turn.resumeDestinationId === undefined
      ? {}
      : { resumeDestinationId: boundedOpaque(turn.resumeDestinationId, "turn resumeDestinationId", 264) }),
    ...(turn.resumedJobId === undefined
      ? {}
      : { resumedJobId: boundedOpaque(turn.resumedJobId, "turn resumedJobId", 96) }),
    reply: turn.reply,
  });
}

function conversationKey(turn: InboundTurn): string {
  return JSON.stringify([
    turn.principal.authority,
    turn.principal.channel,
    turn.principal.accountId,
    turn.principal.conversationId,
    turn.principal.threadId ?? "",
  ]);
}

function turnKey(turn: InboundTurn): string {
  return createHash("sha256").update(JSON.stringify([
    turn.principal.authority,
    turn.principal.channel,
    turn.principal.accountId,
    turn.principal.conversationId,
    turn.principal.threadId ?? "",
    turn.id,
  ])).digest("hex");
}

function completedEventId(key: string): string {
  return `turn:${key}:completed`;
}

function executedEventId(key: string): string {
  return `turn:${key}:executed`;
}

function deliveredEventId(key: string): string {
  return `turn:${key}:delivered`;
}

interface DurableExecutionResult {
  readonly text: string;
  readonly destinationKind: string;
  readonly destinationId: string;
  readonly executionProfile: string;
  readonly executorId: string;
  readonly sessionId?: string | undefined;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

function durableExecutionFromEvent(value: unknown): DurableExecutionResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.text !== "string" || !data.text || data.text.length > MAX_TEXT_CHARS) return undefined;
  for (const key of ["destinationKind", "destinationId", "executionProfile", "executorId"] as const) {
    if (typeof data[key] !== "string" || !(data[key] as string).trim()) return undefined;
  }
  const metadataValue = data.metadata;
  const metadata: Record<string, string | number | boolean | null> = {};
  if (metadataValue !== undefined) {
    if (!metadataValue || typeof metadataValue !== "object" || Array.isArray(metadataValue)) return undefined;
    for (const [key, item] of Object.entries(metadataValue as Record<string, unknown>)) {
      if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") return undefined;
      metadata[key] = item as string | number | boolean | null;
    }
  }
  return Object.freeze({
    text: data.text,
    destinationKind: data.destinationKind as string,
    destinationId: data.destinationId as string,
    executionProfile: data.executionProfile as string,
    executorId: data.executorId as string,
    ...(typeof data.sessionId === "string" && data.sessionId ? { sessionId: data.sessionId } : {}),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata: Object.freeze(metadata) }),
  });
}

function eventSubject(key: string): string {
  return `turn:${key.slice(0, 32)}`;
}

function eventData(turn: InboundTurn): Record<string, string | number> {
  return {
    messageId: turn.id,
    authority: turn.principal.authority,
    channel: turn.principal.channel,
    accountId: turn.principal.accountId,
    conversationId: turn.principal.conversationId,
    senderId: turn.principal.senderId,
    ...(turn.principal.threadId === undefined ? {} : { threadId: turn.principal.threadId }),
  };
}

function resumeDecision(turn: InboundTurn): import("../routing/contract.js").RoutingDecision | undefined {
  const destinationId = turn.resumeDestinationId?.trim();
  if (!destinationId) return undefined;
  if (destinationId !== "session:new") {
    if (!destinationId.startsWith("session:")) throw new Error(`Invalid restart-resume destination: ${destinationId}`);
    const sessionId = destinationId.slice("session:".length);
    if (!sessionId || sessionId.length > 256 || sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..") || /[\u0000-\u001f\u007f]/.test(sessionId)) {
      throw new Error(`Invalid restart-resume session id: ${JSON.stringify(sessionId)}`);
    }
  }
  return Object.freeze({
    messageId: turn.id,
    destination: Object.freeze({ kind: "session" as const, id: destinationId }),
    execution: Object.freeze({ profile: "agent" as const }),
    confidence: 1,
  });
}

function selectExecutor(executors: readonly TurnExecutor[], decision: Parameters<TurnExecutor["canHandle"]>[0]): TurnExecutor {
  const matches = executors
    .filter((executor) => executor.canHandle(decision))
    .map((executor) => ({ executor, priority: executor.priority ?? 0 }))
    .sort((left, right) => right.priority - left.priority || left.executor.id.localeCompare(right.executor.id));
  if (matches.length === 0) {
    throw new Error(`No turn executor is registered for ${decision.destination.kind}/${decision.execution.profile}`);
  }
  const first = matches[0]!;
  const second = matches[1];
  if (second && second.priority === first.priority) {
    throw new Error(
      `Ambiguous turn executors at priority ${first.priority}: ${first.executor.id}, ${second.executor.id}`,
    );
  }
  return first.executor;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

async function bestEffortReply(turn: InboundTurn, text: string): Promise<void> {
  try {
    await turn.reply(text);
  } catch (error) {
    reportOperationalError({ component: "turn-loop", operation: "deliver failure reply", error });
  }
}

function serial<T>(queues: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.then(operation);
  const barrier = current.then(() => undefined, () => undefined);
  queues.set(key, barrier);
  return current.finally(() => {
    if (queues.get(key) === barrier) queues.delete(key);
  });
}

export function createTurnRuntime(options: TurnRuntimeOptions): TurnRuntimeService {
  const conversationQueues = new Map<string, Promise<void>>();
  const sessionQueues = new Map<string, Promise<void>>();
  const completedInProcess = new Set<string>();
  // Deferred host callbacks cannot be serialized. Keeping them keyed by turn lets a
  // same-process provider retry replay the durable reply and still run the callback
  // exactly once. Cross-process restart recovery must be owned by the subsystem that
  // created the callback (lifecycle/settings/self-improvement all persist their state).
  const pendingFinalizers = new Map<string, () => void | Promise<void>>();
  let activeTurns = 0;

  const rememberCompleted = (key: string): void => {
    completedInProcess.delete(key);
    completedInProcess.add(key);
    while (completedInProcess.size > MAX_COMPLETED_IN_PROCESS) {
      const oldest = completedInProcess.values().next().value as string | undefined;
      if (oldest === undefined) break;
      completedInProcess.delete(oldest);
    }
  };

  const publishFailure = (turn: InboundTurn, key: string, phase: string, error: unknown): void => {
    try {
      options.events.publish({
        type: "turn.failed",
        source: "turn-loop",
        subject: eventSubject(key),
        data: {
          ...eventData(turn),
          phase,
          errorType: error instanceof Error ? error.name : "unknown",
        },
      });
    } catch (publishError) {
      reportOperationalError({ component: "turn-loop", operation: `publish failure event for ${phase}`, error: publishError });
    }
  };

  const executeTurn = async (turn: InboundTurn, submitOptions: TurnSubmitOptions): Promise<TurnResult> => {
    const key = turnKey(turn);
    const completionId = completedEventId(key);
    const executionId = executedEventId(key);
    const deliveryId = deliveredEventId(key);
    let phase = "dedupe";
    let replyDelivered = false;
    let executionDurable = false;
    let execution: TurnExecutionResult | undefined;

    try {
      submitOptions.signal?.throwIfAborted();
      if (completedInProcess.has(key) || options.events.get(completionId) !== undefined) {
        rememberCompleted(key);
        pendingFinalizers.delete(key);
        return Object.freeze({ status: "duplicate", messageId: turn.id });
      }

      // If execution finished but delivery/completion did not, never invoke the
      // executor again. Re-deliver the exact durable result and finish the turn. This
      // turns provider redelivery after a transient reply failure into reply replay
      // instead of duplicate real-world side effects or duplicate background jobs.
      const durableExecution = durableExecutionFromEvent(options.events.get(executionId)?.data);
      if (durableExecution) {
        if (options.events.get(deliveryId) === undefined) {
          phase = "reply-replay";
          await turn.reply(durableExecution.text);
          replyDelivered = true;
          phase = "delivery-replay";
          options.events.publish({
            id: deliveryId,
            type: "turn.delivered",
            source: "turn-loop",
            subject: eventSubject(key),
            data: eventData(turn),
          });
        } else {
          replyDelivered = true;
        }
        phase = "completion-replay";
        options.events.publish({
          id: completionId,
          type: "turn.completed",
          source: "turn-loop",
          subject: eventSubject(key),
          data: {
            ...eventData(turn),
            destinationKind: durableExecution.destinationKind,
            destinationId: durableExecution.destinationId,
            executionProfile: durableExecution.executionProfile,
            executorId: durableExecution.executorId,
            ...(durableExecution.sessionId === undefined ? {} : { sessionId: durableExecution.sessionId }),
            ...(durableExecution.metadata ?? {}),
            replayed: true,
          },
        });
        rememberCompleted(key);
        const finalizer = pendingFinalizers.get(key);
        pendingFinalizers.delete(key);
        phase = "after-reply-replay";
        await finalizer?.();
        return Object.freeze({
          status: "completed",
          messageId: turn.id,
          executorId: durableExecution.executorId,
          ...(durableExecution.sessionId === undefined ? {} : { sessionId: durableExecution.sessionId }),
        });
      }

      phase = "received-event";
      options.events.publish({
        id: `turn:${key}:received`,
        type: "turn.received",
        source: "turn-loop",
        subject: eventSubject(key),
        occurredAt: new Date(turn.timestamp).toISOString(),
        data: eventData(turn),
      });

      phase = "identity";
      const runTrusted = <T>(operation: () => T): T => turn.principal.authority === "local"
        ? options.permissions.runAsLocal(operation)
        : options.permissions.runAsChannel(
            {
              channel: turn.principal.channel,
              accountId: turn.principal.accountId,
              senderId: turn.principal.senderId,
              conversationId: turn.principal.conversationId,
              ...(turn.principal.threadId === undefined ? {} : { threadId: turn.principal.threadId }),
            },
            operation,
          );

      return await runTrusted(async () => {
        phase = "routing";
        const route = () => options.routing.route(
          {
            id: turn.id,
            principal: turn.principal,
            text: turn.text,
            ...(turn.attachments === undefined ? {} : {
              attachments: turn.attachments.map((attachment) => Object.freeze({
                kind: attachment.kind,
                ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
                ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
                ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
              })),
            }),
            timestamp: turn.timestamp,
          },
          { ...(submitOptions.signal === undefined ? {} : { signal: submitOptions.signal }) },
        );
        const observability = options.observability?.();
        const forcedResumeDecision = resumeDecision(turn);
        const decision = forcedResumeDecision ?? (observability
          ? await observability.withSpan({
              name: "routing.classify",
              component: "routing",
              attributes: {
                messageId: turn.id,
                channel: turn.principal.channel,
                accountId: turn.principal.accountId,
                conversationId: turn.principal.conversationId,
              },
            }, route)
          : await route());

        phase = "executor-selection";
        const executor = selectExecutor(options.executors(), decision);
        const execute = () => executor.execute({
          turn,
          decision,
          ...(submitOptions.signal === undefined ? {} : { signal: submitOptions.signal }),
        });

        phase = "execution";
        const backgroundJobs = options.sessionJobs?.();
        execution = backgroundJobs
          && decision.destination.kind === "session"
          && decision.execution.profile === "agent"
          ? await (async () => {
              phase = "background-admission";
              const job = await backgroundJobs.start({
                sourceKey: key,
                destinationId: decision.destination.id,
                text: turn.text,
                timestamp: turn.timestamp,
                origin: {
                  authority: turn.principal.authority,
                  channel: turn.principal.channel,
                  accountId: turn.principal.accountId,
                  conversationId: turn.principal.conversationId,
                  senderId: turn.principal.senderId,
                  ...(turn.principal.threadId === undefined ? {} : { threadId: turn.principal.threadId }),
                },
                run: async (signal, report, jobContext) => {
                  const result = await executor.execute({
                    turn,
                    decision,
                    signal,
                    progress: report,
                    ...(jobContext?.jobId === undefined ? {} : { jobId: jobContext.jobId }),
                  });
                  return {
                    text: result.text,
                    ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
                    ...(result.afterReply === undefined ? {} : { afterNotify: result.afterReply }),
                  };
                },
                notify: turn.reply,
              });
              const queued = job.currentStatus?.startsWith("Queued") === true;
              return Object.freeze({
                text: [
                  `${queued ? "Queued" : "Started"} background work: ${job.label} (${job.id}).`,
                  job.currentStatus ?? "Accepted for background execution.",
                  "I will send retry/failure updates and the final report back to this conversation.",
                ].join("\n"),
                metadata: { jobId: job.id, background: true },
              });
            })()
          : decision.destination.kind === "session" && decision.destination.id !== "session:new"
            ? await serial(sessionQueues, decision.destination.id, execute)
            : await execute();

        submitOptions.signal?.throwIfAborted();
        // Persist the externally visible result before attempting delivery. If the
        // reply transport fails or the process is restarted, a provider retry can
        // replay this exact result without running the executor twice.
        phase = "execution-result";
        options.events.publish({
          id: executionId,
          type: "turn.executed",
          source: "turn-loop",
          subject: eventSubject(key),
          data: {
            text: execution.text,
            destinationKind: decision.destination.kind,
            destinationId: decision.destination.id,
            executionProfile: decision.execution.profile,
            executorId: executor.id,
            ...(execution.sessionId === undefined ? {} : { sessionId: execution.sessionId }),
            ...(execution.metadata === undefined ? {} : { metadata: execution.metadata }),
          },
        });
        executionDurable = true;
        if (execution.afterReply) pendingFinalizers.set(key, execution.afterReply);

        phase = "reply";
        await turn.reply(execution.text);
        replyDelivered = true;

        phase = "delivery";
        options.events.publish({
          id: deliveryId,
          type: "turn.delivered",
          source: "turn-loop",
          subject: eventSubject(key),
          data: eventData(turn),
        });

        phase = "completion";
        options.events.publish({
          id: completionId,
          type: "turn.completed",
          source: "turn-loop",
          subject: eventSubject(key),
          data: {
            ...eventData(turn),
            destinationKind: decision.destination.kind,
            destinationId: decision.destination.id,
            executionProfile: decision.execution.profile,
            executorId: executor.id,
            ...(execution.sessionId === undefined ? {} : { sessionId: execution.sessionId }),
            ...(execution.metadata ?? {}),
          },
        });
        rememberCompleted(key);
        phase = "after-reply";
        const finalizer = pendingFinalizers.get(key);
        pendingFinalizers.delete(key);
        await finalizer?.();
        return Object.freeze({
          status: "completed",
          messageId: turn.id,
          decision,
          executorId: executor.id,
          ...(execution.sessionId === undefined ? {} : { sessionId: execution.sessionId }),
        });
      });
    } catch (error) {
      // The durable execution record is the commit point for externally visible
      // work. Once it exists, compensation could undo successful side effects while
      // a retry later replays the stored success response. Only compensate failures
      // that occur before that commit point; after it, retry delivery/completion from
      // the durable result instead of re-running or rolling back the executor.
      if (!executionDurable) {
        try {
          await execution?.afterFailure?.(error);
        } catch (cleanupError) {
          error = new AggregateError([error, cleanupError], "Turn failed and its failure cleanup also failed");
        }
      }
      publishFailure(turn, key, phase, error);
      if (!replyDelivered && !isAbort(error, submitOptions.signal)) {
        await bestEffortReply(turn, SAFE_FAILURE_REPLY);
      }
      throw error;
    }
  };

  return Object.freeze({
    submit(rawTurn: InboundTurn, submitOptions: TurnSubmitOptions = {}): Promise<TurnResult> {
      const turn = normalizeTurn(rawTurn);
      const operation = async (): Promise<TurnResult> => {
        activeTurns += 1;
        try {
          const run = () => executeTurn(turn, submitOptions);
          const observability = options.observability?.();
          return observability
            ? await observability.withSpan({
                name: "turn.process",
                component: "turn-loop",
                attributes: {
                  messageId: turn.id,
                  channel: turn.principal.channel,
                  accountId: turn.principal.accountId,
                  conversationId: turn.principal.conversationId,
                },
              }, run)
            : await run();
        } finally {
          activeTurns -= 1;
        }
      };
      return serial(conversationQueues, conversationKey(turn), operation);
    },
    status(): TurnRuntimeStatus {
      return Object.freeze({
        activeTurns,
        queuedConversations: conversationQueues.size,
        lockedSessions: sessionQueues.size,
        completedInProcess: completedInProcess.size,
      });
    },
  });
}
