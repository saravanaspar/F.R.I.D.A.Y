import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";

function splitAndChain(command) {
  const steps = [];
  let current = "";
  let quote = undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === "&" && next === "&") {
      const step = current.trim();
      if (step) steps.push(step);
      current = "";
      index += 1;
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) steps.push(tail);
  return steps;
}

function timestamp() {
  return new Date().toISOString();
}

function runCapture(command, args = []) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", () => resolve("unavailable"));
    child.on("close", () => resolve(output.trim() || "unavailable"));
  });
}

function runStep(command, log) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: process.cwd(),
      env: process.env,
      shell: process.env.SHELL || "/bin/sh",
      stdio: ["inherit", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });

    child.on("error", (error) => {
      const message = `${error.stack ?? error.message}\n`;
      process.stderr.write(message);
      log.write(message);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        const message = `Process terminated by signal ${signal}\n`;
        process.stderr.write(message);
        log.write(message);
      }
      resolve(code ?? 1);
    });
  });
}

function emit(log, text = "") {
  const line = `${text}\n`;
  process.stdout.write(line);
  log.write(line);
}

const root = process.cwd();
const packagePath = join(root, "package.json");
const reportPath = join(root, "report.log");
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const verify = pkg.scripts?.verify;

if (typeof verify !== "string" || !verify.trim()) {
  throw new Error("package.json does not define scripts.verify");
}

const commands = [];
const preverify = pkg.scripts?.preverify;
if (typeof preverify === "string" && preverify.trim()) {
  commands.push({ name: "preverify", command: preverify.trim() });
}
for (const [index, command] of splitAndChain(verify).entries()) {
  commands.push({ name: `verify ${index + 1}`, command });
}

const log = createWriteStream(reportPath, { flags: "w" });
let failed = 0;
let passed = 0;

try {
  emit(log, "FRIDAY FULL VERIFY REPORT");
  emit(log, `Started: ${timestamp()}`);
  emit(log, `Repository: ${root}`);
  emit(log, `Package: ${pkg.name ?? "unknown"}@${pkg.version ?? "unknown"}`);
  emit(log, `Commit: ${await runCapture("git", ["rev-parse", "HEAD"])}`);
  emit(log, `Node: ${process.version}`);
  emit(log, `npm: ${await runCapture("npm", ["--version"])}`);
  emit(log, `Stages: ${commands.length}`);

  for (let index = 0; index < commands.length; index += 1) {
    const step = commands[index];
    emit(log);
    emit(log, "================================================================");
    emit(log, `START ${index + 1}/${commands.length}: ${step.name}`);
    emit(log, `COMMAND: ${step.command}`);
    emit(log, `Started: ${timestamp()}`);
    emit(log, "================================================================");

    const code = await runStep(step.command, log);

    emit(log);
    emit(log, "----------------------------------------------------------------");
    if (code === 0) {
      passed += 1;
      emit(log, `PASS: ${step.name}`);
    } else {
      failed += 1;
      emit(log, `FAIL: ${step.name} (exit code ${code})`);
    }
    emit(log, `Finished: ${timestamp()}`);
    emit(log, "----------------------------------------------------------------");
  }

  emit(log);
  emit(log, "================================================================");
  emit(log, "FINAL SUMMARY");
  emit(log, "================================================================");
  emit(log, `Passed stages: ${passed}`);
  emit(log, `Failed stages: ${failed}`);
  emit(log, `Finished: ${timestamp()}`);
  emit(log, `Report: ${reportPath}`);
  emit(log, "================================================================");
} finally {
  await new Promise((resolve) => log.end(resolve));
}

process.exitCode = failed > 0 ? 1 : 0;
