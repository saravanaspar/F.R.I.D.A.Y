import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export interface WebhookRateLimit {
  windowMs: number;
  maxRequests: number;
}

export interface WebhookRouteInfo {
  id: string;
  path: string;
  auth: "hmac-sha256";
  eventType: string;
  source: string;
  maxBodyBytes: number;
  maxAgeSeconds: number;
  rateLimit: WebhookRateLimit;
}

export interface WebhookServerStatus {
  running: boolean;
  host: string;
  configuredPort: number;
  boundPort?: number | undefined;
  routeCount: number;
}

export interface WebhooksService {
  routes(): readonly WebhookRouteInfo[];
  route(id: string): WebhookRouteInfo | undefined;
  status(): WebhookServerStatus;
}

export const WEBHOOKS_CAPABILITY: Capability<WebhooksService> =
  defineCapability<WebhooksService>("webhooks");
