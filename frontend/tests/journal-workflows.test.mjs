import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-workflows-"));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: ["sessions", "kinaSummary"].map(name => fileURLToPath(new URL(`../src/lib/${name}.ts`, import.meta.url))), outdir: directory, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm" });
const { buildSessions } = await import(pathToFileURL(join(directory, "sessions.mjs")).href);
const { parseKinaSummary, assignKinaSummaryToSessions } = await import(pathToFileURL(join(directory, "kinaSummary.mjs")).href);

test("filtering keeps server-owned workflow identity and generated text never transfers", () => {
  const a = "0123456789abcdef", b = "fedcba9876543210";
  const first = { id: a, start: "2026-09-06T09:00:00+08:00", end: "2026-09-06T10:00:00+08:00" };
  const second = { id: b, start: "2026-09-06T12:00:00+08:00", end: "2026-09-06T12:10:00+08:00" };
  const blocks = [first, second].map(row => ({ kind: "screen", start: row.start, end: row.end, app: "Editor", category: "work", category_label: "Work", duration_seconds: 60 }));
  const day = { workflows: { sessions: [first, second] }, timeline: blocks };
  const entries = parseKinaSummary(`> - \`09:00–09:30\` 合成描述。 <!-- kina:workflow:${a} -->`);
  assert.equal(entries[0].text, "合成描述。");
  const sessions = buildSessions(day);
  assert.equal(sessions[0].workflowId, a);
  assert.equal(assignKinaSummaryToSessions(entries, sessions, "Asia/Shanghai")[0].length, 1);
  const filtered = buildSessions({ ...day, timeline: [blocks[1]] });
  assert.deepEqual(assignKinaSummaryToSessions(entries, filtered, "Asia/Shanghai"), [[]]);
});

test("short timeline fragments omitted by the backend do not become workflow cards", () => {
  const short = { id: "0123456789abcdef", start: "2026-09-06T09:00:00+08:00", end: "2026-09-06T09:01:00+08:00", active_seconds: 60 };
  const full = { id: "fedcba9876543210", start: "2026-09-06T10:00:00+08:00", end: "2026-09-06T10:15:00+08:00", active_seconds: 900 };
  const timeline = [short, full].map(row => ({ kind: "screen", start: row.start, end: row.end, app: "Editor", category: "work", category_label: "Work", duration_seconds: row.active_seconds }));
  const day = { workflows: { min_active_seconds: 900, sessions: [full] }, timeline };
  const sessions = buildSessions(day);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].workflowId, full.id);
  assert.equal(sessions[0].seconds, 900);
  assert.equal(day.timeline.length, 2);
  assert.deepEqual(buildSessions({ ...day, workflows: { sessions: [] } }), []);
  const entries = parseKinaSummary(`> - \`09:00–09:01\` 合成短片段描述。 <!-- kina:workflow:${short.id} -->`);
  assert.deepEqual(assignKinaSummaryToSessions(entries, sessions, "Asia/Shanghai"), [[]]);
  const legacy = parseKinaSummary([
    "> - `09:00–09:01` 旧格式短片段。",
    "> - `09:00–09:00` 不足一分钟的旧描述。",
    "> - `10:00–10:15` 完整工作流描述。",
  ].join("\n"));
  assert.deepEqual(assignKinaSummaryToSessions(legacy, sessions, "Asia/Shanghai"), [[legacy[2]]]);
});
