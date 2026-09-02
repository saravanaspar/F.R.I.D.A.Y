import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type AuthRuntime = typeof import("@friday/auth");

/**
 * Narrow transport-agnostic identity needed to bind an interactive model
 * credential flow to its originating conversation. Keep this contract local
 * to Auth so model credential consumers do not depend on the Channels package.
 */
export interface ModelCredentialPrincipal {
  readonly channel: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly threadId?: string | undefined;
}

/** The only capture detail consumers need after Auth starts the protected flow. */
export interface ModelCredentialCapture {
  readonly id: string;
}

/** Public OAuth helpers. Secret persistence remains behind the trusted credential capability. */
export interface AuthService {
  readonly getOAuthProvider: AuthRuntime["getOAuthProvider"];
  readonly getOAuthProviders: AuthRuntime["getOAuthProviders"];
  readonly registerOAuthProvider: AuthRuntime["registerOAuthProvider"];
  readonly oauthErrorHtml: AuthRuntime["oauthErrorHtml"];
  readonly oauthSuccessHtml: AuthRuntime["oauthSuccessHtml"];
  readonly generatePKCE: AuthRuntime["generatePKCE"];
}

export interface ModelCredentialService {
  ref(provider: string): string;
  has(provider: string): boolean;
  getApiKey(provider: string): Promise<string | undefined>;
  requestApiKeyCapture(input: {
    readonly principal: ModelCredentialPrincipal;
    readonly provider: string;
    readonly mode?: "create" | "rotate" | undefined;
  }): Promise<ModelCredentialCapture>;
  captureApiKey(input: {
    readonly principal: ModelCredentialPrincipal;
    readonly provider: string;
    readonly mode?: "create" | "rotate" | undefined;
  }): Promise<ModelCredentialCapture>;
}

export const AUTH_CAPABILITY: Capability<AuthService> =
  defineCapability<AuthService>("auth");

export const MODEL_CREDENTIALS_CAPABILITY: Capability<ModelCredentialService> =
  defineCapability<ModelCredentialService>("model-credentials");
