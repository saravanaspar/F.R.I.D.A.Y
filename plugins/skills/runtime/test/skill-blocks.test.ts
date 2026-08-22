import { describe, expect, it } from "vitest";
import { parseSkillBlock } from "../src/skill-blocks.js";

describe("skill blocks", () => {
  it("parses a skill block with a trailing user message", () => {
    expect(
      parseSkillBlock('<skill name="review" location="/tmp/review/SKILL.md">\nbody\n</skill>\n\ncheck this'),
    ).toEqual({
      name: "review",
      location: "/tmp/review/SKILL.md",
      content: "body",
      userMessage: "check this",
    });
  });

  it("parses a skill block without a user message", () => {
    expect(parseSkillBlock('<skill name="review" location="/tmp/review/SKILL.md">\nbody\n</skill>')).toEqual({
      name: "review",
      location: "/tmp/review/SKILL.md",
      content: "body",
      userMessage: undefined,
    });
  });

  it("returns null for ordinary text", () => {
    expect(parseSkillBlock("ordinary user text")).toBeNull();
  });
});
