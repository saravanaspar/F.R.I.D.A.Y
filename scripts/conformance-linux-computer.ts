import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import type { ComputerBrowserAction, ComputerObservation } from "../plugins/computer/contract.js";
import { createLinuxSwayComputerAdapter } from "../plugins/computer/providers/linux-sway.js";

const execFileAsync = promisify(execFile);
const FIXTURE_TOKEN = "phase5-visible-token-9f31";
const NEVER_DISPATCH = "phase5-protected-input-must-never-dispatch";
const SAFE_TEXT = "phase5-safe-browser-input";

function fail(message: string): never {
  throw new Error(message);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

async function managerEnvironment(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const merged: NodeJS.ProcessEnv = { ...base };
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("systemctl", ["--user", "show-environment"], { encoding: "utf8" }));
  } catch {
    return merged;
  }
  const allowed = new Set([
    "FRIDAY_COMPUTER_SWAYSOCK",
    "FRIDAY_COMPUTER_CDP_URL",
    "FRIDAY_COMPUTER_CDP_PORT",
    "FRIDAY_COMPUTER_SESSION_MODE",
    "FRIDAY_COMPUTER_HUMAN_OUTPUT",
    "FRIDAY_COMPUTER_AGENT_OUTPUTS",
    "XDG_RUNTIME_DIR",
    "SWAYSOCK",
  ]);
  for (const line of stdout.split(/\r?\n/u)) {
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals);
    if (!allowed.has(key)) continue;
    const value = line.slice(equals + 1);
    if (!value.includes("\0")) merged[key] = value;
  }
  return merged;
}

function fixtureStartHtml(): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>FRIDAY Phase 5 CDP fixture</title></head>
  <body>
    <h1>PHASE5_CDP_READY</h1>
    <p id="provider-redaction">token=${FIXTURE_TOKEN}</p>
    <button id="safe-button" type="button">increment</button>
    <div id="count">count=0</div>
    <label>Safe input <input id="safe-input" name="note" autocomplete="off"></label>
    <div id="typed-output">typed=</div>
    <div id="key-output">key=</div>
    <label>Protected <input id="protected-entry" name="password" type="password" value="fixture-password-value"></label>
    <div id="captcha-panel" class="captcha">captcha=blue-car</div>
    <a id="next-link" href="/next">next</a>
    <script>
      const button = document.querySelector('#safe-button');
      const count = document.querySelector('#count');
      const safeInput = document.querySelector('#safe-input');
      const typedOutput = document.querySelector('#typed-output');
      const keyOutput = document.querySelector('#key-output');
      button.addEventListener('click', () => {
        const current = Number((count.textContent || 'count=0').split('=')[1] || '0');
        count.textContent = 'count=' + String(current + 1);
      });
      safeInput.addEventListener('input', () => { typedOutput.textContent = 'typed=' + safeInput.value; });
      safeInput.addEventListener('keydown', (event) => { keyOutput.textContent = 'key=' + event.key; });
    </script>
  </body>
</html>`;
}

function fixtureNextHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>FRIDAY next</title></head><body><h1>PHASE5_CDP_NEXT_READY</h1></body></html>`;
}

function serveFixture(request: IncomingMessage, response: ServerResponse): void {
  const path = request.url?.split("?", 1)[0] ?? "/";
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (path === "/" || path === "/start") {
    response.statusCode = 200;
    response.end(fixtureStartHtml());
    return;
  }
  if (path === "/next") {
    response.statusCode = 200;
    response.end(fixtureNextHtml());
    return;
  }
  if (path === "/favicon.ico") {
    response.statusCode = 204;
    response.end();
    return;
  }
  response.statusCode = 404;
  response.end("not found");
}

