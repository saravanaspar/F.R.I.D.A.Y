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
  type RuntimePermissionMode,
  type RuntimeSettings,
} from "../plugins/runtime-settings/runtime-env.js";
import { modelCredentialVaultRef, modelProviderTypicallyNeedsApiKey } from "../plugins/auth/model-credential-ref.js";
import { createTerminalOnboardingIO } from "./terminal-setup-ui.js";

export interface OnboardingSandboxProbeResult {
  readonly available: boolean;
  readonly status?: "ready" | "podman-unavailable" | "rootless-required" | "image-missing" | undefined;
  readonly reason?: string | undefined;
}

export interface OnboardingSandboxSetupResult {
  readonly status: "already-ready" | "built";
  readonly image: string;
}

export interface OnboardingModelDescriptor {
  readonly id: string;
  readonly name?: string | undefined;
  readonly featured?: boolean | undefined;
}

export interface OnboardingModelCatalog {
  providers(): readonly string[];
  models(provider: string): readonly OnboardingModelDescriptor[];
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
  readonly timezone?: string | undefined;
  readonly setupSandbox?: boolean | undefined;
  readonly configureChannels?: boolean | undefined;
  /** First-run setup may require an API-key credential for providers that use one. */
  readonly requireMainCredential?: boolean | undefined;
  readonly io?: OnboardingIO | undefined;
  readonly catalog?: OnboardingModelCatalog | undefined;
  readonly probeSandbox?: ((image: string) => OnboardingSandboxProbeResult) | undefined;
  readonly ensureSandbox?: (() => OnboardingSandboxSetupResult) | undefined;
  /** Test/integration seam for probing a custom OpenAI-compatible descriptor before registration. */
  readonly verifyCustomModel?: ((descriptor: ReturnType<typeof toCustomModelDescriptor>, apiKey?: string) => Promise<void>) | undefined;
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
    models: (provider) => model.getModels(provider as never).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      featured: candidate.featured,
    })),
  };
}

const CUSTOM_PROVIDER = "__friday_custom_openai_compatible__";

const PROVIDER_PRESENTATION: Readonly<Record<string, { readonly label: string; readonly hint?: string }>> = Object.freeze({
  openai: { label: "OpenAI", hint: "GPT models · API key" },
  "openai-codex": { label: "OpenAI Codex", hint: "Codex authentication" },
  anthropic: { label: "Anthropic", hint: "Claude models · API key" },
  google: { label: "Google", hint: "Gemini models · API key" },
  "google-vertex": { label: "Google Vertex AI", hint: "Google Cloud" },
  openrouter: { label: "OpenRouter", hint: "many providers through one key" },
  deepseek: { label: "DeepSeek", hint: "DeepSeek models · API key" },
  "github-copilot": { label: "GitHub Copilot", hint: "Copilot authentication" },
  xai: { label: "xAI", hint: "Grok models · API key" },
  groq: { label: "Groq", hint: "fast inference · API key" },
  mistral: { label: "Mistral", hint: "Mistral models · API key" },
  "amazon-bedrock": { label: "Amazon Bedrock", hint: "AWS credentials" },
  "azure-openai-responses": { label: "Azure OpenAI", hint: "Azure endpoint + credential" },
});

