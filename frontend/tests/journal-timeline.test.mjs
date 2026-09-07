import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-timeline-"));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL("../src/experiments/concepts/journalTimelineModel.ts", import.meta.url))], outfile: join(directory, "timeline.mjs"), bundle: true, platform: "node", format: "esm" });
const { buildJournalTimeline, journalTimelineBarAt, clampJournalTimelineView, zoomJournalTimeline, journalTimelineInView, journalTimelineTicks } = await import(pathToFileURL(join(directory, "timeline.mjs")).href);
const start = Date.parse("2026-09-04T06:00:00+08:00");
const clock = seconds => new Date(start + seconds * 1000).toISOString();
const block = (from, to, app = "Editor", category = "work") => ({ kind: "screen", start: clock(from), end: clock(to), duration_seconds: to - from, app, category, category_label: category, title: "Synthetic", project: "", event_refs: [] });
const day = timeline => ({ workflows: { sessions: timeline.filter(block => block.kind === "screen").map((block, index) => ({ id: index.toString(16).padStart(16, "0"), start: block.start, end: block.end })) }, range: { start: clock(0), end: clock(86400) }, timeline, journal: { workflow_notes: [], activity_summary_markdown: "" } });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("positions and bar lengths preserve elapsed time, idle gaps and source data", () => {
  const source = day([block(3600, 7200), block(10800, 18000, "Browser")]);
  const before = JSON.stringify(source), model = buildJournalTimeline(source);
  close(model.bars[0].from, 1 / 24);
  close(model.bars[1].to - model.bars[1].from, 2 * (model.bars[0].to - model.bars[0].from));
  close(model.bars[1].from - model.bars[0].to, 1 / 24);
  assert.equal(JSON.stringify(source), before);
});

test("wheel zoom keeps the time under the pointer fixed and can return to all day", () => {
  const total = 86400000, all = { start: 0, span: total }, anchor = 0.375;
  const zoomed = zoomJournalTimeline(all, total, 0.625, anchor);
  close(zoomed.start + zoomed.span * anchor, total * anchor);
  assert.deepEqual(zoomJournalTimeline(zoomed, total, 1.6, anchor), all);
});

test("zoom and pan stop at the day edges and a five-minute detail window", () => {
  const total = 86400000;
  const smallest = zoomJournalTimeline({ start: 0, span: total }, total, 0.000001, 0.75);
  assert.equal(smallest.span, 300000);
  assert.deepEqual(clampJournalTimelineView({ start: -total, span: 3600000 }, total), { start: 0, span: 3600000 });
  assert.deepEqual(clampJournalTimelineView({ start: total, span: 3600000 }, total), { start: total - 3600000, span: 3600000 });
  assert.deepEqual(zoomJournalTimeline(smallest, total, 100000, 0.9), { start: 0, span: total });
});

test("chart clips intervals to the selected range and skips non-screen activity", () => {
  const model = buildJournalTimeline(day([block(-3600, 3600), { ...block(5000, 5500), kind: "offline" }, block(85000, 90000)]));
  assert.equal(model.bars.length, 2);
  assert.equal(model.bars[0].from, 0);
  assert.equal(model.bars[1].to, 1);
  close(model.bars[0].to, 1 / 24);
});

test("zoom clips bars at viewport edges without changing activity identity or duration", () => {
  const model = buildJournalTimeline(day([block(0, 60), block(3600, 3612, "Launcher"), block(3612, 10812), block(12000, 12020)]));
  const view = { start: 3600000, span: 300000 };
  const visible = journalTimelineInView(model.bars, model.span, view);
  assert.deepEqual(visible.map(bar => bar.index), [1, 2]);
  close(visible[0].from, 0);
  close(visible[0].to, 12 / 300);
  assert.equal(visible[1].to, 1);
  assert.equal(visible[1].block, model.bars[2].block);
  assert.equal(visible[1].block.duration_seconds, 7200);
  assert.equal(journalTimelineBarAt(visible, 0.02, 0.001), 0);
});

test("cross-midnight activity stays on one scale and filtering does not shift it", () => {
  const late = block(17.75 * 3600, 18.25 * 3600, "Reader", "reading");
  const all = buildJournalTimeline(day([block(3600, 7200), late]));
  const filtered = buildJournalTimeline(day([late]));
  assert.deepEqual(filtered.bars[0], all.bars[1]);
  close(filtered.bars[0].from, 17.75 / 24);
  close(filtered.bars[0].to, 18.25 / 24);
});

test("empty and loading states contain no fabricated activity", () => {
  for (const source of [null, day([])]) {
    const model = buildJournalTimeline(source);
    assert.deepEqual(model.bars, []);
    assert.deepEqual(model.groups, []);
  }
});

test("ticks become finer with zoom and leave room for both viewport endpoints", () => {
  for (const span of [86400000, 3600000, 300000]) {
    const view = { start: 18123000, span }, ticks = journalTimelineTicks(view, 533);
    assert.equal(ticks[0], view.start);
    assert.equal(ticks.at(-1), view.start + view.span);
    assert.ok(ticks.length >= 4 && ticks.length <= 12);
    ticks.slice(1).forEach((tick, index) => assert.ok((tick - ticks[index]) / span * 533 >= 30));
  }
  assert.deepEqual(journalTimelineTicks({ start: 0, span: 0 }, 533), []);
  assert.deepEqual(clampJournalTimelineView({ start: 0, span: 0 }, 0), { start: 0, span: 0 });
});

test("pointer lookup finds subpixel events but leaves idle intervals empty", () => {
  const { bars } = buildJournalTimeline(day([block(3600, 3612, "Launcher"), block(3612, 10812), block(10812, 10824, "Launcher")]));
  assert.equal(journalTimelineBarAt(bars, 3606 / 86400, 2 / 420), 0);
  assert.equal(journalTimelineBarAt(bars, 10818 / 86400, 2 / 420), 2);
  assert.equal(journalTimelineBarAt(bars, 10826 / 86400, 2 / 420), 2);
  assert.equal(journalTimelineBarAt(bars, 0.75, 2 / 420), -1);
  assert.equal(journalTimelineBarAt([], 0, 2 / 420), -1);
});