async function main(): Promise<void> {
  if (process.platform !== "linux") fail(`Linux Computer conformance requires Linux, got ${process.platform}`);
  const environment = await managerEnvironment(process.env);
  const adapter = createLinuxSwayComputerAdapter({ environment });
  const snapshot = await adapter.snapshot();
  requireCondition(snapshot.availability === "online", `Linux Computer is not online: ${snapshot.availability}`);
  requireCondition(snapshot.browser?.running === true, "Chromium CDP browser supervisor is not running");
  const screen = snapshot.screens.find((candidate) => candidate.kind === "agent");
  requireCondition(screen, "No Agent screen is available for CDP conformance");
  requireCondition(adapter.runBrowserAction, "Linux provider does not expose browser actions");

  const server = createServer(serveFixture);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    requireCondition(address && typeof address !== "string", "Fixture server did not bind a TCP address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const run = async (action: ComputerBrowserAction): Promise<ComputerObservation> => {
      const result = await adapter.runBrowserAction!({
        screenId: screen.id,
        controlGeneration: 1,
        action,
        automationOrder: ["cdp"],
      });
      requireCondition(result.mode === "cdp", `Expected CDP mode, got ${result.mode}`);
      return result.observation;
    };

    let observation = await run({ kind: "navigate", url: `${baseUrl}/start?token=${FIXTURE_TOKEN}` });
    requireCondition(observation.url?.includes("token=[REDACTED]") === true, "Sensitive URL query was not redacted");
    requireCondition(!observation.url?.includes(FIXTURE_TOKEN), "Sensitive URL query escaped provider redaction");
    requireCondition(observation.domSummary?.includes("PHASE5_CDP_READY") === true, "Navigation did not settle on the fixture page");
    requireCondition(!observation.domSummary?.includes(FIXTURE_TOKEN), "Synthetic token escaped DOM redaction");
    requireCondition(!observation.domSummary?.includes("blue-car"), "Synthetic CAPTCHA escaped DOM redaction");
    requireCondition(!observation.domSummary?.includes("fixture-password-value"), "Synthetic protected input escaped DOM redaction");

    observation = await run({ kind: "click", target: "#safe-button" });
    requireCondition(observation.domSummary?.includes("count=1") === true, "CDP mouse click did not reach the live page");

    observation = await run({ kind: "type", target: "#safe-input", text: SAFE_TEXT, sensitive: false });
    requireCondition(observation.domSummary?.includes(`typed=${SAFE_TEXT}`) === true, "CDP text input did not reach the focused live element");

    observation = await run({ kind: "press", key: "Enter" });
    requireCondition(observation.domSummary?.includes("key=Enter") === true, "CDP key press did not reach the focused live element");

    let protectedRejected = false;
    try {
      await run({ kind: "type", target: "#protected-entry", text: NEVER_DISPATCH, sensitive: false });
    } catch (error) {
      protectedRejected = error instanceof Error && /protected browser input requires human takeover/i.test(error.message);
      if (!protectedRejected) throw error;
    }
    requireCondition(protectedRejected, "Provider did not reject DOM-discovered protected input");
    observation = await adapter.observeScreen(screen.id, 1);
    requireCondition(!observation.domSummary?.includes(NEVER_DISPATCH), "Rejected protected input appeared in a later observation");

    observation = await run({ kind: "click", target: "#next-link" });
    requireCondition(observation.url?.startsWith(`${baseUrl}/next`) === true, "CDP click navigation did not settle on the destination URL");
    requireCondition(observation.domSummary?.includes("PHASE5_CDP_NEXT_READY") === true, "CDP click navigation did not settle on the destination DOM");

    await run({ kind: "navigate", url: "about:blank" });
    process.stdout.write("PASS: real Chromium CDP navigate/click/type/press and provider safety conformance are healthy.\n");
    process.stdout.write(`SCREEN=${screen.id}\n`);
    process.stdout.write(`CDP=${environment.FRIDAY_COMPUTER_CDP_URL?.trim() || "http://127.0.0.1:9222/"}\n`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`FAIL: ${message}\n`);
  process.exitCode = 1;
});
