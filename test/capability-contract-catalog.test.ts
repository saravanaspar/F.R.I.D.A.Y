import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCapabilityContractCatalog } from "../plugins/self-improvement/capability-catalog.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("self-improvement plugin contract catalog", () => {
  it("discovers every configured ordinary plugin including contribution and hook extension points", async () => {
    const catalog = await buildCapabilityContractCatalog(
      process.cwd(),
      "system action status active-work",
    );
    expect(catalog.complete).toBe(true);
    expect(catalog.issues).toEqual([]);

    const config = JSON.parse(await readFile(join(process.cwd(), "friday.config.json"), "utf8")) as { plugins: string[] };
    const expected = config.plugins.filter((entry) => !entry.endsWith("/capabilities/index.ts")).length;
    expect(catalog.contracts).toHaveLength(expected);

    const system = catalog.contracts.find((entry) => entry.plugin === "system");
    expect(system?.capabilities).toEqual([]);
    expect(system?.contributions).toEqual(["system.action", "system.status", "system.active-work"]);
    expect(system?.publicTypes).toContain("SystemActionContribution");
    expect(system?.surfaces).toContainEqual({ kind: "contribution", id: "system.action", type: "SystemActionContribution" });
    expect(system?.publicApi).toContain("interface SystemActionContribution");

    const turnLoop = catalog.contracts.find((entry) => entry.plugin === "turn-loop");
    expect(turnLoop?.contributions).toContain("agent.tool");
    expect(turnLoop?.hooks).toContain("turn.ingress");
    expect(turnLoop?.surfaces).toContainEqual({ kind: "hook", id: "turn.ingress", type: "InboundTurn" });

    const auth = catalog.contracts.find((entry) => entry.plugin === "auth");
    expect(auth?.surfaces).toContainEqual({ kind: "capability", id: "model-credentials", type: "ModelCredentialService" });

    const scheduler = catalog.contracts.find((entry) => entry.plugin === "scheduler");
    expect(scheduler?.contributions).toContain("scheduler.action");

    const memory = catalog.contracts.find((entry) => entry.plugin === "memory");
    expect(memory?.publicTypes).toContain("MemoryStoreService");
    expect(memory?.publicTypes).toContain("MemoryEntry");
    expect(memory?.contributionInstances).toContainEqual({
      surface: "agent.tool",
      type: "AgentToolContribution",
      ids: [
        "memory-forget-note",
        "memory-index-project-docs",
        "memory-recall",
        "memory-remember-note",
        "memory-remember-relation",
      ],
      dynamic: 0,
    });
    expect(memory?.contributionInstances).toContainEqual({
      surface: "system.action",
      type: "SystemActionContribution",
      ids: [
        "memory.correct",
        "memory.embeddings.refresh",
        "memory.embeddings.status",
        "memory.preference.forget",
        "memory.preference.remember",
        "memory.preferences",
        "memory.review",
      ],
      dynamic: 0,
    });

    expect(memory?.contributionInstances).toContainEqual({
      surface: "system.status",
      type: "SystemStatusContribution",
      ids: ["memory"],
      dynamic: 0,
    });

    const toolCatalog = await buildCapabilityContractCatalog(process.cwd(), "agent tool extension");
    const toolTurnLoop = toolCatalog.contracts.find((entry) => entry.plugin === "turn-loop");
    expect(toolTurnLoop?.publicApi).toContain("interface AgentToolContribution");
  });


  it("keeps CI inspection and self-improvement discovery on the same auto-derived contract inventory", async () => {
    const catalog = await buildCapabilityContractCatalog(process.cwd(), "all plugin contracts");
    expect(catalog.complete).toBe(true);

    const stdout = execFileSync(process.execPath, ["scripts/check-plugin-boundaries.mjs", "--catalog-json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const inspected = JSON.parse(stdout) as {
      plugins: Array<{
        plugin: string;
        surfaces: Array<{ kind: string; id: string; type: string }>;
        publicTypes: string[];
        contributionInstances: Array<{ surface: string; type: string; ids: string[]; dynamic: number }>;
      }>;
    };

    expect(inspected.plugins.map((entry) => ({
      plugin: entry.plugin,
      surfaces: entry.surfaces,
      publicTypes: entry.publicTypes,
      contributionInstances: entry.contributionInstances.map(({ surface, type, ids, dynamic }) => ({ surface, type, ids, dynamic })),
    }))).toEqual(catalog.contracts.map((entry) => ({
      plugin: entry.plugin,
      surfaces: [...entry.surfaces],
      publicTypes: [...entry.publicTypes].sort((left, right) => left.localeCompare(right)),
      contributionInstances: [...entry.contributionInstances],
    })));
  });

  it("auto-discovers concrete contribution ownership and rejects duplicate static ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-contract-contributions-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "plugins", "owner"), { recursive: true });
    await mkdir(join(root, "plugins", "one"), { recursive: true });
    await mkdir(join(root, "plugins", "two"), { recursive: true });
    await writeFile(
      join(root, "friday.config.json"),
      `${JSON.stringify({ plugins: ["./plugins/owner/index.ts", "./plugins/one/index.ts", "./plugins/two/index.ts"] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(root, "plugins", "owner", "contract.ts"), [
      "export interface DemoContribution { readonly id: string; run(): void; }",
      "export const DEMO_CONTRIBUTION = defineContribution<DemoContribution>(\"demo.action\");",
      "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(join(root, "plugins", "owner", "index.ts"), "export {};\n", { mode: 0o600 });
    for (const plugin of ["one", "two"]) {
      await writeFile(join(root, "plugins", plugin, "contract.ts"), [
        `export interface ${plugin === "one" ? "One" : "Two"}Service { status(): string; }`,
        `export const ${plugin.toUpperCase()}_CAPABILITY = defineCapability<${plugin === "one" ? "One" : "Two"}Service>(\"${plugin}\");`,
        "",
      ].join("\n"), { mode: 0o600 });
      await writeFile(join(root, "plugins", plugin, "index.ts"), [
        "ctx.contribute(DEMO_CONTRIBUTION, { id: \"same\", run() {} });",
        "",
      ].join("\n"), { mode: 0o600 });
    }

    const catalog = await buildCapabilityContractCatalog(root, "demo action");
    expect(catalog.complete).toBe(false);
    expect(catalog.issues.join(" ")).toMatch(/duplicate static demo\.action contribution id same/i);
  });

  it("marks discovery incomplete when a configured ordinary plugin contract cannot be inspected", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-contract-catalog-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "friday.config.json"),
      `${JSON.stringify({ plugins: ["./plugins/missing/index.ts"] }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const catalog = await buildCapabilityContractCatalog(root, "reuse an existing plugin");
    expect(catalog.complete).toBe(false);
    expect(catalog.contracts).toEqual([]);
    expect(catalog.issues.join(" ")).toMatch(/missing.*contract\.ts/i);
  });

  it("keeps public-type discovery bounded above current large contracts", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-contract-type-limit-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "plugins", "demo"), { recursive: true });
    await writeFile(
      join(root, "friday.config.json"),
      `${JSON.stringify({ plugins: ["./plugins/demo/index.ts"] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const extraTypes = Array.from({ length: 64 }, (_, index) => `export type PublicType${index + 1} = string;`);
    await writeFile(
      join(root, "plugins", "demo", "contract.ts"),
      [
        "export interface DemoService { status(): string; }",
        ...extraTypes,
        "export const DEMO_CAPABILITY = defineCapability<DemoService>(\"demo\");",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(join(root, "plugins", "demo", "index.ts"), "export {};\n", { mode: 0o600 });

    const catalog = await buildCapabilityContractCatalog(root, "reuse demo");
    expect(catalog.complete).toBe(false);
    expect(catalog.issues.join(" ")).toMatch(/exported public type count exceeds the discovery limit of 64/i);
  });

  it("fails closed when a semantic public API is exported but never connected to a surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-contract-orphan-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "plugins", "demo"), { recursive: true });
    await writeFile(
      join(root, "friday.config.json"),
      `${JSON.stringify({ plugins: ["./plugins/demo/index.ts"] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(root, "plugins", "demo", "contract.ts"),
      [
        "export interface DemoService { status(): string; }",
        "export interface ForgottenService { forgotten(): void; }",
        "export const DEMO_CAPABILITY = defineCapability<DemoService>(\"demo\");",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const catalog = await buildCapabilityContractCatalog(root, "reuse demo");
    expect(catalog.complete).toBe(false);
    expect(catalog.issues.join(" ")).toMatch(/ForgottenService.*not reachable/i);
  });

  it("fails closed when a surface is defined but not exported from contract.ts", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-contract-hidden-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "plugins", "demo"), { recursive: true });
    await writeFile(
      join(root, "friday.config.json"),
      `${JSON.stringify({ plugins: ["./plugins/demo/index.ts"] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(root, "plugins", "demo", "contract.ts"),
      [
        "export interface DemoService { status(): string; }",
        "const DEMO_CAPABILITY = defineCapability<DemoService>(\"demo\");",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const catalog = await buildCapabilityContractCatalog(root, "reuse demo");
    expect(catalog.complete).toBe(false);
    expect(catalog.issues.join(" ")).toMatch(/exported const/i);
  });

});
