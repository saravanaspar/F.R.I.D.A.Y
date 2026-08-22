#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assetByRole, projectRoot } from "./binary-assets.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function parseArgs() {
  const args = process.argv.slice(2);
  let tag = process.env.FRIDAY_SANDBOX_IMAGE_TAG?.trim() || "friday-sandbox:ci";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tag") {
      const value = args[index + 1];
      if (!value?.trim()) throw new Error("--tag requires a non-empty image tag");
      tag = value.trim();
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { tag };
}

function main() {
  const { tag } = parseArgs();
  const containerfile = assetByRole("sandbox-containerfile");
  const context = containerfile.context ?? dirname(containerfile.source);
  const result = spawnSync("docker", ["build", "--file", containerfile.source, "--tag", tag, context], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker build failed with exit code ${result.status ?? "unknown"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
