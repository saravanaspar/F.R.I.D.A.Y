import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { WebhookRateLimit, WebhookRouteInfo, WebhookServerStatus } from "./contract.js";

export interface WebhookHmacRouteInput {
  id: string;
  path: string;
  eventType: string;
  source?: string | undefined;
  secretRef: string;
  signatureHeader?: string | undefined;
  timestampHeader?: string | undefined;
  nonceHeader?: string | undefined;
  maxBodyBytes?: number | undefined;
  maxAgeSeconds?: number | undefined;
  rateLimit?: Partial<WebhookRateLimit> | undefined;
}

export interface WebhookIngressRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: Uint8Array;
}

export interface WebhookIngressResponse {
  status: number;
  body: string;
  eventId?: string | undefined;
}

export interface WebhookServerOptions {
  host?: string | undefined;
  port?: number | undefined;
}

export interface WebhooksTrustedService {
  registerHmacRoute(input: WebhookHmacRouteInput): () => void;
  ingest(request: WebhookIngressRequest): Promise<WebhookIngressResponse>;
  start(options?: WebhookServerOptions): Promise<WebhookServerStatus>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export const WEBHOOKS_TRUSTED_CAPABILITY: Capability<WebhooksTrustedService> =
  defineCapability<WebhooksTrustedService>("webhooks.trusted");

export type { WebhookRouteInfo };
