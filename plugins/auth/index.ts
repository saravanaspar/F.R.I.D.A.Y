import { reportOperationalError } from "@friday/operational-errors";
import * as auth from "@friday/auth";
import type { FridayPlugin } from "../../src/plugin.js";
import { modelCredentialVaultRef, modelOAuthCredentialVaultRef, modelProviderTypicallyNeedsApiKey } from "./model-credential-ref.js";
import { definePlugin } from "../capabilities/protocol.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../channels/trusted-contract.js";
import { MODEL_CAPABILITY } from "../model/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, type SystemActionExecutionContext } from "../system/contract.js";
import { VAULT_CAPABILITY } from "../vault/contract.js";
import { VAULT_TRUSTED_CAPABILITY } from "../vault/trusted-contract.js";
import {
  AUTH_CAPABILITY,
  MODEL_CREDENTIALS_CAPABILITY,
  PROTECTED_CREDENTIALS_CAPABILITY,
  type AuthService,
  type ModelCredentialService,
  type ProtectedCredentialService,
} from "./contract.js";

type ProtectedCredentialCaptureInput = Parameters<ProtectedCredentialService["capture"]>[0];
type ApiKeyCaptureInput = Parameters<ModelCredentialService["captureApiKey"]>[0];
type OAuthCaptureInput = Parameters<ModelCredentialService["captureOAuth"]>[0];

function safeProvider(value: unknown): string {
  if (typeof value !== "string") throw new Error("provider must be a string");
  const provider = value.trim();
  if (!provider || provider.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(provider)) {
    throw new Error("provider is invalid");
  }
  return provider;
}

function targetFromTurn(turn: SystemActionExecutionContext["turn"]) {
  return Object.freeze({
    channel: turn.principal.channel,
    accountId: turn.principal.accountId,
    conversationId: turn.principal.conversationId,
    senderId: turn.principal.senderId,
    ...(turn.principal.threadId === undefined ? {} : { threadId: turn.principal.threadId }),
  });
}

function targetFromPrincipal(principal: Parameters<ProtectedCredentialService["capture"]>[0]["principal"]) {
  return Object.freeze({
    channel: principal.channel,
    accountId: principal.accountId,
    conversationId: principal.conversationId,
    ...(principal.threadId === undefined ? {} : { threadId: principal.threadId }),
  });
}

function encodeOAuthCredentials(credentials: Record<string, unknown>): Uint8Array {
  const text = JSON.stringify(credentials);
  if (!text || text.length > 128_000) throw new Error("OAuth credential bundle is invalid or too large");
  return Buffer.from(text, "utf8");
}

