import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_INPUT_CONTRIBUTION } from "../plugins/turn-loop/contract.js";
import artifactsPlugin from "../plugins/artifacts/index.js";
import { ARTIFACTS_CAPABILITY } from "../plugins/artifacts/contract.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { CHANNELS_TRUSTED_CAPABILITY, type ChannelsTrustedService } from "../plugins/channels/trusted-contract.js";
import { EXECUTION_CAPABILITY } from "../plugins/execution/contract.js";
import { SANDBOX_CAPABILITY } from "../plugins/sandbox/contract.js";
import type { TurnAttachment, TurnPrincipal } from "../plugins/turn-loop/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const originalHome = process.env.FRIDAY_HOME;

afterEach(async () => {
  uninstallCapabilityRegistry();
  if (originalHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function zipBytes(entries: Record<string, string>): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), "friday-artifact-zip-"));
  roots.push(root);
  const archive = join(root, "package.zip");
  const script = [
    "import json, sys, zipfile",
    "archive=sys.argv[1]",
    "entries=json.loads(sys.argv[2])",
    "with zipfile.ZipFile(archive, 'w') as z:",
    "  for name, value in entries.items(): z.writestr(name, value)",
  ].join("\n");
  await execFileAsync("python3", ["-c", script, archive, JSON.stringify(entries)]);
  return readFile(archive);
}

async function assemble(
  bytes: Buffer,
  execOverride?: (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>,
) {
  const home = await mkdtemp(join(tmpdir(), "friday-artifacts-home-"));
  roots.push(home);
  await chmod(home, 0o700);
  process.env.FRIDAY_HOME = home;

  const channels = {
    async fetchAttachment(_target: unknown, attachment: TurnAttachment) {
      return { bytes, fileName: attachment.fileName ?? "package.zip", mimeType: attachment.mimeType ?? "application/zip" };
    },
  } as unknown as ChannelsTrustedService;

  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(definePlugin({ id: "test-artifact-channels", provides: [CHANNELS_TRUSTED_CAPABILITY] }, (ctx) => {
    ctx.services.provide(CHANNELS_TRUSTED_CAPABILITY, channels);
  }), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-artifact-execution", provides: [EXECUTION_CAPABILITY] }, (ctx) => {
    ctx.services.provide(EXECUTION_CAPABILITY, {
      async execCommand(command: string, args: string[], cwd: string) {
          if (execOverride) return execOverride(command, args, cwd);
          try {
            const result = await execFileAsync(command, args, { cwd, maxBuffer: 4 * 1024 * 1024 });
            return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
          } catch (error) {
            const failure = error as { stdout?: string; stderr?: string; code?: number };
            return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(error), code: failure.code ?? 1, killed: false };
          }
        },
    } as never);
  }), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-artifact-sandbox", provides: [SANDBOX_CAPABILITY] }, (ctx) => {
    ctx.services.provide(SANDBOX_CAPABILITY, {
      image: "test",
      assertAvailable() {},
      registerTrustedReadOnlyMount: () => () => undefined,
      sandboxShell: (request: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({ command: request.command, cwd: request.cwd, env: request.env }),
      sandboxProcess: (request: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) => ({ command: request.command, args: request.args, cwd: request.cwd, env: request.env }),
      sandboxKernel: () => { throw new Error("not used"); },
    } as never);
  }), { defer: true });
  await friday.activatePlugin(artifactsPlugin, { defer: true });
  await friday.completePluginBootstrap();
  return { friday, home, service: requireCapability(ARTIFACTS_CAPABILITY) };
}

const principal: TurnPrincipal = Object.freeze({
  authority: "channel",
  channel: "telegram",
  accountId: "main",
  conversationId: "chat-1",
  senderId: "user-1",
});
const attachment: TurnAttachment = Object.freeze({ kind: "document", externalId: "file-1", fileName: "skill.zip", mimeType: "application/zip" });

