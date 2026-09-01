import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createHmac, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ChannelHub,
  DiscordChannelTransport,
  EmailChannelTransport,
  GoogleChatChannelTransport,
  SignalChannelTransport,
  SlackChannelTransport,
  SmsChannelTransport,
  TeamsChannelTransport,
  TelegramChannelTransport,
  WhatsAppChannelTransport,
  channelPrincipalAllowed,
  sanitizeChannelText,
  splitChannelMessage,
  type ChannelInboundMessage,
  type ChannelPrincipal,
  type ChannelTarget,
  type ChannelTransport,
  type ChannelTransportStatus,
  type CredentialVaultPort,
} from "../src/index.js";
import { accountStatePath } from "../src/state.js";

const tempDirs: string[] = [];
const testHome = mkdtempSync(join(tmpdir(), "friday-channel-home-"));
const originalFridayHome = process.env.FRIDAY_HOME;
beforeAll(() => { process.env.FRIDAY_HOME = testHome; });
afterAll(() => { rmSync(testHome, { recursive: true, force: true }); if (originalFridayHome === undefined) delete process.env.FRIDAY_HOME; else process.env.FRIDAY_HOME = originalFridayHome; });
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(join(testHome, "channels"), { recursive: true, force: true });
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeVault implements CredentialVaultPort {
  readonly values = new Map<string, Buffer>();
  normalizeRef(ref: string): string {
    if (!ref.startsWith("vault://")) throw new Error("bad ref");
    return ref;
  }
  exists(ref: string): boolean { return this.values.has(ref); }
  create(input: { ref: string; kind: string; secret: Uint8Array }) {
    if (this.values.has(input.ref)) throw new Error("exists");
    this.values.set(input.ref, Buffer.from(input.secret));
    return { ref: input.ref, kind: input.kind, version: 1, createdAt: "now", updatedAt: "now" };
  }
  rotate(ref: string, secret: Uint8Array) {
    if (!this.values.has(ref)) throw new Error("missing");
    this.values.set(ref, Buffer.from(secret));
    return { ref, kind: "token", version: 2, createdAt: "then", updatedAt: "now" };
  }
}

class PrivacyTransport implements ChannelTransport {
  readonly channel = "telegram" as const;
  readonly accountId = "default";
  readonly privacy: ("normal" | "secret")[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(target: ChannelTarget, _text: string) {
    return { channel: this.channel, accountId: this.accountId, conversationId: target.conversationId, messageIds: ["m1"] };
  }
  setInputPrivacy(privacy: "normal" | "secret"): void { this.privacy.push(privacy); }
  status(): ChannelTransportStatus { return { channel: this.channel, accountId: this.accountId, state: "running" }; }
}

function principal(overrides: Partial<ChannelPrincipal> = {}): ChannelPrincipal {
  return {
    channel: "telegram",
    accountId: "default",
    conversationId: "chat-1",
    senderId: "user-1",
    ...overrides,
  };
}

function inbound(text: string, p = principal()) {
  return {
    id: "message-1",
    principal: p,
    chatType: "dm" as const,
    text,
    timestamp: 123,
    attachments: [],
  };
}

describe("channel text sanitization", () => {
  it("redacts credential assignments and bearer tokens before publication", () => {
    const source = "api_key=sk-secretvalue123456 Bearer abcdefghijklmno";
    const result = sanitizeChannelText(source);
    expect(result.text).toContain("api_key=[REDACTED]");
    expect(result.text).toContain("Bearer [REDACTED]");
    expect(result.text).not.toContain("secretvalue123456");
    expect(result.text).not.toContain("abcdefghijklmno");
    expect(result.redactionCount).toBeGreaterThanOrEqual(2);
  });

  it("redacts standalone provider-token shapes without preserving the matched value", () => {
    const secrets = [
      "sk-abcdefghijklmnop",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "xoxb-123456789012-abcdefghijkl",
      "AKIA1234567890ABCDEF",
    ];
    for (const secret of secrets) {
      const result = sanitizeChannelText(`credential ${secret}`);
      expect(result.text).toBe("credential [REDACTED]");
      expect(result.text).not.toContain(secret);
    }
  });

  it("repairs lone UTF-16 surrogates and NUL bytes", () => {
    expect(sanitizeChannelText(`a\ud800b\0c`).text).toBe("a�b�c");
  });

  it("rejects oversized inbound text before it can enter downstream state", () => {
    expect(() => sanitizeChannelText("x".repeat(256 * 1024 + 1))).toThrow("exceeds");
  });
});

describe("credential capture", () => {
  it("asks a capable local transport to hide credential input until capture completes", async () => {
    const vault = new FakeVault();
    const hub = new ChannelHub({ credentialVault: vault });
    const transport = new PrivacyTransport();
    hub.registerTransport(transport);
    hub.requestCredentialCapture({
      principal: principal(),
      ref: "vault://demo/token",
      kind: "token",
      mode: "create",
      inputMode: "opaque-token",
    });
    expect(transport.privacy).toEqual(["secret"]);
    await hub.ingest(inbound("secret-token-123"));
    expect(transport.privacy).toEqual(["secret", "normal"]);
  });

  it("captures exactly one message from the exact principal and publishes only a marker", async () => {
    const vault = new FakeVault();
    const hub = new ChannelHub({ credentialVault: vault });
    const observed: ChannelInboundMessage[] = [];
    hub.subscribe((message) => { observed.push(message); });
    const capture = hub.requestCredentialCapture({
      principal: principal(),
      ref: "vault://gmail/work/oauth",
      kind: "oauth",
      mode: "create",
      label: "gmail.work",
    });
    const secret = "CAPTURE_SENTINEL_92x_secret";
    const result = await hub.ingest(inbound(secret));

    expect(result.classification).toBe("credential-captured");
    expect(result.text).toBe("[credential supplied for gmail.work]");
    expect(result.credential?.requestId).toBe(capture.id);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(observed)).not.toContain(secret);
    expect(vault.values.get("vault://gmail/work/oauth")?.toString()).toBe(secret);
    expect(hub.pendingCredentialCaptures()).toEqual([]);
  });

  it("does not capture another sender or another thread", async () => {
    const vault = new FakeVault();
    const hub = new ChannelHub({ credentialVault: vault });
    hub.requestCredentialCapture({
      principal: principal({ threadId: "topic-1" }),
      ref: "vault://service/token",
      kind: "token",
      mode: "create",
    });
    const other = await hub.ingest(inbound("ordinary", principal({ senderId: "user-2", threadId: "topic-1" })));
    const wrongThread = await hub.ingest(inbound("also ordinary", principal({ threadId: "topic-2" })));
    expect(other.classification).toBe("message");
    expect(wrongThread.classification).toBe("message");
    expect(vault.values.size).toBe(0);
    expect(hub.pendingCredentialCaptures()).toHaveLength(1);
  });

  it("requires explicit create versus rotate semantics", () => {
    const vault = new FakeVault();
    vault.values.set("vault://service/token", Buffer.from("old"));
    const hub = new ChannelHub({ credentialVault: vault });
    expect(() => hub.requestCredentialCapture({ principal: principal(), ref: "vault://service/token", kind: "token", mode: "create" })).toThrow("rotation");
    expect(() => hub.requestCredentialCapture({ principal: principal(), ref: "vault://missing/token", kind: "token", mode: "rotate" })).toThrow("create");
  });

  it("rotates an existing credential without exposing either value", async () => {
    const vault = new FakeVault();
    vault.values.set("vault://service/token", Buffer.from("old-secret"));
    const hub = new ChannelHub({ credentialVault: vault });
    hub.requestCredentialCapture({ principal: principal(), ref: "vault://service/token", kind: "token", mode: "rotate", label: "service" });
    const result = await hub.ingest(inbound("new-secret"));
    expect(result.text).toBe("[credential supplied for service]");
    expect(JSON.stringify(result)).not.toContain("new-secret");
    expect(vault.values.get("vault://service/token")?.toString()).toBe("new-secret");
  });

  it("fails closed when Vault write fails and never forwards the submitted value", async () => {
    const vault = new FakeVault();
    vault.create = () => { throw new Error("storage failed"); };
    const hub = new ChannelHub({ credentialVault: vault });
    const seen: ChannelInboundMessage[] = [];
    hub.subscribe((message) => { seen.push(message); });
    hub.requestCredentialCapture({ principal: principal(), ref: "vault://service/token", kind: "token", mode: "create", label: "service" });
    const secret = "MUST_NEVER_ESCAPE_481";
    const result = await hub.ingest(inbound(secret));
    expect(result.classification).toBe("credential-capture-error");
    expect(result.text).toContain("value was not forwarded");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(seen)).not.toContain(secret);
    expect(hub.pendingCredentialCaptures()).toHaveLength(1);
  });

  it("rejects attachments during capture without publishing the text", async () => {
    const vault = new FakeVault();
    const hub = new ChannelHub({ credentialVault: vault });
    hub.requestCredentialCapture({ principal: principal(), ref: "vault://service/token", kind: "token", mode: "create" });
    const result = await hub.ingest({ ...inbound("secret-in-caption"), attachments: [{ kind: "document" as const, externalId: "f1" }] });
    expect(result.classification).toBe("credential-capture-error");
    expect(JSON.stringify(result)).not.toContain("secret-in-caption");
    expect(vault.values.size).toBe(0);
  });

