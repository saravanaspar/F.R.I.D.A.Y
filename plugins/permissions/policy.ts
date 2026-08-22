import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import type {
  PermissionAction,
  PermissionApprovalRequest,
  PermissionDecision,
  PermissionEffect,
  PermissionMode,
  PermissionPrincipalKind,
  PermissionPrincipalView,
  PermissionRequest,
  PermissionsService,
  TrustedIdentityRole,
} from "./contract.js";
import {
  channelIdentityKey,
  findTrustedIdentity,
  getPermissionsStateDir,
  loadTrustedIdentities,
  revokeTrustedIdentity,
  saveTrustedIdentities,
  upsertTrustedIdentity,
} from "./identity-store.js";
import type { ChannelIdentitySelector, ChannelPrincipalSelector, PermissionsTrustedService, TrustChannelIdentityInput } from "./trusted-contract.js";

export type PermissionApprover = (request: PermissionApprovalRequest) => Promise<boolean>;

export interface PermissionAuditEntry {
  readonly category: "authorization" | "identity";
  readonly action: string;
  readonly outcome: "allowed" | "denied" | "error" | "changed";
  readonly actor: {
    readonly id: string;
    readonly kind: PermissionPrincipalKind;
    readonly role: TrustedIdentityRole | "untrusted";
  };
  readonly effect?: string | undefined;
  readonly resource?: string | undefined;
  readonly subject?: string | undefined;
  readonly network?: boolean | undefined;
  readonly mode?: string | undefined;
  readonly access?: string | undefined;
  readonly approvedBy?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
}

export type PermissionAuditSink = (entry: PermissionAuditEntry) => void;

export interface PermissionsServiceOptions {
  approve?: PermissionApprover | undefined;
  stateDir?: string | undefined;
  now?: (() => Date) | undefined;
  audit?: PermissionAuditSink | undefined;
}

export interface PermissionsController {
  readonly permissions: PermissionsService;
  readonly trusted: PermissionsTrustedService;
}

const EFFECTS = new Set<PermissionEffect>([
  "workspace-read",
  "workspace-write",
  "external-read",
  "external-write",
  "credential-write",
  "system-write",
]);

const LOCAL_PRINCIPAL: PermissionPrincipalView = Object.freeze({
  id: "local:operator",
  kind: "local",
  role: "operator",
  label: "Local operator",
});

const UNSCOPED_AUDIT_ACTOR: PermissionAuditEntry["actor"] = Object.freeze({
  id: "system:unscoped",
  kind: "system",
  role: "untrusted",
});

function canonicalExistingOrParent(path: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) return realpathSync(resolved);
  const parent = dirname(resolved);
  if (parent === resolved) return resolved;
  const canonicalParent = canonicalExistingOrParent(parent);
  return resolve(canonicalParent, resolved.slice(parent.length + 1));
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || rel === "." || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizedDisplay(value: string, max = 400): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function validateAction(action: PermissionAction): PermissionAction {
  const id = action.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new Error(`Invalid permission action id: ${JSON.stringify(action.id)}`);
  }
  if (!EFFECTS.has(action.effect)) throw new Error(`Unsupported permission effect: ${JSON.stringify(action.effect)}`);
  const resource = normalizedDisplay(action.resource, 512);
  if (!resource) throw new Error("Permission action resource is required");
  return Object.freeze({ id, effect: action.effect, resource, network: action.network === true });
}

function effectMutates(effect: PermissionEffect): boolean {
  return effect === "workspace-write" || effect === "external-write" || effect === "credential-write" || effect === "system-write";
}

function roleAllows(role: TrustedIdentityRole, action: PermissionAction): boolean {
  return role === "operator" || !effectMutates(action.effect);
}

function requestNeedsApproval(request: PermissionRequest): boolean {
  // Network access is a distinct capability: even `full` permission mode must
  // obtain an explicit approval before a tool can reach the network. This is
  // especially important for channel-originated turns where approval must go
  // back to the originating conversation.
  if (request.action.network) return true;
  if (request.mode === "full") return false;
  switch (request.action.effect) {
    case "workspace-read":
      return false;
    case "workspace-write":
      return request.mode === "ask";
    case "external-read":
    case "external-write":
    case "credential-write":
    case "system-write":
      return true;
  }
}

