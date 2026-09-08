import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-rhythm-devices-"));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL("../src/experiments/concepts/rhythm-devices.ts", import.meta.url))], outfile: join(directory, "devices.mjs"), bundle: true, platform: "node", format: "esm" });
const { rhythmDevices } = await import(pathToFileURL(join(directory, "devices.mjs")).href);
const device = (key, active, observed) => ({ device: key, label: key, active_seconds: active, observed_seconds: observed });
const day = devices => ({ overview: { combined_nonoverlap_seconds: 900 }, rhythm: { devices } });

test("device segments use allocated duration while retaining observed time", () => {
  const devices = [device("mac", 400, 600), device("ipad", 100, 300), device("iphone", 400, 600)];
  assert.deepEqual(rhythmDevices(day(devices)), devices);
  assert.equal(rhythmDevices(day(devices.map(row => ({ ...row, active_seconds: row.observed_seconds })))), null);
});

test("unknown, missing and inconsistent device data never becomes a fabricated Mac bar", () => {
  assert.equal(rhythmDevices(day(undefined)), null);
  assert.equal(rhythmDevices(day([device("mac", -1, 900)])), null);
  assert.equal(rhythmDevices(day([device("mac", 900, 900), device("mac", 0, 0)])), null);
  assert.equal(rhythmDevices(day([device("unrecognized", 900, 900)])), null);
  assert.equal(rhythmDevices(day([device("mac", NaN, 900)])), null);
  assert.deepEqual(rhythmDevices(day([device("mac", 900, 900), device("iphone", 0, null)])),
    [device("mac", 900, 900), device("iphone", 0, null)]);
});
