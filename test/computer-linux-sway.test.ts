import { describe, expect, it } from "vitest";
import { createComputerService } from "../plugins/computer/service.js";
import {
  createLinuxSwayComputerAdapter,
  type LinuxCdpClient,
  type LinuxCdpTarget,
} from "../plugins/computer/providers/linux-sway.js";

const SWAY_OUTPUTS = JSON.stringify([
  {
    name: "DP-1",
    make: "DisplayCo",
    model: "Panel",
    active: true,
    scale: 1,
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
  },
  {
    name: "HEADLESS-1",
    make: "headless",
    model: "FRIDAY Agent",
    active: true,
    scale: 1,
    rect: { x: 1920, y: 0, width: 1280, height: 720 },
  },
]);

function fakeCdp(options: {
  readonly activeProtected?: boolean;
  readonly elementProtected?: boolean;
} = {}): LinuxCdpClient & { readonly calls: Array<{ targetId?: string; method: string; params?: Readonly<Record<string, unknown>> }> } {
  const calls: Array<{ targetId?: string; method: string; params?: Readonly<Record<string, unknown>> }> = [];
  const targets: LinuxCdpTarget[] = [{
    id: "human-tab",
    title: "Human browser",
    url: "https://example.com/",
    type: "page",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/human-tab",
  }];
  let nextUrl = "https://example.com/dashboard?token=provider-secret#fragment";
  return {
    calls,
    async targets() { return targets.map((target) => ({ ...target })); },
    async browserCommand(method, params) {
      calls.push(params === undefined ? { method } : { method, params });
      if (method !== "Target.createTarget") throw new Error(`unexpected browser command: ${method}`);
      targets.push({
        id: "agent-tab",
        title: "OTP 123456 verification code",
        url: nextUrl,
        type: "page",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/agent-tab",
      });
      return { targetId: "agent-tab" };
    },
    async targetCommand(targetId, method, params) {
      calls.push(params === undefined ? { targetId, method } : { targetId, method, params });
      if (method === "Page.navigate") {
        nextUrl = String(params?.url ?? nextUrl);
        const target = targets.find((candidate) => candidate.id === targetId);
        if (target) Object.assign(target, { url: nextUrl });
        return { frameId: "frame-1" };
      }
      if (method === "Input.insertText" || method === "Input.dispatchKeyEvent" || method === "Input.dispatchMouseEvent") return {};
      if (method === "Runtime.callFunctionOn") {
        const functionDeclaration = String(params?.functionDeclaration ?? "");
        if (functionDeclaration.includes("getBoundingClientRect")) {
          return {
            result: {
              value: {
                found: true,
                protected: options.elementProtected === true,
                actionable: true,
                x: 320,
                y: 240,
              },
            },
          };
        }
        return { result: { value: { protected: options.activeProtected === true, expected: true } } };
      }
      if (method !== "Runtime.evaluate") throw new Error(`unexpected target command: ${method}`);
      const expression = String(params?.expression ?? "");
      if (expression === "location.href") return { result: { value: nextUrl } };
      if (expression.includes("readyState: document.readyState")) {
        return { result: { value: { href: nextUrl, readyState: "complete" } } };
      }
      if (expression.includes("const el = document.activeElement;")) {
        return { result: { value: { protected: options.activeProtected === true, expected: true } } };
      }
      if (expression.includes("getBoundingClientRect")) {
        return {
          result: {
            value: {
              found: true,
              protected: options.elementProtected === true,
              actionable: true,
              x: 320,
              y: 240,
            },
          },
        };
      }
      return {
        result: {
          value: "Account password=hunter2 otp=123456 verification code is 654321 token=abc123 captcha=blue-car value=plaintext Visible dashboard",
        },
      };
    },
  };
}

