import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  getFridayHome,
  readRuntimeSettings,
  RUNTIME_ENV_KEYS,
  updateRuntimeSettings,
  type RuntimeComputerBrowserMode,
  type RuntimeComputerSettings,
} from "../plugins/runtime-settings/runtime-env.js";
import {
  hasFridayPrivilegedHelper,
  installComputerHostDependencies,
  installFridayPrivilegeBroker,
} from "../plugins/host-privileges/privileged.js";

const BROWSER_FAMILIES = Object.freeze([
  Object.freeze({ id: "brave", direct: Object.freeze(["brave-browser-stable", "brave-browser", "brave"]), flatpak: "com.brave.Browser" }),
  Object.freeze({ id: "chrome", direct: Object.freeze(["google-chrome-stable", "google-chrome"]), flatpak: "com.google.Chrome" }),
  Object.freeze({ id: "chromium", direct: Object.freeze(["chromium", "chromium-browser"]), flatpak: "org.chromium.Chromium" }),
] as const);
const REQUIRED_COMMANDS = Object.freeze(["systemctl", "wmctrl", "xdotool", "xprop", "python3"]);
const COMPUTER_ENV_KEYS = Object.freeze(RUNTIME_ENV_KEYS.filter((key) => key.startsWith("FRIDAY_COMPUTER_")));
const LEGACY_COMPUTER_ENV_KEYS = Object.freeze(["FRIDAY_CHROMIUM_BIN"] as const);

export interface ComputerBrowserLaunch {
  readonly bin: string;
  readonly args: readonly string[];
  readonly label: string;
}

export interface ComputerSetupOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly uid?: number | undefined;
  readonly browserMode?: RuntimeComputerBrowserMode | undefined;
  readonly agentScreens?: number | undefined;
  readonly run?: ((command: string, args: readonly string[]) => Promise<string>) | undefined;
  readonly commandAvailable?: ((command: string) => boolean) | undefined;
  readonly accessibilityAvailable?: (() => boolean) | undefined;
  readonly hasPrivilegeHelper?: (() => Promise<boolean>) | undefined;
  readonly installPrivilegeBroker?: (() => Promise<void>) | undefined;
  readonly installDependencies?: (() => Promise<void>) | undefined;
}

function setupEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allow = [
    "PATH", "HOME", "DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP",
    "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "LANG", "LC_ALL", "FRIDAY_HOME",
  ] as const;
  const output: NodeJS.ProcessEnv = {};
  for (const name of allow) if (environment[name] !== undefined) output[name] = environment[name];
  return output;
}

