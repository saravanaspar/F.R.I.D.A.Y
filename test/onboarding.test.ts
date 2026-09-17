import { chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOnboarding as runOnboardingRaw, runRouterBootstrap, type OnboardingOptions } from "../src/onboarding.js";
import { maybeManageChannels } from "../src/onboarding-channels.js";
import { readSavedChannels, updateSavedChannel } from "../plugins/channels/config.js";
import { getPermissionsStateDir, loadTrustedIdentities, upsertTrustedIdentity } from "../plugins/permissions/identity-store.js";
import { normalizeCustomProvider, readCustomModels, upsertCustomModel } from "../plugins/runtime-settings/custom-models.js";
import {
  getRuntimeEnvironmentPath,
  loadRuntimeEnvironment,
  RUNTIME_ENV_KEYS,
  parseRuntimeEnvironment,
  updateRuntimeSettings,
} from "../plugins/runtime-settings/runtime-env.js";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  for (const key of RUNTIME_ENV_KEYS) vi.stubEnv(key, "");
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "friday-onboarding-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runOnboarding(options: OnboardingOptions = {}) {
  if (options.home) {
    await updateSavedChannel("whatsapp", { enabled: true, accountId: "default", allowAll: true }, options.home);
    upsertTrustedIdentity(getPermissionsStateDir({ ...process.env, FRIDAY_HOME: options.home }), {
      channel: "whatsapp",
      accountId: "default",
      senderId: "fixture-operator",
      role: "operator",
      label: "onboarding test operator",
    });
  }
  return runOnboardingRaw(options);
}