function adapterFixture(options: {
  readonly uid?: number;
  readonly executable?: (command: string) => Promise<boolean>;
  readonly activeProtected?: boolean;
  readonly elementProtected?: boolean;
} = {}) {
  const cdp = fakeCdp({
    ...(options.activeProtected === undefined ? {} : { activeProtected: options.activeProtected }),
    ...(options.elementProtected === undefined ? {} : { elementProtected: options.elementProtected }),
  });
  const adapter = createLinuxSwayComputerAdapter({
    environment: {
      PATH: "/usr/bin:/bin",
      HOME: "/home/friday",
      FRIDAY_HOME: "/home/friday/.friday",
      FRIDAY_COMPUTER_SWAYSOCK: "/run/user/1000/sway-ipc.test.sock",
      FRIDAY_COMPUTER_CDP_URL: "http://127.0.0.1:9222/",
      FRIDAY_COMPUTER_HUMAN_OUTPUT: "DP-1",
    },
    platform: "linux",
    uid: options.uid ?? 1000,
    cdp,
    executable: options.executable ?? (async () => true),
    async runCommand(command, args) {
      if (command !== "swaymsg") return { ok: false, stdout: "", stderr: `unexpected command ${command}` };
      expect(args).toContain("get_outputs");
      return { ok: true, stdout: SWAY_OUTPUTS, stderr: "" };
    },
    async listDirectory(path) {
      if (path === "/proc") return ["101", "202"];
      return [];
    },
    async readText(path) {
      if (path === "/proc/stat") return "cpu  100 0 50 850 0 0 0 0 0 0\n";
      if (path === "/proc/101/comm") return "chromium\n";
      if (path === "/proc/101/cmdline") return "chromium\0--type=renderer\0";
      if (path === "/proc/202/comm") return "node\n";
      if (path === "/proc/202/cmdline") return "node\0friday\0";
      throw new Error(`unexpected read: ${path}`);
    },
    now: () => new Date("2026-09-12T05:45:00.000Z"),
  });
  return { adapter, cdp };
}

