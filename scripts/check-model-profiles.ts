#!/usr/bin/env -S node --experimental-strip-types
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDiscoveredModel, getProviderRuntimeProfiles } from "../plugins/model/runtime/src/provider-profiles.ts";

const profiles = getProviderRuntimeProfiles();
if (profiles.length === 0) throw new Error("provider runtime profiles must not be empty");
const providers = new Set<string>();
for (const profile of profiles) {
  if (!profile.provider || providers.has(profile.provider)) throw new Error(`duplicate/invalid provider profile: ${profile.provider}`);
  providers.add(profile.provider);
  const model = createDiscoveredModel(profile.provider, "friday-live-discovery-probe");
  if (!model || model.id !== "friday-live-discovery-probe" || model.provider !== profile.provider) {
    throw new Error(`provider profile cannot materialize live model ids: ${profile.provider}`);
  }
  if (!model.api || typeof model.baseUrl !== "string") throw new Error(`invalid runtime transport profile: ${profile.provider}`);
}

const generated = readFileSync(resolve("plugins/model/runtime/src/models.generated.ts"), "utf8");
if (/\bid\s*:\s*["'`]/.test(generated) || /satisfies\s+Model/.test(generated)) {
  throw new Error("bundled model ids are forbidden; models.generated.ts must remain empty");
}
process.stdout.write(`Live-model runtime profiles are valid (${profiles.length} providers, 0 bundled model ids).\n`);
