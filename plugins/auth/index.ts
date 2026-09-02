import * as auth from "@friday/auth";
import type { FridayPlugin } from "../../src/plugin.js";
import { modelCredentialVaultRef } from "./model-credential-ref.js";
import { definePlugin } from "../capabilities/protocol.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../channels/trusted-contract.js";
import { MODEL_CAPABILITY } from "../model/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, type SystemActionExecutionContext } from "../system/contract.js";
import { VAULT_CAPABILITY } from "../vault/contract.js";
import { VAULT_TRUSTED_CAPABILITY } from "../vault/trusted-contract.js";
import {
  AUTH_CAPABILITY,
  MODEL_CREDENTIALS_CAPABILITY,
  type AuthService,
  type ModelCredentialService,
} from "./contract.js";

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

const authPlugin: FridayPlugin = definePlugin({
  id: "auth",
  requires: [MODEL_CAPABILITY, VAULT_CAPABILITY, VAULT_TRUSTED_CAPABILITY],
  optional: [CHANNELS_TRUSTED_CAPABILITY],
  provides: [AUTH_CAPABILITY, MODEL_CREDENTIALS_CAPABILITY],
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

  async function beginApiKeyCapture(
    input: Parameters<ModelCredentialService["requestApiKeyCapture"]>[0],
  ) {
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
      await channels.send({
        channel: input.principal.channel,
        accountId: input.principal.accountId,
        conversationId: input.principal.conversationId,
        ...(input.principal.threadId === undefined ? {} : { threadId: input.principal.threadId }),
      }, [
        `${provider} requires an API key.`,
        "Your NEXT message will be intercepted by the credential handler and will not be sent to the AI model.",
        "Send ONLY the API key itself.",
        "Do not include a field label, quotes, code fences, spaces, or other text.",
      ].join("\n"));
    } catch (error) {
      channels.cancelCredentialCapture(pending.id);
      throw error;
    }
    return pending;
  }

  const credentials: ModelCredentialService = Object.freeze({
    ref(provider: string) {
      return modelCredentialVaultRef(safeProvider(provider));
    },
    has(provider: string) {
      return vault.exists(credentials.ref(provider));
    },
    async getApiKey(provider: string) {
      const ref = credentials.ref(provider);
      if (!vault.exists(ref)) return undefined;
      let value: string | undefined;
      await trustedVault.consume(ref, (secret) => {
        value = Buffer.from(secret).toString("utf8");
      });
      return value;
    },
    async requestApiKeyCapture(input: Parameters<ModelCredentialService["requestApiKeyCapture"]>[0]) {
      return beginApiKeyCapture(input);
    },
    async captureApiKey(input: Parameters<ModelCredentialService["captureApiKey"]>[0]) {
      const pending = await beginApiKeyCapture(input);
      const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
      if (!channels) throw new Error("Model credential capture requires Channels trusted interaction support");
      const completion = await channels.waitForCredentialCapture(pending.id);
      if (completion.status !== "stored") {
        throw new Error(`Credential capture ${completion.status} before a verified key was stored`);
      }
      return pending;
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

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "auth.model-credential",
    label: "Configure model API credential",
    description: "Start strict one-field API-key capture for a model provider. The next channel message is intercepted before routing/model use, validated against the provider, then stored in Vault.",
    parameters: Object.freeze({
      type: "object",
      properties: { provider: { type: "string" } },
      required: ["provider"],
      additionalProperties: false,
    }),
    permission(input) {
      const provider = safeProvider(input.provider);
      return { id: "auth.model-credential", effect: "credential-write", resource: `model:${provider}`, network: true };
    },
    async execute(input, context) {
      const provider = safeProvider(input.provider);
      if (context.turn.principal.authority !== "channel") {
        throw new Error("Model credential capture from this action requires a channel-originated turn");
      }
      const pending = await credentials.captureApiKey({
        principal: targetFromTurn(context.turn),
        provider,
      });
      return {
        stored: true,
        provider,
        requestId: pending.id,
        message: "Credential verified and stored in Vault.",
      };
    },
  });
});

export default authPlugin;