  it("expires and cancels pending captures without touching Vault", async () => {
    let now = 1_000;
    const vault = new FakeVault();
    const hub = new ChannelHub({ credentialVault: vault, now: () => now });
    const capture = hub.requestCredentialCapture({ principal: principal(), ref: "vault://service/token", kind: "token", mode: "create", ttlMs: 1_000 });
    expect(hub.cancelCredentialCapture("wrong")).toBe(false);
    expect(hub.cancelCredentialCapture(capture.id)).toBe(true);
    expect(hub.pendingCredentialCaptures()).toEqual([]);
    expect((await hub.ingest(inbound("reply-after-cancel"))).classification).toBe("credential-capture-error");
    hub.requestCredentialCapture({ principal: principal(), ref: "vault://service/token", kind: "token", mode: "create", ttlMs: 1_000 });
    now = 2_001;
    expect(hub.pendingCredentialCaptures()).toEqual([]);
    const result = await hub.ingest(inbound("normal-after-expiry"));
    expect(result.classification).toBe("message");
    expect(vault.values.size).toBe(0);
  });
});



describe("protected channel interactions", () => {
  function protectedHub() {
    const sent: string[] = [];
    const hub = new ChannelHub({ credentialVault: new FakeVault() });
    const transport: ChannelTransport = {
      channel: "telegram",
      accountId: "default",
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ channel: "telegram", accountId: "default", state: "running" }),
      send: async (target, text) => {
        sent.push(text);
        return { channel: "telegram", accountId: "default", conversationId: target.conversationId, messageIds: [String(sent.length)] };
      },
    };
    hub.registerTransport(transport);
    return { hub, sent };
  }

  it("resolves approvals only from the exact principal and never publishes the approval reply", async () => {
    const { hub, sent } = protectedHub();
    const observed: ChannelInboundMessage[] = [];
    hub.subscribe((message) => { observed.push(message); });
    const approval = hub.requestApproval({
      principal: principal(),
      actionId: "runtime.settings.update",
      effect: "system-mutation",
      resource: "runtime-settings",
      reason: "change the routing model",
      network: true,
    });
    await Promise.resolve();
    const pending = hub.pendingApprovals()[0]!;
    expect(sent[0]).toContain(`approve ${pending.code}`);
    expect(sent[0]).toContain("Network: requested");
    expect(pending.network).toBe(true);

    const unscoped = await hub.ingest(inbound("yes"));
    expect(unscoped.classification).toBe("approval-error");
    expect(hub.pendingApprovals()).toHaveLength(1);

    const wrongSender = await hub.ingest(inbound(`approve ${pending.code}`, principal({ senderId: "user-2" })));
    expect(wrongSender.classification).toBe("approval-error");
    expect(hub.pendingApprovals()).toHaveLength(1);

    const resolved = await hub.ingest(inbound(`approve ${pending.code}`));
    expect(resolved.classification).toBe("approval-resolved");
    expect(resolved.approval).toMatchObject({ requestId: pending.id, approved: true });
    await expect(approval).resolves.toBe(true);
    expect(observed).toHaveLength(0);
  });

  it("keeps resolved and stopped approval codes fail-closed without blocking a fresh request", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "friday-approval-replay-"));
    tempDirs.push(stateDirectory);
    const statePath = join(stateDirectory, "protected.json");
    const first = new ChannelHub({ credentialVault: new FakeVault(), protectedStatePath: statePath });
    first.registerTransport({ channel: "telegram", accountId: "default", start: async () => undefined, stop: async () => undefined, status: () => ({ channel: "telegram", accountId: "default", state: "running" }), send: async (target) => ({ channel: "telegram", accountId: "default", conversationId: target.conversationId, messageIds: ["1"] }) });
    const approval = first.requestApproval({ principal: principal(), actionId: "test", effect: "write", resource: "x", reason: "test" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resolvedPending = first.pendingApprovals()[0]!;
    const code = resolvedPending.code;
    expect((await first.ingest(inbound(`approve ${code}`))).classification).toBe("approval-resolved");
    expect((await first.ingest(inbound(`approve ${code}`))).classification).toBe("approval-error");
    expect((await first.ingest({ ...inbound(""), protectedAction: { requestId: resolvedPending.id, decision: "approve" } })).classification).toBe("approval-error");
    await expect(approval).resolves.toBe(true);
    const fresh = first.requestApproval({ principal: principal(), actionId: "test-2", effect: "write", resource: "y", reason: "test" });
    expect(first.pendingApprovals()).toHaveLength(1);
    const stoppedPending = first.pendingApprovals()[0]!;
    await first.stopAll();
    const second = new ChannelHub({ credentialVault: new FakeVault(), protectedStatePath: statePath });
    expect((await second.ingest(inbound(`approve ${stoppedPending.code}`))).classification).toBe("approval-error");
    expect((await second.ingest({ ...inbound(""), protectedAction: { requestId: stoppedPending.id, decision: "approve" } })).classification).toBe("approval-error");
    await expect(fresh).resolves.toBe(false);
  });

  it("still stops every transport when the final protected-state snapshot fails", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "friday-stop-persistence-"));
    tempDirs.push(stateDirectory);
    const statePath = join(stateDirectory, "protected.json");
    let stopped = false;
    const hub = new ChannelHub({ credentialVault: new FakeVault(), protectedStatePath: statePath, onError: () => undefined });
    hub.registerTransport({
      channel: "telegram",
      accountId: "default",
      start: async () => undefined,
      stop: async () => { stopped = true; },
      status: () => ({ channel: "telegram", accountId: "default", state: "running" }),
      send: async (target) => ({ channel: "telegram", accountId: "default", conversationId: target.conversationId, messageIds: ["1"] }),
    });
    const approval = hub.requestApproval({ principal: principal(), actionId: "test", effect: "write", resource: "x", reason: "test" });
    await Promise.resolve();
    rmSync(statePath);
    mkdirSync(statePath, { mode: 0o700 });
    await expect(hub.stopAll()).rejects.toThrow();
    expect(stopped).toBe(true);
    await expect(approval).resolves.toBe(false);
  });

  it("sanitizes native approval notices and binds one-shot callbacks to the exact principal", async () => {
    let nativeNotice = "";
    const hub = new ChannelHub({ credentialVault: new FakeVault() });
    hub.registerTransport({
      channel: "telegram",
      accountId: "default",
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ channel: "telegram", accountId: "default", state: "running" }),
      send: async (target) => ({ channel: "telegram", accountId: "default", conversationId: target.conversationId, messageIds: ["fallback"] }),
      sendProtectedAction: async (target, text) => {
        nativeNotice = text;
        return { channel: "telegram", accountId: "default", conversationId: target.conversationId, messageIds: ["native"] };
      },
    });

    const approval = hub.requestApproval({
      principal: principal({ threadId: "topic-1" }),
      actionId: "native.test",
      effect: "external-write",
      resource: "remote",
      reason: "use api_key=sk-native-secret-value-123456",
    });
    await Promise.resolve();
    const pending = hub.pendingApprovals()[0]!;
    expect(nativeNotice).toContain("api_key=[REDACTED]");
    expect(nativeNotice).not.toContain("native-secret-value");

    const wrong = await hub.ingest({ ...inbound("", principal({ senderId: "user-2", threadId: "topic-1" })), protectedAction: { requestId: pending.id, decision: "approve" } });
    expect(wrong.classification).toBe("approval-error");
    expect(hub.pendingApprovals()).toHaveLength(1);

    const resolved = await hub.ingest({ ...inbound("", principal({ threadId: "topic-1" })), protectedAction: { requestId: pending.id, decision: "approve" } });
    expect(resolved.classification).toBe("approval-resolved");
    await expect(approval).resolves.toBe(true);
    expect((await hub.ingest({ ...inbound("", principal({ threadId: "topic-1" })), protectedAction: { requestId: pending.id, decision: "approve" } })).classification).toBe("approval-error");
  });

  it("rejects principals that cannot be represented by the bounded restart state", async () => {
    const { hub } = protectedHub();
    await expect(hub.requestApproval({
      principal: principal({ threadId: "x".repeat(257) }),
      actionId: "test",
      effect: "write",
      resource: "x",
      reason: "test",
    })).rejects.toThrow(/threadId exceeds 256/);
  });

  it("lets cancellation win over a foreground approval and permits a new watcher after its tombstone", async () => {
    const { hub } = protectedHub();
    const approval = hub.requestApproval({ principal: principal(), actionId: "test", effect: "write", resource: "x", reason: "test" });
    await Promise.resolve();
    const cancellation = await hub.watchCancellation({ principal: principal(), label: "job" });
    const result = await hub.ingest(inbound(`cancel ${cancellation.request.code}`));
    expect(result.classification).toBe("cancellation-requested");
    expect(cancellation.signal.aborted).toBe(true);
    hub.cancelApproval((await hub.pendingApprovals())[0]!.id);
    await expect(approval).resolves.toBe(false);
    await expect(hub.watchCancellation({ principal: principal(), label: "new-job" })).resolves.toBeDefined();
  });

  it("keeps strict credential capture active until a token-only value validates", async () => {
    const secretPort = new FakeVault();
    const strictHub = new ChannelHub({ credentialVault: secretPort });
    strictHub.registerTransport({
      channel: "telegram",
      accountId: "default",
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ channel: "telegram", accountId: "default", state: "running" }),
      send: async (target) => ({ channel: "telegram", accountId: "default", conversationId: target.conversationId, messageIds: ["1"] }),
    });
    const capture = strictHub.requestCredentialCapture({
      principal: principal(),
      ref: "vault://models/openai/api-key",
      kind: "api-key",
      mode: "create",
      label: "OpenAI API key",
      inputMode: "opaque-token",
      validateSecret: (secret) => {
        if (Buffer.from(secret).toString("utf8") !== "valid-token-123") throw new Error("provider rejected key");
      },
    });
    const completion = strictHub.waitForCredentialCapture(capture.id);

    const prose = await strictHub.ingest(inbound("api key: invalid-token"));
    expect(prose.classification).toBe("credential-capture-error");
    expect(JSON.stringify(prose)).not.toContain("invalid-token");
    expect(secretPort.values.size).toBe(0);
    expect(strictHub.pendingCredentialCaptures()).toHaveLength(1);

    const invalid = await strictHub.ingest(inbound("wrong-token"));
    expect(invalid.classification).toBe("credential-capture-error");
    expect(secretPort.values.size).toBe(0);
    expect(strictHub.pendingCredentialCaptures()).toHaveLength(1);

    const valid = await strictHub.ingest(inbound("valid-token-123"));
    expect(valid.classification).toBe("credential-captured");
    expect(JSON.stringify(valid)).not.toContain("valid-token-123");
    await expect(completion).resolves.toEqual({ requestId: capture.id, status: "stored" });
    expect(secretPort.values.get("vault://models/openai/api-key")?.toString()).toBe("valid-token-123");
  });

  it("captures protected text prompts from the exact principal before normal publication", async () => {
    const { hub } = protectedHub();
    const observed: ChannelInboundMessage[] = [];
    hub.subscribe((message) => { observed.push(message); });
    const result = hub.requestPrompt({
      principal: principal({ threadId: "topic-1" }),
      message: "Send the custom model endpoint.",
      placeholder: "https://models.example.com/v1",
    });
    await Promise.resolve();

    const wrongThread = await hub.ingest(inbound("https://wrong.example", principal({ threadId: "topic-2" })));
    expect(wrongThread.classification).toBe("message");
    expect(observed).toHaveLength(1);

    const captured = await hub.ingest(inbound("https://models.example.com/v1", principal({ threadId: "topic-1" })));
    expect(captured.classification).toBe("prompt-resolved");
    await expect(result).resolves.toBe("https://models.example.com/v1");
    expect(observed).toHaveLength(1);
  });

  it("intercepts the exact cancellation code while unrelated text continues as an ordinary message", async () => {
    const { hub } = protectedHub();
    const handle = await hub.watchCancellation({ principal: principal(), label: "self-improvement" });
    const ordinary = await hub.ingest(inbound("how is it going?"));
    expect(ordinary.classification).toBe("message");
    expect(handle.signal.aborted).toBe(false);

    const unscoped = await hub.ingest(inbound("cancel"));
    expect(unscoped.classification).toBe("message");
    expect(handle.signal.aborted).toBe(false);

    const cancelled = await hub.ingest(inbound(`cancel ${handle.request.code}`));
    expect(cancelled.classification).toBe("cancellation-requested");
    expect(handle.signal.aborted).toBe(true);
  });

  it("removes a cancellation watcher if its instruction cannot be delivered", async () => {
    let attempts = 0;
    const hub = new ChannelHub({ credentialVault: new FakeVault() });
    hub.registerTransport({
      channel: "telegram",
      accountId: "default",
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ channel: "telegram", accountId: "default", state: "running" }),
      send: async (target) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transport unavailable");
        return { channel: "telegram", accountId: "default", conversationId: target.conversationId, messageIds: ["2"] };
      },
    });

    await expect(hub.watchCancellation({ principal: principal(), label: "job" })).rejects.toThrow("transport unavailable");
    await expect(hub.watchCancellation({ principal: principal(), label: "job" })).resolves.toBeDefined();
  });

  it("loads protected interactions as crash tombstones and never republishes the next reply", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "friday-protected-state-"));
    tempDirs.push(stateDirectory);
    const statePath = join(stateDirectory, "protected.json");
    const vault = new FakeVault();
    const first = new ChannelHub({ credentialVault: vault, protectedStatePath: statePath });
    first.requestCredentialCapture({ principal: principal(), ref: "vault://crash/key", kind: "api-key", mode: "create" });
    const second = new ChannelHub({ credentialVault: vault, protectedStatePath: statePath });
    const observed: ChannelInboundMessage[] = [];
    second.subscribe((message) => { observed.push(message); });
    const rejected = await second.ingest(inbound("secret-after-crash"));
    expect(rejected.classification).toBe("credential-capture-error");
    expect(observed).toHaveLength(0);
    expect(vault.values.size).toBe(0);
    const ordinary = await second.ingest(inbound("ordinary message"));
    expect(ordinary.classification).toBe("message");
    expect(observed).toHaveLength(1);
  });

  it("fails closed when protected-interaction restart state is malformed", () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "friday-protected-malformed-"));
    tempDirs.push(stateDirectory);
    const statePath = join(stateDirectory, "protected.json");
    writeFileSync(statePath, "{broken", { mode: 0o600 });
    expect(() => new ChannelHub({ credentialVault: new FakeVault(), protectedStatePath: statePath })).toThrow(/could not be loaded safely/);
  });

  it("rejects stale approval and prompt replies after restart", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "friday-protected-restart-"));
    tempDirs.push(stateDirectory);
    const statePath = join(stateDirectory, "protected.json");
    const first = new ChannelHub({ credentialVault: new FakeVault(), protectedStatePath: statePath });
    const transport: ChannelTransport = { channel: "telegram", accountId: "default", start: async () => undefined, stop: async () => undefined, status: () => ({ channel: "telegram", accountId: "default", state: "running" }), send: async (target) => ({ channel: "telegram", accountId: "default", conversationId: target.conversationId, messageIds: ["1"] }) };
    first.registerTransport(transport);
    const approval = first.requestApproval({ principal: principal(), actionId: "test.action", effect: "external-write", resource: "x", reason: "test" });
    const promptPrincipal = principal({ senderId: "user-2", threadId: "topic-2" });
    const prompt = first.requestPrompt({ principal: promptPrincipal, message: "Protected value" });
    void prompt.catch(() => undefined);
    await Promise.resolve();
    const code = first.pendingApprovals()[0]!.code;
    const second = new ChannelHub({ credentialVault: new FakeVault(), protectedStatePath: statePath });
    const observed: ChannelInboundMessage[] = [];
    second.subscribe((message) => { observed.push(message); });
    expect((await second.ingest(inbound(`approve ${code}`))).classification).toBe("approval-error");
    expect((await second.ingest(inbound("stale prompt reply", promptPrincipal))).classification).toBe("prompt-error");
    expect(observed).toHaveLength(0);
    expect((await second.ingest(inbound("ordinary after stale prompt", promptPrincipal))).classification).toBe("message");
    expect(observed).toHaveLength(1);
    first.cancelApproval(first.pendingApprovals()[0]!.id);
    first.cancelPrompt(first.pendingPrompts()[0]!.id);
    await approval;
    await expect(prompt).rejects.toThrow(/cancelled/);
  });

  it("lets a live cancellation code outrank a stale prompt tombstone after restart", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "friday-protected-cancel-priority-"));
    tempDirs.push(stateDirectory);
    const statePath = join(stateDirectory, "protected.json");
    const transport: ChannelTransport = { channel: "telegram", accountId: "default", start: async () => undefined, stop: async () => undefined, status: () => ({ channel: "telegram", accountId: "default", state: "running" }), send: async (target) => ({ channel: "telegram", accountId: "default", conversationId: target.conversationId, messageIds: ["1"] }) };
    const first = new ChannelHub({ credentialVault: new FakeVault(), protectedStatePath: statePath });
    first.registerTransport(transport);
    const prompt = first.requestPrompt({ principal: principal(), message: "Protected value" });
    void prompt.catch(() => undefined);
    await Promise.resolve();
    await first.stopAll();
    await expect(prompt).rejects.toThrow(/stopped/);

    const second = new ChannelHub({ credentialVault: new FakeVault(), protectedStatePath: statePath });
    second.registerTransport(transport);
    const cancellation = await second.watchCancellation({ principal: principal(), label: "restarted job" });
    expect((await second.ingest(inbound(`cancel ${cancellation.request.code}`))).classification).toBe("cancellation-requested");
    expect(cancellation.signal.aborted).toBe(true);
    expect((await second.ingest(inbound("stale prompt value"))).classification).toBe("prompt-error");
  });
});

