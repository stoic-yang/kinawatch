import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-servers-"));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL("../src/experiments/concepts/serverMonitor.ts", import.meta.url))], outfile: join(directory, "servers.mjs"), bundle: true, platform: "node", format: "esm" });
const { hostStatus, percent, metric, bytes, duration, filterProcesses } = await import(pathToFileURL(join(directory, "servers.mjs")).href);

test("stale time continues to advance when HTTP fails; cached data never reports online", () => {
  const host = { status: "online", age_seconds: 2, data: {} };
  assert.equal(hostStatus(host, 3), "online");
  assert.equal(hostStatus(host, 9), "stale");
  assert.equal(hostStatus(host, 0, true), "stale");
  assert.equal(hostStatus({ ...host, status: "offline" }, 0), "offline");
  assert.equal(hostStatus({ ...host, data: null }, 0, true), "offline");
});
test("unknown metrics stay unknown; process CPU may exceed one core", () => {
  assert.equal(metric(null), "—");
  assert.equal(metric(180.2), "180.2");
  assert.equal(percent(5, 0), null);
  assert.equal(percent(null, 100), null);
  assert.equal(percent(25, 100), 25);
  assert.equal(bytes(2 * 1024 ** 3), "2.0 GiB");
  assert.equal(bytes(19 * 1024 ** 2), "19 MiB");
  assert.equal(duration(90000), "1天 1时");
});
test("task, GPU and service filters combine with search without changing source data", () => {
  const items = [
    { pid: 1, owner: "alice", task: "train", command: "python train.py --seed 17", service: false, gpu_mib: 1024 },
    { pid: 2, owner: "bob", task: "TensorBoard", command: "tensorboard", service: true, gpu_mib: 0 },
    { pid: 3, owner: "alice", task: "worker", command: "python worker.py", service: false, gpu_mib: 0 },
    { pid: 4, owner: "bob", task: "GPU service", command: "python service.py", service: true, gpu_mib: 1024 },
  ];
  assert.deepEqual(filterProcesses(items, "work", "").map(p => p.pid), [1, 3, 4]);
  assert.deepEqual(filterProcesses(items, "gpu", " BOB ").map(p => p.pid), [4]);
  assert.deepEqual(filterProcesses(items, "all", "tensorBOARD").map(p => p.pid), [2]);
  assert.deepEqual(filterProcesses(items, "all", "--seed 17").map(p => p.pid), [1]);
  assert.equal(items.length, 4);
});
