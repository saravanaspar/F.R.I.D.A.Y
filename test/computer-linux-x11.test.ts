import { describe, expect, it } from "vitest";
import { createComputerService } from "../plugins/computer/service.js";
import {
  createLinuxX11ComputerAdapter,
  type LinuxCdpClient,
  type LinuxCdpTarget,
} from "../plugins/computer/providers/linux-x11.js";


function fakeCdp(options: {
  readonly activeProtected?: boolean;
  readonly elementProtected?: boolean;
  readonly structuredName?: string;
  readonly structuredContext?: string;
  readonly structuredObscured?: boolean;
  readonly structuredFocused?: boolean;
  readonly validationName?: string;
  readonly validationContext?: string;
  readonly probeUnsafe?: boolean;
  readonly initialTargets?: readonly LinuxCdpTarget[];
  readonly mediaPlaying?: boolean;
  readonly mediaCurrentTime?: number;
} = {}): LinuxCdpClient & { readonly calls: Array<{ targetId?: string; method: string; params?: Readonly<Record<string, unknown>> }>; readonly titles: ReadonlyMap<string, string> } {
  const calls: Array<{ targetId?: string; method: string; params?: Readonly<Record<string, unknown>> }> = [];
  const targets: LinuxCdpTarget[] = (options.initialTargets ?? []).map((target) => ({ ...target }));
  const windowNames = new Map<string, string>();
  const titles = new Map<string, string>(targets.map((target) => [target.id, target.title]));
  let nextUrl = "https://example.com/dashboard?token=provider-secret#fragment";
  return {
    calls,
    titles,
    async targets() { return targets.map((target) => ({ ...target, title: titles.get(target.id) ?? target.title })); },
    async browserCommand(method, params) {
      calls.push(params === undefined ? { method } : { method, params });
      if (method === "Target.closeTarget") {
        const targetId = String(params?.targetId ?? "");
        const index = targets.findIndex((target) => target.id === targetId);
        if (index >= 0) targets.splice(index, 1);
        windowNames.delete(targetId);
        titles.delete(targetId);
        return { success: index >= 0 };
      }
      if (method !== "Target.createTarget") throw new Error(`unexpected browser command: ${method}`);
      targets.push({
        id: "agent-tab",
        title: "OTP 123456 verification code",
        url: nextUrl,
        type: "page",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/agent-tab",
      });
      titles.set("agent-tab", "OTP 123456 verification code");
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
      if (method === "Page.captureScreenshot") return { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" };
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
      if (expression === "document.title") return { result: { value: titles.get(targetId) ?? "" } };
      if (expression.startsWith("document.title = ")) {
        const assigned = JSON.parse(expression.slice("document.title = ".length)) as string;
        titles.set(targetId, assigned);
        return { result: { value: assigned } };
      }
      if (expression === "window.name") return { result: { value: windowNames.get(targetId) ?? "" } };
      if (expression.startsWith("window.name = ")) {
        const assigned = JSON.parse(expression.slice("window.name = ".length)) as string;
        windowNames.set(targetId, assigned);
        return { result: { value: assigned } };
      }
      if (expression.includes('document.querySelectorAll("audio,video")')) {
        return {
          result: {
            value: {
              elementCount: 1,
              playing: options.mediaPlaying === true,
              paused: options.mediaPlaying !== true,
              ended: false,
              currentTime: options.mediaCurrentTime ?? 0,
              duration: 240,
              muted: false,
              volume: 1,
            },
          },
        };
      }
      if (expression === "location.href") return { result: { value: nextUrl } };
      if (expression === "({width: innerWidth, height: innerHeight})") return { result: { value: { width: 1280, height: 720 } } };
      if (expression.includes("readyState: document.readyState")) {
        return { result: { value: { href: nextUrl, readyState: "complete" } } };
      }
      if (expression.includes("const region = input.bbox")) {
        return {
          result: {
            value: {
              unsafe: options.probeUnsafe === true,
              text: [options.structuredName ?? "Add", options.structuredContext ?? "Chicken Biryani | ₹249"],
              scrollX: 0,
              scrollY: 0,
              innerWidth: 1280,
              innerHeight: 720,
            },
          },
        };
      }
      if (expression.includes("const protectedTarget = protectedPattern.test(signature)")) {
        return {
          result: {
            value: {
              found: true,
              protected: options.elementProtected === true,
              visible: true,
              enabled: true,
              obscured: options.structuredObscured === true,
              name: options.validationName ?? options.structuredName ?? "Add",
              context: options.validationContext ?? options.structuredContext ?? "Chicken Biryani | ₹249",
              role: "button",
              x: 320,
              y: 240,
              left: 280,
              top: 220,
              right: 360,
              bottom: 260,
              pageLeft: 280,
              pageTop: 220,
              pageRight: 360,
              pageBottom: 260,
            },
          },
        };
      }
      if (expression.includes("const interactiveSelector = [")) {
        return {
          result: {
            value: [{
              selector: "#safe-button",
              role: "button",
              name: options.structuredName ?? "Add",
              context: options.structuredContext ?? "Chicken Biryani | ₹249",
              left: 280,
              top: 220,
              right: 360,
              bottom: 260,
              pageLeft: 280,
              pageTop: 220,
              pageRight: 360,
              pageBottom: 260,
              visible: true,
              enabled: true,
              focused: options.structuredFocused === true,
              interactive: true,
              clickable: true,
              editable: false,
              selectable: false,
              scrollable: false,
              draggable: false,
              protected: false,
              obscured: options.structuredObscured === true,
              actions: ["click"],
            }],
          },
        };
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
  readonly structuredName?: string;
  readonly structuredContext?: string;
  readonly structuredObscured?: boolean;
  readonly structuredFocused?: boolean;
  readonly validationName?: string;
  readonly validationContext?: string;
  readonly probeUnsafe?: boolean;
  readonly initialTargets?: readonly LinuxCdpTarget[];
  readonly mediaPlaying?: boolean;
  readonly mediaCurrentTime?: number;
  readonly wmctrlWorkAreaUnavailable?: boolean;
} = {}) {
  const cdp = fakeCdp({
    ...(options.activeProtected === undefined ? {} : { activeProtected: options.activeProtected }),
    ...(options.elementProtected === undefined ? {} : { elementProtected: options.elementProtected }),
    ...(options.structuredName === undefined ? {} : { structuredName: options.structuredName }),
    ...(options.structuredContext === undefined ? {} : { structuredContext: options.structuredContext }),
    ...(options.structuredObscured === undefined ? {} : { structuredObscured: options.structuredObscured }),
    ...(options.structuredFocused === undefined ? {} : { structuredFocused: options.structuredFocused }),
    ...(options.validationName === undefined ? {} : { validationName: options.validationName }),
    ...(options.validationContext === undefined ? {} : { validationContext: options.validationContext }),
    ...(options.probeUnsafe === undefined ? {} : { probeUnsafe: options.probeUnsafe }),
    ...(options.initialTargets === undefined ? {} : { initialTargets: options.initialTargets }),
    ...(options.mediaPlaying === undefined ? {} : { mediaPlaying: options.mediaPlaying }),
    ...(options.mediaCurrentTime === undefined ? {} : { mediaCurrentTime: options.mediaCurrentTime }),
  });
  let activeDesktop = 0;
  const adapter = createLinuxX11ComputerAdapter({
    environment: {
      PATH: "/usr/bin:/bin",
      HOME: "/home/friday",
      FRIDAY_HOME: "/home/friday/.friday",
      DISPLAY: ":0",
      XDG_SESSION_TYPE: "x11",
      XDG_CURRENT_DESKTOP: "KDE",
      FRIDAY_COMPUTER_PROVIDER: "linux-x11",
      FRIDAY_COMPUTER_SESSION_MODE: "native-x11",
      FRIDAY_COMPUTER_X11_AGENT_DESKTOPS: "1",
      FRIDAY_COMPUTER_CDP_URL: "http://127.0.0.1:9222/",
    },
    platform: "linux",
    uid: options.uid ?? 1000,
    cdp,
    executable: options.executable ?? (async () => true),
    async runCommand(command, args) {
      if (command !== "wmctrl") return { ok: false, stdout: "", stderr: `unexpected command ${command}` };
      if (args[0] === "-d") {
        return {
          ok: true,
          stdout: `0 ${activeDesktop === 0 ? "*" : "-"} DG: 1920x1080 VP: 0,0 WA: ${options.wmctrlWorkAreaUnavailable === true ? "N/A" : "0,0 1920x1040"} Desktop 1\n1 ${activeDesktop === 1 ? "*" : "-"} DG: 1920x1080 VP: 0,0 WA: ${options.wmctrlWorkAreaUnavailable === true ? "N/A" : "0,0 1920x1040"} FRIDAY\n`,
          stderr: "",
        };
      }
      if (args[0] === "-s") {
        activeDesktop = Number(args[1]);
        return { ok: true, stdout: "", stderr: "" };
      }
      if (args[0] === "-l") {
        const targets = await cdp.targets();
        return {
          ok: true,
          stdout: targets.map((target, index) => `0x${(0x120001 + index).toString(16)} 1 host ${cdp.titles.get(target.id) ?? target.title} - Browser`).join("\n") + (targets.length > 0 ? "\n" : ""),
          stderr: "",
        };
      }
      return { ok: false, stdout: "", stderr: `unexpected wmctrl args ${args.join(" ")}` };
    },
    async listDirectory(path) {
      if (path === "/proc") return ["101", "202"];
      return [];
    },
    async readText(path) {
      if (path === "/proc/stat") return "cpu  100 0 50 850 0 0 0 0 0 0\n";
      if (path === "/proc/101/comm") return "brave\n";
      if (path === "/proc/101/cmdline") return "brave\0--type=renderer\0";
      if (path === "/proc/202/comm") return "node\n";
      if (path === "/proc/202/cmdline") return "node\0friday\0";
      throw new Error(`unexpected read: ${path}`);
    },
    now: () => new Date("2026-09-12T05:45:00.000Z"),
  });
  return { adapter, cdp };
}

describe("native Linux/X11 Computer provider", () => {
  it("discovers Human/Agent virtual desktops and reports the persistent browser supervisor", async () => {
    const { adapter } = adapterFixture();
    const snapshot = await adapter.snapshot();

    expect(snapshot.availability).toBe("online");
    expect(snapshot.screens).toEqual([
      expect.objectContaining({ id: "DESKTOP-1", kind: "human", width: 1920, height: 1080 }),
      expect.objectContaining({ id: "DESKTOP-2", kind: "agent", width: 1920, height: 1080 }),
    ]);
    expect(snapshot.browser).toMatchObject({
      running: true,
      persistentProfile: true,
      tabs: [],
      windows: [],
    });
    expect(snapshot.resources.browserRendererCount).toBe(1);
    await expect(adapter.doctor?.()).resolves.toEqual([]);
  });

  it("accepts KDE wmctrl desktop rows when EWMH work-area metadata is N/A", async () => {
    const { adapter } = adapterFixture({ wmctrlWorkAreaUnavailable: true });

    const snapshot = await adapter.snapshot();

    expect(snapshot.availability).toBe("online");
    expect(snapshot.screens).toEqual([
      expect.objectContaining({ id: "DESKTOP-1", kind: "human", width: 1920, height: 1080 }),
      expect.objectContaining({ id: "DESKTOP-2", kind: "agent", width: 1920, height: 1080 }),
    ]);
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
      params: expect.objectContaining({ left: 0, top: 0, width: 1920, height: 1080, newWindow: true }),
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

  it("adopts one FRIDAY page after a core restart, closes stale pages, and reports media state", async () => {
    const staleTargets: LinuxCdpTarget[] = [
      { id: "playing-tab", title: "Love Me Like You Do - YouTube", url: "https://www.youtube.com/watch?v=video", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/playing-tab" },
      { id: "search-tab", title: "shakaboom - YouTube", url: "https://www.youtube.com/results?search_query=shakaboom", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/search-tab" },
      { id: "blank-tab", title: "about:blank", url: "about:blank", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/blank-tab" },
      { id: "omnibox", title: "Omnibox Popup", url: "chrome://omnibox-popup.top-chrome/", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/omnibox" },
    ];
    const { adapter, cdp } = adapterFixture({
      initialTargets: staleTargets,
      mediaPlaying: true,
      mediaCurrentTime: 42,
    });
    const service = createComputerService({ pollIntervalMs: 60_000 });
    await service.registerNode(adapter);
    const grant = await service.requestScreen({ ownerId: "job-reuse", preferredNodeId: "linux-local", preferredScreenId: "DESKTOP-2", requireBrowser: true });
    if (grant.state !== "acquired") throw new Error("expected Linux Computer screen grant");

    const result = await service.runBrowserAction(
      grant.screenLease.id,
      "job-reuse",
      grant.controlLease.generation,
      { kind: "navigate", url: "https://www.youtube.com/watch?v=next" },
    );

    expect(cdp.calls.some((call) => call.method === "Target.createTarget")).toBe(false);
    expect(cdp.calls.filter((call) => call.method === "Target.closeTarget").map((call) => call.params?.targetId)).toEqual(["search-tab", "blank-tab"]);
    expect(cdp.calls).toContainEqual(expect.objectContaining({ targetId: "playing-tab", method: "Page.navigate" }));
    expect(result.observation.tabs).toEqual([expect.objectContaining({
      id: "playing-tab",
      media: expect.objectContaining({ playing: true, paused: false, currentTime: 42 }),
    })]);

    const refreshed = await service.refreshNode("linux-local");
    expect(refreshed.browser?.windows).toContainEqual(expect.objectContaining({ owner: "friday", screenId: "DESKTOP-2", tabIds: ["playing-tab"] }));
    expect(refreshed.browser?.tabs.find((tab) => tab.id === "playing-tab")?.media).toMatchObject({ playing: true, currentTime: 42 });
    await service.close();
  });

  it("returns structured semantic refs, preserves local element ids across observations, and rejects stale refs", async () => {
    const { adapter } = adapterFixture();
    await adapter.snapshot();

    const first = await adapter.observeScreen("DESKTOP-2", 1, undefined, {
      scope: "interactive",
      query: "Add",
      maxElements: 10,
    });
    expect(first.domSummary).toBeUndefined();
    expect(first.observationId).toBe("obs-1");
    expect(first.elements).toHaveLength(1);
    expect(first.elements?.[0]).toMatchObject({
      id: "e1",
      ref: "obs-1:e1",
      role: "button",
      name: "Add",
      actions: ["click"],
      source: "dom",
    });

    const second = await adapter.observeScreen("DESKTOP-2", 1, undefined, {
      scope: "interactive",
      query: "Add",
      maxElements: 10,
    });
    expect(second.observationId).toBe("obs-2");
    expect(second.elements?.[0]).toMatchObject({ id: "e1", ref: "obs-2:e1" });
    expect(second.delta).toMatchObject({ baseObservationId: "obs-1", retained: 1, added: [], updated: [], removedIds: [] });

    await expect(adapter.runBrowserAction?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      action: { kind: "click", target: "obs-1:e1" },
      automationOrder: ["cdp"],
    })).rejects.toThrow(/STALE_REF.*reinspect_required=true/);
  });

  it("rejects a semantic ref if the live target label or context changed after observation", async () => {
    const { adapter, cdp } = adapterFixture({
      structuredName: "Continue",
      structuredContext: "Review details",
      validationName: "Delete",
      validationContext: "Delete account",
    });
    await adapter.snapshot();
    const observation = await adapter.observeScreen("DESKTOP-2", 1, undefined, { scope: "interactive", maxElements: 10 });
    const ref = observation.elements?.[0]?.ref;
    if (!ref) throw new Error("expected semantic ref");

    await expect(adapter.runBrowserAction?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      action: { kind: "click", target: ref },
      automationOrder: ["cdp"],
    })).rejects.toThrow(/STALE_REF.*semantic_target_changed=true/);
    expect(cdp.calls.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("gates high-impact semantic actions behind a bounded visual probe token and returns the crop as native image data", async () => {
    const { adapter, cdp } = adapterFixture({ structuredName: "Place Order", structuredContext: "₹529 total" });
    await adapter.snapshot();
    const observation = await adapter.observeScreen("DESKTOP-2", 1, undefined, { scope: "interactive", maxElements: 10 });
    const ref = observation.elements?.[0]?.ref;
    if (!ref) throw new Error("expected semantic ref");

    const deferred = await adapter.runBrowserAction?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      action: { kind: "click", target: ref },
      automationOrder: ["cdp"],
    });
    expect(deferred).toMatchObject({
      performed: false,
      visualProbeRequired: { ref, reason: "high-impact-action", recommendedSize: "small" },
    });
    expect(cdp.calls.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);

    const probe = await adapter.visualProbe?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      ref,
      size: "tiny",
      return: "image",
    });
    expect(probe).toMatchObject({
      observationId: observation.observationId,
      safety: { protectedRegionOmitted: true, challengeRegionOmitted: true },
      ref,
      targetMatch: true,
      image: { mimeType: "image/png" },
    });
    expect(probe?.width).toBeLessThanOrEqual(128);
    expect(probe?.height).toBeLessThanOrEqual(128);
    expect(probe?.probeToken).toMatch(/^probe-/);
    if (!probe?.probeToken) throw new Error("expected visual probe token");
    expect(cdp.calls.some((call) => call.method === "Page.captureScreenshot")).toBe(true);

    const performed = await adapter.runBrowserAction?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      action: { kind: "click", target: ref, visualProbeToken: probe.probeToken },
      automationOrder: ["cdp"],
    });
    expect(performed).toMatchObject({ performed: true, mode: "cdp" });
    expect(cdp.calls.some((call) => call.method === "Input.dispatchMouseEvent" && call.params?.type === "mousePressed")).toBe(true);
  });

  it("also gates activation-key submission on a high-impact focused semantic target", async () => {
    const { adapter, cdp } = adapterFixture({ structuredName: "Place Order", structuredContext: "₹529 total", structuredFocused: true });
    await adapter.snapshot();
    const observation = await adapter.observeScreen("DESKTOP-2", 1, undefined, { scope: "interactive", maxElements: 10 });
    const ref = observation.elements?.[0]?.ref;
    if (!ref) throw new Error("expected semantic ref");

    const deferred = await adapter.runBrowserAction?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      action: { kind: "press", key: "Enter", target: ref },
      automationOrder: ["cdp"],
    });
    expect(deferred).toMatchObject({
      performed: false,
      visualProbeRequired: { ref, reason: "high-impact-action" },
    });
    expect(cdp.calls.some((call) => call.method === "Input.dispatchKeyEvent")).toBe(false);

    const probe = await adapter.visualProbe?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      ref,
      size: "small",
      return: "text",
    });
    if (!probe?.probeToken) throw new Error("expected visual probe token");

    await expect(adapter.runBrowserAction?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      action: { kind: "press", key: "Enter", target: ref, visualProbeToken: probe.probeToken },
      automationOrder: ["cdp"],
    })).resolves.toMatchObject({ performed: true });
    expect(cdp.calls.some((call) => call.method === "Input.dispatchKeyEvent" && call.params?.type === "keyDown")).toBe(true);
  });

  it("requires micro vision for low-confidence semantic targets and refuses protected visual regions", async () => {
    const { adapter } = adapterFixture({ structuredObscured: true, probeUnsafe: true });
    await adapter.snapshot();
    const observation = await adapter.observeScreen("DESKTOP-2", 1, undefined, { scope: "interactive", maxElements: 10 });
    const ref = observation.elements?.[0]?.ref;
    if (!ref) throw new Error("expected semantic ref");

    await expect(adapter.runBrowserAction?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      action: { kind: "click", target: ref },
      automationOrder: ["cdp"],
    })).resolves.toMatchObject({
      performed: false,
      visualProbeRequired: { ref, reason: "low-confidence", recommendedSize: "tiny" },
    });

    await expect(adapter.visualProbe?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      ref,
      size: "tiny",
      return: "text",
    })).rejects.toThrow(/protected or challenge visual region requires human takeover/);
  });

  it("rejects provider-level protected typing targets even when the caller marks the text non-sensitive", async () => {
    const { adapter } = adapterFixture();
    await adapter.snapshot();
    await expect(adapter.runBrowserAction?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      action: { kind: "type", target: "input[name=password]", text: "should-never-be-dispatched", sensitive: false },
      automationOrder: ["cdp"],
    })).rejects.toThrow(/protected browser input requires human takeover/);
  });

  it("rejects key presses while a protected input owns browser focus", async () => {
    const { adapter, cdp } = adapterFixture({ activeProtected: true });
    await adapter.snapshot();
    await expect(adapter.runBrowserAction?.({
      screenId: "DESKTOP-2",
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
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      action: { kind: "click", target: "#safe-button" },
      automationOrder: ["cdp"],
    });
    await adapter.runBrowserAction?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      action: { kind: "type", target: "#safe-input", text: "hello", sensitive: false },
      automationOrder: ["cdp"],
    });
    await adapter.runBrowserAction?.({
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      action: { kind: "press", key: "Enter", target: "#safe-input" },
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
      screenId: "DESKTOP-2",
      controlGeneration: 1,
      action: { kind: "click", target: "#challenge-action" },
      automationOrder: ["cdp"],
    })).rejects.toThrow(/protected browser target requires human takeover/);
    expect(cdp.calls.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("surfaces provider-specific Linux Doctor failures through the Computer authority", async () => {
    const { adapter } = adapterFixture({
      uid: 0,
      executable: async (command) => command !== "wmctrl",
    });
    const service = createComputerService({ pollIntervalMs: 60_000 });
    await service.registerNode(adapter);
    const report = await service.doctor();

    expect(report.status).toBe("degraded");
    expect(report.nodes[0]?.issues).toEqual(expect.arrayContaining([
      "node is degraded",
      "Agent Computer must run as an unprivileged user, not root",
      "wmctrl is not installed or not executable",
    ]));
    await service.close();
  });

  it("rejects a remotely exposed CDP endpoint before the provider can start", () => {
    expect(() => createLinuxX11ComputerAdapter({
      environment: { FRIDAY_COMPUTER_CDP_URL: "http://192.168.1.50:9222/" },
      platform: "linux",
      uid: 1000,
    })).toThrow(/loopback host/);
  });
});

