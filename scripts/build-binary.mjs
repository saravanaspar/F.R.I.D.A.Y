#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { discoverBinaryAssets } from "./binary-assets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildVersion = process.env.FRIDAY_BUILD_VERSION?.trim() || "0.1.0-dev";
const outputRoot = resolve(projectRoot, process.env.FRIDAY_BINARY_OUTPUT_DIR || "build/binary");
const staging = join(outputRoot, ".staging");
const bundle = join(staging, "friday.cjs");
const blob = join(staging, "friday.blob");
const configPath = join(staging, "sea-config.json");
const outputName = process.platform === "win32" ? "friday.exe" : "friday";
const output = join(outputRoot, outputName);

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: "inherit", env: environment });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}`);
}

function nativeAddon() {
  const root = join(projectRoot, "node_modules", "zeromq", "build", process.platform, process.arch, "node");
  if (!existsSync(root)) throw new Error(`No ZeroMQ native build exists for ${process.platform}/${process.arch}`);
  const abi = Number(process.versions.modules);
  const libc = process.platform === "linux"
    ? (process.report?.getReport().header.glibcVersionRuntime ? "glibc" : "musl")
    : process.platform === "darwin" ? "libc" : "msvc";
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${libc}-`) && entry.name.endsWith("-Release"))
    .map((entry) => ({ entry: entry.name, abi: Number(entry.name.split("-")[1]) }))
    .filter((entry) => Number.isFinite(entry.abi) && entry.abi <= abi)
    .sort((left, right) => right.abi - left.abi);
  const selected = candidates[0];
  if (!selected) throw new Error(`No compatible ZeroMQ addon exists for ${process.platform}/${process.arch}, ABI ${abi}`);
  const path = join(root, selected.entry, "addon.node");
  if (!existsSync(path)) throw new Error(`ZeroMQ addon is missing: ${path}`);
  return path;
}

function addAsset(assets, key, path) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Binary asset is missing: ${path}`);
  assets[`runtime/${key.split(sep).join("/")}`] = path;
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(staging, { recursive: true, mode: 0o700 });

const assets = {};
addAsset(assets, join("native", "zeromq.node"), nativeAddon());
for (const asset of discoverBinaryAssets(projectRoot)) addAsset(assets, asset.target, asset.source);

const inputHash = createHash("sha256");
inputHash.update(process.version);
inputHash.update(buildVersion);
for (const [key, path] of Object.entries(assets).sort(([left], [right]) => left.localeCompare(right))) {
  inputHash.update(key);
  inputHash.update(readFileSync(path));
}
const buildId = inputHash.digest("hex").slice(0, 20);

await build({
  entryPoints: [join(projectRoot, "src", "sea-entry.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: `node${process.versions.node.split(".")[0]}`,
  sourcemap: false,
  minify: false,
  logOverride: { "empty-import-meta": "silent" },
  define: {
    __FRIDAY_BINARY_BUILD_ID__: JSON.stringify(buildId),
    __FRIDAY_VERSION__: JSON.stringify(buildVersion),
  },
  plugins: [{
    name: "friday-sea-zeromq",
    setup(esbuild) {
      esbuild.onLoad({ filter: /node_modules[\\/]zeromq[\\/]lib[\\/]load-addon\.js$/ }, () => ({
        loader: "js",
        contents: `"use strict"; Object.defineProperty(exports, "__esModule", { value: true });\n` +
          `const path = require("node:path");\n` +
          `const loadFile = require("node:module").createRequire(process.execPath);\n` +
          `const root = process.env.FRIDAY_BUNDLED_ROOT;\n` +
          `if (!root) throw new Error("FRIDAY bundled runtime was not extracted before ZeroMQ loaded");\n` +
          `exports.default = loadFile(path.join(root, "native", "zeromq.node"));\n`,
      }));
    },
  }],
});

writeFileSync(configPath, `${JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}, null, 2)}\n`, { mode: 0o600 });

run(process.execPath, ["--experimental-sea-config", configPath]);
copyFileSync(process.execPath, output);
if (process.platform === "darwin") run("codesign", ["--remove-signature", output]);

const postjectArgs = [
  join(projectRoot, "node_modules", "postject", "dist", "cli.js"),
  output,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
run(process.execPath, postjectArgs);

if (process.platform === "darwin") run("codesign", ["--sign", "-", output]);
if (process.platform !== "win32") chmodSync(output, 0o755);
run(output, ["--version"], { ...process.env, FRIDAY_HOME: join(staging, "smoke-home") });
rmSync(staging, { recursive: true, force: true });
process.stdout.write(`Built ${relative(projectRoot, output)} (${buildId})\n`);
