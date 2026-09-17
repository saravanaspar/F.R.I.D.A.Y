import {
  normalizeCustomModelEndpoint,
  prepareCustomModel,
  readCustomModels,
  toCustomModelDescriptor,
  upsertCustomModel,
} from "../plugins/runtime-settings/custom-models.js";
import {
  ensureFridayWorkspace,
  getFridayHome,
  getFridayWorkspace,
  loadRuntimeEnvironment,
  normalizeRuntimePermissionMode,
  normalizeRuntimeTimezone,
  readRuntimeSettings,
  saveRuntimeSettings,
  type HostPrivilegeMode,
  type RuntimePermissionMode,
  type RuntimeSettings,
} from "../plugins/runtime-settings/runtime-env.js";
import type { SandboxProbeResult, SandboxSetupResult } from "../plugins/sandbox/contract.js";
import {
  modelCredentialVaultRef,
  modelOAuthCredentialVaultRef,
  modelProviderTypicallyNeedsApiKey,
} from "../plugins/auth/model-credential-ref.js";
import {
  decodeModelOAuthCredential,
  encodeModelOAuthCredential,
  type StoredModelOAuthCredential,
} from "../plugins/auth/model-oauth-credential.js";
import { createTerminalOnboardingIO } from "./terminal-setup-ui.js";

export type OnboardingSandboxProbeResult = SandboxProbeResult;
export type OnboardingSandboxSetupResult = SandboxSetupResult;

export interface OnboardingModelDescriptor {
  readonly id: string;
  readonly name?: string | undefined;
  readonly featured?: boolean | undefined;
  readonly pricingTier?: "free" | "paid" | "unknown" | undefined;
}

export interface OnboardingModelCatalog {
  providers(): readonly string[];
  models(provider: string): readonly OnboardingModelDescriptor[];
}

export interface OnboardingModelDiscovery {
  supports(provider: string): boolean;
  list(provider: string, apiKey: string): Promise<readonly string[]>;
  pricingTier?(provider: string, modelId: string): "free" | "paid" | "unknown";
}

export interface OnboardingOAuthLoginCallbacks {
  readonly onAuth: (info: { readonly url: string; readonly instructions?: string | undefined }) => void;
  readonly onPrompt: (prompt: { readonly message: string; readonly placeholder?: string | undefined; readonly allowEmpty?: boolean | undefined }) => Promise<string>;
  readonly onProgress?: ((message: string) => void) | undefined;
  readonly onManualCodeInput?: (() => Promise<string>) | undefined;
  readonly onSelect?: ((prompt: {
    readonly message: string;
    readonly options: readonly { readonly id: string; readonly label: string }[];
  }) => Promise<string | undefined>) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface OnboardingOAuthProvider {
  readonly id: string;
  readonly name: string;
  readonly usesCallbackServer?: boolean | undefined;
  login(callbacks: OnboardingOAuthLoginCallbacks): Promise<StoredModelOAuthCredential>;
  refreshToken(credentials: StoredModelOAuthCredential): Promise<StoredModelOAuthCredential>;
  getApiKey(credentials: StoredModelOAuthCredential): string;
  discoverModelIds?(credentials: StoredModelOAuthCredential): Promise<readonly string[]>;
}

export interface OnboardingOAuthAccess {
  get(provider: string): OnboardingOAuthProvider | undefined;
}

export type OnboardingPermissionMode = RuntimePermissionMode;
export type OnboardingSettings = RuntimeSettings;

export interface OnboardingSelectChoice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly keywords?: readonly string[] | undefined;
}

export interface OnboardingSelectInput {
  readonly message: string;
  readonly choices: readonly OnboardingSelectChoice[];
  readonly initialValue?: string | undefined;
  readonly searchable?: boolean | undefined;
  readonly maxItems?: number | undefined;
}

export interface OnboardingIO {
  question(prompt: string): Promise<string>;
  /** Rich free-text prompt. When omitted, legacy/simple IO may use question(). */
  text?(prompt: string, initialValue?: string): Promise<string>;
  secretQuestion?(prompt: string): Promise<string>;
  write(text: string): void;
  isInteractive: boolean;
  select?(input: OnboardingSelectInput): Promise<string>;
  confirm?(message: string, initialValue?: boolean): Promise<boolean>;
  runTask?<T>(message: string, task: () => Promise<T>): Promise<T>;
  intro?(title: string, subtitle?: string): void;
  outro?(title: string, details?: readonly string[]): void;
  info?(message: string): void;
  success?(message: string): void;
  warning?(message: string): void;
  close?(): void;
}

export interface OnboardingOptions {
  readonly home?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly routingProvider?: string | undefined;
  readonly routingModel?: string | undefined;
  readonly useMainForRouting?: boolean | undefined;
  readonly permission?: string | undefined;
  /** Local-only host privilege boundary. Defaults fail-closed to none. */
  readonly hostPrivilegeMode?: HostPrivilegeMode | undefined;
  readonly timezone?: string | undefined;
  readonly setupSandbox?: boolean | undefined;
  readonly configureChannels?: boolean | undefined;
  /** First-run setup may require an API-key credential for providers that use one. */
  readonly requireMainCredential?: boolean | undefined;
  readonly io?: OnboardingIO | undefined;
  readonly catalog?: OnboardingModelCatalog | undefined;
  /** Live provider model discovery used to key-scope interactive model choices. */
  readonly modelDiscovery?: OnboardingModelDiscovery | undefined;
  /** OAuth registry used to authenticate subscription-backed providers before model selection. */
  readonly oauthAccess?: OnboardingOAuthAccess | undefined;
  readonly probeSandbox?: (() => OnboardingSandboxProbeResult) | undefined;
  readonly ensureSandbox?: (() => OnboardingSandboxSetupResult | Promise<OnboardingSandboxSetupResult>) | undefined;
  /** Test/integration seam for probing a custom OpenAI-compatible descriptor before registration. */
  readonly verifyCustomModel?: ((descriptor: ReturnType<typeof toCustomModelDescriptor>, apiKey?: string) => Promise<void>) | undefined;
}

export interface RouterBootstrapOptions {
  readonly home?: string | undefined;
  readonly routingProvider?: string | undefined;
  readonly routingModel?: string | undefined;
  readonly permission?: string | undefined;
  readonly hostPrivilegeMode: HostPrivilegeMode;
  readonly timezone?: string | undefined;
  readonly io?: OnboardingIO | undefined;
  readonly catalog?: OnboardingModelCatalog | undefined;
  readonly modelDiscovery?: OnboardingModelDiscovery | undefined;
  readonly oauthAccess?: OnboardingOAuthAccess | undefined;
  readonly verifyCustomModel?: OnboardingOptions["verifyCustomModel"] | undefined;
}

function nonEmpty(value: string | undefined, label: string, maximum = 256): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  if (/[\r\n\0]/.test(normalized)) throw new Error(`${label} contains unsupported control characters`);
  return normalized;
}

