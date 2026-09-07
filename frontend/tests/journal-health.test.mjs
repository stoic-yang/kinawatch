import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-health-"));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL("../src/experiments/concepts/personalHealth.ts", import.meta.url))], outfile: join(directory, "health.mjs"), bundle: true, platform: "node", format: "esm" });
const { healthWindow, meanSleep, shiftHealthDate, sleepDuration, nightPosition } = await import(pathToFileURL(join(directory, "health.mjs")).href);

test("missing dates remain unknown and never depress the sleep mean", () => {
  const days = healthWindow({ days: [{ date: "2026-09-01", sleep: { minutes: 420 }, steps: null }, { date: "2026-09-03", sleep: { minutes: 480 }, steps: null }] }, "2026-09-03", 3);
  assert.equal(days[1].sleep, null);
  assert.equal(meanSleep(days), 450);
  assert.equal(meanSleep(healthWindow(null, "2026-09-03", 7)), null);
  assert.equal(sleepDuration(null), "未记录");
});
test("calendar shifts and midnight positions retain the selected day", () => {
  assert.equal(shiftHealthDate("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftHealthDate("2024-03-01", -1), "2024-02-29");
  assert.equal(nightPosition("2026-09-01T00:00:00+08:00"), 25);
  assert.equal(nightPosition("2026-09-01T06:00:00+08:00"), 50);
  assert.equal(sleepDuration(359.8), "6 小时 0 分");
});