describe("native Linux/X11 desktop placement", () => {
  it("uses a real EWMH virtual desktop directly without a viewer bridge or compositor script", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const cdpCalls: Array<{ method: string; params?: Readonly<Record<string, unknown>> }> = [];
    const targets: LinuxCdpTarget[] = [];
    const names = new Map<string, string>();
    const titles = new Map<string, string>();
    let activeDesktop = 0;
    let targetDesktop = -1;
    let pageUrl = "about:blank";

    const cdp: LinuxCdpClient = {
      async targets() { return targets.map((target) => ({ ...target, title: titles.get(target.id) ?? target.title, url: pageUrl })); },
      async browserCommand(method, params) {
        cdpCalls.push(params === undefined ? { method } : { method, params });
        if (method === "Target.closeTarget") {
          const id = String(params?.targetId ?? "");
          const index = targets.findIndex((target) => target.id === id);
          if (index >= 0) targets.splice(index, 1);
          return { success: true };
        }
        if (method !== "Target.createTarget") throw new Error(`unexpected browser command ${method}`);
        expect(activeDesktop).toBe(1);
        targetDesktop = activeDesktop;
        targets.push({ id: "native-tab", title: "", url: "about:blank", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/native-tab" });
        titles.set("native-tab", "");
        return { targetId: "native-tab" };
      },
      async targetCommand(targetId, method, params) {
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression ?? "");
          if (expression === "window.name") return { result: { value: names.get(targetId) ?? "" } };
          if (expression.startsWith("window.name = ")) {
            const value = JSON.parse(expression.slice("window.name = ".length)) as string;
            names.set(targetId, value);
            return { result: { value } };
          }
          if (expression === "document.title") return { result: { value: titles.get(targetId) ?? "" } };
          if (expression.startsWith("document.title = ")) {
            const value = JSON.parse(expression.slice("document.title = ".length)) as string;
            titles.set(targetId, value);
            return { result: { value } };
          }
          if (expression === "location.href") return { result: { value: pageUrl } };
          if (expression.includes("readyState: document.readyState")) return { result: { value: { href: pageUrl, readyState: "complete" } } };
          if (expression === "({width: innerWidth, height: innerHeight})") return { result: { value: { width: 1920, height: 1080 } } };
          if (expression.includes('document.querySelectorAll("audio,video")')) return { result: { value: { elementCount: 0, playing: false, paused: true, ended: false, currentTime: 0, duration: 0, muted: false, volume: 1 } } };
          if (expression.includes("const interactiveSelector = [")) return { result: { value: [] } };
          return { result: { value: "" } };
        }
        if (method === "Page.navigate") { pageUrl = String(params?.url ?? pageUrl); return { frameId: "frame" }; }
        throw new Error(`unexpected target command ${method}`);
      },
    };

    const adapter = createLinuxX11ComputerAdapter({
      environment: {
        HOME: "/home/friday",
        PATH: "/usr/bin:/bin",
        DISPLAY: ":0",
        XDG_SESSION_TYPE: "x11",
        XDG_CURRENT_DESKTOP: "KDE",
        FRIDAY_COMPUTER_PROVIDER: "linux-x11",
        FRIDAY_COMPUTER_SESSION_MODE: "native-x11",
        FRIDAY_COMPUTER_X11_AGENT_DESKTOPS: "1",
        FRIDAY_COMPUTER_CDP_URL: "http://127.0.0.1:9222/",
      },
      platform: "linux",
      uid: 1000,
      cdp,
      executable: async (command) => command === "wmctrl" || command === "brave-browser-stable",
      async runCommand(command, args) {
        calls.push({ command, args });
        expect(command).toBe("wmctrl");
        if (args[0] === "-d") {
          return { ok: true, stdout: `0 ${activeDesktop === 0 ? "*" : "-"} DG: 1920x1080 VP: 0,0 WA: 0,0 1920x1040 Desktop 1\n1 ${activeDesktop === 1 ? "*" : "-"} DG: 1920x1080 VP: 0,0 WA: 0,0 1920x1040 FRIDAY\n`, stderr: "" };
        }
        if (args[0] === "-s") { activeDesktop = Number(args[1]); return { ok: true, stdout: "", stderr: "" }; }
        if (args[0] === "-l") {
          const title = titles.get("native-tab") ?? "";
          return { ok: true, stdout: targets.length > 0 ? `0x01200001 ${targetDesktop} host ${title} - Brave\n` : "", stderr: "" };
        }
        return { ok: false, stdout: "", stderr: `unexpected wmctrl args ${args.join(" ")}` };
      },
      async listDirectory(path) { return path === "/proc" ? [] : []; },
      async readText(path) { if (path === "/proc/stat") return "cpu 100 0 50 850 0 0 0 0 0 0\n"; throw new Error(`unexpected read ${path}`); },
    });

    const snapshot = await adapter.snapshot();
    expect(snapshot.screens).toEqual([
      expect.objectContaining({ id: "DESKTOP-1", kind: "human" }),
      expect.objectContaining({ id: "DESKTOP-2", kind: "agent" }),
    ]);
    await expect(adapter.sharedScreenSupport?.()).resolves.toMatchObject({ level: "full", backend: "x11-ewmh", viewOnly: false });
    const view = await adapter.openSharedScreen?.({ screenId: "DESKTOP-2", screenLeaseId: "lease", ownerId: "owner", ownerKind: "main-agent", runId: "run", name: "FRIDAY", switchTo: false });
    expect(view).toMatchObject({ screenId: "DESKTOP-2", backend: "x11-ewmh", viewOnly: false, viewerId: "native-browser:native-tab" });
    expect(activeDesktop).toBe(0);
    expect(cdpCalls).toContainEqual(expect.objectContaining({ method: "Target.createTarget" }));
    expect(new Set(calls.map((call) => call.command))).toEqual(new Set(["wmctrl"]));
    expect(calls.filter((call) => call.args[0] === "-s").map((call) => call.args[1])).toEqual(["1", "0"]);
    await expect(adapter.doctor?.()).resolves.toEqual([]);
  });

  it("opens a FRIDAY-owned window in the user's shared browser profile and never closes pre-existing Human windows", async () => {
    let activeDesktop = 0;
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const launches: Array<{ command: string; args: readonly string[] }> = [];
    const markers = new Map<string, string>();
    const closed: string[] = [];
    const humanWindow = { id: "0x01000001", desktop: 0, className: "brave-browser.Brave-browser", title: "Human Gmail" };
    const fridayWindow = { id: "0x02000002", desktop: 0, className: "brave-browser.Brave-browser", title: "FRIDAY Browser" };
    let fridayOpen = false;
    const wmctrlWindows = () => [humanWindow, ...(fridayOpen ? [fridayWindow] : [])]
      .filter((entry) => !closed.includes(entry.id))
      .map((entry) => `${entry.id} ${entry.desktop} ${entry.className} host ${entry.title}`)
      .join("\n") + "\n";

    const adapter = createLinuxX11ComputerAdapter({
      environment: {
        HOME: "/home/friday",
        PATH: "/usr/bin:/bin",
        DISPLAY: ":0",
        XDG_SESSION_TYPE: "x11",
        XDG_CURRENT_DESKTOP: "KDE",
        FRIDAY_COMPUTER_PROVIDER: "linux-x11",
        FRIDAY_COMPUTER_SESSION_MODE: "native-x11",
        FRIDAY_COMPUTER_BROWSER_MODE: "shared",
        FRIDAY_COMPUTER_BROWSER_BIN: "brave-browser-stable",
        FRIDAY_COMPUTER_X11_AGENT_DESKTOPS: "1",
      },
      platform: "linux",
      uid: 1000,
      executable: async () => true,
      async launchCommand(command, args) {
        launches.push({ command, args });
        const launchUrl = args.at(-1) ?? "";
        const token = launchUrl.match(/<title>(FRIDAY-[^<]+)<\/title>/u)?.[1];
        if (token) fridayWindow.title = token;
        fridayOpen = true;
      },
      async runCommand(command, args) {
        calls.push({ command, args });
        if (command === "wmctrl" && args[0] === "-d") {
          return { ok: true, stdout: `0 ${activeDesktop === 0 ? "*" : "-"} DG: 1920x1080 VP: 0,0 WA: 0,0 1920x1040 Desktop 1\n1 ${activeDesktop === 1 ? "*" : "-"} DG: 1920x1080 VP: 0,0 WA: 0,0 1920x1040 FRIDAY\n`, stderr: "" };
        }
        if (command === "wmctrl" && args[0] === "-s") { activeDesktop = Number(args[1]); return { ok: true, stdout: "", stderr: "" }; }
        if (command === "wmctrl" && args[0] === "-ir" && args[2] === "-t") { fridayWindow.desktop = Number(args[3]); return { ok: true, stdout: "", stderr: "" }; }
        if (command === "wmctrl" && args[0] === "-lx") return { ok: true, stdout: wmctrlWindows(), stderr: "" };
        if (command === "xprop" && args[0] === "-id" && args.includes("-set")) {
          markers.set(args[1]!, args.at(-1)!);
          return { ok: true, stdout: "", stderr: "" };
        }
        if (command === "xprop" && args[0] === "-id") {
          const marker = markers.get(args[1]!);
          return marker
            ? { ok: true, stdout: `_FRIDAY_SCREEN_ID(STRING) = "${marker}"\n`, stderr: "" }
            : { ok: false, stdout: "", stderr: "not found" };
        }
        if (command === "xdotool" && args[0] === "getwindowname") {
          return { ok: true, stdout: args[1] === fridayWindow.id ? `${fridayWindow.title}\n` : `${humanWindow.title}\n`, stderr: "" };
        }
        if (command === "xdotool" && args[0] === "windowactivate") return { ok: true, stdout: "", stderr: "" };
        if (command === "xdotool" && args[0] === "windowclose") { closed.push(args[1]!); return { ok: true, stdout: "", stderr: "" }; }
        if (command === "python3" && args[0] === "-c") return { ok: true, stdout: "", stderr: "" };
        if (command === "python3" && args.includes("snapshot")) {
          return { ok: true, stdout: JSON.stringify({
            frameTitle: "FRIDAY Browser",
            url: "https://example.com/account",
            elements: [{ path: "0/1", role: "button", name: "Continue", context: "Example account", left: 100, top: 100, right: 220, bottom: 140, visible: true, enabled: true, interactive: true, clickable: true, actions: ["click"] }],
          }), stderr: "" };
        }
        if (command === "python3" && args.includes("action")) return { ok: true, stdout: JSON.stringify({ performed: true }), stderr: "" };
        return { ok: false, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      },
      async listDirectory(path) { return path === "/proc" ? [] : []; },
      async readText(path) { if (path === "/proc/stat") return "cpu 100 0 50 850 0 0 0 0 0 0\n"; throw new Error(`unexpected read ${path}`); },
    });

    const view = await adapter.openSharedScreen?.({ screenId: "DESKTOP-2", screenLeaseId: "lease", ownerId: "owner", ownerKind: "main-agent", runId: "run", name: "FRIDAY", switchTo: false });
    expect(view?.viewerId).toBe(`native-browser:${fridayWindow.id}`);
    expect(activeDesktop).toBe(0);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.command).toBe("brave-browser-stable");
    expect(launches[0]?.args[0]).toBe("--new-window");
    expect(launches[0]?.args[1]).toMatch(/^data:text\/html,<title>FRIDAY-[0-9a-f-]+<\/title>$/u);
    expect(markers.get(fridayWindow.id)).toBe("friday-screen:linux-local:DESKTOP-2");
    expect(markers.has(humanWindow.id)).toBe(false);
    expect(fridayWindow.desktop).toBe(1);
    expect(calls).toContainEqual({ command: "wmctrl", args: ["-ir", fridayWindow.id, "-t", "1"] });

    const observation = await adapter.observeScreen("DESKTOP-2", 1, undefined, { scope: "interactive", maxElements: 10 });
    expect(observation.elements?.[0]).toMatchObject({ role: "button", name: "Continue", source: "atspi" });
    expect(activeDesktop).toBe(0);

    await expect(adapter.closeSharedScreens?.()).resolves.toBe(1);
    expect(closed).toEqual([fridayWindow.id]);
    expect(closed).not.toContain(humanWindow.id);
    expect(calls.some((call) => call.command === "xdotool" && call.args[0] === "windowclose" && call.args[1] === humanWindow.id)).toBe(false);
  });
});
