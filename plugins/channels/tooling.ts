import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const POSIX_SYSTEM_PATHS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"] as const;
const SETUP_ENV_ALLOWLIST = Object.freeze([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SYSTEMROOT", "WINDIR",
] as const);

function fridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_HOME?.trim();
  return resolve(configured || join(homedir(), ".friday"));
}

function bundledRoot(): string | undefined {
  const value = process.env.FRIDAY_BUNDLED_ROOT?.trim();
  return value ? resolve(value) : undefined;
}

function whatsappAssetsRoot(): string {
  const bundled = bundledRoot();
  return bundled
    ? join(bundled, "channels", "whatsapp")
    : resolve("plugins", "channels", "runtime", "bridge", "whatsapp");
}

export function channelToolingProcessEnv(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of SETUP_ENV_ALLOWLIST) {
    const value = environment[name];
    if (value !== undefined) env[name] = value;
  }
  if (process.platform !== "win32") {
    const current = environment.PATH?.trim();
    env.PATH = [...new Set([...(current ? current.split(":") : []), ...POSIX_SYSTEM_PATHS].filter(Boolean))].join(":");
  }
  return env;
}

function commandAvailable(command: string, args: readonly string[] = ["--version"]): boolean {
  const result = spawnSync(command, [...args], { stdio: "ignore", windowsHide: true, env: channelToolingProcessEnv() });
  return result.status === 0 && result.error === undefined;
}

async function run(command: string, args: readonly string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: channelToolingProcessEnv() });
    let tail = "";
    const capture = (chunk: Buffer, target: NodeJS.WriteStream): void => {
      target.write(chunk);
      tail = `${tail}${String(chunk)}`.slice(-8_000);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, process.stdout));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, process.stderr));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) { resolveRun(); return; }
      rejectRun(new Error([
        `${command} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? "unknown"}`}`,
        tail.trim() ? `Recent subprocess output:\n${tail.trim()}` : "",
      ].filter(Boolean).join("\n")));
    });
  });
}

export async function setupWhatsApp(home = fridayHome()): Promise<string> {
  const source = whatsappAssetsRoot();
  if (!existsSync(join(source, "package.json")) || !existsSync(join(source, "package-lock.json")) || !existsSync(join(source, "bridge.mjs"))) {
    throw new Error(`WhatsApp bridge assets are missing: ${source}`);
  }
  if (!commandAvailable("node") || !commandAvailable("npm")) {
    throw new Error("WhatsApp bridge setup requires a host Node.js/npm installation");
  }
  const root = join(home, "tooling", "whatsapp");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await rm(join(root, "node_modules"), { recursive: true, force: true });
  for (const file of ["bridge.mjs", "package.json", "package-lock.json"] as const) {
    await copyFile(join(source, file), join(root, file));
    await chmod(join(root, file), 0o600);
  }
  await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], root);
  return root;
}
