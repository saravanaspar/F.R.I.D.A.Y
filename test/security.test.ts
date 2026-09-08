import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "../plugins/permissions/contract.js";
import { createPermissionsController, createPermissionsService } from "../plugins/permissions/policy.js";
import { createKernSandboxProvider, createKernSandboxService } from "../plugins/sandbox/providers/kern/index.js";

const tempPaths: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("permissions policy", () => {
  it("implements ask, auto, and full exactly at the workspace boundary", async () => {
    const workspace = await tempDir("friday-permissions-");
    await mkdir(join(workspace, "src"));
    const approvals: PermissionRequest[] = [];
    const controller = createPermissionsController({
      approve: async (request) => {
        approvals.push(request);
        return true;
      },
    });
    const permissions = controller.permissions;

    await controller.trusted.runAsLocal(() => permissions.authorize({
      mode: "ask",
      workspace,
      access: "read",
      path: join(workspace, "src"),
      action: { id: "test.workspace.read", effect: "workspace-read", resource: workspace, network: false },
      reason: "inspect source",
    }));
    expect(approvals).toHaveLength(0);

    await controller.trusted.runAsLocal(() => permissions.authorize({
      mode: "ask",
      workspace,
      access: "write",
      path: join(workspace, "src", "file.ts"),
      action: { id: "test.workspace.write", effect: "workspace-write", resource: workspace, network: false },
      reason: "edit source",
    }));
    expect(approvals).toHaveLength(1);

    await controller.trusted.runAsLocal(() => permissions.authorize({
      mode: "auto",
      workspace,
      access: "write",
      path: join(workspace, "src", "file.ts"),
      action: { id: "test.workspace.write", effect: "workspace-write", resource: workspace, network: false },
      reason: "edit source",
    }));
    expect(approvals).toHaveLength(1);

    await controller.trusted.runAsLocal(() => permissions.authorize({
      mode: "auto",
      workspace,
      access: "write",
      action: { id: "test.workspace.rewrite", effect: "workspace-write", resource: workspace, network: false },
      reason: "rewrite generated tree",
    }));
    expect(approvals).toHaveLength(1);

    await controller.trusted.runAsLocal(() => permissions.authorize({
      mode: "auto",
      workspace,
      access: "write",
      action: { id: "test.network.install", effect: "workspace-write", resource: workspace, network: true },
      reason: "npm install",
    }));
    expect(approvals).toHaveLength(2);

    await controller.trusted.runAsLocal(() => permissions.authorize({
      mode: "full",
      workspace,
      access: "write",
      action: { id: "test.network.full", effect: "workspace-write", resource: workspace, network: true },
      reason: "npm install and rewrite workspace",
    }));
    expect(approvals).toHaveLength(3);
    expect(approvals.at(-1)?.action.id).toBe("test.network.full");

    await expect(
      controller.trusted.runAsLocal(() => permissions.authorize({
        mode: "full",
        workspace,
        access: "write",
        path: join(workspace, "..", "outside.txt"),
        action: { id: "test.workspace.escape", effect: "workspace-write", resource: workspace, network: false },
        reason: "escape workspace",
      })),
    ).rejects.toThrow(/outside workspace/);
  });

  it("defaults to ask and rejects unknown modes", () => {
    const permissions = createPermissionsService({ approve: async () => true });
    expect(permissions.normalizeMode()).toBe("ask");
    expect(permissions.normalizeMode("AUTO")).toBe("auto");
    expect(() => permissions.normalizeMode("unsafe")).toThrow(/Expected ask, auto, or full/);
  });
});

