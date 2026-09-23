import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuaDriver } from "../plugins/cua/driver.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function mockDriver(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "friday-cua-test-"));
  directories.push(directory);
  const executable = join(directory, "cua-driver");
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const readline = require('node:readline');
if (process.argv[2] !== 'mcp') process.exit(2);
const reader = readline.createInterface({input:process.stdin});
reader.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {protocolVersion:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'cua-driver',version:'test'}};
  else if (request.method === 'tools/list') result = {tools:[{name:'get_browser_state',inputSchema:{type:'object',properties:{}}},{name:'browser_navigate',inputSchema:{type:'object',properties:{url:{type:'string'}}}}]};
  else if (request.method === 'tools/call') result = {content:[{type:'text',text:JSON.stringify(request.params)}]};
  else return;
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
`);
  await chmod(executable, 0o755);
  return executable;
}

describe("CUA Driver MCP connection", () => {
  it("uses one persistent stdio session to discover and invoke browser tools", async () => {
    const driver = new CuaDriver(await mockDriver());
    try {
      expect((await driver.listTools()).map((tool) => tool.name)).toEqual(["get_browser_state", "browser_navigate"]);
      expect(await driver.callTool("browser_navigate", { url: "https://example.org" })).toEqual({
        content: [{ type: "text", text: JSON.stringify({ name: "browser_navigate", arguments: { url: "https://example.org" } }) }],
      });
      await expect(driver.callTool("unknown", {})).rejects.toThrow("no tool named unknown");
    } finally { await driver.close(); }
  });

  it("reports unavailable CUA binaries without hanging", async () => {
    const driver = new CuaDriver(join(tmpdir(), "friday-cua-nonexistent-driver"));
    await expect(driver.listTools()).rejects.toThrow();
    await driver.close();
  });
});
