import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function getDefaultDataDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_HOME?.trim();
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(configured);
  }
  return join(homedir(), ".friday");
}

export function getSessionsDir(dataDir: string = getDefaultDataDir()): string {
  return join(dataDir, "sessions");
}
