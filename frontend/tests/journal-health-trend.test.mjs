import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-health-trend-"));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL("../src/experiments/concepts/health-trend.ts", import.meta.url))], outfile: join(directory, "trend.mjs"), bundle: true, platform: "node", format: "esm" });
const { healthTrend } = await import(pathToFileURL(join(directory, "trend.mjs")).href);

test("missing dates split lines while an observed zero remains connected", () => {
  const chart = healthTrend([120, null, 0, 300, 600, null, 60], 600);
  assert.equal(chart.paths.length, 1);
  assert.equal(chart.paths[0], "M 35.714,100.000 L 50.000,50.000 L 64.286,0.000");
  assert.equal(chart.points[1].y, null);
  assert.equal(chart.points[2].y, 100);
  assert.equal(chart.points[6].y, 90);
});

test("empty, all-missing and isolated readings never fabricate a trend", () => {
  for (const values of [[], [null, null], [300], [100, null, 200]]) {
    const chart = healthTrend(values, 600);
    assert.equal(chart.maximum, 600);
    assert.deepEqual(chart.paths, []);
    assert.ok(chart.points.every(point => Number.isFinite(point.x) && (point.y === null || Number.isFinite(point.y))));
  }
});

test("step scale expands without clipping high values or moving zero off its baseline", () => {
  const chart = healthTrend([0, 8500, 12000], 5000);
  assert.equal(chart.maximum, 12000);
  assert.equal(chart.points[0].y, 100);
  assert.equal(chart.points[2].y, 0);
  assert.ok(chart.points.every(point => point.y >= 0 && point.y <= 100));
  assert.equal(healthTrend([0, 0], 5000).maximum, 5000);
});
