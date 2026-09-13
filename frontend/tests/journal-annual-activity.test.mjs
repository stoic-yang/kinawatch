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
const { readWindow } = await import(pathToFileURL(join(directory, "annual.mjs")).href);
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
