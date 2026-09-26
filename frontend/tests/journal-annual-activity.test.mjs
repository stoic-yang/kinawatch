import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-annual-"));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL("../src/experiments/concepts/AnnualRhythm.tsx", import.meta.url))], outfile: join(directory, "annual.mjs"), bundle: true, platform: "node", format: "esm", loader: { ".css": "empty" } });
const { readWindow, activityAverage, annualWindows } = await import(pathToFileURL(join(directory, "annual.mjs")).href);
const date = "2026-09-12";
const window = { start: date, end: date, dates: [date] };
const row = value => ({ date, overview: { combined_nonoverlap_seconds: 99999, active_seconds: 80000, mac_non_entertainment_seconds: value }, quality: { complete: true, issues: [] } });
const read = days => readWindow(window, { start: date, end: date, mode: "routine", days }, "routine")[0];

test("annual cells use only Mac non-entertainment time, including a true zero", () => {
  assert.equal(read([row(1200)]).seconds, 1200);
  assert.equal(read([row(1200)]).state, "ready");
  assert.equal(read([row(0)]).seconds, 0);
  assert.equal(read([row(0)]).state, "empty");
});

test("old or malformed annual metrics never fall back to all-device totals", () => {
  for (const value of [undefined, null, NaN, Infinity, -1, "1200"]) {
    assert.equal(read([row(value)]).seconds, null);
    assert.equal(read([row(value)]).state, "partial");
  }
});

test("missing, duplicate and incomplete days retain their quality state", () => {
  assert.equal(read([]).state, "missing");
  assert.equal(read([row(1200), row(1200)]).seconds, null);
  const partial = row(1200);
  partial.quality = { complete: false, issues: ["Mac unavailable"] };
  assert.equal(read([partial]).state, "partial");
  assert.deepEqual(read([partial]).issues, ["Mac unavailable"]);
});

const cellsFor = (dates, seconds) => Object.fromEntries(dates.map((date, i) => [date, {
  date, state: seconds[i] === 0 ? "empty" : "ready", seconds: seconds[i], issues: [],
}]));

test("recent average includes seven days and true zeros across a year boundary", () => {
  const dates = ["2025-12-27", "2025-12-28", "2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"];
  const cells = cellsFor(dates, [0, 3600, 7200, 10800, 14400, 18000, 21600]);
  assert.equal(activityAverage(cells, dates[0], dates[6]).seconds, 10800);
  const week = activityAverage(cells, "2025-12-29", "2026-01-02");
  assert.equal(week.days, 5);
  assert.equal(week.seconds, 14400);
});

test("Monday averages one day; a complete Sunday week averages all seven", () => {
  const dates = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];
  const cells = cellsFor(dates, [3600, 7200, 10800, 14400, 18000, 21600, 25200]);
  assert.equal(activityAverage(cells, dates[0], dates[0]).seconds, 3600);
  assert.equal(activityAverage(cells, dates[0], dates[6]).seconds, 14400);
});

test("averages do not treat missing or incomplete days as zero or block on unrelated history", () => {
  const cells = cellsFor(["2026-09-21", "2026-09-22"], [3600, 7200]);
  cells["2026-08-01"] = { state: "error", seconds: null };
  assert.equal(activityAverage(cells, "2026-09-21", "2026-09-22").seconds, 5400);
  for (const state of ["loading", "error", "missing", "partial"]) {
    cells["2026-09-22"] = { state, seconds: 7200 };
    assert.equal(activityAverage(cells, "2026-09-21", "2026-09-22").seconds, null);
  }
  delete cells["2026-09-22"];
  assert.equal(activityAverage(cells, "2026-09-21", "2026-09-22").state, "loading");
});

test("calendar-year reads include recent cross-year days once and omit future dates", () => {
  const windows = annualWindows(["2026-01-01", "2026-01-02", "2026-01-03"], "2026-01-02", "2026-01-02");
  assert.deepEqual(windows.map(({start, end}) => [start, end]), [["2025-12-27", "2025-12-31"], ["2026-01-01", "2026-01-02"]]);
  const dates = windows.flatMap(window => window.dates);
  assert.equal(dates.length, 7);
  assert.equal(new Set(dates).size, 7);
  const historical = annualWindows(["2024-01-01"], "2024-12-31", "2026-01-02");
  assert.equal(historical.flatMap(window => window.dates).length, 8);
});
