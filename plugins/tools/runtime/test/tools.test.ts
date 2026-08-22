import { describe, expect, it } from "vitest";
import { allToolNames, createAllTools, createTool } from "../src/index.js";

describe("tool registry", () => {
  it("exposes foreground, edit, ipython, and managed background tools", () => {
    expect([...allToolNames]).toEqual(["bash", "edit", "ipython", "process"]);
    const tools = createAllTools(process.cwd());
    expect(Object.keys(tools)).toEqual(["bash", "edit", "ipython", "process"]);
    expect(tools.ipython.executionMode).toBe("sequential");
  });

  it("creates individual tools", () => {
    expect(createTool("bash", process.cwd()).name).toBe("bash");
    expect(createTool("edit", process.cwd()).name).toBe("edit");
    expect(createTool("ipython", process.cwd()).name).toBe("ipython");
    expect(createTool("process", process.cwd()).name).toBe("process");
  });
});