describe("channel hub", () => {
  it("propagates durable admission failures so transports can withhold acknowledgement", async () => {
    const hub = new ChannelHub({ credentialVault: new FakeVault() });
    hub.subscribeAdmission(() => { throw new Error("durable ingress unavailable"); });
    let observed = false;
    hub.subscribe(() => { observed = true; });

    await expect(hub.ingest(inbound("hello"))).rejects.toThrow("durable ingress unavailable");
    expect(observed).toBe(false);
  });

  it("isolates subscriber failures and never passes unsanitized text to another subscriber", async () => {
    const errors: string[] = [];
    const hub = new ChannelHub({ credentialVault: new FakeVault(), onError: (message) => errors.push(message) });
    hub.subscribe(() => { throw new Error("subscriber leaked? no"); });
    let seen = "";
    hub.subscribe((message) => { seen = message.text; });
    await hub.ingest(inbound("password=hunter2-secret"));
    expect(seen).toBe("password=[REDACTED]");
    expect(errors).toEqual(["A channel subscriber failed while handling a sanitized inbound message"]);
  });

  it("sanitizes outbound text before it reaches a trusted transport", async () => {
    let sent = "";
    const transport: ChannelTransport = {
      channel: "test",
      accountId: "a",
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ channel: "test", accountId: "a", state: "running" }),
      send: async (target, text) => {
        sent = text;
        return { channel: "test", accountId: "a", conversationId: target.conversationId, messageIds: ["1"] };
      },
    };
    const hub = new ChannelHub({ credentialVault: new FakeVault() });
    hub.registerTransport(transport);
    await hub.send({ channel: "test", accountId: "a", conversationId: "c" }, "Bearer outbound-secret-123");
    expect(sent).toBe("Bearer [REDACTED]");
  });

  it("registers transports once and reports bounded status snapshots", () => {
    const hub = new ChannelHub({ credentialVault: new FakeVault() });
    const transport: ChannelTransport = {
      channel: "test",
      accountId: "a",
      start: async () => undefined,
      stop: async () => undefined,
      status: (): ChannelTransportStatus => ({ channel: "test", accountId: "a", state: "stopped" }),
      send: async (target: ChannelTarget) => ({ channel: "test", accountId: "a", conversationId: target.conversationId, messageIds: [] }),
    };
    hub.registerTransport(transport);
    expect(() => hub.registerTransport(transport)).toThrow("already registered");
    expect(hub.list()).toEqual([{
      channel: "test",
      accountId: "a",
      state: "stopped",
      health: "down",
      retryCount: 0,
      inboundFailures: 0,
      outboundFailures: 0,
      authFailures: 0,
      networkFailures: 0,
      backlog: 0,
    }]);
    expect(hub.status()).toMatchObject({ health: "degraded", configured: 1, up: 0, degraded: 0, down: 1, backlog: 0 });
  });

  it("reports inbound retries, auth/network failures, activity timestamps, and protected backlog", async () => {
    let handler: Parameters<ChannelTransport["start"]>[0] | undefined;
    let admissionAttempts = 0;
    let sendAttempts = 0;
    const transport: ChannelTransport = {
      channel: "test",
      accountId: "a",
      async start(next) { handler = next; },
      async stop() {},
      status: () => ({ channel: "test", accountId: "a", state: "running" }),
      async send(target) {
        sendAttempts += 1;
        if (sendAttempts === 1) throw Object.assign(new Error("request unauthorized"), { status: 401 });
        return { channel: "test", accountId: "a", conversationId: target.conversationId, messageIds: ["sent"] };
      },
    };
    let now = Date.parse("2026-08-24T00:00:00.000Z");
    const hub = new ChannelHub({ credentialVault: new FakeVault(), now: () => now });
    hub.registerTransport(transport);
    hub.subscribeAdmission(async () => {
      admissionAttempts += 1;
      if (admissionAttempts === 1) throw new Error("network timeout");
    });
    await hub.startAll();
    const raw = inbound("hello", { channel: "test", accountId: "a", conversationId: "c", senderId: "u" });
    await expect(handler!(raw)).rejects.toThrow("network timeout");
    expect(hub.status()).toMatchObject({ health: "degraded", up: 0, degraded: 1, backlog: 1 });
    now += 1_000;
    await expect(handler!(raw)).resolves.toMatchObject({ classification: "message" });
    expect(hub.status()).toMatchObject({ health: "healthy", up: 1, degraded: 0, retryCount: 1, backlog: 0 });
    await expect(hub.send({ channel: "test", accountId: "a", conversationId: "c" }, "hello")).rejects.toThrow("unauthorized");
    expect(hub.status()).toMatchObject({ health: "degraded", up: 0, degraded: 1 });
    now += 1_000;
    await expect(hub.send({ channel: "test", accountId: "a", conversationId: "c" }, "hello")).resolves.toMatchObject({ messageIds: ["sent"] });

    expect(hub.status()).toMatchObject({
      health: "healthy",
      configured: 1,
      up: 1,
      retryCount: 1,
      inboundFailures: 1,
      outboundFailures: 1,
      authFailures: 1,
      networkFailures: 1,
      backlog: 0,
      lastInboundAt: "2026-08-24T00:00:01.000Z",
      lastFailureAt: "2026-08-24T00:00:01.000Z",
      lastOutboundAt: "2026-08-24T00:00:02.000Z",
    });
  });
});

