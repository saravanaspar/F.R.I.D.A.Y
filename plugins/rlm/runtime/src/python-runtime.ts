import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RLM_KERNEL_BOOTSTRAP = "from rlm import rlm";

export function getRlmPythonPath(): string {
  const bundled = process.env.FRIDAY_BUNDLED_ROOT?.trim();
  if (bundled) return resolve(bundled, "rlm", "python");
  return resolve(dirname(fileURLToPath(import.meta.url)), "../python");
}

export function withRlmPythonPath(env: Record<string, string> = {}): Record<string, string> {
  const pythonPath = getRlmPythonPath();
  const inherited = env.PYTHONPATH ?? process.env.PYTHONPATH;
  return {
    ...env,
    PYTHONPATH: inherited ? `${pythonPath}${delimiter}${inherited}` : pythonPath,
  };
}