async function defaultRun(command: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], env: setupEnvironment(environment) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${String(chunk)}`.slice(-64_000); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${String(chunk)}`.slice(-16_000); });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) { resolveRun(stdout); return; }
      rejectRun(new Error(`${command} ${args.join(" ")} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? "unknown"}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function defaultCommandAvailable(command: string, environment: NodeJS.ProcessEnv): boolean {
  const result = spawnSync("sh", ["-lc", `command -v "$1" >/dev/null 2>&1`, "sh", command], {
    stdio: "ignore",
    env: setupEnvironment(environment),
  });
  return result.status === 0 && result.error === undefined;
}

function defaultAccessibilityAvailable(environment: NodeJS.ProcessEnv): boolean {
  const result = spawnSync("python3", ["-c", "import pyatspi"], { stdio: "ignore", env: setupEnvironment(environment) });
  return result.status === 0 && result.error === undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 8) throw new Error("Computer agent screen count must be between 1 and 8");
  return parsed;
}

function legacyDesktopIndexes(environment: NodeJS.ProcessEnv): readonly number[] | undefined {
  const raw = environment.FRIDAY_COMPUTER_X11_AGENT_DESKTOPS?.trim();
  if (!raw) return undefined;
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (values.length < 1 || values.length > 8 || values.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  if (new Set(values).size !== values.length) return undefined;
  return Object.freeze(values);
}

function browserDetectionEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...environment };
  // Computer setup owns browser discovery. Old shell/systemd values from the
  // retired installer must not pin a user to Chromium or a stale managed
  // profile after upgrading to binary-owned setup.
  delete clean.FRIDAY_COMPUTER_BROWSER_BIN;
  delete clean.FRIDAY_COMPUTER_BROWSER_ARGS;
  delete clean.FRIDAY_CHROMIUM_BIN;
  return clean;
}

function configuredBrowserArgs(environment: NodeJS.ProcessEnv): readonly string[] {
  const raw = environment.FRIDAY_COMPUTER_BROWSER_ARGS?.trim();
  if (!raw) return Object.freeze([]);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("FRIDAY_COMPUTER_BROWSER_ARGS must be a JSON string array"); }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error("FRIDAY_COMPUTER_BROWSER_ARGS must be a JSON string array");
  return Object.freeze((parsed as string[]).slice(0, 16));
}

function browserFamilyOrder(defaultDesktop: string) {
  const normalized = defaultDesktop.trim().toLowerCase();
  const preferred = BROWSER_FAMILIES.find((family) => normalized.includes(family.flatpak.toLowerCase()) || normalized.includes(family.id));
  return preferred ? Object.freeze([preferred, ...BROWSER_FAMILIES.filter((family) => family !== preferred)]) : BROWSER_FAMILIES;
}

async function flatpakBrowser(
  appId: string,
  run: (command: string, args: readonly string[]) => Promise<string>,
  commandAvailable: (command: string) => boolean,
): Promise<ComputerBrowserLaunch | undefined> {
  if (!commandAvailable("flatpak")) return undefined;
  try {
    await run("flatpak", ["info", appId]);
    return Object.freeze({ bin: "flatpak", args: Object.freeze(["run", appId]), label: appId });
  } catch {
    return undefined;
  }
}

export async function detectComputerBrowser(
  environment: NodeJS.ProcessEnv,
  run: (command: string, args: readonly string[]) => Promise<string>,
  commandAvailable: (command: string) => boolean,
): Promise<ComputerBrowserLaunch> {
  const explicit = environment.FRIDAY_COMPUTER_BROWSER_BIN?.trim();
  if (explicit) {
    if (!commandAvailable(explicit)) throw new Error(`FRIDAY_COMPUTER_BROWSER_BIN is not executable: ${explicit}`);
    return Object.freeze({ bin: explicit, args: configuredBrowserArgs(environment), label: explicit });
  }
  let desktop = "";
  if (commandAvailable("xdg-settings")) {
    try { desktop = (await run("xdg-settings", ["get", "default-web-browser"])).trim(); } catch { /* friday-expected-control-flow: direct/Flatpak discovery below is the fallback */ }
  }
  const normalizedDesktop = desktop.trim().toLowerCase();
  for (const family of browserFamilyOrder(desktop)) {
    // An xdg desktop id that names a Flatpak app should win over an unrelated
    // system browser. This keeps FRIDAY on the same default browser/profile the
    // Human is actually using.
    if (normalizedDesktop.includes(family.flatpak.toLowerCase())) {
      const preferredFlatpak = await flatpakBrowser(family.flatpak, run, commandAvailable);
      if (preferredFlatpak) return preferredFlatpak;
    }
    for (const candidate of family.direct) {
      if (commandAvailable(candidate)) return Object.freeze({ bin: candidate, args: Object.freeze([]), label: candidate });
    }
    const packaged = await flatpakBrowser(family.flatpak, run, commandAvailable);
    if (packaged) return packaged;
  }
  throw new Error("No supported Chromium-family browser was found. Install Brave, Chrome, or Chromium, then rerun `friday setup computer`.");
}

function parseDesktopIndexes(output: string): readonly number[] {
  const indexes = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => Number(line.split(/\s+/)[0])).filter(Number.isSafeInteger);
  if (indexes.length < 1) throw new Error("wmctrl did not report any X11 virtual desktops");
  return Object.freeze(indexes);
}

async function ensureAgentDesktops(
  count: number,
  previous: readonly number[] | undefined,
  run: (command: string, args: readonly string[]) => Promise<string>,
): Promise<readonly number[]> {
  let existing = parseDesktopIndexes(await run("wmctrl", ["-d"]));
  const reusable = Object.freeze([...(previous ?? [])]
    .filter((index, position, values) => existing.includes(index) && values.indexOf(index) === position)
    .slice(0, count));
  if (reusable.length === count) return reusable;
  const missing = count - reusable.length;
  const targetCount = existing.length + missing;
  await run("wmctrl", ["-n", String(targetCount)]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    existing = parseDesktopIndexes(await run("wmctrl", ["-d"]));
    if (existing.length >= targetCount) break;
  }
  if (existing.length < targetCount) throw new Error(`X11 virtual desktop creation did not settle to ${targetCount} desktops`);
  return Object.freeze([...reusable, ...existing.slice(existing.length - missing)]);
}

function browserServiceAsset(environment: NodeJS.ProcessEnv): string {
  const bundled = environment.FRIDAY_BUNDLED_ROOT?.trim();
  return bundled ? join(resolve(bundled), "systemd", "friday-computer-browser.service") : resolve("deploy", "systemd", "friday-computer-browser.service");
}

async function removeRetiredComputerArtifacts(home: string, run: (command: string, args: readonly string[]) => Promise<string>): Promise<void> {
  try { await run("systemctl", ["--user", "disable", "--now", "friday-computer-headless.service"]); } catch { /* friday-expected-control-flow: old unit may not exist */ }
  try { await run("systemctl", ["--user", "stop", "friday-computer-share-*.service"]); } catch { /* friday-expected-control-flow: old units may not exist */ }
  await rm(join(home, ".config", "systemd", "user", "friday-computer-headless.service"), { force: true });
  await rm(join(home, ".config", "environment.d", "60-friday-computer.conf"), { force: true });
  await rm(join(home, ".config", "friday", "sway.conf"), { force: true });
  await rm(join(home, ".config", "friday", "sway-headless.conf"), { force: true });
  try {
    await run("systemctl", ["--user", "unset-environment", ...COMPUTER_ENV_KEYS, ...LEGACY_COMPUTER_ENV_KEYS]);
  } catch { /* friday-expected-control-flow: user manager may not have inherited the retired variables */ }
}

async function installManagedBrowserService(environment: NodeJS.ProcessEnv, home: string, run: (command: string, args: readonly string[]) => Promise<string>): Promise<void> {
  const source = browserServiceAsset(environment);
  if (!existsSync(source)) throw new Error(`Computer browser service asset is missing: ${source}`);
  const directory = join(home, ".config", "systemd", "user");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, "friday-computer-browser.service");
  await copyFile(source, target);
  await chmod(target, 0o600);
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "friday-computer-browser.service"]);
  await run("systemctl", ["--user", "restart", "friday-computer-browser.service"]);
}

async function disableManagedBrowserService(home: string, run: (command: string, args: readonly string[]) => Promise<string>): Promise<void> {
  try { await run("systemctl", ["--user", "disable", "--now", "friday-computer-browser.service"]); } catch { /* friday-expected-control-flow: first shared-mode setup has no unit */ }
  await rm(join(home, ".config", "systemd", "user", "friday-computer-browser.service"), { force: true });
  await run("systemctl", ["--user", "daemon-reload"]);
}

async function ensureComputerDependencies(
  settingsHostPrivilegeMode: "broker" | "none",
  commandAvailable: (command: string) => boolean,
  accessibilityAvailable: () => boolean,
  hasPrivilegeHelper: () => Promise<boolean>,
  installPrivilegeBroker: () => Promise<void>,
  installDependencies: () => Promise<void>,
): Promise<void> {
  const missing = REQUIRED_COMMANDS.filter((command) => !commandAvailable(command));
  if (!accessibilityAvailable()) missing.push("python3-pyatspi");
  if (missing.length === 0) return;
  if (settingsHostPrivilegeMode !== "broker") {
    throw new Error(`Computer needs host dependencies: ${[...new Set(missing)].join(", ")}. Enable the restricted broker with \`friday setup privileges broker\`, then rerun \`friday setup computer\`.`);
  }
  if (!(await hasPrivilegeHelper())) await installPrivilegeBroker();
  await installDependencies();
  const after = REQUIRED_COMMANDS.filter((command) => !commandAvailable(command));
  if (!accessibilityAvailable()) after.push("python3-pyatspi");
  if (after.length > 0) throw new Error(`Computer dependency installation completed but these requirements remain unavailable: ${[...new Set(after)].join(", ")}`);
}

