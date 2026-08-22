import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "../plugins/permissions/contract.js";
import { createPermissionsController, createPermissionsService } from "../plugins/permissions/policy.js";
import { createPodmanSandboxService, ensurePodmanSandboxImage } from "../plugins/sandbox/podman.js";

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

describe("Podman sandbox", () => {
  it("builds a rootless read-only, network-off command for read operations", async () => {
    const workspace = await tempDir("friday-podman-");
    const cwd = join(workspace, "src");
    await mkdir(cwd);
    const sandbox = createPodmanSandboxService({
      probe: () => ({ available: true }),
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

    expect(sandbox.sandboxKind).toBe("podman");
    expect(context.command).toContain("'--pull=never'");
    expect(context.command).toContain("'--userns=keep-id'");
    expect(context.command).toContain("'--read-only'");
    expect(context.command).toContain("'--cap-drop=ALL'");
    expect(context.command).toContain("'--security-opt=no-new-privileges'");
    expect(context.command).toContain("'--http-proxy=false'");
    expect(context.command).toContain("'--network=none'");
    expect(context.command).toContain(`'--volume=${workspace}:${workspace}:ro'`);
    expect(context.command).toContain(`'--workdir=${cwd}'`);
    expect(context.command).toContain(`'--env=PATH=${join(workspace, "node_modules", ".bin")}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'`);
    expect(context.command).toContain("'git status --short'");
    expect(context.command).not.toContain("SECRET=host-only");
    expect(context.env.SECRET).toBe("host-only");
  });

  it("allows an explicitly authorized writable workspace and network without auto-pulling images", async () => {
    const workspace = await tempDir("friday-podman-rw-");
    const sandbox = createPodmanSandboxService({ probe: () => ({ available: true }) });
    const context = sandbox.sandboxShell({
      command: "npm install",
      cwd: workspace,
      workspace,
      access: "write",
      network: true,
      env: {},
    });
    expect(context.command).toContain(`'--volume=${workspace}:${workspace}:rw'`);
    expect(context.command).toContain(`'--env=PATH=${join(workspace, "node_modules", ".bin")}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'`);
    expect(context.command).not.toContain("'--network=none'");
    expect(context.command).toContain("'--pull=never'");
  });

  it("blocks network by default until the operation explicitly requests it", async () => {
    const workspace = await tempDir("friday-podman-network-");
    const sandbox = createPodmanSandboxService({ probe: () => ({ available: true }) });
    const context = sandbox.sandboxShell({
      command: "node detached-task.mjs",
      cwd: workspace,
      workspace,
      access: "write",
      network: false,
      env: {},
    });

    expect(sandbox.networkMode).toBe("requested");
    expect(context.command).toContain("'--network=none'");
    expect(context.command).toContain("'--http-proxy=false'");
  });

  it("labels managed background containers so startup cleanup can target only FRIDAY-owned work", async () => {
    const workspace = await tempDir("friday-podman-managed-");
    const previousFridayHome = process.env.FRIDAY_HOME;
    process.env.FRIDAY_HOME = join(workspace, ".friday-test");
    try {
      const sandbox = createPodmanSandboxService({ probe: () => ({ available: true }) });
      const context = sandbox.sandboxProcess({
        command: "/bin/bash",
        args: ["-c", "npm run dev"],
        cwd: workspace,
        workspace,
        access: "write",
        network: false,
        env: {},
        managed: { id: "proc-abc123", runId: "run-xyz" },
      });

      expect(context.command).toBe("podman");
      expect(context.args).toContain("--name=friday-bg-proc-abc123");
      expect(context.args).toContain("--label=io.friday.managed=true");
      expect(context.args).toContain("--label=io.friday.process=proc-abc123");
      expect(context.args).toContain("--label=io.friday.run=run-xyz");
      expect(context.args.some((arg) => /^--label=io\.friday\.owner=[a-f0-9]{24}$/.test(arg))).toBe(true);
      expect(context.args.slice(-3)).toEqual(["localhost/friday-sandbox:gen0", "-c", "npm run dev"]);
    } finally {
      if (previousFridayHome === undefined) delete process.env.FRIDAY_HOME;
      else process.env.FRIDAY_HOME = previousFridayHome;
    }
  });

  it("builds direct internal processes inside the same network-off sandbox boundary", async () => {
    const workspace = await tempDir("friday-podman-process-");
    const sandbox = createPodmanSandboxService({
      probe: () => ({ available: true }),
      networkMode: "requested",
    });
    const context = sandbox.sandboxProcess({
      command: "git",
      args: ["status", "--short"],
      cwd: workspace,
      workspace,
      access: "read",
      network: false,
      env: { PATH: "/usr/bin", SECRET: "host-only" },
    });

    expect(context.command).toBe("podman");
    expect(context.args).toContain("--network=none");
    expect(context.args).toContain(`--volume=${workspace}:${workspace}:ro`);
    expect(context.args).toContain(`--env=PATH=${join(workspace, "node_modules", ".bin")}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`);
    expect(context.args).toContain("--entrypoint=git");
    expect(context.args.slice(-3)).toEqual(["localhost/friday-sandbox:gen0", "status", "--short"]);
    expect(context.args.join("\0")).not.toContain("host-only");
    expect(context.env.SECRET).toBe("host-only");
  });

  it("rejects trusted mounts that overlap the workspace boundary", async () => {
    const parent = await tempDir("friday-podman-overlap-");
    const workspace = join(parent, "workspace");
    const inside = join(workspace, "inside");
    await mkdir(inside, { recursive: true });
    const sandbox = createPodmanSandboxService({
      probe: () => ({ available: true }),
      networkMode: "requested",
    });

    expect(() => sandbox.registerTrustedReadOnlyMount(workspace, inside)).toThrow(/source.*disjoint/);
    expect(() => sandbox.registerTrustedReadOnlyMount(workspace, parent)).toThrow(/source.*disjoint/);

    const external = await tempDir("friday-podman-overlap-source-");
    expect(() => sandbox.registerTrustedReadOnlyMount(workspace, external, workspace)).toThrow(/target.*inside workspace/);
    const outsideTarget = join(external, "target");
    await mkdir(outsideTarget);
    expect(() => sandbox.registerTrustedReadOnlyMount(workspace, external, outsideTarget)).toThrow(/target.*inside workspace/);
  });

  it("mounts only host-registered external dependency targets", async () => {
    const workspace = await tempDir("friday-podman-worktree-");
    const dependencies = await tempDir("friday-podman-deps-");
    const dependencyTarget = join(workspace, "node_modules");
    await mkdir(dependencyTarget);
    const sandbox = createPodmanSandboxService({ probe: () => ({ available: true }) });

    const untrusted = sandbox.sandboxShell({
      command: "node --version",
      cwd: workspace,
      workspace,
      access: "write",
      network: false,
      env: {},
    });
    expect(untrusted.command).not.toContain(`'--volume=${dependencies}:${dependencies}:ro'`);

    const unregister = sandbox.registerTrustedReadOnlyMount(workspace, dependencies, dependencyTarget);
    const trusted = sandbox.sandboxShell({
      command: "node --version",
      cwd: workspace,
      workspace,
      access: "write",
      network: false,
      env: {},
    });
    expect(trusted.command).toContain(`'--volume=${dependencies}:${dependencyTarget}:ro'`);

    unregister();
    const revoked = sandbox.sandboxShell({
      command: "node --version",
      cwd: workspace,
      workspace,
      access: "write",
      network: false,
      env: {},
    });
    expect(revoked.command).not.toContain(`'--volume=${dependencies}:${dependencyTarget}:ro'`);
  });

  it("revalidates a mutable in-workspace mount target before every sandbox launch", async () => {
    const workspace = await tempDir("friday-podman-retarget-");
    const dependencies = await tempDir("friday-podman-retarget-deps-");
    const outside = await tempDir("friday-podman-retarget-outside-");
    const dependencyTarget = join(workspace, "node_modules");
    await mkdir(dependencyTarget);
    const sandbox = createPodmanSandboxService({ probe: () => ({ available: true }) });
    const unregister = sandbox.registerTrustedReadOnlyMount(workspace, dependencies, dependencyTarget);

    await rm(dependencyTarget, { recursive: true, force: true });
    await symlink(outside, dependencyTarget);
    expect(() => sandbox.sandboxShell({
      command: "node --version",
      cwd: workspace,
      workspace,
      access: "write",
      network: false,
      env: {},
    })).toThrow(/target became a symlink/);
    unregister();
  });

  it("scopes trusted auxiliary mounts to the exact registered workspace", async () => {
    const workspace = await tempDir("friday-podman-workspace-a-");
    const otherWorkspace = await tempDir("friday-podman-workspace-b-");
    const dependencies = await tempDir("friday-podman-shared-deps-");
    const dependencyTarget = join(workspace, "node_modules");
    const otherDependencyTarget = join(otherWorkspace, "node_modules");
    await mkdir(dependencyTarget);
    await mkdir(otherDependencyTarget);
    const sandbox = createPodmanSandboxService({ probe: () => ({ available: true }) });
    const unregister = sandbox.registerTrustedReadOnlyMount(workspace, dependencies, dependencyTarget);

    const authorized = sandbox.sandboxShell({
      command: "node --version",
      cwd: workspace,
      workspace,
      access: "write",
      network: false,
      env: {},
    });
    const unrelated = sandbox.sandboxShell({
      command: "node --version",
      cwd: otherWorkspace,
      workspace: otherWorkspace,
      access: "write",
      network: false,
      env: {},
    });

    expect(authorized.command).toContain(`'--volume=${dependencies}:${dependencyTarget}:ro'`);
    expect(unrelated.command).not.toContain(dependencies);
    unregister();
  });

  it("does not trust an arbitrary external symlink chosen by the writable workspace", async () => {
    const workspace = await tempDir("friday-podman-untrusted-");
    const hostSecrets = await tempDir("friday-podman-host-secrets-");
    await writeFile(join(hostSecrets, "secret.txt"), "do-not-mount");
    await symlink(hostSecrets, join(workspace, "node_modules"));
    const sandbox = createPodmanSandboxService({ probe: () => ({ available: true }) });
    const context = sandbox.sandboxShell({
      command: "find node_modules -maxdepth 1 -type f",
      cwd: workspace,
      workspace,
      access: "write",
      network: false,
      env: {},
    });
    expect(context.command).not.toContain(hostSecrets);
  });

  it("launches IPython through a network-off Podman kernel using a shared IPC directory", async () => {
    const workspace = await tempDir("friday-podman-kernel-workspace-");
    const kernelDir = await tempDir("friday-podman-kernel-ipc-");
    const connectionPath = join(kernelDir, "connection.json");
    await writeFile(connectionPath, "{}", { mode: 0o600 });
    const sandbox = createPodmanSandboxService({
      probe: () => ({ available: true }),
      networkMode: "requested",
    });
    const context = sandbox.sandboxKernel({
      python: "/host/python",
      connectionPath,
      tempDir: kernelDir,
      cwd: workspace,
      workspace,
      env: { PATH: "/usr/bin", SECRET: "host-only", PYTHONPATH: join(workspace, "python") },
    });

    expect(context.command).toBe("podman");
    expect(context.args).toContain("--network=none");
    expect(context.args).toContain(`--volume=${workspace}:${workspace}:rw`);
    expect(context.args).toContain(`--volume=${kernelDir}:${kernelDir}:rw`);
    expect(context.args).toContain("--env=HOME=/tmp");
    expect(context.args).toContain(`--env=PATH=${join(workspace, "node_modules", ".bin")}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`);
    expect(context.args).toContain("--env=FRIDAY_SANDBOX=podman");
    expect(context.args).toContain(`--env=PYTHONPATH=${join(workspace, "python")}`);
    expect(context.args.join(" ")).not.toContain("SECRET=host-only");
    expect(context.args.slice(-5)).toEqual(["localhost/friday-sandbox:gen0", "python3", "-m", "ipykernel_launcher", "-f", connectionPath].slice(-5));
  });

  it("re-checks an initially missing image so an approved setup becomes usable without restart", async () => {
    const workspace = await tempDir("friday-podman-refresh-");
    let imageReady = false;
    const sandbox = createPodmanSandboxService({
      probe: () => imageReady
        ? ({ available: true, status: "ready" })
        : ({ available: false, status: "image-missing", reason: "image missing" }),
    });
    expect(sandbox.sandboxKind).toBe("unavailable");
    imageReady = true;
    expect(sandbox.sandboxKind).toBe("podman");
    expect(() => sandbox.sandboxShell({
      command: "true",
      cwd: workspace,
      workspace,
      access: "read",
      network: false,
      env: {},
    })).not.toThrow();
  });

  it("checks for the sandbox image before building and verifies it afterward", async () => {
    const buildContext = await tempDir("friday-podman-build-");
    const containerfile = join(buildContext, "Containerfile");
    await writeFile(containerfile, "FROM scratch\n");
    let probes = 0;
    const runs: Array<{ command: string; args: readonly string[] }> = [];
    const result = ensurePodmanSandboxImage({
      image: "localhost/friday-sandbox:test",
      containerfile,
      contextDir: buildContext,
      probe: () => {
        probes += 1;
        return probes === 1
          ? { available: false, status: "image-missing", reason: "missing" }
          : { available: true, status: "ready" };
      },
      run: (command, args) => {
        runs.push({ command, args: [...args] });
        return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null, error: undefined } as never;
      },
    });
    expect(result).toEqual({ status: "built", image: "localhost/friday-sandbox:test" });
    expect(probes).toBe(2);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      command: "podman",
      args: ["build", "--pull=missing", "--tag", "localhost/friday-sandbox:test", "--file", containerfile, buildContext],
    });
  });

  it("does not rebuild a sandbox image that is already available", () => {
    let runs = 0;
    const result = ensurePodmanSandboxImage({
      image: "localhost/friday-sandbox:test",
      probe: () => ({ available: true, status: "ready" }),
      run: () => {
        runs += 1;
        throw new Error("must not build");
      },
    });
    expect(result).toEqual({ status: "already-ready", image: "localhost/friday-sandbox:test" });
    expect(runs).toBe(0);
  });

  it("fails closed when rootless Podman is unavailable", () => {
    const sandbox = createPodmanSandboxService({
      probe: () => ({ available: false, reason: "FRIDAY requires rootless Podman" }),
    });
    expect(sandbox.sandboxKind).toBe("unavailable");
    expect(() => sandbox.assertAvailable()).toThrow(/rootless Podman/);
  });
});
