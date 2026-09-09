import { resolve } from "node:path";

export function resolveMcpSelfRepository(
  configured: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = configured?.trim() || environment.FRIDAY_SELF_REPOSITORY?.trim();
  return value ? resolve(value) : undefined;
}
