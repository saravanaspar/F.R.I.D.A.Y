import * as memory from "@friday/memory";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function globalMemoryStateDirs(environment: NodeJS.ProcessEnv): readonly string[] {
  const base = resolve(environment.FRIDAY_STATE_DIR?.trim() || environment.FRIDAY_HOME?.trim() || join(homedir(), ".friday"));
  const directories = [memory.getGlobalMemoryStateDir(base)];
  const principalsRoot = join(base, "principals");
  try {
    const principals = readdirSync(principalsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^channel-[a-f0-9]{32}$/.test(entry.name))
      .slice(0, 128);
    for (const principal of principals) {
      const path = join(principalsRoot, principal.name);
      try {
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isDirectory()) continue;
        directories.push(memory.getGlobalMemoryStateDir(path));
      } catch {
        continue;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return Object.freeze(directories);
}

export function memoryEmbeddingHealth(environment: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const provider = environment === process.env
    ? memory.createDefaultMemoryEmbeddingProvider()
    : new memory.BgeSmallEnV15Int8EmbeddingProvider({ toolingRoot: memory.memoryEmbeddingToolingRoot(environment) });
  const providerState = provider.status?.() ?? { ready: true };
  let stores = 0;
  let totalEntries = 0;
  let readyEntries = 0;
  let staleEntries = 0;
  let missingEntries = 0;
  let databaseErrors = 0;
  for (const stateDir of globalMemoryStateDirs(environment)) {
    if (!existsSync(memory.getMemoryStatePath(stateDir))) continue;
    stores += 1;
    try {
      const store = new memory.MemoryStore({ stateDir, scope: "global", readOnly: true });
      try {
        const status = store.embeddingStatus();
        totalEntries += status.totalEntries;
        readyEntries += status.readyEntries;
        staleEntries += status.staleEntries;
        missingEntries += status.missingEntries;
      } finally {
        store.close();
      }
    } catch {
      databaseErrors += 1;
    }
  }
  const indexNeedsMaintenance = staleEntries > 0 || missingEntries > 0;
  return Object.freeze({
    healthy: databaseErrors === 0,
    ready: providerState.ready,
    active: providerState.active ?? false,
    status: databaseErrors > 0
      ? "error"
      : !providerState.ready
        ? "unavailable"
        : indexNeedsMaintenance
          ? "degraded"
          : "ok",
    providerId: provider.id,
    dimensions: provider.dimensions,
    globalStores: stores,
    totalEntries,
    readyEntries,
    staleEntries,
    missingEntries,
    databaseErrors,
    ...(providerState.reason === undefined ? {} : { reason: providerState.reason }),
  });
}

