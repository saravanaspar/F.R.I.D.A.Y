import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function runtimeRoot(): string {
  const bundled = process.env.FRIDAY_BUNDLED_ROOT?.trim();
  if (bundled) return resolve(bundled, "plugins", "execution", "runtime");
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function defaultKernelPythonPath(): string {
  if (process.env.FRIDAY_KERNEL_PYTHON) {
    return resolve(process.env.FRIDAY_KERNEL_PYTHON);
  }
  const root = runtimeRoot();
  if (process.platform === "win32") return join(root, ".venv", "Scripts", "python.exe");
  return join(root, ".venv", "bin", "python");
}

export async function assertKernelPythonReady(python = defaultKernelPythonPath()): Promise<string> {
  if (!existsSync(python)) {
    throw new Error(
      `Python kernel runtime is not provisioned: ${python}. Run \"friday setup execution-python\".`,
    );
  }
  await access(python, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  try {
    await execFileAsync(python, ["-c", "import ipykernel"], { timeout: 10_000 });
  } catch (error) {
    throw new Error(
      `Python kernel runtime is missing ipykernel: ${python}. Run \"friday setup execution-python\".`,
      { cause: error },
    );
  }
  return python;
}
