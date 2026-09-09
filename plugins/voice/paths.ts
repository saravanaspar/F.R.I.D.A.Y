import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Plugin-local resolution of FRIDAY_HOME for setup/state helpers that run outside the runtime graph. */
export function voiceFridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_HOME?.trim();
  return resolve(configured || join(homedir(), ".friday"));
}