describe("access policy and chunking", () => {
  it("defaults network channels to deny and allows exact sender or group conversation", () => {
    const p = principal();
    expect(channelPrincipalAllowed(p, "dm", {})).toBe(false);
    expect(channelPrincipalAllowed(p, "dm", { allowedSenderIds: ["user-1"] })).toBe(true);
    expect(channelPrincipalAllowed(p, "group", { allowedConversationIds: ["chat-1"] })).toBe(true);
    expect(channelPrincipalAllowed(p, "dm", { allowedConversationIds: ["chat-1"] })).toBe(false);
    expect(channelPrincipalAllowed(p, "dm", { allowAll: true })).toBe(true);
  });

  it("splits long outbound messages without dropping content", () => {
    const source = `${"a".repeat(100)} ${"b".repeat(100)} ${"c".repeat(100)}`;
    const chunks = splitChannelMessage(source, 128);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(source.replace(/\s+/g, " "));
  });
});

describe("Telegram transport", () => {
  it("uses an opaque Vault ref, default-denies unknown senders, and normalizes allowed messages", async () => {
    const responses = [
      { ok: true, result: { id: 99, username: "friday_bot" } },
      { ok: true, result: [{ update_id: 1, message: { message_id: 7, date: 2, chat: { id: 10, type: "private" }, from: { id: 11, first_name: "Ada" }, text: "hello" } }] },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => responses.shift() ?? { ok: true, result: [] },
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const secretValues: string[] = [];
    const transport = new TelegramChannelTransport({
      credentialRef: "vault://channels/telegram/default/bot-token",
      allowedSenderIds: ["11"],
      pollTimeoutSeconds: 1,
    }, {
      consume: async (ref, consumer) => {
        expect(ref).toBe("vault://channels/telegram/default/bot-token");
        const secret = Buffer.from("telegram-token");
        secretValues.push(secret.toString());
        try { await consumer(secret); } finally { secret.fill(0); }
      },
    });
    const seen: string[] = [];
    await transport.start((message) => { seen.push(message.text); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await transport.stop();
    expect(seen).toContain("hello");
    // An immediately-empty long-poll response must yield instead of creating
    // an unbounded promise/microtask spin that starves timers and shutdown.
    expect(fetchMock.mock.calls.length).toBeLessThan(10);
    expect(secretValues.length).toBeGreaterThan(0);
    expect(JSON.stringify(transport.status())).not.toContain("telegram-token");
  });
});


async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback port");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function fakeWhatsAppBridge(directory: string): void {
  mkdirSync(join(directory, "node_modules", "@whiskeysockets", "baileys"), { recursive: true });
  writeFileSync(join(directory, "node_modules", "@whiskeysockets", "baileys", "package.json"), "{}\n");
  writeFileSync(join(directory, "bridge.mjs"), `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const secret = process.env.FRIDAY_WHATSAPP_BRIDGE_SECRET ?? "";
let polls = 0;
let sends = 0;
const sent = [];
const pending = [
  { messageId: "blocked", chatId: "15550001@s.whatsapp.net", senderId: "15559999@s.whatsapp.net", body: "blocked" },
  { messageId: "allowed", chatId: "15550001@s.whatsapp.net", senderId: "15551234:9@s.whatsapp.net", senderName: "Ada", body: "caption whatsapp", attachments: [{ id: "wa-media", mimeType: "image/png", size: 10 }], timestamp: 123 },
  { messageId: "allowed-media-only", chatId: "15550001@s.whatsapp.net", senderId: "15551234:9@s.whatsapp.net", attachments: [{ id: "wa-media-only", mimeType: "image/png", size: 10 }], timestamp: 124 },
];

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  if (request.headers.authorization !== \`Bearer \${secret}\`) {
    json(response, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/messages") {
    polls += 1;
    writeFileSync(join(process.cwd(), "poll-count.txt"), String(polls));
    json(response, 200, pending.slice());
    return;
  }
  if (request.method === "POST" && url.pathname === "/messages/ack") {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const accepted = new Set(Array.isArray(body.messageIds) ? body.messageIds.map(String) : []);
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (accepted.has(String(pending[index]?.messageId ?? ""))) pending.splice(index, 1);
      }
      json(response, 200, { ok: true });
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/send") {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      sends += 1;
      const body = JSON.parse(raw || "{}");
      sent.push(body);
      writeFileSync(join(process.cwd(), "sent.json"), JSON.stringify(sent));
      json(response, 200, { messageId: \`sent-\${sends}\` });
    });
    return;
  }
  json(response, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
`);
}

describe("WhatsApp transport", () => {
  it("authenticates its loopback bridge, default-denies unknown senders, normalizes ingress, sends, and shuts down", async () => {
    const bridgeDir = mkdtempSync(join(tmpdir(), "friday-whatsapp-fake-"));
    tempDirs.push(bridgeDir);
    const sessionDir = mkdtempSync(join(tmpdir(), "friday-whatsapp-session-"));
    tempDirs.push(sessionDir);
    fakeWhatsAppBridge(bridgeDir);
    const port = await reserveLoopbackPort();
    const transport = new WhatsAppChannelTransport({
      bridgeDir,
      bridgePort: port,
      sessionDir,
      allowedSenderIds: ["15551234@s.whatsapp.net"],
    });
    const seen: ChannelInboundMessage[] = [];

    await transport.start((message) => { seen.push(message as ChannelInboundMessage); });
    try {
      const deadline = Date.now() + 2_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(seen).toHaveLength(2);
      expect(seen.find((item) => item.id === "allowed")?.text).toBe("caption whatsapp\n[attachment received; WhatsApp media retrieval is not enabled]");
      expect(seen.find((item) => item.id === "allowed-media-only")?.text).toBe("[attachment received; WhatsApp media retrieval is not enabled]");
      expect(seen.every((item) => item.attachments.length === 0)).toBe(true);
      expect(seen[0]?.principal.senderId).toBe("15551234@s.whatsapp.net");
      expect(seen[0]?.principal.conversationId).toBe("15550001@s.whatsapp.net");
      expect(seen[0]?.senderName).toBe("Ada");

      const sendResult = await transport.send(
        { channel: "whatsapp", accountId: "default", conversationId: "15550001@s.whatsapp.net" },
        `${"x".repeat(4090)} ${"y".repeat(32)}`,
      );
      expect(sendResult.messageIds).toEqual(["sent-1", "sent-2"]);
      const sent = JSON.parse(readFileSync(join(bridgeDir, "sent.json"), "utf8")) as Array<{ chatId?: string; message?: string }>;
      expect(sent).toHaveLength(2);
      expect(sent.every((item) => item.chatId === "15550001@s.whatsapp.net")).toBe(true);
      expect(sent.map((item) => item.message ?? "").join(" ").replace(/\s+/g, " ").trim()).toBe(`${"x".repeat(4090)} ${"y".repeat(32)}`);

      await new Promise((resolve) => setTimeout(resolve, 80));
      const polls = Number(readFileSync(join(bridgeDir, "poll-count.txt"), "utf8"));
      expect(polls).toBeLessThan(12);
    } finally {
      await transport.stop();
    }
    expect(transport.status()).toEqual({ channel: "whatsapp", accountId: "default", state: "stopped" });
  }, 10_000);
});

class TestSocket {
  readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  readonly sent: string[] = [];
  closed = false;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: string): void { this.sent.push(data); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }
  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function secretConsumer(values: Readonly<Record<string, string>>) {
  return {
    async consume(ref: string, consumer: (secret: Uint8Array) => void | Promise<void>): Promise<void> {
      const value = values[ref];
      if (value === undefined) throw new Error(`missing test secret ${ref}`);
      const buffer = Buffer.from(value);
      try { await consumer(buffer); } finally { buffer.fill(0); }
    },
  };
}

describe("native protected-action payloads", () => {
  it("emits opaque callback payloads for Telegram, Discord, and Slack", async () => {
    const action = { requestId: "123e4567-e89b-12d3-a456-426614174000", approveLabel: "Approve", denyLabel: "Deny" };
    const telegramFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", telegramFetch);
    const telegram = new TelegramChannelTransport({ credentialRef: "vault://telegram/token" }, secretConsumer({ "vault://telegram/token": "telegram-token" }));
    await telegram.sendProtectedAction({ channel: "telegram", accountId: "default", conversationId: "chat-1" }, "approval", action);
    expect(JSON.parse(String(telegramFetch.mock.calls[0]?.[1]?.body))).toMatchObject({ reply_markup: { inline_keyboard: [[{ callback_data: `friday:${action.requestId}:approve` }, { callback_data: `friday:${action.requestId}:deny` }]] } });

    const discordFetch = vi.fn(async () => new Response(JSON.stringify({ id: "d1" }), { status: 200, headers: { "content-type": "application/json" } }));
    const discord = new DiscordChannelTransport({ credentialRef: "vault://discord/token", apiBaseUrl: "https://discord.test" }, secretConsumer({ "vault://discord/token": "discord-token" }), { fetch: discordFetch as typeof fetch, websocketFactory: () => { throw new Error("not used"); } });
    await discord.sendProtectedAction({ channel: "discord", accountId: "default", conversationId: "channel-1" }, "approval", action);
    expect(JSON.parse(String(discordFetch.mock.calls[0]?.[1]?.body))).toMatchObject({ components: [{ components: [{ custom_id: `friday:${action.requestId}:approve` }, { custom_id: `friday:${action.requestId}:deny` }] }] });

    const slackFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, ts: "s1" }), { status: 200, headers: { "content-type": "application/json" } }));
    const slack = new SlackChannelTransport({ botTokenRef: "vault://slack/bot", appTokenRef: "vault://slack/app" }, secretConsumer({ "vault://slack/bot": "slack-bot", "vault://slack/app": "slack-app" }), { fetch: slackFetch as typeof fetch, websocketFactory: () => { throw new Error("not used"); } });
    await slack.sendProtectedAction({ channel: "slack", accountId: "default", conversationId: "D123", threadId: "thread-1" }, "approval", action);
    const slackBody = JSON.parse(String(slackFetch.mock.calls[0]?.[1]?.body)) as { blocks?: Array<{ elements?: Array<{ action_id?: string }> }>; thread_ts?: string };
    expect(slackBody.thread_ts).toBe("thread-1");
    expect(slackBody.blocks?.[1]?.elements?.map((element) => element.action_id)).toEqual([`friday:${action.requestId}:approve`, `friday:${action.requestId}:deny`]);
  });

  it("turns an authenticated Telegram callback into a protected action before acknowledging it", async () => {
    const requestId = "123e4567-e89b-12d3-a456-426614174000";
    let delivered = false;
    let polls = 0;
    const telegramFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = String(input).split("/").at(-1);
      if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 99, username: "friday_bot" } }), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "getUpdates") {
        polls += 1;
        const result = polls === 1 ? [{
          update_id: 1,
          callback_query: {
            id: "callback-1",
            from: { id: 7, first_name: "Ada" },
            data: `friday:${requestId}:approve`,
            message: { message_id: 10, date: 1, chat: { id: 42, type: "private" } },
          },
        }] : [];
        return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "answerCallbackQuery") {
        expect(JSON.parse(String(init?.body))).toMatchObject({ callback_query_id: "callback-1", text: "Approved" });
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected Telegram method ${method}`);
    });
    vi.stubGlobal("fetch", telegramFetch);
    const transport = new TelegramChannelTransport({ credentialRef: "vault://telegram/callback", allowedSenderIds: ["7"] }, secretConsumer({ "vault://telegram/callback": "telegram-token" }));
    await transport.start(async (message) => {
      expect(message.principal).toMatchObject({ conversationId: "42", senderId: "7" });
      expect(message.protectedAction).toEqual({ requestId, decision: "approve" });
      delivered = true;
      return { ...message, attachments: [], classification: "approval-resolved", redactionCount: 0 };
    });
    const deadline = Date.now() + 1_000;
    while (!delivered && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(delivered).toBe(true);
    expect(telegramFetch.mock.calls.some(([input]) => String(input).endsWith("/answerCallbackQuery"))).toBe(true);
    await transport.stop();
  });
});

describe("Discord transport", () => {
  it("uses a Vault token, accepts an allowed Gateway message, sends via REST, and shuts down", async () => {
    const sockets: TestSocket[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/channels/channel-1/messages")) {
        expect(init?.headers).toMatchObject({ authorization: "Bot discord-token" });
        return new Response(JSON.stringify({ id: "discord-out-1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/interactions/interaction-1/interaction-token/callback")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ type: 4, data: { content: "Approved." } });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected Discord fetch ${url}`);
    });
    const transport = new DiscordChannelTransport({
      credentialRef: "vault://channels/discord/default/bot-token",
      allowedSenderIds: ["user-1"],
    }, secretConsumer({ "vault://channels/discord/default/bot-token": "discord-token" }), {
      fetch: fetchMock as typeof fetch,
      websocketFactory: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 5000 } }) }));
        const originalSend = socket.send.bind(socket);
        socket.send = (data: string) => {
          originalSend(data);
          const payload = JSON.parse(data) as { op?: number };
          if (payload.op === 2) {
            queueMicrotask(() => {
              socket.emit("message", { data: JSON.stringify({ op: 0, t: "READY", s: 1, d: { user: { id: "bot-1" } } }) });
              socket.emit("message", { data: JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "discord-blocked", channel_id: "channel-1", content: "blocked discord", author: { id: "user-2", username: "mallory" } } }) });
              socket.emit("message", { data: JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { id: "discord-in-1", channel_id: "channel-1", content: "hello discord", author: { id: "user-1", username: "ada" } } }) });
              socket.emit("message", { data: JSON.stringify({ op: 0, t: "INTERACTION_CREATE", s: 4, d: { id: "interaction-1", token: "interaction-token", type: 3, channel_id: "channel-1", user: { id: "user-1" }, data: { custom_id: "friday:123e4567-e89b-12d3-a456-426614174000:approve" } } }) });
            });
          }
        };
        return socket as never;
      },
    });
    const seen: ChannelInboundMessage[] = [];
    let protectedAction: unknown;
    await transport.start((message) => {
      if (message.protectedAction) {
        protectedAction = message.protectedAction;
        return { ...message, attachments: [], classification: "approval-resolved", redactionCount: 0 };
      }
      seen.push(message as ChannelInboundMessage);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.map((item) => item.text)).toEqual(["hello discord"]);
    expect(protectedAction).toEqual({ requestId: "123e4567-e89b-12d3-a456-426614174000", decision: "approve" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/interactions/interaction-1/interaction-token/callback"))).toBe(true);
    const identifyFrame = sockets[0]?.sent.find((frame) => {
      try { return (JSON.parse(frame) as { op?: number }).op === 2; } catch { return false; }
    });
    expect(identifyFrame).toBeDefined();
    expect(JSON.parse(identifyFrame ?? "{}"))
      .toMatchObject({ op: 2, d: { token: "discord-token" } });
    expect(JSON.stringify(transport.status())).not.toContain("discord-token");
    const sent = await transport.send({ channel: "discord", accountId: "default", conversationId: "channel-1" }, "hello back");
    expect(sent.messageIds).toEqual(["discord-out-1"]);
    await transport.stop();
    expect(transport.status().state).toBe("stopped");
  });

  it("serializes durable admission and resumes from the last admitted Gateway sequence", async () => {
    const order: string[] = [];
    let firstSocket: TestSocket | undefined;
    const first = new DiscordChannelTransport({
      accountId: "resume-test",
      credentialRef: "vault://discord/resume",
      allowedSenderIds: ["user-1"],
    }, secretConsumer({ "vault://discord/resume": "discord-token" }), {
      fetch: vi.fn() as never,
      websocketFactory: () => {
        firstSocket = new TestSocket();
        queueMicrotask(() => firstSocket?.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 5_000 } }) }));
        const originalSend = firstSocket.send.bind(firstSocket);
        firstSocket.send = (data: string) => {
          originalSend(data);
          if ((JSON.parse(data) as { op?: number }).op !== 2) return;
          queueMicrotask(() => {
            firstSocket?.emit("message", { data: JSON.stringify({ op: 0, t: "READY", s: 1, d: { user: { id: "bot-1" }, session_id: "session-1", resume_gateway_url: "wss://gateway-us-east1-a.discord.gg" } }) });
            firstSocket?.emit("message", { data: JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "first", channel_id: "channel-1", content: "first", author: { id: "user-1" } } }) });
            firstSocket?.emit("message", { data: JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { id: "second", channel_id: "channel-1", content: "second", author: { id: "user-1" } } }) });
          });
        };
        return firstSocket as never;
      },
    });
    await first.start(async (message) => {
      order.push(`start:${message.id}`);
      if (message.id === "first") await new Promise((resolve) => setTimeout(resolve, 25));
      order.push(`end:${message.id}`);
    });
    const admittedDeadline = Date.now() + 1_000;
    while (order.length < 4 && Date.now() < admittedDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    expect(JSON.parse(readFileSync(accountStatePath("discord", "resume-test", "session.json"), "utf8"))).toMatchObject({ sessionId: "session-1", sequence: 3, botUserId: "bot-1" });
    await first.stop();

    let resumeUrl = "";
    let resumeFrame: unknown;
    let secondSocket: TestSocket | undefined;
    const second = new DiscordChannelTransport({
      accountId: "resume-test",
      credentialRef: "vault://discord/resume",
      allowedSenderIds: ["user-1"],
    }, secretConsumer({ "vault://discord/resume": "discord-token" }), {
      fetch: vi.fn() as never,
      websocketFactory: (url) => {
        resumeUrl = url;
        secondSocket = new TestSocket();
        queueMicrotask(() => secondSocket?.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 5_000 } }) }));
        const originalSend = secondSocket.send.bind(secondSocket);
        secondSocket.send = (data: string) => {
          originalSend(data);
          const frame = JSON.parse(data) as { op?: number };
          if (frame.op !== 6) return;
          resumeFrame = frame;
          queueMicrotask(() => secondSocket?.emit("message", { data: JSON.stringify({ op: 0, t: "RESUMED", s: 4, d: {} }) }));
        };
        return secondSocket as never;
      },
    });
    await second.start(() => undefined);
    expect(resumeUrl).toBe("wss://gateway-us-east1-a.discord.gg/?v=10&encoding=json");
    expect(resumeFrame).toMatchObject({ op: 6, d: { session_id: "session-1", seq: 3, token: "discord-token" } });
    await second.stop();
  });
});

