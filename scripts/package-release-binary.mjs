#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:process";
import { join, resolve } from "node:path";

if (platform === "win32") {
  throw new Error("Windows release packaging is disabled until FRIDAY's private-state permission model has native Windows ACL enforcement");
}
const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;
if (!os || !cpu) throw new Error(`Unsupported release target: ${platform}/${arch}`);

const source = resolve("build", "binary", "friday");
if (!existsSync(source)) throw new Error(`FRIDAY binary is missing: ${source}; run npm run build:binary first`);
const outDir = resolve("build", "release");
mkdirSync(outDir, { recursive: true });
const target = join(outDir, `friday-${os}-${cpu}`);
copyFileSync(source, target);
const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
writeFileSync(`${target}.sha256`, `${digest}  ${target.split(/[\\/]/).pop()}\n`, { mode: 0o644 });
process.stdout.write(`${target}\n`);
