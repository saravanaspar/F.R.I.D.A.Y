import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SelfImprovementMissionStateError,
  SelfImprovementMissionStore,
  getSelfImprovementMissionStatePath,
} from "../plugins/self-improvement/mission-state.js";

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "friday-self-improvement-state-"));
  try {
    const stateDir = join(root, "self-improvement");
    await run(stateDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("self-improvement mission state", () => {
  it("persists a deterministic generation mission and reopens it", async () => {
    await withTempState(async (stateDir) => {
      const store = new SelfImprovementMissionStore(stateDir);
      store.put({
        id: "cand-1",
        objective: "improve FRIDAY",
        repository: "/repo",
        worktreeRoot: "/worktrees",
        provider: "test",
        model: "model",
        permissionMode: "auto",
        gates: [{ id: "tests", command: "npm test" }],
        status: "restarting",
        candidateId: "cand-1",
        fromGenerationId: "gen-000001",
        targetGenerationId: "gen-000002",
        targetCommit: "abc123",
        targetExecutable: { path: "/private/.friday/.updates/binaries/gen-000002/friday", sha256: "a".repeat(64) },
        previousExecutable: { path: "/usr/local/bin/friday", sha256: "b".repeat(64) },
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
        lastError: undefined,
      });
      expect(new SelfImprovementMissionStore(stateDir).findByGeneration("gen-000002")).toMatchObject({
        id: "cand-1",
        targetExecutable: { path: "/private/.friday/.updates/binaries/gen-000002/friday", sha256: "a".repeat(64) },
        previousExecutable: { path: "/usr/local/bin/friday", sha256: "b".repeat(64) },
      });
    });
  });

  it("persists the exact channel continuation and durable attachment references across restart", async () => {
    await withTempState(async (stateDir) => {
      const store = new SelfImprovementMissionStore(stateDir);
      store.put({
        id: "cand-continuation",
        objective: "add skill ZIP intake",
        repository: "/repo",
        worktreeRoot: "/worktrees",
        provider: "test",
        model: "model",
        permissionMode: "ask",
        gates: [{ id: "tests", command: "npm test" }],
        status: "restarting",
        candidateId: "cand-continuation",
        fromGenerationId: "gen-000001",
        targetGenerationId: "gen-000002",
        targetCommit: "abc123",
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
        lastError: undefined,
        continuation: {
          id: "resume:turn-1",
          principal: { authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat-1", senderId: "user-1", threadId: "topic-2" },
          text: "install the skill I attached",
          timestamp: 1_755_600_000_000,
          attachments: [{ kind: "document", externalId: "telegram-file-1", fileName: "skill.zip", sizeBytes: 123, artifactRef: "artifact:11111111-1111-4111-8111-111111111111" }],
        },
      });
      const reopened = new SelfImprovementMissionStore(stateDir).findByGeneration("gen-000002");
      expect(reopened?.continuation).toMatchObject({
        text: "install the skill I attached",
        principal: { channel: "telegram", conversationId: "chat-1", threadId: "topic-2" },
        attachments: [{ artifactRef: "artifact:11111111-1111-4111-8111-111111111111" }],
      });
    });
  });

  it("fails closed when the mission-state directory permissions become broad", async () => {
    await withTempState(async (stateDir) => {
      const store = new SelfImprovementMissionStore(stateDir);
      store.put({
        id: "cand-private", objective: "x", repository: "/repo", worktreeRoot: "/worktrees", provider: "test", model: "model", permissionMode: "ask",
        gates: [{ command: "npm test" }], status: "restarting", candidateId: "cand-private", fromGenerationId: undefined, targetGenerationId: "gen-000002", targetCommit: "abc",
        createdAt: "2026-08-19T00:00:00.000Z", updatedAt: "2026-08-19T00:00:00.000Z", lastError: undefined,
      });
      await chmod(stateDir, 0o755);
      expect(() => new SelfImprovementMissionStore(stateDir)).toThrow(/mission directory permissions are too broad/);
    });
  });

  it("fails closed on corrupt or gate-less restart state", async () => {
    await withTempState(async (stateDir) => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await chmod(stateDir, 0o700);
      await writeFile(getSelfImprovementMissionStatePath(stateDir), "{ broken", { mode: 0o600 });
      await chmod(getSelfImprovementMissionStatePath(stateDir), 0o600);
      expect(() => new SelfImprovementMissionStore(stateDir)).toThrow(SelfImprovementMissionStateError);

      await writeFile(
        getSelfImprovementMissionStatePath(stateDir),
        JSON.stringify({
          schema: 1,
          missions: {
            bad: {
              id: "bad",
              objective: "x",
              repository: "/repo",
              worktreeRoot: "/worktrees",
              provider: "test",
              model: "model",
              permissionMode: "ask",
              gates: [],
              status: "restarting",
              candidateId: "bad",
              targetGenerationId: "gen-000002",
              targetCommit: "abc",
              createdAt: "now",
              updatedAt: "now",
            },
          },
        }),
        { mode: 0o600 },
      );
      expect(() => new SelfImprovementMissionStore(stateDir)).toThrow(/at least one deterministic gate/);
    });
  });
});