describe("Slack transport", () => {
  it("connects with Socket Mode, acknowledges envelopes, normalizes allowed events, and sends", async () => {
    let socket: TestSocket | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth.test")) return new Response(JSON.stringify({ ok: true, user_id: "B123" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/apps.connections.open")) {
        expect(init?.headers).toMatchObject({ authorization: "Bearer xapp-test" });
        return new Response(JSON.stringify({ ok: true, url: "wss://slack.test/socket" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "200.1" }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected Slack fetch ${url}`);
    });
    const transport = new SlackChannelTransport({
      botTokenRef: "vault://channels/slack/default/bot-token",
      appTokenRef: "vault://channels/slack/default/app-token",
      allowedSenderIds: ["U123"],
    }, secretConsumer({
      "vault://channels/slack/default/bot-token": "xoxb-test",
      "vault://channels/slack/default/app-token": "xapp-test",
    }), {
      fetch: fetchMock as typeof fetch,
      websocketFactory: () => {
        socket = new TestSocket();
        queueMicrotask(() => {
          socket?.emit("open", {});
          socket?.emit("message", { data: JSON.stringify({ envelope_id: "env-blocked", type: "events_api", payload: { event: { type: "message", user: "U999", channel: "C123", channel_type: "channel", text: "blocked slack", ts: "99.1" } } }) });
          socket?.emit("message", { data: JSON.stringify({ envelope_id: "env-1", type: "events_api", payload: { event: { type: "message", user: "U123", channel: "C123", channel_type: "channel", text: "hello slack", ts: "100.1" } } }) });
          socket?.emit("message", { data: JSON.stringify({ envelope_id: "env-file", type: "events_api", payload: { event: { type: "message", subtype: "file_share", user: "U123", channel: "D123", channel_type: "im", text: "caption slack", files: [{ id: "F1" }], ts: "101.1" } } }) });
          socket?.emit("message", { data: JSON.stringify({ envelope_id: "env-action", type: "interactive", payload: { type: "block_actions", user: { id: "U123" }, channel: { id: "D123" }, message: { ts: "200.1", thread_ts: "199.1" }, actions: [{ action_id: "friday:123e4567-e89b-12d3-a456-426614174000:deny" }] } }) });
        });
        return socket as never;
      },
    });
    const seen: ChannelInboundMessage[] = [];
    let protectedAction: unknown;
    await transport.start((message) => {
      if (message.protectedAction) {
        protectedAction = { action: message.protectedAction, principal: message.principal, chatType: message.chatType };
        return { ...message, attachments: [], classification: "approval-resolved", redactionCount: 0 };
      }
      seen.push(message as ChannelInboundMessage);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.map((item) => item.text)).toEqual(["hello slack", "caption slack\n[attachment received; Slack media retrieval is not enabled]"]);
    expect(seen.every((item) => item.attachments.length === 0)).toBe(true);
    expect(socket?.sent).toContain(JSON.stringify({ envelope_id: "env-blocked" }));
    expect(socket?.sent).toContain(JSON.stringify({ envelope_id: "env-1" }));
    expect(socket?.sent).toContain(JSON.stringify({ envelope_id: "env-file" }));
    expect(socket?.sent).toContain(JSON.stringify({ envelope_id: "env-action" }));
    expect(protectedAction).toEqual({
      action: { requestId: "123e4567-e89b-12d3-a456-426614174000", decision: "deny" },
      principal: { channel: "slack", accountId: "default", conversationId: "D123", senderId: "U123", threadId: "199.1" },
      chatType: "thread",
    });
    const result = await transport.send({ channel: "slack", accountId: "default", conversationId: "C123" }, "reply");
    expect(result.messageIds).toEqual(["200.1"]);
    await transport.stop();
  });
});

describe("Signal transport", () => {
  it("streams signal-cli SSE notifications and sends JSON-RPC replies through loopback only", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/check")) return new Response("{}", { status: 200 });
      if (url.endsWith("/api/v1/events")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { account: "+15550000", envelope: { sourceNumber: "+15551234", sourceName: "Ada", timestamp: 123, dataMessage: { timestamp: 123, message: "caption signal", attachments: [{ id: "sig-media", contentType: "image/png", size: 10 }] } } } })}\n\n`));
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { account: "+15550000", envelope: { sourceNumber: "+15551234", timestamp: 124, dataMessage: { timestamp: 124, message: "", attachments: [{ id: "sig-media-only", contentType: "image/png", size: 10 }] } } } })}\n\n`));
            init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.endsWith("/api/v1/rpc")) return new Response(JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 456 }, id: "x" }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected Signal fetch ${url}`);
    });
    const transport = new SignalChannelTransport({ account: "+15550000", allowedSenderIds: ["+15551234"] }, { fetch: fetchMock as typeof fetch });
    const seen: ChannelInboundMessage[] = [];
    await transport.start((message) => { seen.push(message as ChannelInboundMessage); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.map((item) => item.text)).toContain("caption signal\n[attachment received; Signal media retrieval is not enabled]");
    expect(seen.map((item) => item.text)).toContain("[attachment received; Signal media retrieval is not enabled]");
    expect(seen.every((item) => item.attachments.length === 0)).toBe(true);
    const result = await transport.send({ channel: "signal", accountId: "default", conversationId: "+15551234" }, "reply");
    expect(result.messageIds).toEqual(["456"]);
    await transport.stop();
  });
});

