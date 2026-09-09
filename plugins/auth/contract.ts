import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type AuthRuntime = typeof import("@friday/auth");

/** Narrow conversation identity used by protected Auth interactions. */
export interface ModelCredentialPrincipal {
  readonly channel: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly threadId?: string | undefined;
}

export interface ModelCredentialCapture {
  readonly id: string;
}

/** Generic protected credential capture owned by Auth; secret text never reaches the model/router. */
export interface ProtectedCredentialService {
  capture(input: {
    readonly principal: ModelCredentialPrincipal;
    readonly ref: string;
    readonly kind: string;
    readonly label: string;
    readonly mode?: "create" | "rotate" | undefined;
    readonly inputMode?: "opaque-token" | "text" | undefined;
    readonly validateSecret?: ((secret: Uint8Array) => void | Promise<void>) | undefined;
    readonly successMessage?: string | undefined;
    readonly failureMessage?: string | undefined;
  }): Promise<ModelCredentialCapture>;
}

/** Public OAuth helpers. Secret persistence remains behind trusted Auth/Vault paths. */
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
  oauthRef(provider: string): string;
  has(provider: string): boolean;
  hasOAuth(provider: string): boolean;
  supportsOAuth(provider: string): boolean;
  /** Whether this provider normally needs an API-key style credential. */
  typicallyNeedsApiKey(provider: string): boolean;
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
  captureOAuth(input: {
    readonly principal: ModelCredentialPrincipal;
    readonly provider: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<ModelCredentialCapture>;
}

export const AUTH_CAPABILITY: Capability<AuthService> =
  defineCapability<AuthService>("auth");

export const MODEL_CREDENTIALS_CAPABILITY: Capability<ModelCredentialService> =
  defineCapability<ModelCredentialService>("model-credentials");

export const PROTECTED_CREDENTIALS_CAPABILITY: Capability<ProtectedCredentialService> =
  defineCapability<ProtectedCredentialService>("protected-credentials");