async function defaultCatalog(home: string): Promise<OnboardingModelCatalog> {
  const model = await import("@friday/model");
  for (const custom of await readCustomModels(home)) {
    model.registerModel(toCustomModelDescriptor(custom) as never, { replace: true });
  }
  return {
    providers: () => model.getProviders() as readonly string[],
    // Built-in providers never expose a local model catalog. Only explicit
    // user-defined custom endpoints retain their locally configured descriptor.
    models: (provider) => provider.startsWith("custom:")
      ? model.getModels(provider as never).map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          featured: candidate.featured,
        }))
      : [],
  };
}

async function defaultModelDiscovery(): Promise<OnboardingModelDiscovery> {
  const model = await import("@friday/model");
  return Object.freeze({
    supports: (provider: string) => model.supportsLiveModelDiscovery(provider),
    list: (provider: string, apiKey: string) => model.discoverAvailableModelIds(provider, apiKey),
    pricingTier: (provider: string, modelId: string) => model.getDiscoveredModelPricingTier(provider, modelId),
  });
}

async function defaultOAuthAccess(): Promise<OnboardingOAuthAccess> {
  const auth = await import("@friday/auth");
  return Object.freeze({
    get(provider: string): OnboardingOAuthProvider | undefined {
      const candidate = auth.getOAuthProvider(provider);
      if (!candidate) return undefined;
      return Object.freeze({
        id: candidate.id,
        name: candidate.name,
        ...(candidate.usesCallbackServer === undefined ? {} : { usesCallbackServer: candidate.usesCallbackServer }),
        login: async (callbacks: OnboardingOAuthLoginCallbacks) => candidate.login(callbacks as never) as Promise<StoredModelOAuthCredential>,
        refreshToken: async (credentials: StoredModelOAuthCredential) => candidate.refreshToken(credentials as never) as Promise<StoredModelOAuthCredential>,
        getApiKey: (credentials: StoredModelOAuthCredential) => candidate.getApiKey(credentials as never),
        ...(candidate.discoverModelIds ? {
          discoverModelIds: async (credentials: StoredModelOAuthCredential) => candidate.discoverModelIds!(credentials as never),
        } : {}),
      });
    },
  });
}

const DISABLED_MODEL_DISCOVERY: OnboardingModelDiscovery = Object.freeze({
  supports: () => false,
  list: async () => Object.freeze([]),
});

const DISABLED_OAUTH_ACCESS: OnboardingOAuthAccess = Object.freeze({
  get: () => undefined,
});

const CUSTOM_PROVIDER = "__friday_custom_openai_compatible__";

const PROVIDER_PRESENTATION: Readonly<Record<string, { readonly label: string; readonly hint?: string }>> = Object.freeze({
  openai: { label: "OpenAI", hint: "GPT models · API key" },
  "openai-codex": { label: "OpenAI Codex", hint: "ChatGPT subscription · OAuth" },
  anthropic: { label: "Anthropic", hint: "Claude models · API key or OAuth" },
  google: { label: "Google", hint: "Gemini models · API key" },
  "google-vertex": { label: "Google Vertex AI", hint: "Google Cloud" },
  openrouter: { label: "OpenRouter", hint: "many providers · API key → live models" },
  deepseek: { label: "DeepSeek", hint: "DeepSeek models · API key" },
  "github-copilot": { label: "GitHub Copilot", hint: "Copilot subscription · OAuth" },
  xai: { label: "xAI", hint: "Grok models · API key" },
  groq: { label: "Groq", hint: "fast inference · API key" },
  mistral: { label: "Mistral", hint: "Mistral models · API key" },
  nvidia: { label: "NVIDIA NIM", hint: "API Catalog · OpenAI-compatible · NVIDIA_API_KEY" },
  "amazon-bedrock": { label: "Amazon Bedrock", hint: "AWS credentials" },
  "azure-openai-responses": { label: "Azure OpenAI", hint: "Azure endpoint + credential" },
});

const FEATURED_PROVIDERS = Object.freeze([
  "openai", "anthropic", "google", "openrouter", "deepseek", "openai-codex",
  "github-copilot", "xai", "groq", "mistral", "nvidia", "amazon-bedrock", "azure-openai-responses",
]);

function providerChoice(provider: string): OnboardingSelectChoice {
  const presentation = PROVIDER_PRESENTATION[provider];
  return Object.freeze({
    value: provider,
    label: presentation?.label ?? provider,
    ...(presentation?.hint ? { hint: presentation.hint } : {}),
    keywords: Object.freeze([provider, presentation?.label ?? provider]),
  });
}

async function confirm(io: OnboardingIO, message: string, initialValue = false): Promise<boolean> {
  if (io.confirm) return io.confirm(message, initialValue);
  const answer = (await io.question(`${message} [${initialValue ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
  if (!answer) return initialValue;
  return answer === "y" || answer === "yes";
}

async function task<T>(io: OnboardingIO, message: string, operation: () => Promise<T>): Promise<T> {
  return io.runTask ? io.runTask(message, operation) : operation();
}

function showInfo(io: OnboardingIO, message: string): void {
  if (io.info) io.info(message);
  else io.write(`${message}\n`);
}

function showSuccess(io: OnboardingIO, message: string): void {
  if (io.success) io.success(message);
  else io.write(`${message} ✓\n`);
}

function showWarning(io: OnboardingIO, message: string): void {
  if (io.warning) io.warning(message);
  else io.write(`${message}\n`);
}


function strictApiKey(value: string): string {
  const token = value.trim();
  if (!token || token.length > 16_384) throw new Error("API key is empty or too long");
  if (/\s/.test(token)) throw new Error("API key must be sent by itself without spaces or extra text");
  if (/^(?:api[_ -]?key|key|token|bearer)\s*[:=]/i.test(token) || /[`'\"]/.test(token)) {
    throw new Error("Send only the API key value; do not include a label, quotes, or code fences");
  }
  return token;
}

interface PreparedProviderModels {
  readonly models: readonly OnboardingModelDescriptor[];
  readonly credentialReady: boolean;
  readonly live: boolean;
}

type ProviderModelSessions = Map<string, PreparedProviderModels>;
type ProviderAuthenticationMethod = "api-key" | "oauth";

function distinctCatalogModels(catalog: OnboardingModelCatalog, provider: string): readonly OnboardingModelDescriptor[] {
  const byId = new Map<string, OnboardingModelDescriptor>();
  for (const model of catalog.models(provider)) {
    const id = model.id.trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, model);
  }
  return Object.freeze([...byId.values()]);
}