describe("kern sandbox provider", () => {
  function commandResult(stdout = "", status = 0) {
    return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status, signal: null } as never;
  }

  const kernBoxHelp = "--image --security-profile --require-limits --memory --cpus --pids-limit --tmpfs --shm-size --net --egress-allow --label -v -w -e -i\n";
  const kernPsHelp = "-q --filter\n";
  const kernStopHelp = "stop <name>...\n";
  const kernBuildHelp = "-t -f\n";

  it("builds a rootless untrusted, network-off kern command for read operations", async () => {
    const workspace = await tempDir("friday-kern-");
    const cwd = join(workspace, "src");
    await mkdir(cwd);
    const sandbox = createKernSandboxService({
      probe: () => ({ available: true, status: "ready" }),
      networkMode: "requested",
    });
    const context = sandbox.sandboxShell({
      command: "git status --short",
      cwd,
      workspace,
      access: "read",
      network: false,
      env: { PATH: "/usr/bin", SECRET: "host-only" },
    });

    expect(sandbox.provider?.id).toBe("kern");
    expect(context.command).toContain("'box'");
    expect(context.command).toContain("'--security-profile' 'untrusted'");
    expect(context.command).toContain("'--require-limits'");
    expect(context.command).toContain("'--memory' '2g'");
    expect(context.command).toContain("'--pids-limit' '1024'");
    expect(context.command).toContain("'--tmpfs' '/tmp/.friday-sandbox:64m'");
    expect(context.command).not.toContain("'--tmpfs' '/tmp:64m'");
    expect(context.command).toContain("'HOME=/tmp/.friday-sandbox'");
    expect(context.command).toContain("'TMPDIR=/tmp/.friday-sandbox'");
    expect(context.command).toContain(`'${workspace}:${workspace}:ro'`);
    expect(context.command).toContain(`'-w' '${cwd}'`);
    expect(context.command).toContain("'FRIDAY_SANDBOX_PROVIDER=kern'");
    expect(context.command).toContain("'/bin/bash' '-c'");
    expect(context.command).not.toContain("'/bin/bash' '-lc'");
    expect(context.command).toContain("'git status --short'");
    expect(context.command).not.toContain("'--net' 'host'");
    expect(context.command).not.toContain("'--egress-allow'");
    expect(context.command).not.toContain("SECRET=host-only");
    expect(context.env.SECRET).toBeUndefined();
  });

  it("uses kern's isolated egress allowlist for explicitly requested networking", async () => {
    const workspace = await tempDir("friday-kern-network-");
    const sandbox = createKernSandboxService({
      probe: () => ({ available: true, status: "ready" }),
      egressAllow: ["registry.npmjs.org", "files.pythonhosted.org"],
    });
    const blocked = sandbox.sandboxShell({ command: "true", cwd: workspace, workspace, access: "write", network: false, env: {} });
    const allowed = sandbox.sandboxShell({ command: "npm install", cwd: workspace, workspace, access: "write", network: true, env: {} });
    expect(sandbox.networkMode).toBe("requested");
    expect(sandbox.egressAllow).toEqual(["registry.npmjs.org", "files.pythonhosted.org"]);
    expect(blocked.command).not.toContain("'--net' 'host'");
    expect(blocked.command).not.toContain("'--egress-allow'");
    expect(allowed.command).toContain("'--egress-allow' 'registry.npmjs.org,files.pythonhosted.org'");
    expect(allowed.command).not.toContain("'--net' 'host'");
    expect(allowed.command).toContain(`'${workspace}:${workspace}:rw'`);
  });

  it("fails closed instead of widening requested networking to the host namespace", async () => {
    const workspace = await tempDir("friday-kern-network-closed-");
    const sandbox = createKernSandboxService({
      probe: () => ({ available: true, status: "ready" }),
      egressAllow: [],
    });
    expect(() => sandbox.sandboxShell({
      command: "npm install",
      cwd: workspace,
      workspace,
      access: "write",
      network: true,
      env: {},
    })).toThrow(/FRIDAY_SANDBOX_EGRESS_ALLOW/);
  });

  it("shares the host network only under the explicit unrestricted override", async () => {
    const workspace = await tempDir("friday-kern-network-unrestricted-");
    const sandbox = createKernSandboxService({
      probe: () => ({ available: true, status: "ready" }),
      networkMode: "unrestricted",
    });
    const context = sandbox.sandboxShell({ command: "true", cwd: workspace, workspace, access: "read", network: false, env: {} });
    expect(context.command).toContain("'--net' 'host'");
    expect(context.command).not.toContain("'--egress-allow'");
  });

  it("rejects malformed egress allowlist entries before a sandbox can launch", () => {
    expect(() => createKernSandboxService({
      probe: () => ({ available: true, status: "ready" }),
      egressAllow: ["registry.npmjs.org,evil.example"],
    })).toThrow(/egress domain is invalid/);
  });

  it("runs direct processes through kern without inheriting host secrets and labels managed work", async () => {
    const workspace = await tempDir("friday-kern-process-");
    const sandbox = createKernSandboxService({ probe: () => ({ available: true, status: "ready" }) });
    const context = sandbox.sandboxProcess({
      command: "git",
      args: ["status", "--short"],
      cwd: workspace,
      workspace,
      access: "read",
      network: false,
      env: { PATH: "/usr/bin", SECRET: "host-only" },
      managed: { id: "proc-abc123", runId: "run-xyz" },
    });
    expect(context.command).toBe("kern");
    expect(context.args[0]).toBe("box");
    expect(context.args[1]).toMatch(/^friday-bg-\d+-(?:[a-f0-9]{32}|unverifiable)-proc-abc123-[a-f0-9]{8}$/);
    expect(context.args).toContain("--security-profile");
    expect(context.args).toContain("--require-limits");
    expect(context.args).toContain("--pids-limit");
    expect(context.args).toContain("-c");
    expect(context.args).not.toContain("-lc");
    expect(context.args).toContain("io.friday.managed=true");
    expect(context.args).toContain("io.friday.process=proc-abc123");
    expect(context.args).toContain("io.friday.run=run-xyz");
    expect(context.args).toContain("git");
    expect(context.args.slice(-2)).toEqual(["status", "--short"]);
    expect(context.args.join("\0")).not.toContain("host-only");
    expect(context.env.SECRET).toBeUndefined();
  });

  it("stops one managed kern process through owner-scoped labels", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const sandbox = createKernSandboxService({
      probe: () => ({ available: true, status: "ready" }),
      processIdentity: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      runtimePid: 303,
      run(command, args) {
        calls.push({ command, args: [...args] });
        if (args[0] === "ps") return commandResult("friday-bg-303-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-proc-abc123-deadbeef\n");
        if (args[0] === "stop") return commandResult();
        throw new Error(`unexpected kern command: ${command} ${args.join(" ")}`);
      },
    });
    sandbox.cleanupManagedProcess?.("proc-abc123");
    expect(calls[0]?.args).toContain("label=io.friday.process=proc-abc123");
    expect(calls[1]?.args).toEqual(["stop", "friday-bg-303-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-proc-abc123-deadbeef"]);
  });

  it("keeps a live predecessor during stale cleanup and stops only proven-stale kern boxes", () => {
    const liveIdentity = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const staleExpectedIdentity = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const staleActualIdentity = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const unreadableLiveIdentity = "cccccccccccccccccccccccccccccccc";
    const deadIdentity = "dddddddddddddddddddddddddddddddd";
    const liveName = `friday-bg-101-${liveIdentity}-proc-live-11111111`;
    const staleName = `friday-bg-202-${staleExpectedIdentity}-proc-stale-22222222`;
    const unreadableLiveName = `friday-bg-404-${unreadableLiveIdentity}-proc-unknown-33333333`;
    const deadName = `friday-bg-505-${deadIdentity}-proc-dead-44444444`;
    const unverifiableName = "friday-bg-606-unverifiable-proc-legacy-55555555";
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const identities = new Map<number, string | undefined>([
      [303, "ffffffffffffffffffffffffffffffff"],
      [101, liveIdentity],
      [202, staleActualIdentity],
      [404, undefined],
      [505, undefined],
      [606, undefined],
    ]);
    const sandbox = createKernSandboxService({
      probe: () => ({ available: true, status: "ready" }),
      runtimePid: 303,
      processIdentity: (pid) => identities.get(pid),
      processAlive: (pid) => pid === 404 ? true : pid === 505 ? false : undefined,
      run(command, args) {
        calls.push({ command, args: [...args] });
        if (args[0] === "ps") {
          return commandResult([liveName, staleName, unreadableLiveName, deadName, unverifiableName].join("\n") + "\n");
        }
        if (args[0] === "stop") return commandResult();
        throw new Error(`unexpected kern command: ${command} ${args.join(" ")}`);
      },
    });

    sandbox.cleanupStaleManagedProcesses?.();

    const stop = calls.find((call) => call.args[0] === "stop");
    expect(stop?.args).toEqual(["stop", staleName, deadName]);
    expect(stop?.args).not.toContain(liveName);
    expect(stop?.args).not.toContain(unreadableLiveName);
    expect(stop?.args).not.toContain(unverifiableName);
  });

  it("mounts only host-registered external dependency targets and revalidates them", async () => {
    const workspace = await tempDir("friday-kern-worktree-");
    const dependencies = await tempDir("friday-kern-deps-");
    const outside = await tempDir("friday-kern-outside-");
    const dependencyTarget = join(workspace, "node_modules");
    await mkdir(dependencyTarget);
    const sandbox = createKernSandboxService({ probe: () => ({ available: true, status: "ready" }) });

    const untrusted = sandbox.sandboxShell({ command: "node --version", cwd: workspace, workspace, access: "write", network: false, env: {} });
    expect(untrusted.command).not.toContain(dependencies);

    const unregister = sandbox.registerTrustedReadOnlyMount(workspace, dependencies, dependencyTarget);
    const trusted = sandbox.sandboxShell({ command: "node --version", cwd: workspace, workspace, access: "write", network: false, env: {} });
    expect(trusted.command).toContain(`'${dependencies}:${dependencyTarget}:ro'`);

    await rm(dependencyTarget, { recursive: true, force: true });
    await symlink(outside, dependencyTarget);
    expect(() => sandbox.sandboxShell({ command: "true", cwd: workspace, workspace, access: "write", network: false, env: {} })).toThrow(/target became a symlink/);
    unregister();
  });

  it("rejects trusted mounts that overlap the workspace boundary", async () => {
    const parent = await tempDir("friday-kern-overlap-");
    const workspace = join(parent, "workspace");
    const inside = join(workspace, "inside");
    await mkdir(inside, { recursive: true });
    const sandbox = createKernSandboxService({ probe: () => ({ available: true, status: "ready" }) });
    expect(() => sandbox.registerTrustedReadOnlyMount(workspace, inside)).toThrow(/source.*disjoint/);
    expect(() => sandbox.registerTrustedReadOnlyMount(workspace, parent)).toThrow(/source.*disjoint/);
  });

  it("launches IPython in a network-off kern box with its IPC directory and bounded environment", async () => {
    const workspace = await tempDir("friday-kern-kernel-workspace-");
    const kernelDir = await tempDir("friday-kern-kernel-ipc-");
    const connectionPath = join(kernelDir, "connection.json");
    await writeFile(connectionPath, "{}", { mode: 0o600 });
    const sandbox = createKernSandboxService({ probe: () => ({ available: true, status: "ready" }) });
    const context = sandbox.sandboxKernel({
      python: "/host/python",
      connectionPath,
      tempDir: kernelDir,
      cwd: workspace,
      workspace,
      env: { PATH: "/usr/bin", SECRET: "host-only", PYTHONPATH: join(workspace, "python") },
    });
    expect(context.command).toBe("kern");
    expect(context.args).toContain(`${workspace}:${workspace}:rw`);
    expect(context.args).toContain(`${kernelDir}:${kernelDir}:rw`);
    expect(context.args).toContain(`PYTHONPATH=${join(workspace, "python")}`);
    expect(context.args).not.toContain("--net");
    expect(context.args).not.toContain("--egress-allow");
    expect(context.args.join(" ")).not.toContain("SECRET=host-only");
  });

  it("re-checks a missing image so approved setup becomes usable without restart", async () => {
    const workspace = await tempDir("friday-kern-refresh-");
    let imageReady = false;
    const sandbox = createKernSandboxService({
      probe: () => imageReady
        ? ({ available: true, status: "ready" })
        : ({ available: false, status: "image-missing", reason: "image missing" }),
    });
    expect(() => sandbox.assertAvailable()).toThrow(/image missing/);
    imageReady = true;
    expect(() => sandbox.sandboxShell({ command: "true", cwd: workspace, workspace, access: "read", network: false, env: {} })).not.toThrow();
  });

  it("checks exact kern CLI flags instead of accepting prefix-only matches", () => {
    const provider = createKernSandboxProvider({
      image: "friday-sandbox:test",
      probeRun(_command, args) {
        if (args[0] === "--version") return commandResult("kern 0.7.0\n");
        if (args[0] === "doctor") return commandResult("ok\n");
        if (args[0] === "box") return commandResult(kernBoxHelp.replace("--pids-limit", "--pids-limit-extra"));
        throw new Error(`probe should have failed before: ${args.join(" ")}`);
      },
    });
    expect(provider.probe()).toMatchObject({
      available: false,
      status: "host-unready",
    });
    expect(provider.probe().reason).toMatch(/--pids-limit/);
  });

  it("checks the kern host/image before building and verifies the image afterward", async () => {
    const buildContext = await tempDir("friday-kern-build-");
    const containerfile = join(buildContext, "Containerfile");
    await writeFile(containerfile, "FROM scratch\n");
    let imageReady = false;
    const setupCalls: Array<{ command: string; args: readonly string[] }> = [];
    const provider = createKernSandboxProvider({
      image: "friday-sandbox:test",
      containerfile,
      contextDir: buildContext,
      probeRun(command, args) {
        if (args[0] === "--version") return commandResult("kern 0.7.0\n");
        if (args[0] === "doctor") return commandResult("ok\n");
        if (args[0] === "box") return commandResult(kernBoxHelp);
        if (args[0] === "ps") return commandResult(kernPsHelp);
        if (args[0] === "stop") return commandResult(kernStopHelp);
        if (args[0] === "build") return commandResult(kernBuildHelp);
        if (args[0] === "images") return commandResult(imageReady ? '[{"reference":"friday-sandbox:test"}]' : "[]");
        throw new Error(`unexpected probe: ${command} ${args.join(" ")}`);
      },
      setupRun(command, args) {
        setupCalls.push({ command, args: [...args] });
        imageReady = true;
        return commandResult();
      },
    });
    expect(provider.setup()).toEqual({ status: "prepared", providerId: "kern", image: "friday-sandbox:test" });
    expect(setupCalls).toEqual([{ command: "kern", args: ["build", "-t", "friday-sandbox:test", "-f", containerfile, buildContext] }]);
  });

  it("does not rebuild an image that kern already has", () => {
    let setupCalls = 0;
    const provider = createKernSandboxProvider({
      image: "friday-sandbox:test",
      probeRun(_command, args) {
        if (args[0] === "box") return commandResult(kernBoxHelp);
        if (args[0] === "ps") return commandResult(kernPsHelp);
        if (args[0] === "stop") return commandResult(kernStopHelp);
        if (args[0] === "build") return commandResult(kernBuildHelp);
        if (args[0] === "images") return commandResult('[{"reference":"friday-sandbox:test"}]');
        return commandResult("ok\n");
      },
      setupRun() {
        setupCalls += 1;
        return commandResult();
      },
    });
    expect(provider.setup()).toEqual({ status: "already-ready", providerId: "kern", image: "friday-sandbox:test" });
    expect(setupCalls).toBe(0);
  });

  it("fails closed when kern is unavailable", () => {
    const sandbox = createKernSandboxService({
      probe: () => ({ available: false, status: "binary-unavailable", reason: "kern is unavailable" }),
    });
    expect(() => sandbox.assertAvailable()).toThrow(/kern is unavailable/);
  });
});