describe("FRIDAY onboarding", () => {
  it("requires at least one enabled ingress channel before first-run settings are published", async () => {
    const home = await temporaryDirectory();
    await expect(runOnboardingRaw({
      home,
      provider: "openai",
      model: "gpt-test",
      permission: "ask",
      timezone: "UTC",
      setupSandbox: false,
      // This test owns only the first-run channel invariant. Keep model/auth
      // discovery out of scope so provider-module startup cannot turn the
      // assertion into a wall-clock-dependent integration test.
      catalog: {
        providers: () => ["openai"],
        models: () => [{ id: "gpt-test", name: "GPT Test" }],
      },
      io: {
        isInteractive: false,
        question: async () => { throw new Error("unexpected prompt"); },
        write: () => undefined,
      },
    })).rejects.toThrow(/requires at least one enabled ingress channel/);
    await expect(readFile(getRuntimeEnvironmentPath(home), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists only non-secret runtime defaults with private permissions", async () => {
    const home = await temporaryDirectory();
    const output: string[] = [];

    await runOnboarding({
      home,
      provider: "openai",
      model: "gpt-test",
      permission: "ask",
      setupSandbox: false,
      io: {
        isInteractive: false,
        question: async () => { throw new Error("unexpected prompt"); },
        write: (text) => { output.push(text); },
      },
      probeSandbox: () => ({ available: false, status: "image-missing" }),
    });

    const path = getRuntimeEnvironmentPath(home);
    const text = await readFile(path, "utf8");
    expect(parseRuntimeEnvironment(text)).toEqual({
      FRIDAY_MODEL_PROVIDER: "openai",
      FRIDAY_MODEL_ID: "gpt-test",
      FRIDAY_ROUTING_PROVIDER: "openai",
      FRIDAY_ROUTING_MODEL_ID: "gpt-test",
      FRIDAY_PERMISSION_MODE: "ask",
      FRIDAY_HOST_PRIVILEGE_MODE: "none",
      FRIDAY_TIMEZONE: expect.any(String),
      FRIDAY_WORKSPACE: join(dirname(home), "FRIDAY-workspace"),
    });
    expect(text).not.toMatch(/(?:API_KEY|TOKEN|PASSWORD|CREDENTIAL)=/i);
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect(output.join("")).toContain("Sandbox image setup skipped");
  });

  it("loads stored defaults without overriding explicit process environment", async () => {
    const home = await temporaryDirectory();
    await runOnboarding({
      home,
      provider: "stored-provider",
      model: "stored-model",
      permission: "auto",
      setupSandbox: false,
      io: {
        isInteractive: false,
        question: async () => { throw new Error("unexpected prompt"); },
        write: () => undefined,
      },
      probeSandbox: () => ({ available: false, status: "image-missing" }),
    });

    const environment: NodeJS.ProcessEnv = { FRIDAY_MODEL_PROVIDER: "explicit-provider" };
    await loadRuntimeEnvironment({ home, environment });
    expect(environment.FRIDAY_MODEL_PROVIDER).toBe("explicit-provider");
    expect(environment.FRIDAY_MODEL_ID).toBe("stored-model");
    expect(environment.FRIDAY_PERMISSION_MODE).toBe("auto");
  });

  it("builds the approved sandbox image only after explicit approval", async () => {
    const home = await temporaryDirectory();
    let builds = 0;
    const common = {
      home,
      provider: "provider",
      model: "model",
      permission: "full",
      io: {
        isInteractive: false,
        question: async () => { throw new Error("unexpected prompt"); },
        write: () => undefined,
      },
      probeSandbox: () => ({ available: false, status: "image-missing" as const }),
      ensureSandbox: () => {
        builds += 1;
        return { status: "prepared" as const, providerId: "kern", image: "localhost/friday-sandbox:gen0" };
      },
    };

    await runOnboarding({ ...common, setupSandbox: false });
    expect(builds).toBe(0);
    await runOnboarding({ ...common, setupSandbox: true });
    expect(builds).toBe(1);
  });

  it("captures the provider credential before model selection and shows only live key-scoped models", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const home = await temporaryDirectory();
    const events: string[] = [];
    let modelChoices: readonly string[] = [];
    let routingChoices: readonly string[] = [];
    let discoveryCalls = 0;

    const saved = await runOnboarding({
      home,
      setupSandbox: false,
      configureChannels: false,
      catalog: {
        providers: () => ["google"],
        models: () => [
          { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite" },
          { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", featured: true },
        ],
      },
      modelDiscovery: {
        supports: (provider) => provider === "google",
        async list(provider, apiKey) {
          discoveryCalls += 1;
          events.push(`discover:${provider}:${apiKey}`);
          return ["gemini-3.5-flash-lite", "provider-only-unknown-model"];
        },
      },
      io: {
        isInteractive: true,
        select: async (input) => {
          events.push(`select:${input.message}`);
          if (input.message === "Choose your provider") return "google";
          if (input.message === "Choose a model") {
            modelChoices = input.choices.map((choice) => choice.value);
            return "gemini-3.5-flash-lite";
          }
          if (input.message === "Routing model") return "separate";
          if (input.message === "Routing model provider") return "google";
          if (input.message === "Routing model model") {
            routingChoices = input.choices.map((choice) => choice.value);
            return "gemini-3.5-flash-lite";
          }
          if (input.message === "Permission mode") return "ask";
          throw new Error(`unexpected selector: ${input.message}`);
        },
        confirm: async () => true,
        secretQuestion: async () => { events.push("secret"); return "test-google-key"; },
        question: async (message) => { throw new Error(`unexpected question: ${message}`); },
        text: async (_prompt, initial) => initial ?? "UTC",
        write: () => undefined,
      },
    });

    expect(saved).toMatchObject({
      modelProvider: "google",
      modelId: "gemini-3.5-flash-lite",
      routingProvider: "google",
      routingModelId: "gemini-3.5-flash-lite",
    });
    expect(discoveryCalls).toBe(1);
    expect(modelChoices).toEqual(["gemini-3.5-flash-lite", "provider-only-unknown-model"]);
    expect(routingChoices).toEqual(["gemini-3.5-flash-lite", "provider-only-unknown-model"]);
    expect(events.indexOf("secret")).toBeLessThan(events.indexOf("select:Choose a model"));
    expect(events).toContain("discover:google:test-google-key");
  });

  it("authenticates OpenRouter before model selection and loads only models returned for that key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const home = await temporaryDirectory();
    const events: string[] = [];
    let modelChoices: readonly string[] = [];

    const saved = await runOnboarding({
      home,
      useMainForRouting: true,
      setupSandbox: false,
      configureChannels: false,
      catalog: {
        providers: () => ["openrouter"],
        models: () => [
          { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol" },
          { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
        ],
      },
      modelDiscovery: {
        supports: (provider) => provider === "openrouter",
        async list(provider, apiKey) {
          events.push(`discover:${provider}:${apiKey}`);
          return ["anthropic/claude-sonnet-5", "provider-only-model"];
        },
      },
      io: {
        isInteractive: true,
        select: async (input) => {
          events.push(`select:${input.message}`);
          if (input.message === "Choose your provider") return "openrouter";
          if (input.message === "Choose a model") {
            modelChoices = input.choices.map((choice) => choice.value);
            return "anthropic/claude-sonnet-5";
          }
          if (input.message === "Permission mode") return "ask";
          throw new Error(`unexpected selector: ${input.message}`);
        },
        confirm: async () => true,
        secretQuestion: async () => { events.push("secret"); return "openrouter-test-key"; },
        question: async (message) => { throw new Error(`unexpected question: ${message}`); },
        text: async (_prompt, initial) => initial ?? "UTC",
        write: () => undefined,
      },
    });

    expect(saved).toMatchObject({
      modelProvider: "openrouter",
      modelId: "anthropic/claude-sonnet-5",
    });
    expect(modelChoices).toEqual(["anthropic/claude-sonnet-5", "provider-only-model"]);
    expect(events.indexOf("secret")).toBeLessThan(events.indexOf("select:Choose a model"));
    expect(events).toContain("discover:openrouter:openrouter-test-key");
  });

  it("does not truncate live OpenRouter models before the searchable picker", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const home = await temporaryDirectory();
    const liveIds = [
      ...Array.from({ length: 130 }, (_, index) => `alpha/model-${String(index).padStart(3, "0")}`),
      "stealth/union-alpha",
    ];
    let modelChoices: readonly string[] = [];

    const saved = await runOnboarding({
      home,
      useMainForRouting: true,
      setupSandbox: false,
      configureChannels: false,
      catalog: {
        providers: () => ["openrouter"],
        models: () => [],
      },
      modelDiscovery: {
        supports: (provider) => provider === "openrouter",
        async list() {
          return liveIds;
        },
        pricingTier(_provider, modelId) {
          return modelId === "stealth/union-alpha" ? "free" : "paid";
        },
      },
      io: {
        isInteractive: true,
        select: async (input) => {
          if (input.message === "Choose your provider") return "openrouter";
          if (input.message === "Choose a model") {
            modelChoices = input.choices.map((choice) => choice.value);
            return "stealth/union-alpha";
          }
          if (input.message === "Permission mode") return "ask";
          throw new Error(`unexpected selector: ${input.message}`);
        },
        confirm: async () => true,
        secretQuestion: async () => "openrouter-test-key",
        question: async (message) => { throw new Error(`unexpected question: ${message}`); },
        text: async (_prompt, initial) => initial ?? "UTC",
        write: () => undefined,
      },
    });

    expect(modelChoices).toHaveLength(liveIds.length);
    expect(modelChoices[0]).toBe("stealth/union-alpha");
    expect(modelChoices).toContain("stealth/union-alpha");
    expect(saved).toMatchObject({
      modelProvider: "openrouter",
      modelId: "stealth/union-alpha",
    });
  });

  it("refuses a hardcoded model picker when authenticated live discovery is unavailable", async () => {
    vi.stubEnv("ZAI_API_KEY", "");
    const home = await temporaryDirectory();
    const selections: string[] = [];

    await expect(runOnboarding({
      home,
      useMainForRouting: true,
      setupSandbox: false,
      configureChannels: false,
      catalog: {
        providers: () => ["zai"],
        models: () => [{ id: "must-not-be-used" }],
      },
      modelDiscovery: {
        supports: () => false,
        list: async () => { throw new Error("discovery should not run"); },
      },
      io: {
        isInteractive: true,
        select: async (input) => {
          selections.push(input.message);
          if (input.message === "Choose your provider") return "zai";
          throw new Error(`model picker should not be reached: ${input.message}`);
        },
        confirm: async () => true,
        secretQuestion: async () => { throw new Error("API key should not be requested without live discovery"); },
        question: async (message) => { throw new Error(`unexpected question: ${message}`); },
        text: async (_prompt, initial) => initial ?? "UTC",
        write: () => undefined,
      },
    })).rejects.toThrow(/hardcoded model lists are disabled/);

    expect(selections).toEqual(["Choose your provider"]);
  });

  it("completes OAuth authentication and account model discovery before showing models, then reuses the saved OAuth session", async () => {
    const home = await temporaryDirectory();
    const events: string[] = [];
    let loginCalls = 0;
    let modelChoices: readonly string[] = [];
    const oauthAccess: NonNullable<OnboardingOptions["oauthAccess"]> = {
      get(provider: string) {
        if (provider !== "openai-codex") return undefined;
        return {
          id: "openai-codex",
          name: "OpenAI Codex",
          usesCallbackServer: true,
          async login(callbacks) {
            loginCalls += 1;
            events.push("oauth:login");
            callbacks.onAuth({ url: "https://example.test/oauth" });
            return { access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 60_000 };
          },
          async refreshToken(credentials: { access: string; refresh: string; expires: number }) {
            return credentials;
          },
          getApiKey(credentials: { access: string }) {
            return credentials.access;
          },
          async discoverModelIds(credentials: { access: string }) {
            events.push(`oauth:models:${credentials.access}`);
            return ["gpt-5.4", "account-only-model"];
          },
        };
      },
    };
    const catalog = {
      providers: () => ["openai-codex"],
      models: () => [{ id: "gpt-5.3-codex" }, { id: "gpt-5.4" }],
    };
    const modelDiscovery = {
      supports: () => false,
      list: async () => { throw new Error("discovery should not run"); },
    };
    const io = {
      isInteractive: true,
      select: async (input: { message: string; choices: readonly { value: string }[] }) => {
        events.push(`select:${input.message}`);
        if (input.message === "Choose your provider") return "openai-codex";
        if (input.message === "Choose a model") {
          modelChoices = input.choices.map((choice) => choice.value);
          return "gpt-5.4";
        }
        if (input.message === "Permission mode") return "ask";
        throw new Error(`unexpected selector: ${input.message}`);
      },
      confirm: async () => true,
      question: async (message: string) => { throw new Error(`unexpected question: ${message}`); },
      text: async (_prompt: string, initial?: string) => initial ?? "UTC",
      write: () => undefined,
    };

    await runOnboarding({
      home,
      useMainForRouting: true,
      setupSandbox: false,
      configureChannels: false,
      catalog,
      modelDiscovery,
      oauthAccess,
      io,
    });

    expect(events.indexOf("oauth:login")).toBeLessThan(events.indexOf("select:Choose a model"));
    expect(events.indexOf("oauth:models:oauth-access")).toBeLessThan(events.indexOf("select:Choose a model"));
    expect(modelChoices).toEqual(["account-only-model", "gpt-5.4"]);
    expect(loginCalls).toBe(1);

    events.length = 0;
    await runOnboarding({
      home,
      useMainForRouting: true,
      setupSandbox: false,
      configureChannels: false,
      catalog,
      modelDiscovery,
      oauthAccess,
      io,
    });
    expect(loginCalls).toBe(1);
    expect(events).not.toContain("oauth:login");
    expect(events).toContain("oauth:models:oauth-access");
    expect(events).toContain("select:Choose a model");
  });

  it("does not expose an OAuth provider model picker when authentication fails", async () => {
    const home = await temporaryDirectory();
    const selections: string[] = [];

    await expect(runOnboarding({
      home,
      useMainForRouting: true,
      setupSandbox: false,
      configureChannels: false,
      catalog: {
        providers: () => ["github-copilot"],
        models: () => [{ id: "gpt-5.4" }],
      },
      modelDiscovery: { supports: () => false, list: async () => [] },
      oauthAccess: {
        get: () => ({
          id: "github-copilot",
          name: "GitHub Copilot",
          async login() { throw new Error("OAuth denied"); },
          async refreshToken(credentials) { return credentials; },
          getApiKey(credentials) { return credentials.access; },
        }),
      },
      io: {
        isInteractive: true,
        select: async (input) => {
          selections.push(input.message);
          if (input.message === "Choose your provider") return "github-copilot";
          throw new Error(`model picker should not be reached: ${input.message}`);
        },
        question: async (message) => { throw new Error(`unexpected question: ${message}`); },
        write: () => undefined,
      },
    })).rejects.toThrow("OAuth denied");

    expect(selections).toEqual(["Choose your provider"]);
  });

  it("rejects an explicitly requested model that the live credential cannot access", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const home = await temporaryDirectory();

    await expect(runOnboarding({
      home,
      provider: "google",
      model: "gemini-2.5-flash-lite",
      setupSandbox: false,
      configureChannels: false,
      catalog: {
        providers: () => ["google"],
        models: () => [
          { id: "gemini-2.5-flash-lite" },
          { id: "gemini-3.5-flash-lite" },
        ],
      },
      modelDiscovery: {
        supports: () => true,
        list: async () => ["gemini-3.5-flash-lite"],
      },
      io: {
        isInteractive: true,
        confirm: async () => true,
        secretQuestion: async () => "test-google-key",
        question: async (message) => { throw new Error(`unexpected question: ${message}`); },
        write: () => undefined,
      },
    })).rejects.toThrow("google/gemini-2.5-flash-lite is not available to the configured credential");
  });

  it("uses rich selector and confirmation hooks when the terminal UI provides them", async () => {
    const home = await temporaryDirectory();
    const prompts: string[] = [];
    const choicesSeen: string[][] = [];

    await runOnboarding({
      home,
      useMainForRouting: true,
      setupSandbox: false,
      configureChannels: false,
      catalog: {
        providers: () => ["zai", "openai", "anthropic"],
        models: (provider) => provider === "openai"
          ? [{ id: "gpt-featured", name: "GPT Featured", featured: true }, { id: "gpt-other" }]
          : [{ id: `${provider}-model` }],
      },
      io: {
        isInteractive: true,
        question: async () => { throw new Error("rich setup should not use numbered questions"); },
        select: async (input) => {
          prompts.push(input.message);
          choicesSeen.push(input.choices.map((choice) => choice.value));
          if (input.message === "Choose your provider") return "openai";
          if (input.message === "Choose a model") return "gpt-featured";
          if (input.message === "Permission mode") return "ask";
          throw new Error(`unexpected selector: ${input.message}`);
        },
        confirm: async () => false,
        write: () => undefined,
      },
    });

    expect(prompts).toEqual(["Choose your provider", "Choose a model", "Permission mode"]);
    expect(choicesSeen[0]?.slice(0, 3)).toEqual(["openai", "anthropic", "zai"]);
    expect(choicesSeen[1]?.[0]).toBe("gpt-featured");
  });

  it("reuses stored defaults when onboarding is run again", async () => {
    const home = await temporaryDirectory();
    const io = {
      isInteractive: false,
      question: async () => { throw new Error("unexpected prompt"); },
      write: () => undefined,
    };
    const probeSandbox = () => ({ available: false, status: "image-missing" as const });

    await runOnboarding({
      home,
      provider: "stored-provider",
      model: "stored-model",
      permission: "auto",
      setupSandbox: false,
      io,
      probeSandbox,
    });

    await updateRuntimeSettings({ selfRepository: "/srv/friday-source" }, home);

    await expect(runOnboarding({ home, setupSandbox: false, io, probeSandbox })).resolves.toEqual({
      modelProvider: "stored-provider",
      modelId: "stored-model",
      routingProvider: "stored-provider",
      routingModelId: "stored-model",
      permissionMode: "auto",
      hostPrivilegeMode: "none",
      timezone: expect.any(String),
      workspaceRoot: join(dirname(home), "FRIDAY-workspace"),
      selfRepository: "/srv/friday-source",
    });
  });


  it("persists a dedicated cheap routing model and can switch back to the main model", async () => {
    const home = await temporaryDirectory();
    const io = { isInteractive: false, question: async () => { throw new Error("unexpected prompt"); }, write: () => undefined };
    const probeSandbox = () => ({ available: false, status: "image-missing" as const });

    await runOnboarding({
      home,
      provider: "main-provider",
      model: "main-model",
      routingProvider: "cheap-provider",
      routingModel: "cheap-router",
      permission: "ask",
      setupSandbox: false,
      io,
      probeSandbox,
    });
    expect(parseRuntimeEnvironment(await readFile(getRuntimeEnvironmentPath(home), "utf8"))).toMatchObject({
      FRIDAY_MODEL_PROVIDER: "main-provider",
      FRIDAY_MODEL_ID: "main-model",
      FRIDAY_ROUTING_PROVIDER: "cheap-provider",
      FRIDAY_ROUTING_MODEL_ID: "cheap-router",
    });

    await runOnboarding({ home, useMainForRouting: true, setupSandbox: false, io, probeSandbox });
    const parsed = parseRuntimeEnvironment(await readFile(getRuntimeEnvironmentPath(home), "utf8"));
    expect(parsed.FRIDAY_ROUTING_PROVIDER).toBe("main-provider");
    expect(parsed.FRIDAY_ROUTING_MODEL_ID).toBe("main-model");
    expect(parsed.FRIDAY_MODEL_PROVIDER).toBe("main-provider");
  });

  it("fails closed on broad or symlinked runtime defaults", async () => {
    const broadHome = await temporaryDirectory();
    await runOnboarding({
      home: broadHome,
      provider: "provider",
      model: "model",
      permission: "ask",
      setupSandbox: false,
      io: {
        isInteractive: false,
        question: async () => { throw new Error("unexpected prompt"); },
        write: () => undefined,
      },
    });
    const broadPath = getRuntimeEnvironmentPath(broadHome);
    await chmod(broadPath, 0o644);
    await expect(loadRuntimeEnvironment({ home: broadHome, environment: {} }))
      .rejects.toThrow("runtime environment permissions are too broad");

    const symlinkHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    await runOnboarding({
      home: targetHome,
      provider: "provider",
      model: "model",
      permission: "ask",
      setupSandbox: false,
      io: {
        isInteractive: false,
        question: async () => { throw new Error("unexpected prompt"); },
        write: () => undefined,
      },
    });
    await symlink(getRuntimeEnvironmentPath(targetHome), getRuntimeEnvironmentPath(symlinkHome));
    await expect(loadRuntimeEnvironment({ home: symlinkHome, environment: {} }))
      .rejects.toThrow("runtime environment must not be a symlink");
  });


  it("fails closed when FRIDAY_HOME itself is broad or symlinked", async () => {
    const broadHome = await temporaryDirectory();
    await chmod(broadHome, 0o755);
    await expect(runOnboarding({
      home: broadHome,
      provider: "provider",
      model: "model",
      permission: "ask",
      setupSandbox: false,
      io: { isInteractive: false, question: async () => { throw new Error("unexpected prompt"); }, write: () => undefined },
    })).rejects.toThrow("FRIDAY home permissions are too broad");

    const realHome = await temporaryDirectory();
    const parent = await temporaryDirectory();
    const linkedHome = join(parent, "linked-home");
    await symlink(realHome, linkedHome);
    await expect(runOnboarding({
      home: linkedHome,
      provider: "provider",
      model: "model",
      permission: "ask",
      setupSandbox: false,
      io: { isInteractive: false, question: async () => { throw new Error("unexpected prompt"); }, write: () => undefined },
    })).rejects.toThrow("FRIDAY home must be a private directory");
  });

  it("rejects unsupported runtime environment keys", () => {
    expect(() => parseRuntimeEnvironment("FRIDAY_MODEL_PROVIDER=ok\nFRIDAY_API_KEY=nope\n"))
      .toThrow("Unsupported FRIDAY runtime environment key: FRIDAY_API_KEY");
  });

  it("preflights a custom endpoint before persisting or registering its descriptor", async () => {
    const home = await temporaryDirectory();
    const answers = [
      "1",
      "https://models.example.com/v1",
      "demo-model",
      "demo-provider",
      "n",
    ];
    const verified: Array<{ provider: string; apiKey?: string }> = [];

    await expect(runOnboarding({
      home,
      catalog: { providers: () => [], models: () => [] },
      setupSandbox: false,
      configureChannels: false,
      io: {
        isInteractive: true,
        question: async () => answers.shift() ?? (() => { throw new Error("unexpected prompt"); })(),
        write: () => undefined,
      },
      verifyCustomModel: async (descriptor, apiKey) => {
        verified.push({ provider: descriptor.provider, ...(apiKey === undefined ? {} : { apiKey }) });
        throw new Error("endpoint is unreachable");
      },
    })).rejects.toThrow("endpoint is unreachable");

    expect(verified).toEqual([{ provider: "custom:demo-provider" }]);
    await expect(readCustomModels(home)).resolves.toEqual([]);
  });

  it("keeps custom provider ids stable across normalization and persistence", async () => {
    const home = await temporaryDirectory();
    expect(normalizeCustomProvider("demo-provider")).toBe("custom:demo-provider");
    expect(normalizeCustomProvider("custom:demo-provider")).toBe("custom:demo-provider");

    await upsertCustomModel({
      provider: "custom:demo-provider",
      modelId: "demo-model",
      baseUrl: "https://models.example.com/v1",
    }, home);

    await expect(readCustomModels(home)).resolves.toMatchObject([
      { provider: "custom:demo-provider", modelId: "demo-model" },
    ]);
  });

  it("requires an exact operator for preconfigured enabled channels and rejects read-only or stale identities", async () => {
    const home = await temporaryDirectory();
    await updateSavedChannel("whatsapp", { enabled: true, accountId: "default", allowedSenderIds: ["operator-1"] }, home);
    const io = { isInteractive: false, question: async () => { throw new Error("unexpected prompt"); }, write: () => undefined };
    await expect(maybeManageChannels(io, home, false, true)).rejects.toThrow(/no exact trusted identity/);
    const stateDir = getPermissionsStateDir({ ...process.env, FRIDAY_HOME: home });
    upsertTrustedIdentity(stateDir, { channel: "whatsapp", accountId: "default", senderId: "old-operator", role: "operator" });
    await expect(maybeManageChannels(io, home, false, true)).rejects.toThrow(/no exact trusted identity/);
    upsertTrustedIdentity(stateDir, { channel: "whatsapp", accountId: "default", senderId: "operator-1", role: "read-only" });
    await expect(maybeManageChannels(io, home, false, true)).rejects.toThrow(/no exact trusted identity/);
  });

  it("accepts allow-all only when an exact trusted operator identity is already present", async () => {
    const home = await temporaryDirectory();
    await updateSavedChannel("whatsapp", { enabled: true, accountId: "default", allowAll: true }, home);
    const io = { isInteractive: false, question: async () => { throw new Error("unexpected prompt"); }, write: () => undefined };
    await expect(maybeManageChannels(io, home, false, true)).rejects.toThrow(/no exact trusted identity/);
    upsertTrustedIdentity(getPermissionsStateDir({ ...process.env, FRIDAY_HOME: home }), { channel: "whatsapp", accountId: "default", senderId: "allow-all-operator", role: "operator" });
    await expect(maybeManageChannels(io, home, false, true)).resolves.toBeUndefined();
  });

  it("explicitly pairs the first configured channel operator", async () => {
    const home = await temporaryDirectory();
    let menuVisits = 0;
    const io = {
      isInteractive: true,
      select: async (input: { message: string }) => {
        if (input.message === "Ingress channels") return menuVisits++ === 0 ? "whatsapp" : "__done__";
        if (input.message.startsWith("whatsapp ·")) return "enable";
        throw new Error(`unexpected selector: ${input.message}`);
      },
      question: async (message: string) => {
        if (message.startsWith("FRIDAY account id")) return "default";
        if (message.startsWith("Allowed sender IDs")) return "operator-1,reader-1";
        if (message.startsWith("Allowed group/channel IDs")) return "";
        if (message.startsWith("Loopback bridge port")) return "8765";
        if (message.startsWith("Exact sender ID to pair")) return "operator-1";
        throw new Error(`unexpected question: ${message}`);
      },
      confirm: async (message: string) => message.startsWith("Trust exactly whatsapp/default/operator-1"),
      write: () => undefined,
    };
    await maybeManageChannels(io, home, true, true);
    expect((await readSavedChannels(home)).channels.whatsapp).toMatchObject({ enabled: true, allowedSenderIds: ["operator-1", "reader-1"] });
    expect(loadTrustedIdentities(getPermissionsStateDir({ ...process.env, FRIDAY_HOME: home }))).toEqual([
      expect.objectContaining({ channel: "whatsapp", accountId: "default", senderId: "operator-1", role: "operator" }),
    ]);
  });

  it("rolls channel configuration back when initial operator trust is declined", async () => {
    const home = await temporaryDirectory();
    const io = {
      isInteractive: true,
      select: async (input: { message: string }) => input.message === "Ingress channels" ? "whatsapp" : "enable",
      question: async (message: string) => {
        if (message.startsWith("FRIDAY account id")) return "default";
        if (message.startsWith("Allowed sender IDs")) return "operator-1";
        if (message.startsWith("Allowed group/channel IDs")) return "";
        if (message.startsWith("Loopback bridge port")) return "8765";
        throw new Error(`unexpected question: ${message}`);
      },
      confirm: async () => false,
      write: () => undefined,
    };
    await expect(maybeManageChannels(io, home, true, true)).rejects.toThrow(/pairing was not confirmed/);
    expect((await readSavedChannels(home)).channels.whatsapp).toBeUndefined();
    expect(loadTrustedIdentities(getPermissionsStateDir({ ...process.env, FRIDAY_HOME: home }))).toEqual([]);
  });

  it("supports mandatory router-only bootstrap while keeping the main reasoning model optional", async () => {
    const home = await temporaryDirectory();
    await updateSavedChannel("whatsapp", { enabled: true, accountId: "default", allowedSenderIds: ["operator-1"] }, home);
    upsertTrustedIdentity(getPermissionsStateDir({ ...process.env, FRIDAY_HOME: home }), {
      channel: "whatsapp", accountId: "default", senderId: "operator-1", role: "operator",
    });
    const saved = await runRouterBootstrap({
      home,
      routingProvider: "router-provider",
      routingModel: "router-model",
      permission: "ask",
      hostPrivilegeMode: "none",
      timezone: "UTC",
      catalog: { providers: () => [], models: () => [] },
      io: { isInteractive: false, question: async () => { throw new Error("unexpected prompt"); }, write: () => undefined },
    });
    expect(saved.modelProvider).toBeUndefined();
    expect(saved).toMatchObject({
      routingProvider: "router-provider",
      routingModelId: "router-model",
      permissionMode: "ask",
      hostPrivilegeMode: "none",
    });
    expect(parseRuntimeEnvironment(await readFile(getRuntimeEnvironmentPath(home), "utf8"))).toMatchObject({
      FRIDAY_ROUTING_PROVIDER: "router-provider",
      FRIDAY_ROUTING_MODEL_ID: "router-model",
      FRIDAY_HOST_PRIVILEGE_MODE: "none",
    });
  });

});