describe("Phase 5 Linux/Sway Computer provider", () => {
  it("discovers Human/headless Agent outputs and reports the shared Chromium supervisor", async () => {
    const { adapter } = adapterFixture();
    const snapshot = await adapter.snapshot();

    expect(snapshot.availability).toBe("online");
    expect(snapshot.screens).toEqual([
      expect.objectContaining({ id: "DP-1", kind: "human", width: 1920, height: 1080 }),
      expect.objectContaining({ id: "HEADLESS-1", kind: "agent", width: 1280, height: 720 }),
    ]);
    expect(snapshot.browser).toMatchObject({
      running: true,
      persistentProfile: true,
      tabs: [expect.objectContaining({ id: "human-tab", url: "https://example.com/" })],
      windows: [expect.objectContaining({ owner: "human", screenId: "DP-1" })],
    });
    expect(snapshot.resources.browserRendererCount).toBe(1);
    await expect(adapter.doctor?.()).resolves.toEqual([]);
  });

  it("allocates a CDP window on the Agent output and attests only after provider-side secret/CAPTCHA redaction", async () => {
    const { adapter, cdp } = adapterFixture();
    const service = createComputerService({ pollIntervalMs: 60_000 });
    await service.registerNode(adapter);
    const grant = await service.requestScreen({ ownerId: "job-linux", preferredNodeId: "linux-local", requireBrowser: true });
    if (grant.state !== "acquired") throw new Error("expected Linux Computer screen grant");

    const result = await service.runBrowserAction(
      grant.screenLease.id,
      "job-linux",
      grant.controlLease.generation,
      { kind: "navigate", url: "https://example.com/work?token=visible-to-page" },
    );

    expect(result.mode).toBe("cdp");
    expect(cdp.calls).toContainEqual(expect.objectContaining({
      method: "Target.createTarget",
      params: expect.objectContaining({ left: 1920, top: 0, width: 1280, height: 720, newWindow: true }),
    }));
    expect(result.observation.safety).toEqual({
      protectedInputOmitted: true,
      keystrokesOmitted: true,
      captchaOmitted: true,
      sensitiveScreenshotOmitted: true,
    });
    expect(result.observation.screenshotArtifactRef).toBeUndefined();
    expect(result.observation.domSummary).toContain("password=[REDACTED]");
    expect(result.observation.domSummary).toContain("otp=[REDACTED]");
    expect(result.observation.domSummary).toContain("token=[REDACTED]");
    expect(result.observation.domSummary).toContain("[CAPTCHA CONTENT OMITTED]");
    expect(result.observation.domSummary).not.toContain("hunter2");
    expect(result.observation.domSummary).not.toContain("123456");
    expect(result.observation.domSummary).not.toContain("654321");
    expect(result.observation.domSummary).not.toContain("abc123");
    expect(result.observation.domSummary).not.toContain("blue-car");
    expect(result.observation.url).toContain("token=[REDACTED]");
    expect(result.observation.url).not.toContain("visible-to-page");
    expect(result.observation.tabs[0]?.title).toBe("[SENSITIVE PAGE TITLE OMITTED]");

    await service.close();
  });

  it("rejects provider-level protected typing targets even when the caller marks the text non-sensitive", async () => {
    const { adapter } = adapterFixture();
    await adapter.snapshot();
    await expect(adapter.runBrowserAction?.({
      screenId: "HEADLESS-1",
      controlGeneration: 1,
      action: { kind: "type", target: "input[name=password]", text: "should-never-be-dispatched", sensitive: false },
      automationOrder: ["cdp"],
    })).rejects.toThrow(/protected browser input requires human takeover/);
  });

  it("rejects key presses while a protected input owns browser focus", async () => {
    const { adapter, cdp } = adapterFixture({ activeProtected: true });
    await adapter.snapshot();
    await expect(adapter.runBrowserAction?.({
      screenId: "HEADLESS-1",
      controlGeneration: 1,
      action: { kind: "press", key: "a" },
      automationOrder: ["cdp"],
    })).rejects.toThrow(/protected browser input requires human takeover/);
    expect(cdp.calls.some((call) => call.method === "Input.dispatchKeyEvent")).toBe(false);
  });

  it("uses CDP mouse/key input for click, typing, and named key presses", async () => {
    const { adapter, cdp } = adapterFixture();
    await adapter.snapshot();

    await adapter.runBrowserAction?.({
      screenId: "HEADLESS-1",
      controlGeneration: 1,
      action: { kind: "click", target: "#safe-button" },
      automationOrder: ["cdp"],
    });
    await adapter.runBrowserAction?.({
      screenId: "HEADLESS-1",
      controlGeneration: 1,
      action: { kind: "type", target: "#safe-input", text: "hello", sensitive: false },
      automationOrder: ["cdp"],
    });
    await adapter.runBrowserAction?.({
      screenId: "HEADLESS-1",
      controlGeneration: 1,
      action: { kind: "press", key: "Enter" },
      automationOrder: ["cdp"],
    });

    expect(cdp.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "Input.dispatchMouseEvent",
        params: expect.objectContaining({ type: "mousePressed", button: "left", x: 320, y: 240 }),
      }),
      expect.objectContaining({ method: "Input.insertText", params: { text: "hello" } }),
      expect.objectContaining({
        method: "Input.dispatchKeyEvent",
        params: expect.objectContaining({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }),
      }),
    ]));
    const selectorCalls = cdp.calls.filter((call) => call.method === "Runtime.callFunctionOn");
    expect(selectorCalls.some((call) => String(call.params?.functionDeclaration ?? "").includes("#safe-input"))).toBe(false);
    expect(selectorCalls.some((call) => String(call.params?.functionDeclaration ?? "").includes("#safe-button"))).toBe(false);
    expect(selectorCalls.some((call) => (call.params?.arguments as readonly { value?: unknown }[] | undefined)?.some((argument) => argument.value === "#safe-input"))).toBe(true);
    expect(cdp.calls.some((call) => call.method === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("el.click()"))).toBe(false);
  });

  it("rejects protected click targets discovered from the live DOM before dispatching mouse input", async () => {
    const { adapter, cdp } = adapterFixture({ elementProtected: true });
    await adapter.snapshot();

    await expect(adapter.runBrowserAction?.({
      screenId: "HEADLESS-1",
      controlGeneration: 1,
      action: { kind: "click", target: "#challenge-action" },
      automationOrder: ["cdp"],
    })).rejects.toThrow(/protected browser target requires human takeover/);
    expect(cdp.calls.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("surfaces provider-specific Linux Doctor failures through the Computer authority", async () => {
    const { adapter } = adapterFixture({
      uid: 0,
      executable: async (command) => command !== "sway",
    });
    const service = createComputerService({ pollIntervalMs: 60_000 });
    await service.registerNode(adapter);
    const report = await service.doctor();

    expect(report.status).toBe("degraded");
    expect(report.nodes[0]?.issues).toEqual(expect.arrayContaining([
      "node is degraded",
      "Agent Computer must run as an unprivileged user, not root",
      "sway is not installed or not executable",
    ]));
    await service.close();
  });

  it("rejects a remotely exposed CDP endpoint before the provider can start", () => {
    expect(() => createLinuxSwayComputerAdapter({
      environment: { FRIDAY_COMPUTER_CDP_URL: "http://192.168.1.50:9222/" },
      platform: "linux",
      uid: 1000,
    })).toThrow(/loopback host/);
  });
});