function describe(request: PermissionApprovalRequest): string {
  const target = request.path ? `\nTarget: ${normalizedDisplay(request.path, 512)}` : "";
  const network = request.action.network ? "\nNetwork: requested" : "";
  return [
    `FRIDAY requests action ${normalizedDisplay(request.action.id, 128)}.`,
    `Principal: ${normalizedDisplay(request.principal.label, 128)} (${request.principal.id}, ${request.principal.role})`,
    `Effect: ${request.action.effect}`,
    `Resource: ${normalizedDisplay(request.action.resource, 512)}`,
    `Reason: ${normalizedDisplay(request.reason, 512)}`,
  ].join("\n") + target + network;
}

export async function terminalPermissionApprover(request: PermissionApprovalRequest): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Permission approval is required in ${request.mode} mode, but no interactive terminal is available`,
    );
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${describe(request)}\nApprove? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

function channelPrincipal(identity: ReturnType<typeof findTrustedIdentity>, selector?: ChannelPrincipalSelector): PermissionPrincipalView {
  if (!identity) throw new Error("Channel identity is not trusted for privileged FRIDAY actions");
  return Object.freeze({
    id: identity.id,
    kind: "channel",
    role: identity.role,
    label: identity.label,
    channel: identity.channel,
    accountId: identity.accountId,
    senderId: identity.senderId,
    ...(selector?.conversationId === undefined ? {} : { conversationId: selector.conversationId }),
    ...(selector?.threadId === undefined ? {} : { threadId: selector.threadId }),
  });
}

function auditActor(principal: PermissionPrincipalView): PermissionAuditEntry["actor"] {
  return Object.freeze({ id: principal.id, kind: principal.kind, role: principal.role });
}

function targetIdentityId(selector: ChannelIdentitySelector): string {
  return `channel:${channelIdentityKey(selector).slice(0, 24)}`;
}

export function createPermissionsController(options: PermissionsServiceOptions = {}): PermissionsController {
  const approve = options.approve ?? terminalPermissionApprover;
  const stateDir = options.stateDir ?? getPermissionsStateDir();
  const now = options.now ?? (() => new Date());
  const audit = options.audit;
  const context = new AsyncLocalStorage<PermissionPrincipalView>();
  const recordAudit = (entry: PermissionAuditEntry): void => {
    audit?.(entry);
  };

  const service: PermissionsService = {
    normalizeMode(value?: string): PermissionMode {
      const normalized = value?.trim().toLowerCase() || "ask";
      if (normalized === "ask" || normalized === "auto" || normalized === "full") return normalized;
      throw new Error(`Unsupported permission mode: ${JSON.stringify(value)}. Expected ask, auto, or full`);
    },

    assertWorkspacePath(workspaceInput: string, pathInput: string): string {
      const workspace = canonicalExistingOrParent(workspaceInput);
      const target = canonicalExistingOrParent(pathInput);
      if (!contained(workspace, target)) {
        throw new Error(`Permission policy denied access outside workspace: ${target}`);
      }
      return target;
    },

    async authorize(request: PermissionRequest): Promise<PermissionDecision> {
      const actor = context.getStore();
      if (!actor) {
        recordAudit({
          category: "authorization",
          action: "permissions.missing-context",
          outcome: "denied",
          actor: UNSCOPED_AUDIT_ACTOR,
          ...(request.access === "read" || request.access === "write" ? { access: request.access } : {}),
          details: { reason: "missing-principal-context" },
        });
        throw new Error(
          "Permission context is required; trusted code must use runAsLocal(), runAsSystem(), or runAsChannel()",
        );
      }
      let workspace: string | undefined;
      let action: PermissionAction | undefined;
      let mode: PermissionMode | undefined;
      try {
        mode = service.normalizeMode(request.mode);
        workspace = canonicalExistingOrParent(request.workspace);
        action = validateAction(request.action);
        if (request.path !== undefined) service.assertWorkspacePath(workspace, request.path);
        const expectedAccess = action.effect === "workspace-read" || action.effect === "external-read" ? "read" : "write";
        if (request.access !== expectedAccess) {
          throw new Error(`Permission action ${action.id} requires ${expectedAccess} access, not ${request.access}`);
        }
      } catch (error) {
        recordAudit({
          category: "authorization",
          action: action?.id ?? "permissions.invalid-request",
          outcome: "denied",
          actor: auditActor(actor),
          ...(action === undefined ? {} : {
            effect: action.effect,
            resource: action.resource,
            network: action.network,
          }),
          ...(mode === undefined ? {} : { mode }),
          ...(request.access === "read" || request.access === "write" ? { access: request.access } : {}),
          details: { reason: "invalid-request" },
        });
        throw error;
      }

      const normalizedRequest: PermissionRequest = {
        ...request,
        mode,
        workspace,
        action,
        reason: normalizedDisplay(request.reason, 512) || action.id,
      };

      if (!roleAllows(actor.role, action)) {
        recordAudit({
          category: "authorization",
          action: action.id,
          outcome: "denied",
          actor: auditActor(actor),
          effect: action.effect,
          resource: action.resource,
          network: action.network,
          mode: normalizedRequest.mode,
          access: normalizedRequest.access,
          details: { reason: "identity-role" },
        });
        throw new Error(`Permission policy denied ${action.id}: identity ${actor.id} is read-only`);
      }

      if (!requestNeedsApproval(normalizedRequest)) {
        recordAudit({
          category: "authorization",
          action: action.id,
          outcome: "allowed",
          actor: auditActor(actor),
          effect: action.effect,
          resource: action.resource,
          network: action.network,
          mode: normalizedRequest.mode,
          access: normalizedRequest.access,
          approvedBy: "policy",
        });
        return { allowed: true, approvedBy: "policy" };
      }

      let allowed: boolean;
      try {
        allowed = await approve({ ...normalizedRequest, principal: actor });
      } catch (error) {
        recordAudit({
          category: "authorization",
          action: action.id,
          outcome: "error",
          actor: auditActor(actor),
          effect: action.effect,
          resource: action.resource,
          network: action.network,
          mode: normalizedRequest.mode,
          access: normalizedRequest.access,
          details: { phase: "approval", errorType: error instanceof Error ? error.name : "unknown" },
        });
        throw error;
      }

      if (!allowed) {
        recordAudit({
          category: "authorization",
          action: action.id,
          outcome: "denied",
          actor: auditActor(actor),
          effect: action.effect,
          resource: action.resource,
          network: action.network,
          mode: normalizedRequest.mode,
          access: normalizedRequest.access,
          details: { reason: "user-rejected" },
        });
        throw new Error(`Permission denied: ${normalizedRequest.reason}`);
      }

      recordAudit({
        category: "authorization",
        action: action.id,
        outcome: "allowed",
        actor: auditActor(actor),
        effect: action.effect,
        resource: action.resource,
        network: action.network,
        mode: normalizedRequest.mode,
        access: normalizedRequest.access,
        approvedBy: "user",
      });
      return { allowed: true, approvedBy: "user" };
    },
  };

  const trusted: PermissionsTrustedService = Object.freeze({
    identities() {
      return loadTrustedIdentities(stateDir);
    },
    trustChannelIdentity(input: TrustChannelIdentityInput) {
      const actor = context.getStore();
      if (!actor) {
        throw new Error("Permission context is required before changing trusted identities");
      }
      const subject = targetIdentityId(input);
      const before = [...loadTrustedIdentities(stateDir)];
      const existing = findTrustedIdentity(stateDir, input);
      recordAudit({
        category: "identity",
        action: "permissions.trust-channel",
        outcome: "allowed",
        actor: auditActor(actor),
        subject,
        details: {
          operation: existing ? "update" : "create",
          role: input.role ?? "operator",
          ...(existing === undefined ? {} : { previousRole: existing.role }),
        },
      });

      let identity: ReturnType<typeof upsertTrustedIdentity>;
      try {
        identity = upsertTrustedIdentity(stateDir, input, now);
      } catch (error) {
        try {
          recordAudit({
            category: "identity",
            action: "permissions.trust-channel",
            outcome: "error",
            actor: auditActor(actor),
            subject,
            details: { phase: "identity-state-write", errorType: error instanceof Error ? error.name : "unknown" },
          });
        } catch (auditError) {
          throw new AggregateError([error, auditError], "Trusted identity update failed and its audit error could not be recorded");
        }
        throw error;
      }

      try {
        recordAudit({
          category: "identity",
          action: "permissions.trust-channel",
          outcome: "changed",
          actor: auditActor(actor),
          subject: identity.id,
          details: { operation: existing ? "update" : "create", role: identity.role },
        });
      } catch (auditError) {
        try {
          saveTrustedIdentities(stateDir, before);
        } catch (rollbackError) {
          throw new AggregateError(
            [auditError, rollbackError],
            "Trusted identity audit failed and identity-state rollback also failed",
          );
        }
        throw auditError;
      }
      return identity;
    },
    revokeChannelIdentity(selector: ChannelIdentitySelector) {
      const actor = context.getStore();
      if (!actor) {
        throw new Error("Permission context is required before changing trusted identities");
      }
      const subject = targetIdentityId(selector);
      const before = [...loadTrustedIdentities(stateDir)];
      const existing = findTrustedIdentity(stateDir, selector);
      if (!existing) {
        recordAudit({
          category: "identity",
          action: "permissions.revoke-channel",
          outcome: "denied",
          actor: auditActor(actor),
          subject,
          details: { reason: "not-found" },
        });
        return false;
      }

      recordAudit({
        category: "identity",
        action: "permissions.revoke-channel",
        outcome: "allowed",
        actor: auditActor(actor),
        subject: existing.id,
        details: { previousRole: existing.role },
      });
      const revoked = revokeTrustedIdentity(stateDir, selector);
      if (!revoked) {
        recordAudit({
          category: "identity",
          action: "permissions.revoke-channel",
          outcome: "error",
          actor: auditActor(actor),
          subject: existing.id,
          details: { phase: "identity-state-write", reason: "lost-target" },
        });
        return false;
      }
      try {
        recordAudit({
          category: "identity",
          action: "permissions.revoke-channel",
          outcome: "changed",
          actor: auditActor(actor),
          subject: existing.id,
          details: { previousRole: existing.role },
        });
      } catch (auditError) {
        try {
          saveTrustedIdentities(stateDir, before);
        } catch (rollbackError) {
          throw new AggregateError(
            [auditError, rollbackError],
            "Trusted identity revocation audit failed and identity-state rollback also failed",
          );
        }
        throw auditError;
      }
      return true;
    },
    runAsLocal<T>(operation: () => T): T {
      return context.run(LOCAL_PRINCIPAL, operation);
    },
    runAsSystem<T>(serviceName: string, operation: () => T): T {
      const serviceId = normalizedDisplay(serviceName, 128);
      if (!serviceId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(serviceId)) {
        throw new Error(`Invalid trusted system identity: ${JSON.stringify(serviceName)}`);
      }
      return context.run(Object.freeze({
        id: `system:${serviceId}`,
        kind: "system",
        role: "operator",
        label: `FRIDAY system service ${serviceId}`,
      }), operation);
    },
    runAsChannel<T>(selector: ChannelPrincipalSelector, operation: () => T): T {
      const identity = findTrustedIdentity(stateDir, selector);
      if (!identity) {
        const id = targetIdentityId(selector);
        recordAudit({
          category: "identity",
          action: "permissions.resolve-channel-identity",
          outcome: "denied",
          actor: { id, kind: "channel", role: "untrusted" },
          subject: id,
          details: { reason: "untrusted" },
        });
        throw new Error("Channel identity is not trusted for privileged FRIDAY actions");
      }
      return context.run(channelPrincipal(identity, selector), operation);
    },
  });

  return Object.freeze({ permissions: Object.freeze(service), trusted });
}

export function createPermissionsService(options: PermissionsServiceOptions = {}): PermissionsService {
  return createPermissionsController(options).permissions;
}
