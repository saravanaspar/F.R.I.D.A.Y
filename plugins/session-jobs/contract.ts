import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type SessionJobStatus = "queued" | "running" | "retrying" | "completed" | "resumed" | "error" | "cancelled";

export interface SessionJobOrigin {
  readonly authority: "local" | "channel";
  readonly channel: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly threadId?: string | undefined;
}

export interface SessionJobProgress {
  readonly kind: "status" | "tool" | "retry";
  readonly message: string;
  readonly timestamp?: number | undefined;
  readonly attempt?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly delayMs?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly notify?: boolean | undefined;
}

export interface SessionJobTimelineEntry {
  readonly at: string;
  readonly kind: SessionJobProgress["kind"];
  readonly message: string;
  readonly attempt?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly delayMs?: number | undefined;
}

export interface SessionJobRecord {
  readonly id: string;
  /** Stable source-operation key used to make admission idempotent across provider retries. */
  readonly sourceKey?: string | undefined;
  readonly destinationId: string;
  readonly sessionId?: string | undefined;
  readonly label: string;
  readonly requestPreview: string;
  readonly origin: SessionJobOrigin;
  readonly status: SessionJobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly currentStatus?: string | undefined;
  readonly retryAttempt?: number | undefined;
  readonly retryMax?: number | undefined;
  readonly error?: string | undefined;
  readonly resultPreview?: string | undefined;
  readonly timeline: readonly SessionJobTimelineEntry[];
}


export interface SessionJobResumeRecord {
  readonly id: string;
  readonly destinationId: string;
  readonly requestText: string;
  readonly timestamp: number;
  readonly origin: SessionJobOrigin;
}

export interface SessionJobRunResult {
  readonly text: string;
  readonly sessionId?: string | undefined;
  /** Runs only after the final success notification has been attempted. */
  readonly afterNotify?: (() => void | Promise<void>) | undefined;
}

export interface SessionJobStartRequest {
  /** Stable key for the user operation that admitted this job (for example a durable turn key). */
  readonly sourceKey?: string | undefined;
  readonly destinationId: string;
  readonly text: string;
  readonly timestamp: number;
  readonly origin: SessionJobOrigin;
  readonly run: (
    signal: AbortSignal,
    report: (progress: SessionJobProgress) => Promise<void>,
    context?: Readonly<{ jobId: string }> | undefined,
  ) => Promise<SessionJobRunResult>;
  readonly notify: (text: string) => Promise<void>;
}

export interface SessionJobListOptions {
  readonly activeOnly?: boolean | undefined;
  readonly limit?: number | undefined;
}

export interface SessionJobsService {
  start(request: SessionJobStartRequest): Promise<SessionJobRecord>;
  list(options?: SessionJobListOptions): readonly SessionJobRecord[];
  get(jobId: string): SessionJobRecord | undefined;
  find(query: string, options?: { activeOnly?: boolean | undefined }): readonly SessionJobRecord[];
  cancel(jobId: string, reason?: string): Promise<SessionJobRecord>;
  /** Host-only interrupted work that has no process-local runner and can be reconstructed after restart. */
  resumable(): readonly SessionJobResumeRecord[];
  /** Mark an interrupted predecessor job as replaced by its durable resume turn. */
  markResumed(jobId: string, resumedTurnId: string): Promise<SessionJobRecord>;
  close(): Promise<void>;
}

export const SESSION_JOBS_CAPABILITY: Capability<SessionJobsService> =
  defineCapability<SessionJobsService>("session-jobs");
