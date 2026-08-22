import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventsService } from "../plugins/events/events.js";
import { createWebhooksService } from "../plugins/webhooks/webhooks.js";
import { getWebhooksDatabasePath } from "../plugins/webhooks/store.js";

const roots: string[] = [];
const fixedNow = new Date("2026-08-19T07:00:00.000Z");
const timestamp = Math.floor(fixedNow.getTime() / 1000).toString();
const secret = Buffer.from("webhook-test-secret", "utf8");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "friday-webhooks-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function signature(nonce: string, body: string, at = timestamp): string {
  return `sha256=${createHmac("sha256", secret).update(`${at}.${nonce}.`).update(body).digest("hex")}`;
}

async function harness(root: string, options: { rateLimit?: { windowMs: number; maxRequests: number } } = {}) {
  let ids = 0;
  const events = createEventsService({
    stateDir: join(root, "events"),
    now: () => fixedNow,
    idFactory: () => `event-${++ids}`,
  });
  const consumedRefs: string[] = [];
  const webhooks = createWebhooksService({
    stateDir: join(root, "webhooks"),
    events,
    now: () => fixedNow,
    consumeSecret: async (ref, consumer) => {
      consumedRefs.push(ref);
      await consumer(Uint8Array.from(secret));
    },
  });
  webhooks.trusted.registerHmacRoute({
    id: "github-push",
    path: "/hooks/github",
    eventType: "webhook.github.push",
    secretRef: "vault://webhooks/github/signing",
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
  });
  return { events, webhooks, consumedRefs };
}

function headers(nonce: string, body: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-friday-timestamp": timestamp,
    "x-friday-nonce": nonce,
    "x-friday-signature": signature(nonce, body),
    ...overrides,
  };
}