describe("Email transport", () => {
  it("polls IMAP through the short-lived bridge abstraction and sends SMTP replies without plaintext config", async () => {
    let polls = 0;
    const bridge = vi.fn(async (request: Record<string, unknown>) => {
      expect(request.password).toBe("mail-secret");
      if (request.command === "status") return { ok: true, maxUid: 10, uidValidity: "1" };
      if (request.command === "poll") {
        polls += 1;
        return polls === 1
          ? { ok: true, maxUid: 12, uidValidity: "1", messages: [{ uid: 11, messageId: "<m1@example>", threadId: "<m1@example>", fromAddress: "ada@example.com", fromName: "Ada", subject: "Hi", text: "caption email", attachments: [{ externalId: "mail-media", fileName: "x.png", sizeBytes: 10 }] }, { uid: 12, messageId: "<m2@example>", threadId: "<m2@example>", fromAddress: "ada@example.com", subject: "Media", text: "", attachments: [{ externalId: "mail-media-only", fileName: "x.png", sizeBytes: 10 }] }] }
          : { ok: true, maxUid: 11, uidValidity: "1", messages: [] };
      }
      if (request.command === "send") return { ok: true, messageId: "smtp-1" };
      return { ok: false };
    });
    const transport = new EmailChannelTransport({
      address: "friday@example.com",
      passwordRef: "vault://channels/email/default/password",
      imapHost: "imap.example.com",
      smtpHost: "smtp.example.com",
      pollIntervalMs: 100,
      allowedSenderIds: ["ada@example.com"],
    }, secretConsumer({ "vault://channels/email/default/password": "mail-secret" }), { runBridge: bridge as never });
    const seen: ChannelInboundMessage[] = [];
    await transport.start((message) => { seen.push(message as ChannelInboundMessage); });
    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(seen.map((item) => item.text)).toContain("caption email\n[attachment received; email media retrieval is not enabled]");
    expect(seen.map((item) => item.text)).toContain("[attachment received; email media retrieval is not enabled]");
    expect(seen.every((item) => item.attachments.length === 0)).toBe(true);
    const result = await transport.send({ channel: "email", accountId: "default", conversationId: "ada@example.com", threadId: "<m1@example>" }, "reply");
    expect(result.messageIds).toEqual(["smtp-1"]);
    await transport.stop();
  });

  it("resumes a same-mailbox UID checkpoint across transport instances", async () => {
    const polls: number[] = [];
    const bridge = vi.fn(async (request: Record<string, unknown>) => {
      if (request.command === "status") return { ok: true, maxUid: 10, uidValidity: "9" };
      if (request.command === "poll") { polls.push(Number(request.afterUid)); return { ok: true, maxUid: 11, uidValidity: "9", messages: [] }; }
      return { ok: true, messageId: "sent" };
    });
    const config = { address: "resume@example.com", passwordRef: "vault://mail/resume", imapHost: "imap.resume.example", smtpHost: "smtp.resume.example", pollIntervalMs: 100, allowedSenderIds: ["ada@example.com"] } as const;
    const first = new EmailChannelTransport(config, secretConsumer({ "vault://mail/resume": "secret" }), { runBridge: bridge as never });
    await first.start(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await first.stop();
    const second = new EmailChannelTransport(config, secretConsumer({ "vault://mail/resume": "secret" }), { runBridge: bridge as never });
    await second.start(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await second.stop();
    expect(polls.some((value) => value >= 11)).toBe(true);
  });

  it("rewinds safely when IMAP UIDVALIDITY changes while polling", async () => {
    const afterUids: number[] = [];
    let polls = 0;
    const bridge = vi.fn(async (request: Record<string, unknown>) => {
      if (request.command === "status") return { ok: true, maxUid: 8, uidValidity: "1" };
      if (request.command === "poll") {
        afterUids.push(Number(request.afterUid));
        polls += 1;
        return { ok: true, maxUid: 2, uidValidity: "2", messages: [] };
      }
      return { ok: true, messageId: "sent" };
    });
    const transport = new EmailChannelTransport({
      accountId: "uid-change",
      address: "uid-change@example.com",
      passwordRef: "vault://mail/uid-change",
      imapHost: "imap.example.com",
      smtpHost: "smtp.example.com",
      pollIntervalMs: 100,
      allowedSenderIds: ["ada@example.com"],
    }, secretConsumer({ "vault://mail/uid-change": "secret" }), { runBridge: bridge as never });
    await transport.start(() => undefined);
    const deadline = Date.now() + 1_000;
    while (polls < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    await transport.stop();
    expect(afterUids.slice(0, 2)).toEqual([8, 0]);
  });

  it("ignores and replaces a malformed optional IMAP checkpoint", async () => {
    const checkpoint = accountStatePath("email", "corrupt", "uid.v2.json");
    mkdirSync(join(testHome, "channels", "email"), { recursive: true, mode: 0o700 });
    writeFileSync(checkpoint, "{broken", { mode: 0o600 });
    const bridge = vi.fn(async (request: Record<string, unknown>) => request.command === "status"
      ? { ok: true, maxUid: 3, uidValidity: "7" }
      : { ok: true, maxUid: 3, uidValidity: "7", messages: [] });
    const transport = new EmailChannelTransport({
      accountId: "corrupt",
      address: "corrupt@example.com",
      passwordRef: "vault://mail/corrupt",
      imapHost: "imap.example.com",
      smtpHost: "smtp.example.com",
      pollIntervalMs: 100,
      allowedSenderIds: ["ada@example.com"],
    }, secretConsumer({ "vault://mail/corrupt": "secret" }), { runBridge: bridge as never });
    await transport.start(() => undefined);
    await transport.stop();
    expect(JSON.parse(readFileSync(checkpoint, "utf8"))).toMatchObject({ uidValidity: "7", lastUid: 3 });
  });
});

function signedJwt(privateKey: KeyObject, kid: string, payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign(privateKey).toString("base64url")}`;
}

describe("Teams transport", () => {
  it("verifies Bot Framework JWTs, default-gates principals, and replies through the trusted serviceUrl", async () => {
    const port = await reserveLoopbackPort();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://teams.test/openid") return new Response(JSON.stringify({ issuer: "https://api.botframework.com", jwks_uri: "https://teams.test/jwks" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://teams.test/jwks") return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "kid-1", alg: "RS256", use: "sig" }] }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://teams.test/token") return new Response(JSON.stringify({ access_token: "teams-access" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/v3/conversations/conv-1/activities")) return new Response(JSON.stringify({ id: "teams-out-1" }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected Teams fetch ${url}`);
    });
    const transport = new TeamsChannelTransport({
      clientId: "client-1",
      clientSecretRef: "vault://channels/teams/default/client-secret",
      tenantId: "tenant-1",
      listenPort: port,
      openIdMetadataUrl: "https://teams.test/openid",
      tokenUrl: "https://teams.test/token",
      allowedSenderIds: ["aad-user-1"],
    }, secretConsumer({ "vault://channels/teams/default/client-secret": "teams-secret" }), { fetch: fetchMock as typeof fetch });
    const seen: ChannelInboundMessage[] = [];
    await transport.start((message) => { seen.push(message as ChannelInboundMessage); });
    const now = Math.floor(Date.now() / 1000);
    const serviceUrl = "https://smba.trafficmanager.net/teams";
    const unsignedServiceUrlJwt = signedJwt(privateKey, "kid-1", { iss: "https://api.botframework.com", aud: "client-1", exp: now + 300, nbf: now - 5 });
    const rejected = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${unsignedServiceUrlJwt}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", id: "teams-rejected", serviceUrl, text: "must reject", conversation: { id: "conv-1", conversationType: "personal" }, from: { id: "teams-user", aadObjectId: "aad-user-1" }, channelData: { tenant: { id: "tenant-1" } } }),
    });
    expect(rejected.status).toBe(401);
    const jwt = signedJwt(privateKey, "kid-1", { iss: "https://api.botframework.com", aud: "client-1", exp: now + 300, nbf: now - 5, serviceUrl });
    const response = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", id: "teams-in-1", serviceUrl, timestamp: new Date().toISOString(), text: "hello teams", attachments: [{ contentType: "image/png", name: "image.png" }], conversation: { id: "conv-1", conversationType: "personal" }, from: { id: "teams-user", aadObjectId: "aad-user-1", name: "Ada" }, recipient: { id: "bot" }, channelData: { tenant: { id: "tenant-1" } } }),
    });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.map((item) => item.text)).toContain("hello teams\n[attachment received; Teams media retrieval is not enabled]");
    expect(seen.every((item) => item.attachments.length === 0)).toBe(true);
    const result = await transport.send({ channel: "teams", accountId: "default", conversationId: "conv-1" }, "reply");
    expect(result.messageIds).toEqual(["teams-out-1"]);
    const action = { requestId: "123e4567-e89b-12d3-a456-426614174000" };
    await transport.sendProtectedAction({ channel: "teams", accountId: "default", conversationId: "conv-1" }, "approval", action);
    const adaptiveCardCall = fetchMock.mock.calls.find(([, init]) => String(init?.body).includes("AdaptiveCard"));
    expect(JSON.parse(String(adaptiveCardCall?.[1]?.body))).toMatchObject({
      attachments: [{ content: { actions: [
        { data: { action: `friday:${action.requestId}:approve` } },
        { data: { action: `friday:${action.requestId}:deny` } },
      ] } }],
    });
    const callback = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", id: "teams-action-1", serviceUrl, value: { action: `friday:${action.requestId}:deny`, requestId: action.requestId }, conversation: { id: "conv-1", conversationType: "personal" }, from: { id: "teams-user", aadObjectId: "aad-user-1", name: "Ada" }, recipient: { id: "bot" }, channelData: { tenant: { id: "tenant-1" } } }),
    });
    expect(callback.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.find((item) => item.id === "teams-action-1")).toMatchObject({
      principal: { conversationId: "conv-1", senderId: "aad-user-1" },
      protectedAction: { requestId: action.requestId, decision: "deny" },
    });
    await transport.stop();
    const restartPort = await reserveLoopbackPort();
    const restarted = new TeamsChannelTransport({
      clientId: "client-1",
      clientSecretRef: "vault://channels/teams/default/client-secret",
      tenantId: "tenant-1",
      listenPort: restartPort,
      openIdMetadataUrl: "https://teams.test/openid",
      tokenUrl: "https://teams.test/token",
      allowedSenderIds: ["aad-user-1"],
    }, secretConsumer({ "vault://channels/teams/default/client-secret": "teams-secret" }), { fetch: fetchMock as typeof fetch });
    await restarted.start(() => undefined);
    await expect(restarted.send({ channel: "teams", accountId: "default", conversationId: "conv-1" }, "after restart")).resolves.toMatchObject({ messageIds: ["teams-out-1"] });
    await restarted.stop();

    const mismatchedPort = await reserveLoopbackPort();
    const mismatched = new TeamsChannelTransport({
      clientId: "client-1",
      clientSecretRef: "vault://channels/teams/default/client-secret",
      tenantId: "tenant-2",
      listenPort: mismatchedPort,
      openIdMetadataUrl: "https://teams.test/openid",
      tokenUrl: "https://teams.test/token",
      allowedSenderIds: ["aad-user-1"],
    }, secretConsumer({ "vault://channels/teams/default/client-secret": "teams-secret" }), { fetch: fetchMock as typeof fetch });
    await mismatched.start(() => undefined);
    await expect(mismatched.send({ channel: "teams", accountId: "default", conversationId: "conv-1" }, "must not reuse route")).rejects.toThrow(/no trusted serviceUrl/);
    await mismatched.stop();
  });
});

