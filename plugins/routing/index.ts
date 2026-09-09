import { createHash } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import { MODEL_CREDENTIALS_CAPABILITY, type ModelCredentialService } from "../auth/contract.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EVENTS_CAPABILITY } from "../events/contract.js";
import { MEMORY_CAPABILITY, type MemoryService } from "../memory/contract.js";
import { MODEL_CAPABILITY, type ModelService } from "../model/contract.js";
import { ownerScopeAllows, principalScope, principalStateRoot, samePrincipalOrigin } from "../principal-scope.js";
import { SESSION_JOBS_CAPABILITY, type SessionJobsService } from "../session-jobs/contract.js";
import { SESSIONS_CAPABILITY, type SessionsService } from "../sessions/contract.js";
import { ROUTING_CAPABILITY, type RoutingPrincipal } from "./contract.js";
import {
  createRoutingService,
  type RoutingClassifier,
  type RoutingMemoryHint,
  type RoutingSessionCandidate,
} from "./router.js";

const SESSION_CANDIDATE_LIMIT = 12;
const SESSION_SEARCH_POOL = 48;
const MEMORY_HINT_LIMIT = 6;

function stateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_STATE_DIR?.trim() || environment.FRIDAY_HOME?.trim();
  return configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
}

function clip(value: string, max: number): string {
  const normalized = value.replaceAll("\u0000", "\ufffd").replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}\u2026`;
}

function tokens(value: string): readonly string[] {
  return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).slice(0, 32))];
}

function relevance(query: readonly string[], text: string): number {
  if (query.length === 0) return 0;
  const haystack = text.toLowerCase();
  return query.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function sessionLabel(session: { id: string; cwd: string; name?: string | undefined }): string {
  const name = session.name?.trim();
  if (name) return clip(name, 160);
  const cwdName = basename(session.cwd.trim());
  return cwdName ? clip(cwdName, 160) : `Session ${session.id.slice(0, 8)}`;
}

function createSessionCandidateProvider(sessions: SessionsService, sessionJobs: () => SessionJobsService | undefined) {
  return async ({ query, principal }: { readonly query: string; readonly principal: RoutingPrincipal }): Promise<readonly RoutingSessionCandidate[]> => {
    const all = (await sessions.SessionManager.listAll(undefined, join(stateRoot(), "sessions")))
      .filter((session) => ownerScopeAllows(session.ownerScope, principal));
    const activeBySession = new Map<string, ReturnType<SessionJobsService["list"]>[number][]>();
    for (const job of sessionJobs()?.list({ activeOnly: true, limit: 100 }) ?? []) {
      if (!samePrincipalOrigin(job.origin, principal)) continue;
      if (!job.sessionId) continue;
      const list = activeBySession.get(job.sessionId) ?? [];
      list.push(job);
      activeBySession.set(job.sessionId, list);
    }
    const pool = all.slice(0, SESSION_SEARCH_POOL);
    const queryTokens = tokens(query);
    const searched = pool
      .map((session) => ({
        session,
        score: relevance(queryTokens, `${session.name ?? ""}\n${session.cwd}\n${session.firstMessage}`),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.session.modified.getTime() - left.session.modified.getTime());

    const merged = new Map<string, (typeof all)[number]>();
    for (const { session } of searched) merged.set(session.id, session);
    for (const session of pool) {
      if (merged.size >= SESSION_CANDIDATE_LIMIT) break;
      merged.set(session.id, session);
    }

    return Object.freeze([...merged.values()].slice(0, SESSION_CANDIDATE_LIMIT).map((session) => {
      const active = activeBySession.get(session.id) ?? [];
      return Object.freeze({
        id: `session:${session.id}`,
        label: sessionLabel(session),
        summary: clip([
          session.state?.status ? `state=${session.state.status}` : "",
          session.firstMessage ? `first=${session.firstMessage}` : "",
          ...active.slice(0, 3).map((job) => `active=${job.label}; ${job.status}; ${job.currentStatus ?? job.requestPreview}`),
        ].filter(Boolean).join("; ") || "Persistent FRIDAY session", 500),
        modifiedAt: session.modified.toISOString(),
      });
    }));
  };
}

function createMemorySearch(memory: MemoryService) {
  return async ({ query, principal }: { readonly query: string; readonly principal: RoutingPrincipal }): Promise<readonly RoutingMemoryHint[]> => {
    const root = principalStateRoot(stateRoot(), principal);
    const stateDir = memory.globalStateDir(root);
    const databasePath = memory.statePath(stateDir);
    if (!existsSync(databasePath) || !query.trim()) return Object.freeze([]);
    const store = memory.openStore({ stateDir, scope: "global", semanticSearch: false, readOnly: true });
    try {
      return Object.freeze(store.search(query, { kinds: ["memory"], limit: MEMORY_HINT_LIMIT }).map((result) => Object.freeze({
        id: result.entry.id,
        kind: result.entry.kind,
        title: result.entry.title,
        content: clip(result.entry.content, 500),
      })));
    } finally {
      store.close();
    }
  };
}

function selectedModel(environment: NodeJS.ProcessEnv = process.env): { provider: string; modelId: string } {
  const provider = environment.FRIDAY_ROUTING_PROVIDER?.trim() || environment.FRIDAY_MODEL_PROVIDER?.trim();
  const modelId = environment.FRIDAY_ROUTING_MODEL_ID?.trim() || environment.FRIDAY_MODEL_ID?.trim();
  if (!provider || !modelId) {
    throw new Error(
      "Routing model selection is required: set FRIDAY_ROUTING_PROVIDER/FRIDAY_ROUTING_MODEL_ID or FRIDAY_MODEL_PROVIDER/FRIDAY_MODEL_ID",
    );
  }
  return { provider, modelId };
}

function createClassifier(models: ModelService, credentials: () => ModelCredentialService | undefined): RoutingClassifier {
  return async ({ systemPrompt, userPrompt, signal }) => {
    const selected = selectedModel();
    const model = models.getModel(selected.provider as never, selected.modelId as never);
    if (!model) throw new Error(`Unknown routing model: ${selected.provider}/${selected.modelId}`);
    const apiKey = await credentials()?.getApiKey(selected.provider);
    const response = await models.completeSimple(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
      },
      {
        temperature: 0,
        maxTokens: 384,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(`Routing model failed: ${response.errorMessage || response.stopReason}`);
    }
    if (response.stopReason === "length") throw new Error("Routing model output was truncated");
    const text = response.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("Routing model returned no JSON decision");
    return models.parseJsonWithRepair<unknown>(text);
  };
}

function eventOccurredAt(timestamp: number): string {
  const candidate = Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
  return Number.isNaN(candidate.getTime()) ? new Date().toISOString() : candidate.toISOString();
}

function routeEventKey(message: { id: string; principal: RoutingPrincipal }): string {
  return createHash("sha256").update(JSON.stringify([
    principalScope(message.principal),
    message.id,
  ])).digest("hex");
}

function destinationEventKey(kind: string, id: string): string {
  return createHash("sha256").update(JSON.stringify([kind, id])).digest("hex").slice(0, 32);
}

const routingPlugin: FridayPlugin = definePlugin({ id: "routing", requires: [EVENTS_CAPABILITY, MEMORY_CAPABILITY, MODEL_CAPABILITY, SESSIONS_CAPABILITY], optional: [MODEL_CREDENTIALS_CAPABILITY, SESSION_JOBS_CAPABILITY], provides: [ROUTING_CAPABILITY] }, (ctx) => {
  const events = ctx.services.require(EVENTS_CAPABILITY);
  const memory = ctx.services.require(MEMORY_CAPABILITY);
  const models = ctx.services.require(MODEL_CAPABILITY);
  const sessions = ctx.services.require(SESSIONS_CAPABILITY);

  const routing = createRoutingService({
    classify: createClassifier(models, () => ctx.services.optional(MODEL_CREDENTIALS_CAPABILITY)),
    sessions: createSessionCandidateProvider(sessions, () => ctx.services.optional(SESSION_JOBS_CAPABILITY)),
    memory: createMemorySearch(memory),
    publishDecision: (message, decision) => {
      events.publish({
        type: "routing.message.routed",
        source: "routing",
        subject: `channel-message:${routeEventKey(message).slice(0, 32)}`,
        dedupeKey: `routed:${routeEventKey(message)}`,
        occurredAt: eventOccurredAt(message.timestamp),
        data: {
          messageKey: routeEventKey(message).slice(0, 32),
          ownerScope: principalScope(message.principal),
          destination: {
            kind: decision.destination.kind,
            key: destinationEventKey(decision.destination.kind, decision.destination.id),
          },
          execution: { profile: decision.execution.profile },
          confidence: decision.confidence,
        },
      });
    },
    publishFailure: (message) => {
      try {
        events.publish({
          type: "routing.message.failed",
          source: "routing",
          subject: `channel-message:${routeEventKey(message).slice(0, 32)}`,
          dedupeKey: `failed:${routeEventKey(message)}`,
          occurredAt: eventOccurredAt(message.timestamp),
          data: {
            messageKey: routeEventKey(message).slice(0, 32),
            ownerScope: principalScope(message.principal),
            reason: "classification-failed",
          },
        });
      } catch (publishError) {
        reportOperationalError({ component: "routing", operation: "publish routing failure event", error: publishError });
      }
    },
  });


  ctx.services.provide(ROUTING_CAPABILITY, routing);
});

export default routingPlugin;
export * from "./contract.js";
export {
  createRoutingService,
  ROUTING_SYSTEM_PROMPT,
  type RoutingClassifier,
  type RoutingClassifierRequest,
  type RoutingMemoryHint,
  type RoutingServiceOptions,
  type RoutingSessionCandidate,
} from "./router.js";
