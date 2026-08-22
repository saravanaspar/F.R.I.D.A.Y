/**
 * Internal bootstrap hook used by composition plugins that need to validate or
 * activate registered plugin metadata after discovery is complete.
 *
 * The bootstrap surface is intentionally symbol-only. Ordinary plugins do not
 * receive a host command registry or any other application service.
 */
export const PLUGIN_BOOTSTRAP_FINALIZER = Symbol.for("friday.plugin.bootstrap-finalizer.v1");

/** Registers host-shutdown cleanup owned by a bootstrap/composition plugin. */
export const PLUGIN_BOOTSTRAP_DISPOSER = Symbol.for("friday.plugin.bootstrap-disposer.v1");

/** Marks configured-plugin discovery so declarative plugins can defer activation. */
export const PLUGIN_BOOTSTRAP_DEFERRED = Symbol.for("friday.plugin.bootstrap-deferred.v1");

export type PluginBootstrapFinalizer = () => void | Promise<void>;
export type PluginBootstrapDisposer = () => void | Promise<void>;

/**
 * Ephemeral host API exposed only while plugin modules are being discovered.
 *
 * There are deliberately no string-keyed methods. Runtime composition belongs
 * to the plugin kernel, and operator interaction belongs to normal plugins / the
 * setup utility rather than a permanent command dispatcher.
 */
export interface PluginBootstrapAPI {
  readonly [PLUGIN_BOOTSTRAP_FINALIZER]: (finalizer: PluginBootstrapFinalizer) => void;
  readonly [PLUGIN_BOOTSTRAP_DISPOSER]: (disposer: PluginBootstrapDisposer) => void;
  readonly [PLUGIN_BOOTSTRAP_DEFERRED]: boolean;
}

/** A FRIDAY plugin module entrypoint. */
export type FridayPlugin = (api: PluginBootstrapAPI) => void | Promise<void>;
