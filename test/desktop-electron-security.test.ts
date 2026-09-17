import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("desktop Electron security helpers", () => {
  it("only derives credential paths from bounded device ids", () => {
    const security = require("../apps/desktop/electron/security.cjs") as {
      credentialFileName(deviceId: string): string;
      validatedSigningPayload(payload: string): string;
    };
    expect(security.credentialFileName("desktop-1")).toBe("credential-device%3Adesktop-1");
    expect(() => security.credentialFileName("../../secrets")).toThrow(/device id/i);
    expect(security.validatedSigningPayload('friday-client-auth-v1:{"path":"/v1/projects"}')).toContain("friday-client-auth-v1:");
    expect(() => security.validatedSigningPayload("sign arbitrary data")).toThrow(/signing payload/i);
  });

  it("accepts only the exact packaged renderer URL", () => {
    const security = require("../apps/desktop/electron/security.cjs") as {
      rendererUrl(indexPath: string): string;
      isTrustedRendererUrl(url: string, indexPath: string): boolean;
    };
    const indexPath = join("/tmp", "friday", "index.html");
    const trusted = security.rendererUrl(indexPath);
    expect(security.isTrustedRendererUrl(trusted, indexPath)).toBe(true);
    expect(security.isTrustedRendererUrl("https://attacker.invalid/", indexPath)).toBe(false);
  });
});