describe("Artifacts", () => {
  it("persists host-generated project artifacts through the same private artifact store", async () => {
    const { service } = await assemble(Buffer.from("unused"));
    const patch = Buffer.from("diff --git a/base.txt b/base.txt\n+changed\n");
    const record = await service.storeGenerated({ fileName: "atlas-job.diff", mimeType: "text/x-diff", bytes: patch });
    expect(record.fileName).toBe("atlas-job.diff");
    expect(record.mimeType).toBe("text/x-diff");
    expect(record.sizeBytes).toBe(patch.byteLength);
    await expect(service.consume(record.ref, (bytes) => Buffer.from(bytes).toString("utf8"))).resolves.toBe(patch.toString("utf8"));
  });

  it("persists private integrity-checked attachments and rejects a broadened artifact root", async () => {
    const bytes = await zipBytes({ "skill/SKILL.md": "# Test\n" });
    const { home, service } = await assemble(bytes);
    const record = await service.ingestChannelAttachment(principal, attachment);
    expect(record.sizeBytes).toBe(bytes.byteLength);
    expect(await service.consume(record.ref, (value) => Buffer.from(value).equals(bytes))).toBe(true);
    const artifactRoot = join(home, "artifacts");
    expect((await stat(artifactRoot)).mode & 0o077).toBe(0);
    await chmod(artifactRoot, 0o755);
    await expect(service.inspect(record.ref)).rejects.toThrow("Artifact root permissions are too broad");
  });

  it("reports aggregate quota and cleanup preserves artifacts referenced by sessions", async () => {
    const bytes = await zipBytes({ "document.txt": "storage lifecycle" });
    const { home, service } = await assemble(bytes);
    const protectedRecord = await service.ingestChannelAttachment(principal, attachment);
    const disposableRecord = await service.ingestChannelAttachment(principal, { ...attachment, externalId: "file-2" });
    await service.setQuota(2 * 1024 * 1024);
    expect(await service.storage()).toMatchObject({ artifacts: 2, totalBytes: bytes.byteLength * 2, quotaBytes: 2 * 1024 * 1024 });

    const old = "2025-01-01T00:00:00.000Z";
    for (const record of [protectedRecord, disposableRecord]) {
      await writeFile(join(home, "artifacts", `${record.id}.json`), `${JSON.stringify({ ...record, createdAt: old })}\n`, { mode: 0o600 });
    }
    await mkdir(join(home, "sessions"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, "sessions", "active.jsonl"), `${JSON.stringify({ attachment: protectedRecord.ref })}\n`, { mode: 0o600 });

    const preview = await service.previewCleanup({ olderThanDays: 1 });
    expect(preview).toMatchObject({ protectedCount: 1, reclaimableBytes: disposableRecord.sizeBytes });
    const result = await service.cleanup([protectedRecord.ref, disposableRecord.ref]);
    expect(result.deleted).toEqual([disposableRecord.ref]);
    expect(result.skippedProtected).toEqual([protectedRecord.ref]);
    await expect(service.inspect(protectedRecord.ref)).resolves.toBeDefined();
    await expect(service.inspect(disposableRecord.ref)).rejects.toThrow();
  });

  it("rejects ZIP traversal before materializing a package tree", async () => {
    const bytes = await zipBytes({ "../escape.txt": "escape", "skill/SKILL.md": "# Test\n" });
    const { service } = await assemble(bytes);
    await expect(service.stagePackageSource({ principal, attachment })).rejects.toThrow("archive contains unsafe path");
  });

  it("downloads GitHub repositories through a bounded archive intake", async () => {
    const archive = await zipBytes({ "demo-main/SKILL.md": "# Demo\n" });
    const commands: Array<{ command: string; args: string[] }> = [];
    const { service } = await assemble(Buffer.alloc(0), async (command, args, cwd) => {
      commands.push({ command, args: [...args] });
      if (command === "curl") {
        await writeFile(join(cwd, "source.zip"), archive);
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      try {
        const result = await execFileAsync(command, args, { cwd, maxBuffer: 4 * 1024 * 1024 });
        return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; code?: number };
        return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(error), code: failure.code ?? 1, killed: false };
      }
    });

    const stage = await service.stagePackageSource({
      url: "https://github.com/example/demo.git",
      maxBytes: archive.byteLength,
    });
    try {
      expect(commands.some((entry) => entry.command === "git")).toBe(false);
      const curl = commands.find((entry) => entry.command === "curl")!;
      expect(curl.args).toContain("--max-filesize");
      expect(curl.args).toContain(String(archive.byteLength));
      expect(curl.args.at(-1)).toBe("https://github.com/example/demo/archive/HEAD.zip");
      await expect(readFile(join(stage.sourceDir, "SKILL.md"), "utf8")).resolves.toBe("# Demo\n");
    } finally {
      await stage.dispose();
    }
  });

  it("prepares large structured attachments under one runtime-lifetime read-only session mount", async () => {
    const large = Buffer.from(JSON.stringify({ records: Array.from({ length: 6000 }, (_, index) => ({ index, status: index % 2 ? "ok" : "error", detail: "x".repeat(12) })) }));
    const { home } = await assemble(large);
    const workspace = join(home, "workspace");
    const sessionArtifactDir = join(home, "session-artifacts", "attachment-session");
    await mkdir(workspace, { recursive: true });
    const input = collectContributions(AGENT_INPUT_CONTRIBUTION).find((entry) => entry.id === "artifacts-attachments")!;
    const baseContext = {
      cwd: workspace,
      sessionId: "attachment-session",
      sessionArtifactDir,
      deferAfterReply() {},
      deferOnFailure() {},
    };
    const runtime = await input.prepareRuntime?.(baseContext);
    expect(runtime?.mounts).toEqual([{ source: join(sessionArtifactDir, "attachments") }]);

    const prepared = await input.prepare({
      ...baseContext,
      turn: {
        id: "turn-large-json",
        principal,
        text: "Find the error distribution in this JSON.",
        attachments: [{ kind: "document", externalId: "json-1", fileName: "huge.json", mimeType: "application/json", sizeBytes: large.byteLength }],
        timestamp: Date.now(),
        reply: async () => undefined,
      },
    });
    expect(prepared?.context).toContain("Large structured/text attachment");
    expect(prepared?.context).toContain("do not dump the whole file into model context");
    expect(prepared?.context).toContain("IPython/Python");
    expect(prepared?.context).not.toContain('"records"');
    expect(prepared?.persistedContext).toContain("readOnlyPath=");
    expect(prepared?.persistedContext).not.toContain('"records"');
    expect(prepared?.mounts ?? []).toHaveLength(0);
    expect(prepared?.images ?? []).toHaveLength(0);

    const readOnlyPath = /readOnlyPath=([^\n]+)/.exec(prepared?.persistedContext ?? "")?.[1];
    expect(readOnlyPath).toBeTruthy();
    expect(readOnlyPath?.startsWith(join(sessionArtifactDir, "attachments"))).toBe(true);
    expect((await lstat(readOnlyPath!)).isFile()).toBe(true);
  });

  it("provides a bounded preview for small text and native image content for model vision", async () => {
    const text = Buffer.from('{"project":"T","status":"ready"}');
    const { home, friday: textHost } = await assemble(text);
    const input = collectContributions(AGENT_INPUT_CONTRIBUTION).find((entry) => entry.id === "artifacts-attachments")!;
    const preparedText = await input.prepare({
      cwd: home,
      sessionId: "attachment-session",
      turn: { id: "turn-small", principal, text: "read it", attachments: [{ kind: "document", externalId: "text-1", fileName: "small.json", mimeType: "application/json", sizeBytes: text.byteLength }], timestamp: Date.now(), reply: async () => undefined },
      deferAfterReply() {}, deferOnFailure() {},
    });
    expect(preparedText?.context).toContain('boundedPreview:\n{"project":"T","status":"ready"}');

    // The capability registry is process-global by design. Dispose the first
    // isolated composition before assembling another one inside the same test.
    await textHost.dispose();

    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { home: imageHome } = await assemble(image);
    const imageInput = collectContributions(AGENT_INPUT_CONTRIBUTION).find((entry) => entry.id === "artifacts-attachments")!;
    const preparedImage = await imageInput.prepare({
      cwd: imageHome,
      sessionId: "attachment-image-session",
      turn: {
        id: "turn-image",
        principal,
        text: "inspect this image",
        attachments: [{ kind: "image", externalId: "image-1", fileName: "image.png", mimeType: "image/png", sizeBytes: image.byteLength }],
        timestamp: Date.now(),
        reply: async () => undefined,
      },
      deferAfterReply() {},
      deferOnFailure() {},
    });
    expect(preparedImage?.images).toEqual([{ mimeType: "image/png", data: image.toString("base64") }]);
  });

});