describe("webhooks plugin", () => {
  it("exposes only non-secret route metadata", async () => {
    const root = await tempRoot();
    const { events, webhooks } = await harness(root);
    try {
      expect(webhooks.public.routes()).toEqual([
        expect.objectContaining({ id: "github-push", path: "/hooks/github", eventType: "webhook.github.push", auth: "hmac-sha256" }),
      ]);
      expect(JSON.stringify(webhooks.public.routes())).not.toContain("vault://");
      expect(JSON.stringify(webhooks.public.routes())).not.toContain(secret.toString("utf8"));
    } finally {
      await webhooks.trusted.close();
      await events.close();
    }
  });

  it("accepts a valid signed HTTP request and publishes exactly one sanitized Event", async () => {
    const root = await tempRoot();
    const { events, webhooks, consumedRefs } = await harness(root);
    try {
      const status = await webhooks.trusted.start({ port: 0 });
      const body = JSON.stringify({ ref: "refs/heads/main", after: "abc123" });
      const nonce = "delivery-0001";
      const response = await fetch(`http://127.0.0.1:${status.boundPort}/hooks/github`, {
        method: "POST",
        headers: headers(nonce, body),
        body,
      });
      expect(response.status).toBe(202);
      const published = events.replay();
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        type: "webhook.github.push",
        source: "webhook.github-push",
        dedupeKey: nonce,
        data: { ref: "refs/heads/main", after: "abc123" },
        metadata: { webhook: { routeId: "github-push", nonce } },
      });
      expect(JSON.stringify(published[0])).not.toContain("x-friday-signature");
      expect(JSON.stringify(published[0])).not.toContain(secret.toString("utf8"));
      expect(consumedRefs).toEqual(["vault://webhooks/github/signing"]);
    } finally {
      await webhooks.trusted.close();
      await events.close();
    }
  });

  it("rejects valid signed replays while Events dedupe closes the publish-to-nonce crash window", async () => {
    const root = await tempRoot();
    const { events, webhooks } = await harness(root);
    try {
      const body = JSON.stringify({ value: 1 });
      const nonce = "delivery-0002";
      const request = { method: "POST", path: "/hooks/github", headers: headers(nonce, body), body: Buffer.from(body) } as const;
      expect((await webhooks.trusted.ingest(request)).status).toBe(202);
      expect((await webhooks.trusted.ingest(request)).status).toBe(409);
      expect(events.replay()).toHaveLength(1);
    } finally {
      await webhooks.trusted.close();
      await events.close();
    }
  });

  it("rejects bad signatures, stale timestamps, invalid JSON, methods and oversized bodies before Event publication", async () => {
    const root = await tempRoot();
    const { events, webhooks } = await harness(root);
    try {
      const body = JSON.stringify({ value: 1 });
      expect((await webhooks.trusted.ingest({
        method: "POST", path: "/hooks/github", headers: headers("delivery-0003", body, { "x-friday-signature": "sha256=" + "00".repeat(32) }), body: Buffer.from(body),
      })).status).toBe(401);

      const stale = Math.floor((fixedNow.getTime() - 301_000) / 1000).toString();
      expect((await webhooks.trusted.ingest({
        method: "POST", path: "/hooks/github", headers: headers("delivery-0004", body, { "x-friday-timestamp": stale, "x-friday-signature": signature("delivery-0004", body, stale) }), body: Buffer.from(body),
      })).status).toBe(401);

      const invalid = "{not-json";
      expect((await webhooks.trusted.ingest({
        method: "POST", path: "/hooks/github", headers: headers("delivery-0005", invalid), body: Buffer.from(invalid),
      })).status).toBe(400);

      expect((await webhooks.trusted.ingest({
        method: "GET", path: "/hooks/github", headers: {}, body: Buffer.alloc(0),
      })).status).toBe(405);

      const large = Buffer.alloc(1024 * 1024 + 1, 0x61);
      expect((await webhooks.trusted.ingest({
        method: "POST", path: "/hooks/github", headers: {}, body: large,
      })).status).toBe(413);
      expect(events.replay()).toHaveLength(0);
    } finally {
      await webhooks.trusted.close();
      await events.close();
    }
  });

  it("persists rate limiting across service restart", async () => {
    const root = await tempRoot();
    const first = await harness(root, { rateLimit: { windowMs: 60_000, maxRequests: 1 } });
    const body = JSON.stringify({ value: 1 });
    try {
      expect((await first.webhooks.trusted.ingest({
        method: "POST", path: "/hooks/github", headers: headers("delivery-rate-1", body), body: Buffer.from(body),
      })).status).toBe(202);
    } finally {
      await first.webhooks.trusted.close();
    }

    const second = createWebhooksService({
      stateDir: join(root, "webhooks"),
      events: first.events,
      now: () => fixedNow,
      consumeSecret: async (_ref, consumer) => { await consumer(Uint8Array.from(secret)); },
    });
    second.trusted.registerHmacRoute({
      id: "github-push",
      path: "/hooks/github",
      eventType: "webhook.github.push",
      secretRef: "vault://webhooks/github/signing",
      rateLimit: { windowMs: 60_000, maxRequests: 1 },
    });
    try {
      expect((await second.trusted.ingest({
        method: "POST", path: "/hooks/github", headers: headers("delivery-rate-2", body), body: Buffer.from(body),
      })).status).toBe(429);
    } finally {
      await second.trusted.close();
      await first.events.close();
    }
  });


  it("retains nonce replay protection for the full validity window of future-dated signed requests", async () => {
    const root = await tempRoot();
    let current = new Date(fixedNow);
    const events = createEventsService({ stateDir: join(root, "events"), now: () => current });
    const webhooks = createWebhooksService({
      stateDir: join(root, "webhooks"),
      events,
      now: () => current,
      consumeSecret: async (_ref, consumer) => { await consumer(Uint8Array.from(secret)); },
    });
    webhooks.trusted.registerHmacRoute({
      id: "future", path: "/hooks/future", eventType: "webhook.future", secretRef: "vault://future",
      maxAgeSeconds: 300,
    });
    const futureTimestamp = Math.floor((fixedNow.getTime() + 240_000) / 1000).toString();
    const body = JSON.stringify({ value: 1 });
    const nonce = "future-delivery-1";
    const request = {
      method: "POST",
      path: "/hooks/future",
      headers: headers(nonce, body, {
        "x-friday-timestamp": futureTimestamp,
        "x-friday-signature": signature(nonce, body, futureTimestamp),
      }),
      body: Buffer.from(body),
    } as const;
    try {
      expect((await webhooks.trusted.ingest(request)).status).toBe(202);
      current = new Date(fixedNow.getTime() + 360_000);
      expect((await webhooks.trusted.ingest(request)).status).toBe(409);
      expect(events.replay()).toHaveLength(1);
    } finally {
      await webhooks.trusted.close();
      await events.close();
    }
  });

  it("rejects duplicate route ids and paths and allows explicit unregister", async () => {
    const root = await tempRoot();
    const { events, webhooks } = await harness(root);
    try {
      expect(() => webhooks.trusted.registerHmacRoute({
        id: "github-push", path: "/hooks/other", eventType: "webhook.other", secretRef: "vault://other",
      })).toThrow(/id is already registered/);
      expect(() => webhooks.trusted.registerHmacRoute({
        id: "other", path: "/hooks/github", eventType: "webhook.other", secretRef: "vault://other",
      })).toThrow(/path is already registered/);
      const unregister = webhooks.trusted.registerHmacRoute({
        id: "other", path: "/hooks/other", eventType: "webhook.other", secretRef: "vault://other",
      });
      expect(webhooks.public.routes()).toHaveLength(2);
      unregister();
      expect(webhooks.public.routes()).toHaveLength(1);
    } finally {
      await webhooks.trusted.close();
      await events.close();
    }
  });

  it("starts explicitly on loopback and stops gracefully", async () => {
    const root = await tempRoot();
    const { events, webhooks } = await harness(root);
    try {
      expect(webhooks.public.status()).toMatchObject({ running: false, host: "127.0.0.1" });
      const started = await webhooks.trusted.start({ port: 0 });
      expect(started.running).toBe(true);
      expect(started.boundPort).toBeGreaterThan(0);
      await webhooks.trusted.stop();
      expect(webhooks.public.status().running).toBe(false);
    } finally {
      await webhooks.trusted.close();
      await events.close();
    }
  });

  it("fails closed when the webhook security database is corrupt", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "webhooks");
    await mkdir(stateDir, { recursive: true });
    await writeFile(getWebhooksDatabasePath(stateDir), "not-sqlite");
    const events = createEventsService({ stateDir: join(root, "events") });
    expect(() => createWebhooksService({
      stateDir,
      events,
      consumeSecret: async () => {},
    })).toThrow();
    await events.close();
  });
});
