import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-container-ui-"));
after(() => rm(directory, { recursive: true, force: true }));
const page = fileURLToPath(new URL("../src/experiments/concepts/ServersPage.tsx", import.meta.url));
await build({
  stdin: {
    contents: `import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
${await readFile(page, "utf8")}
export const renderHost = host => renderToStaticMarkup(createElement(HostCard, { host, elapsed: 0, failed: false }));`,
    resolveDir: dirname(page), loader: "tsx",
  },
  outfile: join(directory, "page.cjs"), bundle: true, platform: "node", format: "cjs",
  jsx: "automatic", loader: { ".css": "empty" },
});
const { renderHost } = createRequire(import.meta.url)(join(directory, "page.cjs"));
const host = {
  alias: "compute-rental", status: "online", route: "直连", age_seconds: 0, received_at: null, error: "",
  data: { hostname: "container", time: 1234, cpu: 50, cores: 32, cpu_scope: "cgroup", memory_scope: "cgroup",
    memory: { total: 160 * 1024 ** 3, used: 120 * 1024 ** 3, available: 40 * 1024 ** 3 },
    load: ["100", "100", "100"], uptime: 100, swap: { total: 0, used: 0 }, disks: [], errors: [], processes: [],
    gpus: ["0", "1"].map(index => ({ index, name: "NVIDIA Example GPU", util: 80, used_mib: 10000, total_mib: 24564, temperature: 60, power: 200 })),
  },
};

test("one container card has shared CPU/RAM once and both individual GPUs", () => {
  const html = renderHost(host);
  assert.equal(html.match(/<span>CPU · 容器<\/span>/g)?.length, 1);
  assert.equal(html.match(/<span>内存 · 容器<\/span>/g)?.length, 1);
  assert.match(html, /32 核配额 · GPU 共享/);
  assert.match(html, /120.0 GiB \/ 160.0 GiB · 含缓存/);
  assert.match(html, /aria-label="GPU 0"/);
  assert.match(html, /aria-label="GPU 1"/);
  assert.doesNotMatch(html, /Load/);
  assert.match(html, /宿主机已运行/);
});

test("fractional CPU quotas and missing scoped readings remain visible without host fallback", () => {
  const html = renderHost({ ...host, data: { ...host.data, cores: 1.5, cpu: null, memory: { total: 160 * 1024 ** 3, used: null } } });
  assert.match(html, /1.50 核配额/);
  assert.match(html, /— \/ 160.0 GiB/);
});

test("old ordinary-server data keeps CPU, host load and memory presentation", () => {
  const html = renderHost({ ...host, data: { ...host.data, cpu_scope: undefined, memory_scope: undefined } });
  assert.match(html, /<span>CPU<\/span>/);
  assert.match(html, /<span>内存<\/span>/);
  assert.match(html, /Load 100 \/ 100 \/ 100/);
  assert.doesNotMatch(html, /容器|宿主机已运行/);
});