function decodeOAuthCredentials(bytes: Uint8Array, provider: string): import("@friday/auth").OAuthCredentials {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new Error(`Stored OAuth credential for ${provider} is invalid`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Stored OAuth credential for ${provider} is invalid`);
  const record = parsed as Record<string, unknown>;
  if (typeof record.access !== "string" || typeof record.refresh !== "string" || typeof record.expires !== "number") {
    throw new Error(`Stored OAuth credential for ${provider} is incomplete`);
  }
  return record as import("@friday/auth").OAuthCredentials;
}

const authPlugin: FridayPlugin = definePlugin({
  id: "auth",
  requires: [MODEL_CAPABILITY, VAULT_CAPABILITY, VAULT_TRUSTED_CAPABILITY],
  optional: [CHANNELS_TRUSTED_CAPABILITY],
  provides: [AUTH_CAPABILITY, MODEL_CREDENTIALS_CAPABILITY, PROTECTED_CREDENTIALS_CAPABILITY],
}, (ctx) => {
  const model = ctx.services.require(MODEL_CAPABILITY);
  const vault = ctx.services.require(VAULT_CAPABILITY);
  const trustedVault = ctx.services.require(VAULT_TRUSTED_CAPABILITY);

  auth.configureModelCatalogAccess({
    getModels: (provider) => {
      const knownProvider = model.getProviders().find((candidate) => candidate === provider);
      return knownProvider ? model.getModels(knownProvider) : [];
    },
  });

  const protectedCredentials: ProtectedCredentialService = Object.freeze({
    async capture(input: ProtectedCredentialCaptureInput) {
      const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
      if (!channels) throw new Error("Protected credential capture requires Channels trusted interaction support");
      const ref = vault.normalizeRef(input.ref);
      const mode = input.mode ?? (vault.exists(ref) ? "rotate" : "create");
      const pending = channels.requestCredentialCapture({
        principal: input.principal,
        ref,
        kind: input.kind,
        mode,
        label: input.label,
        inputMode: input.inputMode ?? "opaque-token",
        ...(input.validateSecret === undefined ? {} : { validateSecret: input.validateSecret }),
        ...(input.successMessage === undefined ? {} : { successMessage: input.successMessage }),
        ...(input.failureMessage === undefined ? {} : { failureMessage: input.failureMessage }),
      });
      try {
        await channels.send(targetFromPrincipal(input.principal), [
          `Protected credential capture started for ${input.label}.`,
          "Your NEXT message is intercepted before routing/model use and is written directly to Vault only after validation.",
          "Send only the requested secret value.",
        ].join("\n"));
      } catch (error) {
        channels.cancelCredentialCapture(pending.id);
        throw error;
      }
      const completion = await channels.waitForCredentialCapture(pending.id);
      if (completion.status !== "stored") throw new Error(`Credential capture ${completion.status} before a secret was stored`);
      return Object.freeze({ id: pending.id });
    },
  });

  let credentials!: ModelCredentialService;

  async function beginApiKeyCapture(input: Parameters<ModelCredentialService["requestApiKeyCapture"]>[0]) {
    const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
    if (!channels) throw new Error("Model credential capture requires Channels trusted interaction support");
    const provider = safeProvider(input.provider);
    const knownProvider = model.getProviders().find((candidate) => candidate === provider);
    if (!knownProvider) throw new Error(`Unknown model provider: ${provider}`);
    const models = model.getModels(knownProvider);
    const testModel = models.find((candidate) => candidate.featured) ?? models[0];
    if (!testModel) throw new Error(`No models are registered for provider ${provider}`);
    const ref = credentials.ref(provider);
    const mode = input.mode ?? (vault.exists(ref) ? "rotate" : "create");
    const pending = channels.requestCredentialCapture({
      principal: input.principal,
      ref,
      kind: "model-api-key",
      mode,
      label: `${provider} API key`,
      inputMode: "opaque-token",
      async validateSecret(secret: Uint8Array) {
        const apiKey = Buffer.from(secret).toString("utf8");
        const response = await model.completeSimple(
          testModel as never,
          { messages: [{ role: "user", content: "Reply only with OK.", timestamp: Date.now() }] },
          { apiKey, maxTokens: 4, temperature: 0 },
        );
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          throw new Error(`${provider} rejected the credential`);
        }
      },
      successMessage: `Credential verified and stored for ${provider}.`,
      failureMessage: `That value was not accepted for ${provider}. Send only the API key itself; do not add labels, quotes, code fences, or other text.`,
    });
    try {
      await channels.send(targetFromPrincipal(input.principal), [
        `${provider} requires an API key.`,
        "Your NEXT message will be intercepted by the credential handler and will not be sent to the AI model.",
        "Send ONLY the API key itself.",
      ].join("\n"));
    } catch (error) {
      channels.cancelCredentialCapture(pending.id);
      throw error;
    }
    return pending;
  }

  credentials = Object.freeze({
    ref(provider: string) { return modelCredentialVaultRef(safeProvider(provider)); },
    oauthRef(provider: string) { return modelOAuthCredentialVaultRef(safeProvider(provider)); },
    has(provider: string) { return vault.exists(credentials.ref(provider)) || vault.exists(credentials.oauthRef(provider)); },
    hasOAuth(provider: string) { return vault.exists(credentials.oauthRef(provider)); },
    supportsOAuth(provider: string) { return auth.getOAuthProvider(safeProvider(provider)) !== undefined; },
    typicallyNeedsApiKey(provider: string) { return modelProviderTypicallyNeedsApiKey(safeProvider(provider)); },
    async getApiKey(providerInput: string) {
      const provider = safeProvider(providerInput);
      const apiRef = credentials.ref(provider);
      if (vault.exists(apiRef)) {
        let value: string | undefined;
        await trustedVault.consume(apiRef, (secret) => { value = Buffer.from(secret).toString("utf8"); });
        return value;
      }
      const oauthRef = credentials.oauthRef(provider);
      if (!vault.exists(oauthRef)) return undefined;
      const oauthProvider = auth.getOAuthProvider(provider);
      if (!oauthProvider) throw new Error(`OAuth provider is no longer registered: ${provider}`);
      let oauthCredentials: import("@friday/auth").OAuthCredentials | undefined;
      await trustedVault.consume(oauthRef, (secret) => { oauthCredentials = decodeOAuthCredentials(secret, provider); });
      if (!oauthCredentials) return undefined;
      if (Date.now() >= oauthCredentials.expires) {
        oauthCredentials = await oauthProvider.refreshToken(oauthCredentials);
        const encoded = encodeOAuthCredentials(oauthCredentials);
        try { trustedVault.rotate(oauthRef, encoded); } finally { encoded.fill(0); }
      }
      return oauthProvider.getApiKey(oauthCredentials);
    },
    async requestApiKeyCapture(input: ApiKeyCaptureInput) { return beginApiKeyCapture(input); },
    async captureApiKey(input: ApiKeyCaptureInput) {
      const pending = await beginApiKeyCapture(input);
      const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
      if (!channels) throw new Error("Model credential capture requires Channels trusted interaction support");
      const completion = await channels.waitForCredentialCapture(pending.id);
      if (completion.status !== "stored") throw new Error(`Credential capture ${completion.status} before a verified key was stored`);
      return Object.freeze({ id: pending.id });
    },
    async captureOAuth(input: OAuthCaptureInput) {
      const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
      if (!channels) throw new Error("OAuth login requires Channels trusted interaction support");
      const providerId = safeProvider(input.provider);
      const provider = auth.getOAuthProvider(providerId);
      if (!provider) throw new Error(`Provider ${providerId} does not expose a supported OAuth login flow`);
      const principal = input.principal;
      const target = targetFromPrincipal(principal);
      const prompt = (message: string, allowEmpty = false) => channels.requestPrompt({
        principal,
        title: `${provider.name} OAuth`,
        message,
        allowEmpty,
        maxLength: 8_192,
      });
      const oauthCredentials = await provider.login({
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        onAuth(info) {
          void channels.send(target, [
            `${provider.name} OAuth authorization:`,
            info.url,
            ...(info.instructions ? [info.instructions] : []),
            provider.usesCallbackServer
              ? "If the browser is on another device and localhost cannot complete, copy the final redirect URL and send it when FRIDAY asks."
              : "Complete authorization in your browser; FRIDAY will continue automatically when the provider confirms it.",
          ].join("\n")).catch((error: unknown) => {
            reportOperationalError({ component: "auth", operation: "send OAuth authorization prompt", error, severity: "warn", outcome: "degraded" });
          });
        },
        onPrompt: (request) => prompt(`${request.message}${request.placeholder ? `\nExample: ${request.placeholder}` : ""}`, request.allowEmpty === true),
        ...(provider.usesCallbackServer
          ? { onManualCodeInput: () => prompt("Paste the final OAuth redirect URL or authorization code. This protected reply is not sent to the model.") }
          : {}),
        onProgress(message) {
          void channels.send(target, `${provider.name} OAuth: ${message}`).catch((error: unknown) => {
            reportOperationalError({ component: "auth", operation: "send OAuth progress", error, severity: "warn", outcome: "degraded" });
          });
        },
        onSelect: async (request) => {
          const value = await channels.requestPrompt({
            principal,
            title: `${provider.name} OAuth`,
            message: request.message,
            options: request.options.map((option) => ({ label: option.label, value: option.id })),
            allowCustom: false,
            maxLength: 256,
          });
          return value.trim() || undefined;
        },
      });
      const ref = credentials.oauthRef(providerId);
      const encoded = encodeOAuthCredentials(oauthCredentials);
      try {
        if (vault.exists(ref)) trustedVault.rotate(ref, encoded);
        else trustedVault.create({ ref, kind: "oauth", secret: encoded });
      } finally {
        encoded.fill(0);
      }
      return Object.freeze({ id: `oauth:${providerId}` });
    },
  });

  const service: AuthService = Object.freeze({
    getOAuthProvider: auth.getOAuthProvider,
    getOAuthProviders: auth.getOAuthProviders,
    registerOAuthProvider: auth.registerOAuthProvider,
    oauthErrorHtml: auth.oauthErrorHtml,
    oauthSuccessHtml: auth.oauthSuccessHtml,
    generatePKCE: auth.generatePKCE,
  });
  ctx.services.provide(AUTH_CAPABILITY, service);
  ctx.services.provide(MODEL_CREDENTIALS_CAPABILITY, credentials);
  ctx.services.provide(PROTECTED_CREDENTIALS_CAPABILITY, protectedCredentials);

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "auth.model-credential",
    label: "Configure model API credential",
    description: "Start strict one-field API-key capture. The next channel message is intercepted before routing/model use, validated, then stored in Vault.",
    parameters: Object.freeze({ type: "object", properties: { provider: { type: "string" } }, required: ["provider"], additionalProperties: false }),
    permission(input) {
      const provider = safeProvider(input.provider);
      return { id: "auth.model-credential", effect: "credential-write", resource: `model:${provider}`, network: true };
    },
    async execute(input, context) {
      const provider = safeProvider(input.provider);
      if (context.turn.principal.authority !== "channel") throw new Error("Model credential capture from this action requires a channel-originated turn");
      const pending = await credentials.captureApiKey({ principal: targetFromTurn(context.turn), provider });
      return { stored: true, provider, requestId: pending.id, message: "Credential verified and stored in Vault." };
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "auth.oauth-login",
    label: "Complete provider OAuth login",
    description: "Run a supported OAuth/device-code flow from the originating trusted channel. Authorization URLs are sent to the channel; codes/redirect replies use protected prompts and OAuth tokens are persisted only in Vault.",
    parameters: Object.freeze({ type: "object", properties: { provider: { type: "string" } }, required: ["provider"], additionalProperties: false }),
    permission(input) {
      const provider = safeProvider(input.provider);
      return { id: "auth.oauth-login", effect: "credential-write", resource: `model-oauth:${provider}`, network: true };
    },
    async execute(input, context) {
      const provider = safeProvider(input.provider);
      if (context.turn.principal.authority !== "channel") throw new Error("OAuth login from this action requires a channel-originated turn");
      await credentials.captureOAuth({ principal: targetFromTurn(context.turn), provider, ...(context.signal === undefined ? {} : { signal: context.signal }) });
      return { stored: true, provider, message: "OAuth login completed and the token bundle was stored in Vault." };
    },
  });
});

export default authPlugin;
