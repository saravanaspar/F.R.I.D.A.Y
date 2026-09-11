import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { provideCapability, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { CLIENT_GATEWAY_CAPABILITY } from "../plugins/clients/contract.js";
import clientsPlugin from "../plugins/clients/index.js";
import agentProfilesPlugin from "../plugins/agent-profiles/index.js";
import conversationsPlugin from "../plugins/conversations/index.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import executionPlugin from "../plugins/execution/index.js";
import worktreesPlugin from "../plugins/worktrees/index.js";
import projectsPlugin from "../plugins/projects/index.js";
import { createComputerPlugin } from "../plugins/computer/index.js";
import { COMPUTER_CAPABILITY, type ComputerNodeAdapter } from "../plugins/computer/contract.js";
import { DEVICES_CAPABILITY, type DeviceDescriptor } from "../plugins/devices/contract.js";
import devicesPlugin from "../plugins/devices/index.js";
import { EVENTS_CAPABILITY } from "../plugins/events/contract.js";
import { createEventsPlugin } from "../plugins/events/index.js";
import { TURN_LOOP_CAPABILITY, type InboundTurn } from "../plugins/turn-loop/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";
import { WebSocket } from "ws";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const originalStateDir = process.env.FRIDAY_STATE_DIR;

afterEach(async () => {
  uninstallCapabilityRegistry();
  if (originalStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = originalStateDir;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Phase 1 client gateway", () => {
  it("lets two clients observe the same session and job event history", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-client-gateway-"));
    roots.push(stateDir);
    process.env.FRIDAY_STATE_DIR = stateDir;
    const host = new PluginTestHost();
    await host.activatePlugin(capabilitiesPlugin);
    await host.activatePlugin(createEventsPlugin({ autoStartWorker: false }));
    await host.activatePlugin(devicesPlugin);
    await host.activatePlugin(clientsPlugin);
    await host.completePluginBootstrap();

    const events = requireCapability(EVENTS_CAPABILITY);
    const devices = requireCapability(DEVICES_CAPABILITY);
    const gateway = requireCapability(CLIENT_GATEWAY_CAPABILITY);
    const keys = generateKeyPairSync("ed25519");
    const descriptor: DeviceDescriptor = {
      deviceId: "desktop-1", name: "Build desktop", type: "test",
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const pairing = await devices.beginPairing(descriptor);
    await devices.approvePairing(pairing.pairingId);
    const challenge = await devices.issueChallenge(descriptor.deviceId);
    const signature = sign(null, Buffer.from(challenge.challenge), keys.privateKey).toString("base64url");
    const connection = await gateway.connect({ deviceId: descriptor.deviceId, challenge: challenge.challenge, signature });
    const peerKeys = generateKeyPairSync("ed25519");
    const peerDescriptor: DeviceDescriptor = {
      deviceId: "android-1", name: "Build phone", type: "android",
      publicKey: peerKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const peerPairing = await devices.beginPairing(peerDescriptor);
    await devices.approvePairing(peerPairing.pairingId);
    const peerChallenge = await devices.issueChallenge(peerDescriptor.deviceId);
    const peerSignature = sign(null, Buffer.from(peerChallenge.challenge), peerKeys.privateKey).toString("base64url");
    const peerConnection = await gateway.connect({ deviceId: peerDescriptor.deviceId, challenge: peerChallenge.challenge, signature: peerSignature });

    events.publish({ type: "session.message.created", source: "sessions", subject: "session:shared-session", data: { sessionId: "shared-session", messageId: "message-1" } });
    events.publish({ type: "session-job.started", source: "session-jobs", subject: "job:shared-job", data: { jobId: "shared-job", sessionId: "shared-session", status: "running" } });
    const firstView = connection.resume(0).filter((message) => message.event.subject?.includes("shared-"));
    const secondView = peerConnection.resume(0).filter((message) => message.event.subject?.includes("shared-"));
    expect(firstView.map((message) => message.event.id)).toEqual(secondView.map((message) => message.event.id));
    expect(firstView.map((message) => message.event.type)).toEqual(["session.message.created", "session-job.started"]);
    expect(gateway.connections()).toHaveLength(2);

    const lastSeenSequence = gateway.latestSequence();
    connection.close();
    expect(gateway.connections()).toHaveLength(1);
    events.publish({ type: "session-job.completed", source: "session-jobs", subject: "job:shared-job", data: { jobId: "shared-job", sessionId: "shared-session", status: "completed" } });
    const nextChallenge = await devices.issueChallenge(descriptor.deviceId);
    const nextSignature = sign(null, Buffer.from(nextChallenge.challenge), keys.privateKey).toString("base64url");
    const reconnected = await gateway.connect({ deviceId: descriptor.deviceId, challenge: nextChallenge.challenge, signature: nextSignature });
    expect(reconnected.resume(lastSeenSequence).map((message) => message.event.type)).toEqual(["session-job.completed"]);
    peerConnection.close();
    reconnected.close();
    expect(gateway.connections()).toHaveLength(0);
    await host.dispose();
  });

  it("serves health, replay, and authenticated WebSocket streaming", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-client-http-"));
    roots.push(stateDir);
    process.env.FRIDAY_STATE_DIR = stateDir;
    const host = new PluginTestHost();
    await host.activatePlugin(capabilitiesPlugin);
    await host.activatePlugin(createEventsPlugin({ autoStartWorker: false }));
    await host.activatePlugin(devicesPlugin);
    await host.activatePlugin(clientsPlugin);
    await host.completePluginBootstrap();
    const events = requireCapability(EVENTS_CAPABILITY);
    const devices = requireCapability(DEVICES_CAPABILITY);
    const gateway = requireCapability(CLIENT_GATEWAY_CAPABILITY);
    const keys = generateKeyPairSync("ed25519");
    const descriptor: DeviceDescriptor = { deviceId: "desktop-http", name: "HTTP test", type: "test", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
    const pairing = await devices.beginPairing(descriptor);
    await devices.approvePairing(pairing.pairingId);
    const status = await gateway.start({ port: 0 });
    expect(status.running).toBe(true);
    const base = `http://127.0.0.1:${status.port}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const challengeResponse = await fetch(`${base}/v1/auth/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: descriptor.deviceId }) });
    const challenge = await challengeResponse.json() as { challenge: string };
    const signature = sign(null, Buffer.from(challenge.challenge), keys.privateKey).toString("base64url");
    events.publish({ type: "http.before", source: "client-gateway", data: { ok: true } });
    const replay = await fetch(`${base}/v1/events/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: descriptor.deviceId, challenge: challenge.challenge, signature, afterSequence: 0 }) });
    expect((await replay.json() as { events: readonly unknown[] }).events).toHaveLength(1);

    const streamChallenge = await devices.issueChallenge(descriptor.deviceId);
    const streamSignature = sign(null, Buffer.from(streamChallenge.challenge), keys.privateKey).toString("base64url");
    const socket = new WebSocket(`${base.replace("http", "ws")}/v1/stream`);
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => socket.send(JSON.stringify({ kind: "client.authenticate", protocolVersion: 1, requestId: "ws-auth", deviceId: descriptor.deviceId, challenge: streamChallenge.challenge, signature: streamSignature, afterSequence: 1 })));
      socket.on("message", (data) => { messages.push(data.toString()); if (messages.some((value) => value.includes('"kind":"client.ready"'))) resolve(); });
      socket.on("error", (error) => reject(error));
    });
    const peerKeys = generateKeyPairSync("ed25519");
    const peer: DeviceDescriptor = { deviceId: "computer-node-http", name: "Computer Node", type: "computer-node", publicKey: peerKeys.publicKey.export({ type: "spki", format: "pem" }).toString() };
    const peerPairing = await devices.beginPairing(peer);
    await devices.approvePairing(peerPairing.pairingId);
    const peerChallenge = await devices.issueChallenge(peer.deviceId);
    const peerSignature = sign(null, Buffer.from(peerChallenge.challenge), peerKeys.privateKey).toString("base64url");
    const peerSocket = new WebSocket(`${base.replace("http", "ws")}/v1/stream`);
    const peerMessages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      peerSocket.on("open", () => peerSocket.send(JSON.stringify({ kind: "client.authenticate", protocolVersion: 1, requestId: "peer-auth", deviceId: peer.deviceId, challenge: peerChallenge.challenge, signature: peerSignature })));
      peerSocket.on("message", (data) => { peerMessages.push(data.toString()); if (peerMessages.some((value) => value.includes('"kind":"client.ready"'))) resolve(); });
      peerSocket.on("error", (error) => reject(error));
    });
    socket.send(JSON.stringify({ kind: "webrtc.offer", protocolVersion: 1, requestId: "offer-1", targetDeviceId: peer.deviceId, sessionId: "screen-1", payload: { type: "offer", sdp: "test-sdp" } }));
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("timed out waiting for signaling relay")), 1_000);
      const check = (): void => { if (peerMessages.some((value) => value.includes('"sourceDeviceId":"desktop-http"'))) { clearTimeout(deadline); resolve(); } else setTimeout(check, 5); };
      check();
    });
    events.publish({ type: "http.live", source: "client-gateway", data: { ok: true } });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("timed out waiting for live event")), 1_000);
      const check = (): void => { if (messages.some((value) => value.includes('"type":"http.live"'))) { clearTimeout(deadline); resolve(); } else setTimeout(check, 5); };
      check();
    });
    socket.close();
    peerSocket.close();
    await gateway.stop();
    await host.dispose();
  });

  it("exposes authenticated Phase 2 profile and conversation resources", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-client-phase2-"));
    roots.push(stateDir);
    process.env.FRIDAY_STATE_DIR = stateDir;
    const host = new PluginTestHost();
    await host.activatePlugin(capabilitiesPlugin);
    await host.activatePlugin(createEventsPlugin({ autoStartWorker: false }));
    await host.activatePlugin(devicesPlugin);
    await host.activatePlugin(agentProfilesPlugin);
    await host.activatePlugin(conversationsPlugin);
    await host.activatePlugin(clientsPlugin);
    await host.completePluginBootstrap();
    const devices = requireCapability(DEVICES_CAPABILITY);
    const gateway = requireCapability(CLIENT_GATEWAY_CAPABILITY);
    const keys = generateKeyPairSync("ed25519");
    const descriptor: DeviceDescriptor = { deviceId: "desktop-phase2", name: "Phase 2 client", type: "test", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
    const pairing = await devices.beginPairing(descriptor);
    await devices.approvePairing(pairing.pairingId);
    const status = await gateway.start({ port: 0 });
    const base = `http://127.0.0.1:${status.port}`;
    const post = async (path: string, input: Record<string, unknown>) => {
      const challenge = await devices.issueChallenge(descriptor.deviceId);
      const signature = sign(null, Buffer.from(challenge.challenge), keys.privateKey).toString("base64url");
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: descriptor.deviceId, challenge: challenge.challenge, signature, ...input }) });
      expect(response.status).toBeLessThan(400);
      return response.json() as Promise<Record<string, unknown>>;
    };
    await post("/v1/agent-profiles/create", { name: "Developer", roleInstructions: "Build tested changes." });
    await post("/v1/agent-profiles/create", { name: "Research", roleInstructions: "Verify sources." });
    const profiles = await post("/v1/agent-profiles/list", {});
    expect((profiles.profiles as readonly unknown[])).toHaveLength(2);
    const created = await post("/v1/conversations/create", { id: "ignored", type: "group", title: "Launch", sessionId: "launch-session", participants: [{ kind: "user", id: "operator" }, { kind: "agent", id: "developer" }, { kind: "agent", id: "research" }] });
    const conversationId = (created.conversation as { id: string }).id;
    const mentions = await post("/v1/conversations/mentions/resolve", { conversationId, text: "@Developer ask @Research" });
    expect(mentions.mentions).toMatchObject({ agentIds: ["developer", "research"] });
    const thread = await post("/v1/conversations/threads/create", { conversationId, rootMessageId: "message-1" });
    await post("/v1/conversations/threads/reply", { threadId: (thread.thread as { id: string }).id });
    await post("/v1/conversations/reactions/add", { messageId: "message-1", actorId: "operator", emoji: "✅" });
    const reactions = await post("/v1/conversations/reactions/list", { messageId: "message-1" });
    expect((reactions.reactions as readonly unknown[])).toHaveLength(1);
    await gateway.stop();
    await host.dispose();
  });

  it("exposes authenticated Phase 3 project resolution and isolated worktree APIs", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-client-phase3-state-"));
    const repository = await mkdtemp(join(tmpdir(), "friday-client-phase3-repo-"));
    const worktreeRoot = await mkdtemp(join(tmpdir(), "friday-client-phase3-worktrees-"));
    roots.push(stateDir, repository, worktreeRoot);
    process.env.FRIDAY_STATE_DIR = stateDir;
    await execFileAsync("git", ["init"], { cwd: repository });
    await execFileAsync("git", ["config", "user.email", "friday-test@example.com"], { cwd: repository });
    await execFileAsync("git", ["config", "user.name", "FRIDAY Test"], { cwd: repository });
    await writeFile(join(repository, "base.txt"), "base\n");
    await execFileAsync("git", ["add", "base.txt"], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: repository });

    const host = new PluginTestHost();
    await host.activatePlugin(capabilitiesPlugin);
    await host.activatePlugin(createEventsPlugin({ autoStartWorker: false }));
    await host.activatePlugin(devicesPlugin);
    await host.activatePlugin(sessionResourcesPlugin);
    await host.activatePlugin(executionPlugin);
    await host.activatePlugin(worktreesPlugin);
    await host.activatePlugin(agentProfilesPlugin);
    await host.activatePlugin(conversationsPlugin);
    await host.activatePlugin(projectsPlugin);
    const submittedTurns: InboundTurn[] = [];
    provideCapability(TURN_LOOP_CAPABILITY, {
      async submit(turn: InboundTurn) {
        submittedTurns.push(turn);
        return { status: "completed" as const, messageId: turn.id, sessionId: "phase3-session" };
      },
      status: () => ({ activeTurns: 0, queuedConversations: 0, lockedSessions: 0, completedInProcess: submittedTurns.length }),
    });
    await host.activatePlugin(clientsPlugin);
    await host.completePluginBootstrap();

    const devices = requireCapability(DEVICES_CAPABILITY);
    const gateway = requireCapability(CLIENT_GATEWAY_CAPABILITY);
    const keys = generateKeyPairSync("ed25519");
    const descriptor: DeviceDescriptor = {
      deviceId: "desktop-phase3",
      name: "Phase 3 client",
      type: "test",
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const pairing = await devices.beginPairing(descriptor);
    await devices.approvePairing(pairing.pairingId);
    const status = await gateway.start({ port: 0 });
    const base = `http://127.0.0.1:${status.port}`;
    const post = async (path: string, input: Record<string, unknown>) => {
      const challenge = await devices.issueChallenge(descriptor.deviceId);
      const signature = sign(null, Buffer.from(challenge.challenge), keys.privateKey).toString("base64url");
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: descriptor.deviceId, challenge: challenge.challenge, signature, ...input }),
      });
      expect(response.status).toBeLessThan(400);
      return response.json() as Promise<Record<string, unknown>>;
    };

    const created = await post("/v1/projects/create", {
      id: "atlas",
      name: "Atlas",
      rootPath: repository,
      repositoryKind: "git",
      validation: { test: "printf phase3-test", build: "printf phase3-build" },
      policy: {
        defaultTargetId: "sandbox",
        allowedTargetIds: ["sandbox"],
        requireWorktreeForWrites: true,
        worktreeRoot,
      },
    });
    expect(created.project).toMatchObject({ id: "atlas", rootPath: repository });

    const plan = await post("/v1/projects/resolve-target", { projectId: "atlas", operation: "edit", access: "write" });
    expect(plan.plan).toMatchObject({ projectId: "atlas", requiresWorktree: true, target: { kind: "sandbox" } });

    const developer = await post("/v1/agent-profiles/create", {
      name: "Developer",
      roleInstructions: "Implement and validate Project changes.",
      defaultProjectId: "atlas",
    });
    const developerId = (developer.profile as { id: string }).id;
    const conversation = await post("/v1/conversations/create", {
      type: "group",
      title: "Atlas",
      participants: [{ kind: "user", id: "operator" }, { kind: "agent", id: developerId }],
    });
    const conversationId = (conversation.conversation as { id: string }).id;
    const turnResponse = await post("/v1/turns", {
      conversationId,
      agentProfileId: developerId,
      text: "make the change and run validation",
    });
    expect(turnResponse.result).toMatchObject({ status: "completed", sessionId: "phase3-session" });
    expect(submittedTurns).toHaveLength(1);
    expect(submittedTurns[0]).toMatchObject({ projectId: "atlas", sessionAffinityId: expect.any(String) });

    const workspaceResponse = await post("/v1/projects/worktrees/create", { projectId: "atlas", name: "client-slice" });
    const directory = (workspaceResponse.workspace as { directory: string }).directory;
    expect(directory.startsWith(worktreeRoot)).toBe(true);
    await writeFile(join(directory, "base.txt"), "changed through client project workspace\n");

    const diff = await post("/v1/projects/worktrees/diff", { projectId: "atlas", directory });
    expect((diff.diff as { patch: string }).patch).toContain("+changed through client project workspace");
    const published = await post("/v1/projects/worktrees/publish-diff", { projectId: "atlas", directory });
    expect((published.report as { diff: { patch: string } }).diff.patch).toContain("+changed through client project workspace");
    await post("/v1/projects/worktrees/remove", { projectId: "atlas", directory, force: true, deleteBranch: true });

    await gateway.stop();
    await host.dispose();
  });

  it("exposes authenticated Phase 4 Computer status, observation, and human takeover APIs", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-client-phase4-state-"));
    roots.push(stateDir);
    process.env.FRIDAY_STATE_DIR = stateDir;
    const adapter: ComputerNodeAdapter = {
      descriptor: {
        id: "desk-1",
        label: "Desk Computer",
        platform: "test",
        capabilities: {
          executionOperations: ["shell", "edit", "process", "git"],
          browser: true,
          playwright: true,
          accessibility: true,
          cdp: true,
          visualControl: true,
          screenCapture: true,
          rawInput: true,
          virtualDisplays: true,
          managedLifecycle: false,
        },
      },
      async snapshot() {
        return {
          availability: "online",
          resources: { totalMemoryMb: 8_192, availableMemoryMb: 6_144, cpuPercent: 12, browserRendererCount: 2, screenWorkloadPercent: 10 },
          screens: [
            { id: "human-1", label: "Human", kind: "human" },
            { id: "agent-1", label: "Agent", kind: "agent" },
          ],
          browser: {
            running: true,
            profileId: "shared-profile",
            persistentProfile: true,
            windows: [{ id: "window-1", owner: "friday", screenId: "agent-1", tabIds: ["tab-1"] }],
            tabs: [{ id: "tab-1", title: "Example", url: "https://example.com/", active: true }],
          },
        };
      },
      async observeScreen(screenId) {
        return {
          observedAt: new Date().toISOString(),
          screenId,
          url: "https://example.com/account",
          domSummary: "account page; protected fields omitted",
          accessibilitySummary: "main document",
          tabs: [{ id: "tab-1", title: "Account", url: "https://example.com/account", active: true }],
          screenshotArtifactRef: "artifact:client-safe-screen",
          processes: [{ pid: 123, name: "chromium" }],
        };
      },
    };

    const host = new PluginTestHost();
    await host.activatePlugin(capabilitiesPlugin);
    await host.activatePlugin(createEventsPlugin({ autoStartWorker: false }));
    await host.activatePlugin(devicesPlugin);
    await host.activatePlugin(createComputerPlugin({ adapters: [adapter], service: { pollIntervalMs: 60_000 } }));
    await host.activatePlugin(clientsPlugin);
    await host.completePluginBootstrap();

    const devices = requireCapability(DEVICES_CAPABILITY);
    const computer = requireCapability(COMPUTER_CAPABILITY);
    const grant = await computer.requestScreen({ ownerId: "job-client-phase4", preferredNodeId: "desk-1" });
    if (grant.state !== "acquired") throw new Error("expected Computer screen grant");

    const gateway = requireCapability(CLIENT_GATEWAY_CAPABILITY);
    const keys = generateKeyPairSync("ed25519");
    const descriptor: DeviceDescriptor = {
      deviceId: "desktop-phase4",
      name: "Phase 4 client",
      type: "test",
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const pairing = await devices.beginPairing(descriptor);
    await devices.approvePairing(pairing.pairingId);
    const status = await gateway.start({ port: 0 });
    const base = `http://127.0.0.1:${status.port}`;
    const call = async (path: string, input: Record<string, unknown>) => {
      const challenge = await devices.issueChallenge(descriptor.deviceId);
      const signature = sign(null, Buffer.from(challenge.challenge), keys.privateKey).toString("base64url");
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: descriptor.deviceId, challenge: challenge.challenge, signature, ...input }),
      });
      const payload = await response.json() as Record<string, unknown>;
      return { response, payload };
    };
    const post = async (path: string, input: Record<string, unknown>) => {
      const result = await call(path, input);
      expect(result.response.status).toBeLessThan(400);
      return result.payload;
    };

    const unauthenticated = await fetch(`${base}/v1/computer/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(unauthenticated.status).toBeGreaterThanOrEqual(400);

    const computerStatus = await post("/v1/computer/status", {});
    expect(computerStatus.status).toMatchObject({ nodes: 1, online: 1, activeScreenLeases: 1, humanTakeovers: 0 });
    const nodes = await post("/v1/computer/nodes", {});
    expect(nodes.nodes).toEqual([expect.objectContaining({
      id: "desk-1",
      platform: "test",
      agentScreens: 1,
      browser: expect.objectContaining({ available: true, running: true, windows: 1, tabs: 1 }),
    })]);
    expect(JSON.stringify(nodes)).not.toContain("https://example.com/");
    const screens = await post("/v1/computer/screens", {});
    expect(screens.screens).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "desk-1", id: "agent-1", kind: "agent" })]));
    const leases = await post("/v1/computer/leases", {});
    expect(leases.leases).toEqual([expect.objectContaining({ screenLeaseId: grant.screenLease.id, control: expect.objectContaining({ holder: "agent" }) })]);

    const observed = await post("/v1/computer/observe", { screenLeaseId: grant.screenLease.id });
    expect(observed.observation).toMatchObject({ screenId: "agent-1", screenshotArtifactRef: "artifact:client-safe-screen" });

    const takeover = await post("/v1/computer/takeover", { screenLeaseId: grant.screenLease.id, handBackAfterMs: 5_000, humanOwnerId: "ignored" });
    expect(takeover.control).toMatchObject({
      holder: "human",
      holderId: "client:desktop-phase4",
      transcriptPolicy: { captureKeystrokes: false, captureSecrets: false, captureSensitiveScreenshots: false },
    });
    const blockedObservation = await call("/v1/computer/observe", { screenLeaseId: grant.screenLease.id });
    expect(blockedObservation.response.status).toBeGreaterThanOrEqual(400);

    const activity = await post("/v1/computer/human-activity", { screenLeaseId: grant.screenLease.id });
    expect(activity.control).toMatchObject({ holder: "human", holderId: "client:desktop-phase4" });
    const handedBack = await post("/v1/computer/hand-back", { screenLeaseId: grant.screenLease.id });
    expect(handedBack).toMatchObject({
      controlLease: { holder: "agent", holderId: "job-client-phase4" },
      observation: { screenId: "agent-1", screenshotArtifactRef: "artifact:client-safe-screen" },
    });

    await gateway.stop();
    await host.dispose();
  });

});
