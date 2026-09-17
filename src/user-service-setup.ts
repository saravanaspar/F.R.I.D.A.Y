import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface UserServiceSetupOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly run?: ((command: string, args: readonly string[]) => Promise<void>) | undefined;
}

function serviceAsset(environment: NodeJS.ProcessEnv): string {
  const bundled = environment.FRIDAY_BUNDLED_ROOT?.trim();
  return bundled ? join(resolve(bundled), "systemd", "friday.service") : resolve("deploy", "systemd", "friday.service");
}

async function defaultRun(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { stdio: "inherit", env: process.env });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) { resolveRun(); return; }
      rejectRun(new Error(`${command} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? "unknown"}`}`));
    });
  });
}

export async function setupFridayUserService(options: UserServiceSetupOptions = {}): Promise<string> {
  if ((options.platform ?? process.platform) !== "linux") throw new Error("FRIDAY user-service setup is currently supported on Linux only");
  const environment = options.environment ?? process.env;
  const home = resolve(environment.HOME?.trim() || homedir());
  const source = serviceAsset(environment);
  if (!existsSync(source)) throw new Error(`FRIDAY user-service asset is missing: ${source}`);
  const directory = join(home, ".config", "systemd", "user");
  const target = join(directory, "friday.service");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await copyFile(source, target);
  await chmod(target, 0o600);
  const run = options.run ?? defaultRun;
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "friday.service"]);
  // Restart rather than relying on `enable --now`: rerunning setup after a
  // binary/unit update must replace the already-running process as well.
  await run("systemctl", ["--user", "restart", "friday.service"]);
  return target;
}