describe("Google Chat transport", () => {
  it("verifies Google bearer metadata, normalizes Chat messages, and sends with service-account app auth", async () => {
    const port = await reserveLoopbackPort();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const serviceAccount = JSON.stringify({ client_email: "friday-chat@example.iam.gserviceaccount.com", private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), token_uri: "https://google.test/token" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://google.test/tokeninfo")) {
        const inboundToken = new URL(url).searchParams.get("id_token");
        return new Response(JSON.stringify({ aud: "https://friday.example/google-chat/events", iss: "https://accounts.google.com", email: inboundToken === "wrong-google" ? "other@example.iam.gserviceaccount.com" : "chat@system.gserviceaccount.com", email_verified: "true", exp: Math.floor(Date.now() / 1000) + 300 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://google.test/token") return new Response(JSON.stringify({ access_token: "google-access" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/spaces/AAA/messages")) return new Response(JSON.stringify({ name: "spaces/AAA/messages/out-1" }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected Google Chat fetch ${url}`);
    });
    const transport = new GoogleChatChannelTransport({
      serviceAccountRef: "vault://channels/google-chat/default/service-account",
      audience: "https://friday.example/google-chat/events",
      listenPort: port,
      tokenInfoUrl: "https://google.test/tokeninfo",
      chatApiBaseUrl: "https://google.test/v1",
      allowedSenderIds: ["users/123"],
    }, secretConsumer({ "vault://channels/google-chat/default/service-account": serviceAccount }), { fetch: fetchMock as typeof fetch });
    const seen: ChannelInboundMessage[] = [];
    await transport.start((message) => { seen.push(message as ChannelInboundMessage); });
    const rejected = await fetch(`http://127.0.0.1:${port}/google-chat/events`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-google", "content-type": "application/json" },
      body: JSON.stringify({ type: "MESSAGE", message: { name: "spaces/AAA/messages/rejected", text: "must reject", sender: { name: "users/123", type: "HUMAN" }, space: { name: "spaces/AAA", type: "DM" } } }),
    });
    expect(rejected.status).toBe(401);
    const response = await fetch(`http://127.0.0.1:${port}/google-chat/events`, {
      method: "POST",
      headers: { authorization: "Bearer google-inbound", "content-type": "application/json" },
      body: JSON.stringify({ type: "MESSAGE", message: { name: "spaces/AAA/messages/in-1", text: "hello chat", attachment: [{ name: "spaces/AAA/messages/in-1/attachments/A1", contentType: "image/png" }], sender: { name: "users/123", displayName: "Ada", type: "HUMAN" }, space: { name: "spaces/AAA", type: "DM" }, thread: { name: "spaces/AAA/threads/T1" } } }),
    });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.map((item) => item.text)).toContain("hello chat\n[attachment received; Google Chat media retrieval is not enabled]");
    expect(seen.every((item) => item.attachments.length === 0)).toBe(true);
    const action = { requestId: "123e4567-e89b-12d3-a456-426614174000" };
    await transport.sendProtectedAction({ channel: "google-chat", accountId: "default", conversationId: "spaces/AAA", threadId: "spaces/AAA/threads/T1" }, "approval", action);
    const cardCall = fetchMock.mock.calls.find(([, init]) => String(init?.body).includes("cardsV2"));
    const cardBody = JSON.parse(String(cardCall?.[1]?.body)) as {
      cardsV2?: Array<{
        card?: {
          sections?: Array<{
            widgets?: Array<{
              buttonList?: {
                buttons?: Array<{
                  onClick?: {
                    action?: {
                      function?: string;
                      parameters?: Array<{ key?: string; value?: string }>;
                    };
                  };
                }>;
              };
            }>;
          }>;
        };
      }>;
      thread?: { name?: string };
    };
    const cardButtons = cardBody.cardsV2?.[0]?.card?.sections?.[0]?.widgets?.[0]?.buttonList?.buttons;
    expect(cardButtons?.map((button) => button.onClick?.action?.function)).toEqual(["fridayProtectedAction", "fridayProtectedAction"]);
    expect(cardButtons?.[0]?.onClick?.action?.parameters).toEqual([{ key: "requestId", value: action.requestId }, { key: "decision", value: "approve" }]);
    expect(cardBody.thread?.name).toBe("spaces/AAA/threads/T1");
    const callback = await fetch(`http://127.0.0.1:${port}/google-chat/events`, {
      method: "POST",
      headers: { authorization: "Bearer google-inbound", "content-type": "application/json" },
      body: JSON.stringify({
        type: "CARD_CLICKED",
        message: { name: "spaces/AAA/messages/out-1", sender: { name: "users/bot", type: "BOT" }, space: { name: "spaces/AAA", type: "DM" } },
        user: { name: "users/123", displayName: "Ada", type: "HUMAN" },
        space: { name: "spaces/AAA", type: "DM" },
        thread: { name: "spaces/AAA/threads/T1" },
        common: { invokedFunction: "fridayProtectedAction", parameters: { requestId: action.requestId, decision: "approve" } },
      }),
    });
    expect(callback.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.find((item) => item.protectedAction)).toMatchObject({
      principal: { conversationId: "spaces/AAA", senderId: "users/123", threadId: "spaces/AAA/threads/T1" },
      protectedAction: { requestId: action.requestId, decision: "approve" },
    });
    const result = await transport.send({ channel: "google-chat", accountId: "default", conversationId: "spaces/AAA", threadId: "spaces/AAA/threads/T1" }, "reply");
    expect(result.messageIds).toEqual(["spaces/AAA/messages/out-1"]);
    await transport.stop();
  });
});

