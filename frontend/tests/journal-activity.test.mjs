import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-activity-"));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: ["journalActivity", "journalWorkflow"].map(name => fileURLToPath(new URL(`../src/experiments/concepts/${name}.ts`, import.meta.url))), outdir: directory, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm" });
const { buildJournalActivity } = await import(pathToFileURL(join(directory, "journalActivity.mjs")).href);
const { buildJournalWorkflow } = await import(pathToFileURL(join(directory, "journalWorkflow.mjs")).href);
const start = Date.parse("2026-09-04T06:00:00+08:00");
const clock = seconds => new Date(start + seconds * 1000).toISOString();
const block = (from, to, app = "Editor", seconds = to - from, category = "work") => ({ kind: "screen", start: clock(from), end: clock(to), duration_seconds: seconds, app, category, category_label: category, title: "Synthetic", project: "", event_refs: [] });
const day = timeline => ({ workflows: { sessions: timeline.filter(block => block.kind === "screen").map((block, index) => ({ id: index.toString(16).padStart(16, "0"), start: block.start, end: block.end })) }, range: { start: clock(0), end: clock(86400) }, timeline, journal: { workflow_notes: [], activity_summary_markdown: "" } });
const sum = sessions => sessions.reduce((total, item) => total + item.seconds, 0);

test("long use splits on half-hour boundaries, preserving source and precise totals", () => {
  const source = day([block(1200, 7500, "Editor", 5700.125)]);
  const before = JSON.stringify(source);
  const sessions = buildJournalActivity(source);
  assert.equal(sessions.length, 5);
  assert.equal(sessions[0].start, clock(1200));
  assert.equal(sessions.at(-1).end, clock(7500));
  assert.ok(sessions.every(item => Date.parse(item.end) - Date.parse(item.start) <= 1800000));
  assert.ok(Math.abs(sum(sessions) - 5700.125) < 1e-8);
  assert.equal(JSON.stringify(source), before);
});

test("sustained app changes make separate entries", () => {
  const sessions = buildJournalActivity(day([block(0, 240), block(240, 420, "Browser"), block(420, 900)]));
  assert.deepEqual(sessions.map(item => item.topApps[0].app), ["Editor", "Browser", "Editor"]);
  assert.equal(sum(sessions), 900);
});

test("brief interruptions stay with the main activity and their time is retained", () => {
  const sessions = buildJournalActivity(day([block(0, 240), block(240, 255, "Finder"), block(255, 900)]));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].topApps[0].app, "Editor");
  assert.equal(sessions[0].topApps[1].seconds, 15);
  assert.equal(sum(sessions), 900);
});

test("five-minute pauses divide entries without counting idle time", () => {
  const sessions = buildJournalActivity(day([block(0, 60), block(360, 540)]));
  assert.equal(sessions.length, 2);
  assert.equal(sum(sessions), 240);
});

test("calendar midnight and partial windows retain chronological ranges", () => {
  const sessions = buildJournalActivity(day([block(17.75 * 3600, 18.25 * 3600)]));
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].end, clock(18 * 3600));
  assert.equal(sessions[1].start, sessions[0].end);
  assert.equal(sum(sessions), 1800);
});

test("workflow text is assigned once, and removed activity cannot transfer it", () => {
  const source = day([block(0, 7200), block(9000, 9300, "Browser", 300, "reading")]);
  source.journal.workflow_notes = [{ start_time: "06:00", end_time: "08:00", note: "Synthetic manual description" }];
  const items = buildJournalWorkflow(source, buildJournalActivity(source), "Asia/Shanghai");
  assert.equal(items.filter(item => item.source === "workflow").length, 1);
  assert.equal(items[0].description, "Synthetic manual description");
  const filtered = { ...source, timeline: source.timeline.filter(item => item.category === "reading") };
  const filteredItems = buildJournalWorkflow(source, buildJournalActivity(filtered), "Asia/Shanghai");
  assert.equal(filteredItems.length, 1);
  assert.equal(filteredItems[0].source, "apps");
});

test("empty and non-screen data produce no screen workflow", () => {
  assert.deepEqual(buildJournalActivity(null), []);
  assert.deepEqual(buildJournalActivity(day([])), []);
  assert.deepEqual(buildJournalActivity(day([{ ...block(0, 3600), kind: "offline" }])), []);
});
