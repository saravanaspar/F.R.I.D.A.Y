import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const EXECUTION_PYTHON_REQUIREMENTS = Object.freeze([
  "ipykernel==6.30.1",
  "dill==0.4.0",
] as const);

function toolingRoot(): string {
  const configured = process.env.FRIDAY_HOME?.trim();
  const home = resolve(configured || join(homedir(), ".friday"));
  return join(home, "tooling", "execution-python");
}

export function defaultKernelPythonPath(): string {
  if (process.env.FRIDAY_KERNEL_PYTHON) {
    return resolve(process.env.FRIDAY_KERNEL_PYTHON);
  }
  const root = toolingRoot();
  if (process.platform === "win32") return join(root, "venv", "Scripts", "python.exe");
  return join(root, "venv", "bin", "python");
}

export async function assertKernelPythonReady(python = defaultKernelPythonPath()): Promise<string> {
  if (!existsSync(python)) {
    throw new Error(
      `Python kernel runtime is not provisioned: ${python}. Run \"friday setup execution-python\".`,
    );
  }
  await access(python, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  try {
    await execFileAsync(python, [
      "-c",
      "import importlib.metadata as m, sys; assert sys.version_info[:2] == (3, 11); assert m.version('ipykernel') == '6.30.1'; assert m.version('dill') == '0.4.0'",
    ], { timeout: 10_000 });
  } catch (error) {
    throw new Error(
      `Python kernel runtime is stale or incomplete: ${python}. Run \"friday setup execution-python\".`,
      { cause: error },
    );
  }
  return python;
}