const FEATURED_PROVIDERS = Object.freeze([
  "openai", "anthropic", "google", "openrouter", "deepseek", "openai-codex",
  "github-copilot", "xai", "groq", "mistral", "amazon-bedrock", "azure-openai-responses",
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
  home: string,
  label: string,
  verifyCustomModel?: OnboardingOptions["verifyCustomModel"],
): Promise<{ provider: string; modelId: string }> {
  const providerLabel = label === "Main model" ? "Choose your provider" : `${label} provider`;
  const modelLabel = label === "Main model" ? "Choose a model" : `${label} model`;
  const provider = await resolveProvider(providedProvider, currentProvider, io, catalog, providerLabel);
  if (provider === CUSTOM_PROVIDER) return configureCustomSelection(io, home, label, verifyCustomModel);
  const modelId = await resolveModel(providedModel, currentModel, provider, io, catalog, modelLabel);
  return { provider, modelId };
}

async function resolveModel(
  provided: string | undefined,
  current: string | undefined,
  provider: string,
  io: OnboardingIO,
  catalog: OnboardingModelCatalog,
  label: string,
): Promise<string> {
  if (provided?.trim()) return provided.trim();
  if (!io.isInteractive) return nonEmpty(current, label);
  const models: OnboardingSelectChoice[] = [...catalog.models(provider)]
    .sort((left, right) => Number(Boolean(right.featured)) - Number(Boolean(left.featured)) || left.id.localeCompare(right.id))
    .slice(0, 120)
    .map((model) => ({
      value: model.id,
      label: model.name && model.name !== model.id ? model.name : model.id,
      hint: model.name && model.name !== model.id ? model.id : model.featured ? "featured" : undefined,
      keywords: [model.id, model.name ?? "", model.featured ? "featured recommended" : ""],
    }));
  return choose(io, label, models, current, { searchable: true, maxItems: 9 });
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
  home: string,
): Promise<{ routingProvider?: string; routingModelId?: string }> {
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
    home,
    "Routing model",
    options.verifyCustomModel,
  );
  return { routingProvider: selection.provider, routingModelId: selection.modelId };
}

async function maybeSetupSandbox(
  options: OnboardingOptions,
  io: OnboardingIO,
): Promise<OnboardingSandboxSetupResult | undefined> {
  if (options.setupSandbox === false) {
    if (!io.info) io.write("Sandbox image setup skipped.\n");
    return undefined;
  }

  const sandbox = await import("../plugins/sandbox/podman.js");
  const image = sandbox.DEFAULT_SANDBOX_IMAGE;
  const probe = options.probeSandbox ?? sandbox.probePodman;
  const before = probe(image);
  if (before.available) {
    showSuccess(io, "Coding sandbox is ready");
    return undefined;
  }
  if (before.status !== "image-missing") {
    const reason = before.reason ?? before.status ?? "rootless Podman unavailable";
    showWarning(io, `Coding sandbox is not ready · ${reason}`);
    return undefined;
  }

  let approved = options.setupSandbox === true;
  if (options.setupSandbox === undefined && io.isInteractive) {
    approved = await confirm(io, "Build the local coding sandbox now?", false);
  }
  if (!approved) {
    showInfo(io, "Coding sandbox skipped · add it later with `friday setup sandbox`");
    return undefined;
  }
  const result = await task(io, "Building the local coding sandbox", async () => options.ensureSandbox?.() ?? sandbox.ensurePodmanSandboxImage({ image, probe }));
  showSuccess(io, `Coding sandbox ${result.status}`);
  return result;
}

function summary(io: OnboardingIO, settings: RuntimeSettings): void {
  const routing = settings.routingProvider && settings.routingModelId
    ? `${settings.routingProvider}/${settings.routingModelId}`
    : "main model";
  if (io.outro) {
    io.outro("FRIDAY is ready", [
      `Model       ${settings.modelProvider}/${settings.modelId}`,
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
    `  Main model:    ${settings.modelProvider}/${settings.modelId}`,
    `  Routing model: ${routing}`,
    `  Permissions:   ${settings.permissionMode}`,
    `  Timezone:      ${settings.timezone}`,
    `  Workspace:     ${settings.workspaceRoot ?? "default"}`,
    "",
  ].join("\n"));
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
    if (io.isInteractive) banner(io, stored !== undefined);

    const main = await resolveSelection(
      options.provider,
      options.model,
      environment.FRIDAY_MODEL_PROVIDER,
      environment.FRIDAY_MODEL_ID,
      io,
      catalog,
      home,
      "Main model",
      options.verifyCustomModel,
    );
    if (!main.provider.startsWith("custom:")) {
      await maybeConfigureProviderCredential(main.provider, main.modelId, home, io, options.requireMainCredential === true);
    }
    const routing = await resolveRouting(options, stored, main, io, catalog, home);
    if (routing.routingProvider && routing.routingModelId && routing.routingProvider !== main.provider) {
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
