import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { KernelManager } from "../plugins/execution/runtime/src/kernel/index.js";
import { createPodmanSandboxService } from "../plugins/sandbox/podman.js";
import { VaultStore, VAULT_MASTER_KEY_FILE_NAME } from "../plugins/vault/runtime/src/index.js";

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

const podmanIt = process.env.FRIDAY_RUN_PODMAN_INTEGRATION === "1" ? it : it.skip;
const PODMAN_INTEGRATION_TIMEOUT_MS = 30_000;

async function runSandboxProcess(context: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(context.command, context.args, {
      cwd: context.cwd,
      env: context.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

const KERNEL_EXECUTION_WATCHDOG_MS = 20_000;

async function executeKernelWithWatchdog(manager: KernelManager, code: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KERNEL_EXECUTION_WATCHDOG_MS);
  try {
    return await manager.execute(code, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

podmanIt("runs internal host-owned processes without exposing host files or environment", async () => {
  const workspace = await tempDir("friday-podman-process-workspace-");
  const outside = await tempDir("friday-podman-process-host-secret-");
  const vaultDir = join(outside, "vault");
  const vault = new VaultStore({ stateDir: vaultDir, workspaceRoot: workspace });
  vault.create({ ref: "vault://integration/process/token", kind: "token", secret: "host-secret" });
  const outsideSecret = join(vaultDir, VAULT_MASTER_KEY_FILE_NAME);
  const dependencies = await tempDir("friday-podman-process-dependencies-");
  await writeFile(join(dependencies, "sentinel.txt"), "trusted-dependency");
  const dependencyBin = join(dependencies, ".bin");
  await mkdir(dependencyBin);
  const dependencyExecutable = join(dependencyBin, "friday-sentinel");
  await writeFile(dependencyExecutable, "#!/bin/sh\necho trusted-binary\n");
  await chmod(dependencyExecutable, 0o755);
  const dependencyTarget = join(workspace, "node_modules");
  await mkdir(dependencyTarget);

  const sandbox = createPodmanSandboxService();
  sandbox.assertAvailable();
  const unregisterDependencies = sandbox.registerTrustedReadOnlyMount(workspace, dependencies, dependencyTarget);
  try {
    const script = [
      "import os",
      "from pathlib import Path",
      `outside = Path(${JSON.stringify(outsideSecret)})`,
      "print(os.environ.get('FRIDAY_TEST_HOST_SECRET'))",
      "print(outside.exists())",
      "print(Path('node_modules/sentinel.txt').read_text())",
    ].join(";");
    const context = sandbox.sandboxProcess({
      command: "python3",
      args: ["-c", script],
      cwd: workspace,
      workspace,
      access: "read",
      network: false,
      env: { ...process.env, FRIDAY_TEST_HOST_SECRET: "must-not-enter-container" },
    });
    const result = await runSandboxProcess(context);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("None\nFalse\ntrusted-dependency\n");

    const binaryContext = sandbox.sandboxProcess({
      command: "/bin/bash",
      args: ["-c", "friday-sentinel"],
      cwd: workspace,
      workspace,
      access: "read",
      network: false,
      env: process.env,
    });
    const binaryResult = await runSandboxProcess(binaryContext);
    expect(binaryResult.code, binaryResult.stderr).toBe(0);
    expect(binaryResult.stdout).toBe("trusted-binary\n");
  } finally {
    unregisterDependencies();
  }
}, PODMAN_INTEGRATION_TIMEOUT_MS);

podmanIt("runs the persistent model kernel inside network-off Podman without host secrets", async () => {
  const workspace = await tempDir("friday-podman-kernel-workspace-");
  const outside = await tempDir("friday-podman-kernel-host-secret-");
  const vaultDir = join(outside, "vault");
  const vault = new VaultStore({ stateDir: vaultDir, workspaceRoot: workspace });
  vault.create({ ref: "vault://integration/kernel/token", kind: "token", secret: "host-secret" });
  const outsideSecret = join(vaultDir, VAULT_MASTER_KEY_FILE_NAME);
  const dependencies = await tempDir("friday-podman-kernel-dependencies-");
  await writeFile(join(dependencies, "sentinel.txt"), "trusted-dependency");
  const dependencyTarget = join(workspace, "node_modules");
  await mkdir(dependencyTarget);

  const sandbox = createPodmanSandboxService();
  sandbox.assertAvailable();
  const unregisterDependencies = sandbox.registerTrustedReadOnlyMount(
    workspace,
    dependencies,
    dependencyTarget,
  );
  const manager = new KernelManager({
    cwd: workspace,
    transport: "ipc",
    env: { FRIDAY_TEST_HOST_SECRET: "must-not-enter-container" },
    launcher(request) {
      return sandbox.sandboxKernel({
        python: request.python,
        connectionPath: request.connectionPath,
        tempDir: request.tempDir,
        cwd: request.cwd ?? workspace,
        workspace,
        env: request.env,
      });
    },
  });

  try {
    const result = await executeKernelWithWatchdog(manager, [
      "import os",
      "from pathlib import Path",
      `outside = Path(${JSON.stringify(outsideSecret)})`,
      "Path('inside.txt').write_text('sandboxed\\n')",
      "print(os.environ.get('FRIDAY_TEST_HOST_SECRET'))",
      "print(outside.exists())",
      "print(Path('node_modules/sentinel.txt').read_text())",
      "try:",
      "    Path('node_modules/write.txt').write_text('blocked')",
      "    print('writable')",
      "except OSError:",
      "    print('readonly')",
    ].join("\n"));

    expect(result.status).toBe("ok");
    expect(result.stdout).toBe("None\nFalse\ntrusted-dependency\nreadonly\n");
    expect(await readFile(join(workspace, "inside.txt"), "utf8")).toBe("sandboxed\n");
  } finally {
    await manager.dispose();
    unregisterDependencies();
  }
}, PODMAN_INTEGRATION_TIMEOUT_MS);