export async function setupComputer(options: ComputerSetupOptions = {}): Promise<RuntimeComputerSettings> {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  if (platform !== "linux") throw new Error("FRIDAY Computer setup is currently supported on Linux X11 only");
  if (uid === 0) throw new Error("FRIDAY Computer setup must run as the desktop user, not root");
  const environment = options.environment ?? process.env;
  if (environment.XDG_SESSION_TYPE?.trim().toLowerCase() !== "x11") throw new Error(`FRIDAY Computer currently requires an X11 desktop session; detected ${environment.XDG_SESSION_TYPE?.trim() || "unknown"}`);
  if (!environment.DISPLAY?.trim()) throw new Error("FRIDAY Computer requires DISPLAY from the active X11 desktop session");
  const home = resolve(environment.HOME?.trim() || homedir());
  const fridayHome = getFridayHome(environment);
  const existing = await readRuntimeSettings(fridayHome);
  if (!existing) throw new Error("FRIDAY runtime settings do not exist; run `friday setup` first");
  const commandAvailable = options.commandAvailable ?? ((command: string) => defaultCommandAvailable(command, environment));
  const run = options.run ?? ((command: string, args: readonly string[]) => defaultRun(command, args, environment));
  const accessibilityAvailable = options.accessibilityAvailable ?? (() => defaultAccessibilityAvailable(environment));
  const migratedDesktopIndexes = existing.computer?.x11AgentDesktops ?? legacyDesktopIndexes(environment);
  await ensureComputerDependencies(
    existing.hostPrivilegeMode ?? "none",
    commandAvailable,
    accessibilityAvailable,
    options.hasPrivilegeHelper ?? hasFridayPrivilegedHelper,
    options.installPrivilegeBroker ?? installFridayPrivilegeBroker,
    options.installDependencies ?? installComputerHostDependencies,
  );
  const sessionVariables = ["DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]
    .filter((name) => environment[name]?.trim());
  if (sessionVariables.length > 0) await run("systemctl", ["--user", "import-environment", ...sessionVariables]);
  const browser = await detectComputerBrowser(browserDetectionEnvironment(environment), run, commandAvailable);
  const migratedScreenCount = migratedDesktopIndexes?.length ?? 1;
  const agentScreens = positiveInteger(options.agentScreens, existing.computer?.agentScreens ?? migratedScreenCount);
  const agentDesktops = await ensureAgentDesktops(agentScreens, migratedDesktopIndexes, run);
  const browserMode = options.browserMode ?? existing.computer?.browserMode ?? "managed-cdp";
  if (browserMode !== "shared" && browserMode !== "managed-cdp") throw new Error("Computer browser mode must be shared or managed-cdp");
  await removeRetiredComputerArtifacts(home, run);
  const managedProfile = join(fridayHome, "computer", "browser-profile");
  const computer: RuntimeComputerSettings = Object.freeze({
    provider: "linux-x11",
    sessionMode: "native-x11",
    browserMode,
    browserBin: browser.bin,
    ...(browser.args.length === 0 ? {} : { browserArgs: browser.args }),
    agentScreens,
    x11AgentDesktops: agentDesktops,
    ...(browserMode === "managed-cdp" ? {
      cdpUrl: "http://127.0.0.1:9222/",
      cdpPort: 9222,
      browserProfileDir: managedProfile,
    } : {}),
  });
  await updateRuntimeSettings({ computer }, fridayHome);
  if (browserMode === "managed-cdp") await installManagedBrowserService(environment, home, run);
  else await disableManagedBrowserService(home, run);
  process.stdout.write([
    "[computer] Linux X11 Computer configured.",
    `[computer] browser=${browser.label}`,
    `[computer] mode=${browserMode}`,
    `[computer] agent-desktops=${agentDesktops.join(",")}`,
    browserMode === "shared"
      ? "[computer] FRIDAY will open its own normal browser window in your existing browser profile. Existing Human windows remain open and current cookies/logins are shared."
      : `[computer] managed fallback profile=${managedProfile}`,
    "Restart FRIDAY, then run `friday doctor` before the first Computer task.",
    "",
  ].join("\n"));
  return computer;
}
