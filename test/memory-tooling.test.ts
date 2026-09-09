import { describe, expect, it } from "vitest";
import { memoryToolingProcessEnv } from "../plugins/memory/tooling.js";

describe("memory embedding tooling", () => {
  it("does not pass model/provider credentials into BGE setup subprocesses", () => {
    const env = memoryToolingProcessEnv({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      HTTPS_PROXY: "https://proxy.example",
      OPENAI_API_KEY: "secret-openai",
      ANTHROPIC_API_KEY: "secret-anthropic",
      FRIDAY_VAULT_PASSWORD: "secret-vault",
    });
    expect(env.PYTHONNOUSERSITE).toBe("1");
    expect(env.PYTHONUNBUFFERED).toBe("1");
    expect(env.HTTPS_PROXY).toBe("https://proxy.example");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.FRIDAY_VAULT_PASSWORD).toBeUndefined();
  });
});
