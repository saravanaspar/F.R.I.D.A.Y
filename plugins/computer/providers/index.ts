import type { ComputerNodeAdapter } from "../contract.js";
import { createLinuxSwayComputerAdapter, type LinuxSwayComputerAdapterOptions } from "./linux-sway.js";

export const COMPUTER_PROVIDER_NONE = "none";
export const COMPUTER_PROVIDER_LINUX_SWAY = "linux-sway";

export interface ConfiguredComputerProviderHealth {
  readonly configured: boolean;
  readonly provider?: string | undefined;
  readonly status: "ok" | "degraded" | "unavailable";
  readonly nodes: number;
  readonly issues: readonly string[];
}

export function configuredComputerProviderId(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = environment.FRIDAY_COMPUTER_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === COMPUTER_PROVIDER_NONE) return undefined;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw)) throw new Error("FRIDAY_COMPUTER_PROVIDER is invalid");
  return raw;
}

export function configuredComputerAdapters(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  options: Pick<LinuxSwayComputerAdapterOptions, "runTool" | "cleanupRunProcesses"> = {},
): readonly ComputerNodeAdapter[] {
  const provider = configuredComputerProviderId(environment);
  if (!provider) return Object.freeze([]);
  if (provider === COMPUTER_PROVIDER_LINUX_SWAY) {
    return Object.freeze([createLinuxSwayComputerAdapter({ environment, platform, ...options })]);
  }
  throw new Error(`Computer provider '${provider}' is not registered. Registered providers: ${COMPUTER_PROVIDER_LINUX_SWAY}`);
}

export async function inspectConfiguredComputerProvider(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ConfiguredComputerProviderHealth> {
  const provider = configuredComputerProviderId(environment);
  if (!provider) return Object.freeze({ configured: false, status: "ok", nodes: 0, issues: Object.freeze([]) });
  let adapters: readonly ComputerNodeAdapter[];
  try { adapters = configuredComputerAdapters(environment, platform); } catch (error) {
    return Object.freeze({
      configured: true,
      provider,
      status: "unavailable",
      nodes: 0,
      issues: Object.freeze([error instanceof Error ? error.message : String(error)]),
    });
  }
  const issues: string[] = [];
  let unavailable = false;
  for (const adapter of adapters) {
    try {
      const snapshot = await adapter.snapshot();
      if (snapshot.availability === "offline") unavailable = true;
      if (snapshot.availability !== "online") issues.push(`${adapter.descriptor.id} is ${snapshot.availability}`);
      const providerIssues = await adapter.doctor?.();
      if (providerIssues) issues.push(...providerIssues.map((issue) => `${adapter.descriptor.id}: ${issue}`));
    } catch (error) {
      unavailable = true;
      issues.push(`${adapter.descriptor.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await adapter.close?.();
    }
  }
  const status = unavailable ? "unavailable" as const : issues.length > 0 ? "degraded" as const : "ok" as const;
  return Object.freeze({ configured: true, provider, status, nodes: adapters.length, issues: Object.freeze(issues.slice(0, 32)) });
}

export { createHttpCdpClient, createLinuxSwayComputerAdapter } from "./linux-sway.js";
export type { LinuxCdpClient, LinuxCdpTarget, LinuxSwayComputerAdapterOptions } from "./linux-sway.js";
