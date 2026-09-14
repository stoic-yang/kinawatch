import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
const directory = await mkdtemp(join(tmpdir(), "kinawatch-mcp-"));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL("../src/experiments/concepts/mcpServices.ts", import.meta.url))], outfile: join(directory, "mcp.mjs"), bundle: true, platform: "node", format: "esm" });
const { canStart, canStop, connectionUrl, mcpRequest } = await import(pathToFileURL(join(directory, "mcp.mjs")).href);
test("running and pending services prevent duplicate action; partial startup can be stopped", () => {
  assert.equal(canStart({ busy: false, status: "running" }), false);
  assert.equal(canStart({ busy: true, status: "starting" }), false);
  assert.equal(canStart({ busy: false, status: "error" }), true);
  assert.equal(canStop({ busy: false, status: "error", server_running: true }), true);
  assert.ok(!canStop({ busy: false, status: "stopped" }));
});
test("connection address accepts only HTTPS tunnel MCP endpoints", () => {
  assert.equal(connectionUrl("https://example-project.trycloudflare.com/mcp"), "https://example-project.trycloudflare.com/mcp");
  for (const value of [null, "javascript:alert(1)", "http://example.trycloudflare.com/mcp", "https://example.trycloudflare.com.evil.test/mcp", "https://user:password@example.trycloudflare.com/mcp", "https://example.trycloudflare.com/mcp?token=secret"]) assert.equal(connectionUrl(value), null);
});
test("mutation uses explicit JSON header and POST; no credential appears in URL", async () => {
  const original = globalThis.fetch;
  try {
    let observed;
    globalThis.fetch = async (...args) => { observed = args; return { ok: true, json: async () => ({ password: "fixture-secret" }) }; };
    assert.deepEqual(await mcpRequest("password", { id: "fixture" }), { password: "fixture-secret" });
    assert.equal(observed[0], "/api/mcp/password");
    assert.equal(observed[1].method, "POST");
    assert.equal(observed[1].headers["X-KinaWatch-MCP"], "1");
    assert.equal(observed[1].cache, "no-store");
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: "duplicate operation" }) });
    await assert.rejects(mcpRequest("action", {}), /duplicate operation/);
  } finally { globalThis.fetch = original; }
});
