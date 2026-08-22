import { chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runOnboarding as runOnboardingRaw, type OnboardingOptions } from "../src/onboarding.js";
import { updateSavedChannel } from "../plugins/channels/config.js";
import { normalizeCustomProvider, readCustomModels, upsertCustomModel } from "../plugins/runtime-settings/custom-models.js";
import {
  getRuntimeEnvironmentPath,
  loadRuntimeEnvironment,
  parseRuntimeEnvironment,
  updateRuntimeSettings,
} from "../plugins/runtime-settings/runtime-env.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "friday-onboarding-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runOnboarding(options: OnboardingOptions = {}) {
  if (options.home) {
    await updateSavedChannel("whatsapp", { enabled: true, accountId: "default", allowAll: true }, options.home);
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
      FRIDAY_PERMISSION_MODE: "ask",
      FRIDAY_TIMEZONE: expect.any(String),
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
        return { status: "built" as const, image: "localhost/friday-sandbox:gen0" };
      },
    };

    await runOnboarding({ ...common, setupSandbox: false });
    expect(builds).toBe(0);
    await runOnboarding({ ...common, setupSandbox: true });
    expect(builds).toBe(1);
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
      permissionMode: "auto",
      timezone: expect.any(String),
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
    expect(parsed.FRIDAY_ROUTING_PROVIDER).toBeUndefined();
    expect(parsed.FRIDAY_ROUTING_MODEL_ID).toBeUndefined();
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
});
