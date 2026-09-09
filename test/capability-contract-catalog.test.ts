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
      }>;
    };

    expect(inspected.plugins.map((entry) => ({
      plugin: entry.plugin,
      surfaces: entry.surfaces,
      publicTypes: entry.publicTypes,
    }))).toEqual(catalog.contracts.map((entry) => ({
      plugin: entry.plugin,
      surfaces: [...entry.surfaces],
      publicTypes: [...entry.publicTypes].sort((left, right) => left.localeCompare(right)),
    })));
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