function testTwilioSignature(url: string, params: URLSearchParams, secret: string): string {
  const pairs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  let source = url;
  for (const [key, value] of pairs) source += key + value;
  return createHmac("sha1", secret).update(source).digest("base64");
}

describe("SMS transport", () => {
  it("verifies Twilio webhook signatures, default-gates senders, and sends through the REST API", async () => {
    const port = await reserveLoopbackPort();
    const publicUrl = "https://friday.example/sms";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/Messages.json")) {
        expect(init?.headers).toMatchObject({ authorization: expect.stringContaining("Basic ") });
        return new Response(JSON.stringify({ sid: "SM-out-1" }), { status: 201, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected SMS fetch ${url}`);
    });
    const transport = new SmsChannelTransport({
      accountSid: `AC${"1".repeat(32)}`,
      authTokenRef: "vault://channels/sms/default/auth-token",
      fromNumber: "+15550000",
      publicWebhookUrl: publicUrl,
      listenPort: port,
      allowedSenderIds: ["+15551234"],
    }, secretConsumer({ "vault://channels/sms/default/auth-token": "twilio-secret" }), { fetch: fetchMock as typeof fetch });
    const seen: ChannelInboundMessage[] = [];
    await transport.start((message) => { seen.push(message as ChannelInboundMessage); });
    const params = new URLSearchParams({ MessageSid: "SM-in-1", From: "+15551234", To: "+15550000", Body: "hello sms", NumMedia: "0" });
    const rejected = await fetch(`http://127.0.0.1:${port}/sms`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "invalid" },
      body: params,
    });
    expect(rejected.status).toBe(403);
    const response = await fetch(`http://127.0.0.1:${port}/sms`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": testTwilioSignature(publicUrl, params, "twilio-secret") },
      body: params,
    });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.map((item) => item.text)).toContain("hello sms");
    const mediaParams = new URLSearchParams({ MessageSid: "SM-in-2", From: "+15551234", To: "+15550000", Body: "caption", NumMedia: "1", MediaUrl0: "https://media.example/file" });
    const mediaResponse = await fetch(`http://127.0.0.1:${port}/sms`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": testTwilioSignature(publicUrl, mediaParams, "twilio-secret") }, body: mediaParams });
    expect(mediaResponse.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.at(-1)?.text).toContain("SMS media retrieval is not enabled");
    expect(seen.at(-1)?.attachments).toEqual([]);
    const mediaOnlyParams = new URLSearchParams({ MessageSid: "SM-in-3", From: "+15551234", To: "+15550000", Body: "", NumMedia: "1", MediaUrl0: "https://media.example/file-only" });
    const mediaOnlyResponse = await fetch(`http://127.0.0.1:${port}/sms`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": testTwilioSignature(publicUrl, mediaOnlyParams, "twilio-secret") }, body: mediaOnlyParams });
    expect(mediaOnlyResponse.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.at(-1)?.text).toBe("[attachment received; SMS media retrieval is not enabled]");
    expect(seen.at(-1)?.attachments).toEqual([]);
    const result = await transport.send({ channel: "sms", accountId: "default", conversationId: "+15551234" }, "reply");
    expect(result.messageIds).toEqual(["SM-out-1"]);
    await transport.stop();
  });
});
