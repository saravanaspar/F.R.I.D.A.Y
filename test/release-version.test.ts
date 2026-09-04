import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = resolve("scripts", "release-version.mjs");

async function canonical(version: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [script, version, "--canonical"]);
  return result.stdout.trim();
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function versionFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "friday-release-version-"));
  const workspace = join(root, "packages", "core");
  const embedded = join(workspace, "embedded");
  await mkdir(embedded, { recursive: true });
  await Promise.all([
    writeJson(join(root, "package.json"), {
      name: "friday",
      version: "1.0.0-dev",
      private: true,
      workspaces: ["packages/*"],
      dependencies: { "@friday/core": "1.0.0-dev" },
    }),
    writeJson(join(workspace, "package.json"), {
      name: "@friday/core",
      version: "1.0.0-dev",
      private: true,
    }),
    writeJson(join(workspace, "friday.binary-assets.json"), {
      schema: 1,
      assets: [
        { source: "embedded/package.json", target: "fixture/package.json" },
        { source: "embedded/package-lock.json", target: "fixture/package-lock.json" },
      ],
    }),
    writeJson(join(embedded, "package.json"), {
      name: "friday-embedded",
      version: "1.0.0-dev",
      private: true,
    }),
    writeJson(join(embedded, "package-lock.json"), {
      name: "friday-embedded",
      version: "1.0.0-dev",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "friday-embedded", version: "1.0.0-dev" } },
    }),
    writeJson(join(root, "package-lock.json"), {
      name: "friday",
      version: "1.0.0-dev",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "friday",
          version: "1.0.0-dev",
          workspaces: ["packages/*"],
          dependencies: { "@friday/core": "1.0.0-dev" },
        },
        "node_modules/@friday/core": { resolved: "packages/core", link: true },
        "packages/core": { name: "@friday/core", version: "1.0.0-dev" },
      },
    }),
  ]);
  return root;
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

  it("keeps all repository package manifests, local dependencies, and lockfiles synchronized", async () => {
    const result = await execFileAsync(process.execPath, [script, "--check-packages"]);
    expect(result.stdout).toContain("Release package versions: PASS");
    expect(result.stdout).toContain("version 1.0.0-dev");
  });

  it("sets one release version across workspaces, embedded packages, dependencies, and lockfiles", async () => {
    const root = await versionFixture();
    try {
      const setResult = await execFileAsync(process.execPath, [script, "--set", "1.2.3", "--root", root]);
      expect(setResult.stdout).toContain("Synchronized 3 package manifests and 2 lockfiles to 1.2.3");

      const [rootPackage, workspacePackage, embeddedPackage, rootLock, embeddedLock] = await Promise.all([
        readFile(join(root, "package.json"), "utf8").then(JSON.parse),
        readFile(join(root, "packages/core/package.json"), "utf8").then(JSON.parse),
        readFile(join(root, "packages/core/embedded/package.json"), "utf8").then(JSON.parse),
        readFile(join(root, "package-lock.json"), "utf8").then(JSON.parse),
        readFile(join(root, "packages/core/embedded/package-lock.json"), "utf8").then(JSON.parse),
      ]);
      expect(rootPackage).toMatchObject({ version: "1.2.3", dependencies: { "@friday/core": "1.2.3" } });
      expect(workspacePackage.version).toBe("1.2.3");
      expect(embeddedPackage.version).toBe("1.2.3");
      expect(rootLock).toMatchObject({
        version: "1.2.3",
        packages: {
          "": { version: "1.2.3", dependencies: { "@friday/core": "1.2.3" } },
          "packages/core": { version: "1.2.3" },
        },
      });
      expect(embeddedLock).toMatchObject({ version: "1.2.3", packages: { "": { version: "1.2.3" } } });

      const checkResult = await execFileAsync(process.execPath, [script, "1.2.3", "--check-packages", "--root", root]);
      expect(checkResult.stdout).toContain("Release package versions: PASS");

      workspacePackage.version = "1.2.4";
      await writeJson(join(root, "packages/core/package.json"), workspacePackage);
      const failed = await execFileAsync(process.execPath, [script, "--check-packages", "--root", root])
        .then(() => undefined, (error: unknown) => error as { stderr?: string });
      expect(failed?.stderr).toContain('packages/core/package.json is "1.2.4"; expected "1.2.3"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects release versions that npm package metadata cannot represent", async () => {
    const root = await versionFixture();
    try {
      const failed = await execFileAsync(process.execPath, [script, "--set", "2.3.04", "--root", root])
        .then(() => undefined, (error: unknown) => error as { stderr?: string });
      expect(failed?.stderr).toContain("cannot be stored in package.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preflights lockfiles before writing any version changes", async () => {
    const root = await versionFixture();
    try {
      const manifestPath = join(root, "package.json");
      const before = await readFile(manifestPath, "utf8");
      await rm(join(root, "package-lock.json"));

      const failed = await execFileAsync(process.execPath, [script, "--set", "1.2.3", "--root", root])
        .then(() => undefined, (error: unknown) => error as { stderr?: string });
      expect(failed?.stderr).toContain("package-lock.json is missing");
      await expect(readFile(manifestPath, "utf8")).resolves.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
