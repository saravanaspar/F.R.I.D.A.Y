import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { getAutonomyStateRoot } from "../plugins/autonomy/runner.js";
import { getSelfImprovementStateRoot } from "../plugins/self-improvement/runner.js";

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
});