function discoveredModels(
  provider: string,
  availableIds: readonly string[],
  discovery: OnboardingModelDiscovery,
): readonly OnboardingModelDescriptor[] {
  const ids = [...new Set(availableIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new Error(`${provider} returned no generative models for this credential`);
  }
  return Object.freeze(ids.map((id) => {
    const pricingTier = discovery.pricingTier?.(provider, id) ?? (id.endsWith(":free") ? "free" : "unknown");
    return Object.freeze({ id, name: id, pricingTier });
  }));
}

function staticPreparedModels(catalog: OnboardingModelCatalog, provider: string, credentialReady: boolean): PreparedProviderModels {
  return Object.freeze({
    models: distinctCatalogModels(catalog, provider),
    credentialReady,
    live: false,
  });
}

async function chooseProviderAuthentication(
  io: OnboardingIO,
  provider: string,
  oauthProvider: OnboardingOAuthProvider,
): Promise<ProviderAuthenticationMethod> {
  if (io.select) {
    const selected = await io.select({
      message: `${PROVIDER_PRESENTATION[provider]?.label ?? provider} authentication`,
      searchable: false,
      initialValue: "oauth",
      maxItems: 2,
      choices: [
        { value: "oauth", label: "Sign in with OAuth", hint: oauthProvider.name },
        { value: "api-key", label: "Use an API key", hint: "masked input · stored in Vault" },
      ],
    });
    return selected === "api-key" ? "api-key" : "oauth";
  }
  const answer = (await io.question(`${provider} authentication [oauth/api-key] [oauth]: `)).trim().toLowerCase();
  return answer === "api-key" || answer === "key" ? "api-key" : "oauth";
}

async function prepareApiKeyProviderModels(
  provider: string,
  home: string,
  io: OnboardingIO,
  catalog: OnboardingModelCatalog,
  discovery: OnboardingModelDiscovery,
  sessions: ProviderModelSessions,
): Promise<PreparedProviderModels> {
  const model = await import("@friday/model");
  const vault = await import("@friday/vault");
  const environment: NodeJS.ProcessEnv = { ...process.env, FRIDAY_HOME: home };
  const store = new vault.VaultStore({
    stateDir: vault.getVaultStateDir(environment),
    workspaceRoot: getFridayWorkspace(environment),
  });
  const ref = modelCredentialVaultRef(provider);
  const exists = store.exists(ref);
  const ambientCredential = model.getEnvApiKey(provider);
  const supportsDiscovery = discovery.supports(provider);
  if (!supportsDiscovery) {
    throw new Error(`${provider} does not expose live model discovery to FRIDAY; hardcoded model lists are disabled`);
  }

  const prepareWithCredential = async (apiKey: string): Promise<PreparedProviderModels> => {
    const availableIds = await task(io, `Fetching ${provider} models available to this credential`, () => discovery.list(provider, apiKey));
    const models = discoveredModels(provider, availableIds, discovery);
    showSuccess(io, `Live model access verified · ${models.length} model(s) returned by ${provider}`);
    return Object.freeze({ models, credentialReady: true, live: true });
  };

  showInfo(io, `Credential · ${exists ? "stored securely in Vault" : ambientCredential ? "available from your environment" : "not configured"}`);

  let captureApproved = false;
  if (exists) {
    const replace = await confirm(io, `Replace the saved ${provider} API key?`, false);
    if (replace) {
      captureApproved = true;
    } else {
      if (!supportsDiscovery) {
        throw new Error(`${provider} does not expose live model discovery to FRIDAY; hardcoded model lists are disabled`);
      }
      try {
        let prepared: PreparedProviderModels | undefined;
        await store.consume(ref, async (secret) => {
          const secretBytes = Buffer.from(secret);
          try {
            prepared = await prepareWithCredential(secretBytes.toString("utf8"));
          } finally {
            secretBytes.fill(0);
          }
        });
        if (prepared) {
          sessions.set(provider, prepared);
          return prepared;
        }
      } catch (error) {
        showWarning(io, `Saved ${provider} credential could not discover usable models · ${error instanceof Error ? error.message : String(error)}`);
        showInfo(io, `Enter a replacement ${provider} API key to continue.`);
      }
    }
  } else if (ambientCredential) {
    try {
      const prepared = await prepareWithCredential(ambientCredential);
      const persistAmbient = await confirm(
        io,
        `Save the ${provider} credential from your environment into FRIDAY Vault for unattended/service restarts?`,
        true,
      );
      if (persistAmbient) {
        const bytes = Buffer.from(ambientCredential, "utf8");
        try {
          store.create({ ref, kind: "model-api-key", secret: bytes });
          showSuccess(io, `Credential saved for ${provider}`);
        } catch (error) {
          showWarning(io, `Credential could not be saved to Vault · ${error instanceof Error ? error.message : String(error)}`);
          showWarning(io, `${provider} remains environment-managed; unattended services must inject the same credential.`);
        } finally {
          bytes.fill(0);
        }
      } else {
        showWarning(io, `${provider} remains environment-managed; unattended services must inject the same credential.`);
      }
      sessions.set(provider, prepared);
      return prepared;
    } catch (error) {
      showWarning(io, `Environment credential could not load usable ${provider} models · ${error instanceof Error ? error.message : String(error)}`);
      showInfo(io, `Enter a ${provider} API key to continue.`);
    }
  }

  if (!captureApproved) {
    captureApproved = await confirm(
      io,
      exists ? `Provide a replacement ${provider} API key?` : `Add an API key for ${provider}?`,
      true,
    );
  }
  if (!captureApproved) {
    throw new Error(`${provider} API-key authentication is required before model selection`);
  }

  showInfo(io, "Your key is masked while typing, used to fetch the live provider model list, then stored in FRIDAY Vault.");
  for (;;) {
    const raw = io.secretQuestion
      ? await io.secretQuestion("API key (input hidden): ")
      : await io.question("API key: ");
    let token: string;
    try {
      token = strictApiKey(raw);
    } catch (error) {
      io.write(`${error instanceof Error ? error.message : String(error)}\nTry again, or press Ctrl+C to exit.\n`);
      continue;
    }

    let prepared: PreparedProviderModels;
    try {
      prepared = await prepareWithCredential(token);
    } catch (error) {
      showWarning(io, `Credential was not saved · ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const bytes = Buffer.from(token, "utf8");
    try {
      if (exists) store.rotate(ref, bytes);
      else store.create({ ref, kind: "model-api-key", secret: bytes });
    } catch (error) {
      throw new Error(`Credential could not be saved to FRIDAY Vault: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      bytes.fill(0);
    }
    showSuccess(io, `Credential verified by live model discovery and saved for ${provider}`);
    sessions.set(provider, prepared);
    return prepared;
  }
}

async function prepareOAuthProviderModels(
  provider: string,
  oauthProvider: OnboardingOAuthProvider,
  home: string,
  io: OnboardingIO,
  catalog: OnboardingModelCatalog,
  discovery: OnboardingModelDiscovery,
  sessions: ProviderModelSessions,
): Promise<PreparedProviderModels> {
  const vault = await import("@friday/vault");
  const environment: NodeJS.ProcessEnv = { ...process.env, FRIDAY_HOME: home };
  const store = new vault.VaultStore({
    stateDir: vault.getVaultStateDir(environment),
    workspaceRoot: getFridayWorkspace(environment),
  });
  const ref = modelOAuthCredentialVaultRef(provider);
  const supportsDiscovery = oauthProvider.discoverModelIds !== undefined || discovery.supports(provider);

  const prepareWithCredentials = async (
    input: StoredModelOAuthCredential,
    persistRefresh: boolean,
  ): Promise<PreparedProviderModels> => {
    let credentials = input;
    if (Date.now() >= credentials.expires) {
      credentials = await task(io, `Refreshing ${oauthProvider.name} authentication`, () => oauthProvider.refreshToken(credentials));
      if (persistRefresh && store.exists(ref)) {
        const encoded = encodeModelOAuthCredential(credentials);
        try {
          store.rotate(ref, encoded);
        } finally {
          encoded.fill(0);
        }
      }
    }
    const apiKey = strictApiKey(oauthProvider.getApiKey(credentials));
    if (!supportsDiscovery) {
      throw new Error(`${provider} OAuth succeeded, but this provider does not expose live model discovery to FRIDAY; hardcoded model lists are disabled`);
    }
    const availableIds = await task(io, `Fetching ${provider} models available to this account`, () => oauthProvider.discoverModelIds
      ? oauthProvider.discoverModelIds(credentials)
      : discovery.list(provider, apiKey));
    const models = discoveredModels(provider, availableIds, discovery);
    showSuccess(io, `OAuth access verified · ${models.length} model(s) returned by ${provider}`);
    return Object.freeze({ models, credentialReady: true, live: true });
  };

  if (store.exists(ref)) {
    try {
      let prepared: PreparedProviderModels | undefined;
      await store.consume(ref, async (secret) => {
        prepared = await prepareWithCredentials(decodeModelOAuthCredential(secret, provider), true);
      });
      if (prepared) {
        sessions.set(provider, prepared);
        return prepared;
      }
    } catch (error) {
      showWarning(io, `Saved ${oauthProvider.name} authentication could not load models · ${error instanceof Error ? error.message : String(error)}`);
      showInfo(io, `Sign in to ${oauthProvider.name} again to continue.`);
    }
  }

  showInfo(io, `${oauthProvider.name} authentication must complete before model selection.`);
  const credentials = await task(io, `Signing in to ${oauthProvider.name}`, () => oauthProvider.login({
    onAuth(info) {
      showInfo(io, `${oauthProvider.name} authorization URL:`);
      io.write(`${info.url}\n`);
      if (info.instructions) showInfo(io, info.instructions);
    },
    onPrompt: async (prompt) => {
      const label = `${prompt.message}${prompt.placeholder ? `\nExample: ${prompt.placeholder}` : ""}`;
      const value = io.text
        ? await io.text(label)
        : await io.question(`${label}\n> `);
      if (!value.trim() && prompt.allowEmpty !== true) throw new Error(`${oauthProvider.name} authentication input must not be empty`);
      return value;
    },
    onProgress(message) {
      showInfo(io, `${oauthProvider.name}: ${message}`);
    },
    ...(oauthProvider.usesCallbackServer ? {
      onManualCodeInput: async () => io.text
        ? io.text(`Paste the final ${oauthProvider.name} OAuth redirect URL or authorization code`)
        : io.question(`Paste the final ${oauthProvider.name} OAuth redirect URL or authorization code: `),
    } : {}),
    onSelect: async (prompt) => {
      if (prompt.options.length === 0) return undefined;
      return choose(io, prompt.message, prompt.options.map((option) => ({
        value: option.id,
        label: option.label,
      })), undefined, { searchable: false, maxItems: Math.min(9, Math.max(5, prompt.options.length)) });
    },
  }));

  const encoded = encodeModelOAuthCredential(credentials);
  try {
    if (store.exists(ref)) store.rotate(ref, encoded);
    else store.create({ ref, kind: "oauth", secret: encoded });
  } finally {
    encoded.fill(0);
  }
  showSuccess(io, `${oauthProvider.name} authentication saved in FRIDAY Vault`);
  const prepared = await prepareWithCredentials(credentials, false);
  sessions.set(provider, prepared);
  return prepared;
}

async function prepareProviderModels(
  provider: string,
  home: string,
  io: OnboardingIO,
  catalog: OnboardingModelCatalog,
  discovery: OnboardingModelDiscovery,
  oauthAccess: OnboardingOAuthAccess,
  sessions: ProviderModelSessions,
  enableProviderAuth: boolean,
): Promise<PreparedProviderModels> {
  const cached = sessions.get(provider);
  if (cached) return cached;

  if (!io.isInteractive || !enableProviderAuth) {
    const prepared = staticPreparedModels(catalog, provider, false);
    sessions.set(provider, prepared);
    return prepared;
  }

  const oauthProvider = oauthAccess.get(provider);
  const usesApiKey = modelProviderTypicallyNeedsApiKey(provider);
  if (!oauthProvider && !usesApiKey) {
    throw new Error(`${provider} has no FRIDAY-managed authenticated live model discovery flow; hardcoded model lists are disabled`);
  }

  if (oauthProvider && !usesApiKey) {
    return prepareOAuthProviderModels(provider, oauthProvider, home, io, catalog, discovery, sessions);
  }

  if (oauthProvider && usesApiKey) {
    const [model, vault] = await Promise.all([import("@friday/model"), import("@friday/vault")]);
    const environment: NodeJS.ProcessEnv = { ...process.env, FRIDAY_HOME: home };
    const store = new vault.VaultStore({
      stateDir: vault.getVaultStateDir(environment),
      workspaceRoot: getFridayWorkspace(environment),
    });
    const hasOAuth = store.exists(modelOAuthCredentialVaultRef(provider));
    const hasApiKey = store.exists(modelCredentialVaultRef(provider)) || Boolean(model.getEnvApiKey(provider));
    if (hasOAuth && !hasApiKey) {
      return prepareOAuthProviderModels(provider, oauthProvider, home, io, catalog, discovery, sessions);
    }
    if (!hasOAuth && hasApiKey) {
      return prepareApiKeyProviderModels(provider, home, io, catalog, discovery, sessions);
    }
    const method = await chooseProviderAuthentication(io, provider, oauthProvider);
    return method === "oauth"
      ? prepareOAuthProviderModels(provider, oauthProvider, home, io, catalog, discovery, sessions)
      : prepareApiKeyProviderModels(provider, home, io, catalog, discovery, sessions);
  }

  return prepareApiKeyProviderModels(provider, home, io, catalog, discovery, sessions);
}

async function maybeConfigureProviderCredential(
  provider: string,
  modelId: string,
  home: string,
  io: OnboardingIO,
  required = false,
): Promise<void> {
  if (!io.isInteractive) return;
  const model = await import("@friday/model");
  const knownProvider = model.getProviders().find((candidate) => candidate === provider);
  const descriptor = knownProvider
    ? model.getModels(knownProvider).find((candidate) => candidate.id === modelId)
    : undefined;
  if (!descriptor) return;

  const vault = await import("@friday/vault");
  const environment: NodeJS.ProcessEnv = { ...process.env, FRIDAY_HOME: home };
  const workspaceRoot = getFridayWorkspace(environment);
  const store = new vault.VaultStore({
    stateDir: vault.getVaultStateDir(environment),
    workspaceRoot,
  });
  const ref = modelCredentialVaultRef(provider);
  const exists = store.exists(ref);
  const ambientCredential = model.getEnvApiKey(provider);
  const credentialState = exists ? "stored securely in Vault" : ambientCredential ? "available from your environment" : "not configured";
  showInfo(io, `Credential · ${credentialState}`);
  if (!exists && ambientCredential) {
    const persistAmbient = await confirm(
      io,
      `Save the ${provider} credential from your environment into FRIDAY Vault for unattended/service restarts?`,
      true,
    );
    if (persistAmbient) {
      const bytes = Buffer.from(ambientCredential, "utf8");
      try {
        const response = await task(io, `Verifying ${provider} environment credential`, () => model.completeSimple(
          descriptor as never,
          { messages: [{ role: "user", content: "Reply only with OK.", timestamp: Date.now() }] },
          { apiKey: ambientCredential, maxTokens: 4, temperature: 0 },
        ));
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          throw new Error(response.errorMessage || `${provider} rejected the environment credential`);
        }
        store.create({ ref, kind: "model-api-key", secret: bytes });
        showSuccess(io, `Credential verified and saved for ${provider}`);
        return;
      } catch (error) {
        showWarning(io, `Environment credential was not saved · ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        bytes.fill(0);
      }
    } else {
      showWarning(io, `${provider} remains environment-managed; unattended services must inject the same credential.`);
      return;
    }
  }
  const defaultYes = modelProviderTypicallyNeedsApiKey(provider);
  const approved = await confirm(
    io,
    exists ? `Replace the saved ${provider} API key?` : `Add an API key for ${provider}?`,
    exists ? false : defaultYes,
  );
  if (!approved) {
    if (required && defaultYes) {
      throw new Error(`${provider} requires a model credential before first-run setup can complete`);
    }
    return;
  }

  showInfo(io, "Your key is masked while typing, verified once, then stored in FRIDAY Vault.");
  for (;;) {
    const raw = io.secretQuestion
      ? await io.secretQuestion("API key (input hidden): ")
      : await io.question("API key: ");
    let token: string;
    try {
      token = strictApiKey(raw);
    } catch (error) {
      io.write(`${error instanceof Error ? error.message : String(error)}\nTry again, or press Ctrl+C to exit.\n`);
      continue;
    }
    const bytes = Buffer.from(token, "utf8");
    try {
      const response = await task(io, `Verifying ${provider} credential`, () => model.completeSimple(
        descriptor as never,
        { messages: [{ role: "user", content: "Reply only with OK.", timestamp: Date.now() }] },
        { apiKey: token, maxTokens: 4, temperature: 0 },
      ));
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage || `${provider} rejected the credential`);
      }
      if (exists) store.rotate(ref, bytes);
      else store.create({ ref, kind: "model-api-key", secret: bytes });
      showSuccess(io, `Credential saved for ${provider}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showWarning(io, `Credential was not saved · ${message}`);
    } finally {
      bytes.fill(0);
    }
  }
}

async function configureCustomSelection(
  io: OnboardingIO,
  home: string,
  label: string,
  verifyCustomModel?: OnboardingOptions["verifyCustomModel"],
): Promise<{ provider: string; modelId: string }> {
  if (!io.isInteractive) throw new Error(`${label} custom model setup requires an interactive terminal`);
  const baseUrl = normalizeCustomModelEndpoint(await io.question(
    `${label} custom endpoint (OpenAI-compatible, e.g. https://host/v1): `,
  ));
  const modelId = nonEmpty(await io.question(`${label} model id: `), `${label} model id`, 160);
  const host = new URL(baseUrl).hostname.replace(/[^A-Za-z0-9._-]+/g, "-");
  const providerInput = (await io.question(`${label} provider name [${host}]: `)).trim() || host;
  const candidate = await prepareCustomModel({ provider: providerInput, modelId, baseUrl, name: modelId }, home);
  const model = await import("@friday/model");
  const descriptor = toCustomModelDescriptor(candidate);
  const verify = async (apiKey?: string): Promise<void> => {
    if (verifyCustomModel) return verifyCustomModel(descriptor, apiKey);
    const response = await model.completeSimple(
      descriptor as never,
      { messages: [{ role: "user", content: "Reply only with OK.", timestamp: Date.now() }] },
      { ...(apiKey === undefined ? {} : { apiKey }), maxTokens: 4, temperature: 0 },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `${candidate.provider} endpoint preflight failed`);
    }
  };

  const vault = await import("@friday/vault");
  const environment: NodeJS.ProcessEnv = { ...process.env, FRIDAY_HOME: home };
  const store = new vault.VaultStore({
    stateDir: vault.getVaultStateDir(environment),
    workspaceRoot: getFridayWorkspace(environment),
  });
  const ref = modelCredentialVaultRef(candidate.provider);
  const exists = store.exists(ref);
  showInfo(io, `Credential · ${exists ? "stored securely in Vault" : "not configured"}`);
  const approved = await confirm(
    io,
    exists ? `Replace the saved ${candidate.provider} API key?` : `Add an API key for ${candidate.provider}?`,
    !exists,
  );
  if (approved) {
    showInfo(io, "The key is masked while typing. FRIDAY verifies the endpoint before saving anything.");
    for (;;) {
      const raw = io.secretQuestion
        ? await io.secretQuestion("API key (input hidden): ")
        : await io.question("API key: ");
      let token: string;
      try {
        token = strictApiKey(raw);
      } catch (error) {
        io.write(`${error instanceof Error ? error.message : String(error)}\nTry again, or press Ctrl+C to exit.\n`);
        continue;
      }
      const bytes = Buffer.from(token, "utf8");
      try {
        await task(io, `Verifying ${candidate.provider} endpoint`, () => verify(token));
        if (exists) store.rotate(ref, bytes);
        else store.create({ ref, kind: "model-api-key", secret: bytes });
        showSuccess(io, `Endpoint and credential verified for ${candidate.provider}`);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showWarning(io, `Endpoint was not saved · ${message}`);
      } finally {
        bytes.fill(0);
      }
    }
  } else if (exists) {
    await store.consume(ref, async (bytes) => verify(Buffer.from(bytes).toString("utf8")));
  } else {
    await verify();
  }

  const record = await upsertCustomModel({ provider: providerInput, modelId, baseUrl, name: modelId }, home);
  model.registerModel(toCustomModelDescriptor(record) as never, { replace: true });
  io.write(`Custom endpoint registered as ${record.provider}/${record.modelId}.\n`);
  return { provider: record.provider, modelId: record.modelId };
}

function banner(io: OnboardingIO, existing: boolean): void {
  const title = existing ? "FRIDAY · Setup" : "Welcome to FRIDAY";
  const subtitle = existing
    ? "Update your model, routing, permissions, channels, and local runtime settings. Current values are preselected."
    : "A private personal agent on your machine. Choose a model, credential, timezone, and at least one ingress channel to finish first-run setup.";
  if (io.intro) io.intro(title, subtitle);
  else io.write(`\n${title}\n${subtitle}\n\n`);
}

async function choose(
  io: OnboardingIO,
  label: string,
  choices: readonly OnboardingSelectChoice[],
  current?: string,
  options: { readonly searchable?: boolean; readonly maxItems?: number } = {},
): Promise<string> {
  if (!io.isInteractive || choices.length === 0) return nonEmpty(current, label);
  if (io.select) {
    return io.select({
      message: label,
      choices,
      ...(current ? { initialValue: current } : {}),
      ...(options.searchable === undefined ? {} : { searchable: options.searchable }),
      ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
    });
  }
  io.write(`${label}\n`);
  choices.forEach((choice, index) => {
    const marker = choice.value === current ? "*" : " ";
    io.write(`  ${index + 1}. ${marker} ${choice.label}${choice.hint ? ` — ${choice.hint}` : ""}\n`);
  });
  const suffix = current ? ` [${current}]` : "";
  const answer = (await io.question(`Select number or enter an id${suffix}: `)).trim();
  if (!answer) return nonEmpty(current, label);
  const number = Number(answer);
  if (Number.isInteger(number) && number >= 1 && number <= choices.length) return choices[number - 1]!.value;
  return nonEmpty(answer, label);
}

async function resolveProvider(
  provided: string | undefined,
  current: string | undefined,
  io: OnboardingIO,
  catalog: OnboardingModelCatalog,
  label: string,
): Promise<string> {
  if (provided?.trim()) return provided.trim();
  if (!io.isInteractive) return nonEmpty(current, label);
  const available = [...new Set(catalog.providers())];
  const rank = new Map(FEATURED_PROVIDERS.map((provider, index) => [provider, index] as const));
  available.sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
  const providers: OnboardingSelectChoice[] = [
    ...available.map(providerChoice),
    {
      value: CUSTOM_PROVIDER,
      label: "Custom OpenAI-compatible endpoint",
      hint: "self-hosted or another compatible API",
      keywords: ["custom", "openai compatible", "self hosted", "local"],
    },
  ];
  return choose(io, label, providers, current, { searchable: true, maxItems: 9 });
}

async function resolveSelection(
  providedProvider: string | undefined,
  providedModel: string | undefined,
  currentProvider: string | undefined,
  currentModel: string | undefined,
  io: OnboardingIO,
  catalog: OnboardingModelCatalog,
  discovery: OnboardingModelDiscovery,
  oauthAccess: OnboardingOAuthAccess,
  sessions: ProviderModelSessions,
  enableProviderAuth: boolean,
  home: string,
  label: string,
  verifyCustomModel?: OnboardingOptions["verifyCustomModel"],
): Promise<{ provider: string; modelId: string; credentialReady: boolean }> {
  const providerLabel = label === "Main model" ? "Choose your provider" : `${label} provider`;
  const modelLabel = label === "Main model" ? "Choose a model" : `${label} model`;
  const provider = await resolveProvider(providedProvider, currentProvider, io, catalog, providerLabel);
  if (provider === CUSTOM_PROVIDER) {
    const custom = await configureCustomSelection(io, home, label, verifyCustomModel);
    return { ...custom, credentialReady: true };
  }
  const prepared = await prepareProviderModels(provider, home, io, catalog, discovery, oauthAccess, sessions, enableProviderAuth);
  const modelId = await resolveModel(
    providedModel,
    currentModel,
    provider,
    io,
    catalog,
    modelLabel,
    prepared.models,
    prepared.live,
  );
  return { provider, modelId, credentialReady: prepared.credentialReady };
}

async function resolveModel(
  provided: string | undefined,
  current: string | undefined,
  provider: string,
  io: OnboardingIO,
  catalog: OnboardingModelCatalog,
  label: string,
  availableModels?: readonly OnboardingModelDescriptor[],
  strictAvailability = false,
): Promise<string> {
  const source = availableModels ?? catalog.models(provider);
  const known = new Set(source.map((model) => model.id));
  if (provided?.trim()) {
    const selected = provided.trim();
    if (strictAvailability && !known.has(selected)) {
      throw new Error(`${provider}/${selected} is not available to the configured credential`);
    }
    return selected;
  }
  if (!io.isInteractive) return nonEmpty(current, label);
  if (strictAvailability && source.length === 0) {
    throw new Error(`No FRIDAY-compatible ${provider} models are available to the configured credential`);
  }

  let initial = current;
  if (strictAvailability && current && !known.has(current)) {
    showWarning(io, `Previously selected ${provider}/${current} is no longer available to this credential; choose another model.`);
    initial = undefined;
  }
  const pricingRank = (tier: OnboardingModelDescriptor["pricingTier"]): number =>
    tier === "free" ? 0 : tier === "paid" ? 1 : 2;
  const models: OnboardingSelectChoice[] = [...source]
    .sort((left, right) =>
      pricingRank(left.pricingTier) - pricingRank(right.pricingTier)
      || Number(Boolean(right.featured)) - Number(Boolean(left.featured))
      || left.id.localeCompare(right.id))
    .map((model) => {
      const pricingHint = model.pricingTier === "free" ? "free" : model.pricingTier === "paid" ? "paid" : undefined;
      const hintParts = [
        model.name && model.name !== model.id ? model.id : undefined,
        pricingHint,
        model.featured ? "featured" : undefined,
      ].filter((value): value is string => Boolean(value));
      return {
        value: model.id,
        label: model.name && model.name !== model.id ? model.name : model.id,
        hint: hintParts.length > 0 ? hintParts.join(" · ") : undefined,
        keywords: [model.id, model.name ?? "", pricingHint ?? "", model.featured ? "featured recommended" : ""],
      };
    });
  return choose(io, label, models, initial, { searchable: true, maxItems: 9 });
}

async function resolvePermission(
  provided: string | undefined,
  current: string | undefined,
  io: OnboardingIO,
): Promise<RuntimePermissionMode> {
  if (provided?.trim()) return normalizeRuntimePermissionMode(provided);
  if (!io.isInteractive) return normalizeRuntimePermissionMode(current);
  if (io.select) {
    return normalizeRuntimePermissionMode(await io.select({
      message: "Permission mode",
      searchable: false,
      initialValue: normalizeRuntimePermissionMode(current),
      maxItems: 3,
      choices: [
        { value: "ask", label: "Ask before consequential actions", hint: "recommended" },
        { value: "auto", label: "Auto-approve ordinary workspace work", hint: "network/system still ask" },
        { value: "full", label: "Full trusted-operator mode", hint: "least restrictive" },
      ],
    }));
  }
  io.write([
    "Permission policy",
    "  1. ask  — recommended; consequential actions require approval",
    "  2. auto — ordinary workspace writes can proceed; network/system/credential actions still ask",
    "  3. full — trusted operators normally skip approval prompts",
  ].join("\n") + "\n");
  const answer = (await io.question(`Select permission mode [${current ?? "ask"}]: `)).trim();
  if (!answer) return normalizeRuntimePermissionMode(current);
  if (answer === "1") return "ask";
  if (answer === "2") return "auto";
  if (answer === "3") return "full";
  return normalizeRuntimePermissionMode(answer);
}

async function resolveRouting(
  options: OnboardingOptions,
  current: RuntimeSettings | undefined,
  main: { provider: string; modelId: string },
  io: OnboardingIO,
  catalog: OnboardingModelCatalog,
  discovery: OnboardingModelDiscovery,
  oauthAccess: OnboardingOAuthAccess,
  sessions: ProviderModelSessions,
  enableProviderAuth: boolean,
  home: string,
): Promise<{ routingProvider?: string; routingModelId?: string; credentialReady?: boolean }> {
  if (options.useMainForRouting === true) return {};
  const explicitlySeparate = Boolean(options.routingProvider?.trim() || options.routingModel?.trim());
  let separate = explicitlySeparate || Boolean(current?.routingProvider && current.routingModelId);
  if (options.useMainForRouting === false) separate = true;
  if (io.isInteractive && options.useMainForRouting === undefined && !explicitlySeparate) {
    if (io.select) {
      const answer = await io.select({
        message: "Routing model",
        searchable: false,
        initialValue: separate ? "separate" : "main",
        maxItems: 2,
        choices: [
          { value: "main", label: "Use the main model", hint: "simple · recommended for most setups" },
          { value: "separate", label: "Use a separate routing model", hint: "cheaper/faster classifier" },
        ],
      });
      separate = answer === "separate";
    } else {
      const currentLabel = separate ? "separate" : "main";
      const answer = (await io.question(`Routing model [main/separate] [${currentLabel}]: `)).trim().toLowerCase();
      if (answer) {
        if (answer === "main" || answer === "m") separate = false;
        else if (answer === "separate" || answer === "s") separate = true;
        else throw new Error("routing model choice must be main or separate");
      }
    }
  }
  if (!separate) return {};
  const selection = await resolveSelection(
    options.routingProvider,
    options.routingModel,
    current?.routingProvider ?? main.provider,
    current?.routingModelId ?? main.modelId,
    io,
    catalog,
    discovery,
    oauthAccess,
    sessions,
    enableProviderAuth,
    home,
    "Routing model",
    options.verifyCustomModel,
  );
  return {
    routingProvider: selection.provider,
    routingModelId: selection.modelId,
    credentialReady: selection.credentialReady,
  };
}

async function maybeSetupSandbox(
  options: OnboardingOptions,
  io: OnboardingIO,
): Promise<OnboardingSandboxSetupResult | undefined> {
  if (options.setupSandbox === false) {
    if (!io.info) io.write("Sandbox image setup skipped.\n");
    return undefined;
  }

  const sandbox = await import("../plugins/sandbox/providers/index.js");
  const provider = sandbox.selectSandboxProvider();
  const probe = options.probeSandbox ?? (() => provider.probe());
  const before = probe();
  if (before.available) {
    showSuccess(io, `Coding sandbox is ready · ${provider.descriptor.displayName}`);
    return undefined;
  }
  if (before.status !== "image-missing") {
    const reason = before.reason ?? before.status ?? `${provider.descriptor.displayName} unavailable`;
    showWarning(io, `Coding sandbox is not ready · ${reason}`);
    return undefined;
  }

  let approved = options.setupSandbox === true;
  if (options.setupSandbox === undefined && io.isInteractive) {
    approved = await confirm(io, `Prepare the ${provider.descriptor.displayName} coding sandbox now?`, false);
  }
  if (!approved) {
    showInfo(io, "Coding sandbox skipped · add it later with `friday setup sandbox`");
    return undefined;
  }
  const result = await task(io, "Preparing the local coding sandbox", async () => options.ensureSandbox?.() ?? provider.setup());
  showSuccess(io, `Coding sandbox ${result.status}`);
  return result;
}

function summary(io: OnboardingIO, settings: RuntimeSettings): void {
  const main = settings.modelProvider && settings.modelId ? `${settings.modelProvider}/${settings.modelId}` : "not configured (router-only)";
  const routing = settings.routingProvider && settings.routingModelId
    ? `${settings.routingProvider}/${settings.routingModelId}`
    : "not configured";
  if (io.outro) {
    io.outro("FRIDAY is ready", [
      `Model       ${main}`,
      `Routing     ${routing}`,
      `Permissions ${settings.permissionMode}`,
      `Timezone    ${settings.timezone}`,
      `Workspace   ${settings.workspaceRoot ?? "default"}`,
      "Run `friday` to start.",
    ]);
    return;
  }
  io.write([
    "",
    "Configuration summary",
    `  Main model:    ${main}`,
    `  Routing model: ${routing}`,
    `  Permissions:   ${settings.permissionMode}`,
    `  Timezone:      ${settings.timezone}`,
    `  Workspace:     ${settings.workspaceRoot ?? "default"}`,
    "",
  ].join("\n"));
}

/**
 * Minimal first-run bootstrap used by v1.0.3 Quick/Custom setup. It deliberately
 * configures only the routing/system model plus the mandatory initial trusted
 * operator channel. A main reasoning model may be added later locally or from
 * that trusted channel.
 */
export async function runRouterBootstrap(options: RouterBootstrapOptions): Promise<OnboardingSettings> {
  const ownsTerminalIO = options.io === undefined;
  const io = options.io ?? createTerminalOnboardingIO();
  try {
    const processEnvironment = process.env;
    const home = options.home ?? getFridayHome(processEnvironment);
    const stored = await readRuntimeSettings(home);
    const environment: NodeJS.ProcessEnv = { ...processEnvironment, FRIDAY_HOME: home };
    await loadRuntimeEnvironment({ home, environment });
    if (stored?.workspaceRoot) environment.FRIDAY_WORKSPACE = stored.workspaceRoot;
    const workspaceRoot = await ensureFridayWorkspace(environment, home);
    const catalog = options.catalog ?? await defaultCatalog(home);
    const discovery = options.modelDiscovery ?? (options.catalog ? DISABLED_MODEL_DISCOVERY : await defaultModelDiscovery());
    const enableProviderAuth = options.catalog === undefined || options.modelDiscovery !== undefined || options.oauthAccess !== undefined;
    const oauthAccess = options.oauthAccess ?? (enableProviderAuth ? await defaultOAuthAccess() : DISABLED_OAUTH_ACCESS);
    const providerSessions: ProviderModelSessions = new Map();
    if (io.isInteractive) {
      if (io.intro) io.intro("FRIDAY · Mandatory bootstrap", "Configure the routing model and pair at least one trusted operator channel. The main reasoning model and all optional features can be configured later.");
      else io.write("\nFRIDAY · Mandatory bootstrap\nRouter + trusted operator channel are required. Optional setup can continue later.\n\n");
    }

    const routing = await resolveSelection(
      options.routingProvider,
      options.routingModel,
      environment.FRIDAY_ROUTING_PROVIDER ?? environment.FRIDAY_MODEL_PROVIDER,
      environment.FRIDAY_ROUTING_MODEL_ID ?? environment.FRIDAY_MODEL_ID,
      io,
      catalog,
      discovery,
      oauthAccess,
      providerSessions,
      enableProviderAuth,
      home,
      "Routing model",
      options.verifyCustomModel,
    );
    if (!routing.provider.startsWith("custom:") && !routing.credentialReady) {
      await maybeConfigureProviderCredential(routing.provider, routing.modelId, home, io, true);
    }

    const permissionMode = normalizeRuntimePermissionMode(options.permission ?? stored?.permissionMode ?? environment.FRIDAY_PERMISSION_MODE ?? "ask");
    const timezone = normalizeRuntimeTimezone(options.timezone ?? stored?.timezone ?? environment.FRIDAY_TIMEZONE);
    const settings: OnboardingSettings = Object.freeze({
      ...(stored?.modelProvider && stored.modelId ? { modelProvider: stored.modelProvider, modelId: stored.modelId } : {}),
      routingProvider: nonEmpty(routing.provider, "routing model provider"),
      routingModelId: nonEmpty(routing.modelId, "routing model id"),
      permissionMode,
      hostPrivilegeMode: options.hostPrivilegeMode,
      timezone,
      workspaceRoot,
      ...(stored?.selfRepository ? { selfRepository: stored.selfRepository } : {}),
    });

    // Mandatory channel pairing is completed before runtime settings are
    // published. An aborted bootstrap can therefore never unlock remote admin.
    const { maybeManageChannels } = await import("./onboarding-channels.js");
    await maybeManageChannels(io, home, true, true, workspaceRoot);
    const path = await saveRuntimeSettings(settings, home);
    showInfo(io, `Mandatory bootstrap saved · ${path}`);
    return settings;
  } finally {
    if (ownsTerminalIO) io.close?.();
  }
}

export async function runOnboarding(options: OnboardingOptions = {}): Promise<OnboardingSettings> {
  const ownsTerminalIO = options.io === undefined;
  const io = options.io ?? createTerminalOnboardingIO();
  try {
    const processEnvironment = process.env;
    const home = options.home ?? getFridayHome(processEnvironment);
    const stored = await readRuntimeSettings(home);
    const environment: NodeJS.ProcessEnv = { ...processEnvironment, FRIDAY_HOME: home };
    await loadRuntimeEnvironment({ home, environment });
    if (stored?.workspaceRoot) environment.FRIDAY_WORKSPACE = stored.workspaceRoot;
    const workspaceRoot = await ensureFridayWorkspace(environment, home);
    const catalog = options.catalog ?? await defaultCatalog(home);
    const discovery = options.modelDiscovery ?? (options.catalog ? DISABLED_MODEL_DISCOVERY : await defaultModelDiscovery());
    const enableProviderAuth = options.catalog === undefined || options.modelDiscovery !== undefined || options.oauthAccess !== undefined;
    const oauthAccess = options.oauthAccess ?? (enableProviderAuth ? await defaultOAuthAccess() : DISABLED_OAUTH_ACCESS);
    const providerSessions: ProviderModelSessions = new Map();
    if (io.isInteractive) banner(io, stored !== undefined);

    const main = await resolveSelection(
      options.provider,
      options.model,
      environment.FRIDAY_MODEL_PROVIDER,
      environment.FRIDAY_MODEL_ID,
      io,
      catalog,
      discovery,
      oauthAccess,
      providerSessions,
      enableProviderAuth,
      home,
      "Main model",
      options.verifyCustomModel,
    );
    if (!main.provider.startsWith("custom:") && !main.credentialReady) {
      await maybeConfigureProviderCredential(main.provider, main.modelId, home, io, options.requireMainCredential === true);
    }
    const routingResult = await resolveRouting(options, stored, main, io, catalog, discovery, oauthAccess, providerSessions, enableProviderAuth, home);
    const { credentialReady: routingCredentialReady, ...routing } = routingResult;
    if (routing.routingProvider && routing.routingModelId && routing.routingProvider !== main.provider && !routingCredentialReady) {
      await maybeConfigureProviderCredential(routing.routingProvider, routing.routingModelId, home, io);
    }
    const permissionMode = await resolvePermission(
      options.permission,
      environment.FRIDAY_PERMISSION_MODE,
      io,
    );
    let timezone = normalizeRuntimeTimezone(options.timezone ?? environment.FRIDAY_TIMEZONE);
    if (options.timezone === undefined && io.isInteractive) {
      // Rich terminal IO has a dedicated free-text prompt. Test/embedded rich IO
      // that only implements selectors keeps the detected timezone instead of
      // unexpectedly falling back to the legacy numbered-question surface.
      const selected = io.text
        ? (await io.text("Timezone (IANA)", timezone)).trim()
        : io.select
          ? ""
          : (await io.question(`Timezone (IANA) [${timezone}]: `)).trim();
      timezone = normalizeRuntimeTimezone(selected || timezone);
    }
    const settings: OnboardingSettings = Object.freeze({
      modelProvider: nonEmpty(main.provider, "model provider"),
      modelId: nonEmpty(main.modelId, "model id"),
      ...routing,
      permissionMode,
      hostPrivilegeMode: options.hostPrivilegeMode ?? stored?.hostPrivilegeMode ?? "none",
      timezone,
      workspaceRoot,
      // Rerunning general setup must not silently forget the canonical source
      // checkout previously saved for self-improvement.
      ...(stored?.selfRepository ? { selfRepository: stored.selfRepository } : {}),
    });
    const firstRun = stored === undefined;
    if (firstRun) {
      // Do not publish runtime settings until the mandatory ingress-channel
      // invariant is satisfied. Otherwise an aborted first run could leave a
      // runtime.env behind and let the next setup invocation bypass the
      // first-run channel requirement.
      const { maybeManageChannels } = await import("./onboarding-channels.js");
      await maybeManageChannels(io, home, options.configureChannels !== false, true, workspaceRoot);
    }
    const path = await saveRuntimeSettings(settings, home);
    showInfo(io, `Settings saved · ${path}`);
    if (!firstRun && options.configureChannels !== false && (io.isInteractive || options.configureChannels === true)) {
      const { maybeManageChannels } = await import("./onboarding-channels.js");
      await maybeManageChannels(io, home, options.configureChannels, false, workspaceRoot);
    }
    await maybeSetupSandbox(options, io);
    summary(io, settings);
    if (!io.outro) io.write("Setup complete. Start or restart FRIDAY with `friday`.\n");
    return settings;
  } finally {
    if (ownsTerminalIO) io.close?.();
  }
}
