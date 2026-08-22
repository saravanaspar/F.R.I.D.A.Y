import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = resolve("scripts", "release-version.mjs");

async function canonical(version: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [script, version, "--canonical"]);
  return result.stdout.trim();
}

describe("FRIDAY release version rules", () => {
  it("accepts one through six digits per numeric component", async () => {
    await expect(canonical("v2.3.04")).resolves.toBe("2.3.04");
    await expect(canonical("v123456.654321.000001")).resolves.toBe("123456.654321.000001");
    await expect(execFileAsync(process.execPath, [script, "v1234567.1.1", "--canonical"])).rejects.toThrow();
    await expect(execFileAsync(process.execPath, [script, "v2.3.4234567", "--canonical"])).rejects.toThrow();
  });

  it("treats trailing patch zeroes as the same decimal release identity", async () => {
    const one = await canonical("v2.3.4");
    expect(await canonical("v2.3.40")).toBe(one);
    expect(await canonical("v2.3.400000")).toBe(one);
  });

  it("preserves leading patch precision so v2.3.04 remains distinct", async () => {
    expect(await canonical("v2.3.04")).toBe("2.3.04");
    expect(await canonical("v2.3.040")).toBe("2.3.04");
    expect(await canonical("v2.3.00004")).toBe("2.3.00004");
    expect(await canonical("v2.3.04")).not.toBe(await canonical("v2.3.4"));
  });

  it("normalizes major/minor integer leading zeroes while preserving the displayed tag", async () => {
    expect(await canonical("v000002.000003.04")).toBe("2.3.04");
    const result = await execFileAsync(process.execPath, [script, "2.3.04"]);
    expect(JSON.parse(result.stdout)).toMatchObject({ tag: "v2.3.04", version: "2.3.04", canonical: "2.3.04" });
  });
});
