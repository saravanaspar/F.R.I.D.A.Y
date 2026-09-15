import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { getAutonomyStateRoot } from "../plugins/autonomy/runner.js";
import { getSelfImprovementStateRoot } from "../plugins/self-improvement/runner.js";
import { getDevicesStateDir } from "../plugins/devices/index.js";

describe("mission-state root consistency", () => {
  const resolvers = [
    ["autonomy", getAutonomyStateRoot],
    ["self-improvement", getSelfImprovementStateRoot],
  ] as const;

  for (const [label, resolver] of resolvers) {
    it(`${label} follows explicit state dir, FRIDAY_STATE_DIR, then FRIDAY_HOME`, () => {
      expect(resolver("./explicit", { FRIDAY_STATE_DIR: "./mission", FRIDAY_HOME: "./home" })).toBe(resolve("./explicit"));
      expect(resolver(undefined, { FRIDAY_STATE_DIR: "./mission", FRIDAY_HOME: "./home" })).toBe(resolve("./mission"));
      expect(resolver(undefined, { FRIDAY_HOME: "./home" })).toBe(resolve("./home"));
    });
  }
  it("devices follows FRIDAY_STATE_DIR before FRIDAY_HOME", () => {
    expect(getDevicesStateDir({ FRIDAY_STATE_DIR: "./mission", FRIDAY_HOME: "./home" }))
      .toBe(join(resolve("./mission"), "devices"));
    expect(getDevicesStateDir({ FRIDAY_HOME: "./home" }))
      .toBe(join(resolve("./home"), "devices"));
  });

});
