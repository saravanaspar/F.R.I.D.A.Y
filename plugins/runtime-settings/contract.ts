import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { TurnFinalizerDescriptor } from "../turn-loop/contract.js";
import type { RuntimeSettings, RuntimeSettingsPatch } from "./runtime-env.js";

export interface RuntimeSettingsUpdateOptions {
  readonly restart?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Re-check restart preconditions at the actual handoff boundary, after the reply. */
  readonly beforeRestart?: (() => void | Promise<void>) | undefined;
  readonly afterReply?: ((callback: () => void | Promise<void>, durable?: TurnFinalizerDescriptor) => void) | undefined;
  readonly onFailure?: ((callback: (error: unknown) => void | Promise<void>) => void) | undefined;
}

export interface RuntimeSettingsService {
  read(): Promise<RuntimeSettings | undefined>;
  update(patch: RuntimeSettingsPatch, options?: RuntimeSettingsUpdateOptions): Promise<RuntimeSettings>;
}

export const RUNTIME_SETTINGS_CAPABILITY: Capability<RuntimeSettingsService> =
  defineCapability<RuntimeSettingsService>("runtime-settings");
