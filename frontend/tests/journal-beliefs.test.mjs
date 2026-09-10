import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-beliefs-"));
after(() => rm(directory, {recursive: true, force: true}));
await build({entryPoints: [fileURLToPath(new URL("../src/experiments/concepts/beliefModel.ts", import.meta.url))], outfile: join(directory, "model.mjs"), bundle: true, platform: "node", format: "esm"});
const { parseBelief, beliefView, orderedBeliefs, reorderBeliefs, nextBeliefDay, readBeliefDrafts } = await import(pathToFileURL(join(directory, "model.mjs")).href);

test("Markdown properties and inline tags derive the title without rewriting source", () => {
  const source = '\ufeff---\r\ntags: [专注, "#实践", Focus]\r\naliases: [别名]\r\n---\r\n# **先看证据**，再判断\r\n\r\n#复盘 #focus\r\n\r\n`#代码` [不是 #链接](https://example.com) \\#转义\r\n\r\n```md\r\n#代码块\r\n```';
  const view = parseBelief(source);
  assert.equal(view.title, '先看证据，再判断');
  assert.deepEqual(view.tags, ['专注', '实践', 'Focus', '复盘']);
  assert.match(view.html, /<strong>先看证据<\/strong>/);
  assert.equal(beliefView({id: 'a', path: 'example.md', markdown: source}).markdown, source);
});

test("malformed YAML is visible and unsafe HTML stays literal", () => {
  assert.throws(() => parseBelief('---\ntags: [未闭合\n---\n# 标题'), /属性格式/);
  assert.throws(() => parseBelief('---\ntags: ["含 空格"]\n---\n# 标题'), /标签/);
  const result = parseBelief('# 标题\n\n<script>alert(1)</script>\n\n[点击](javascript:alert(1))');
  assert.ok(!result.html.includes('<script>'));
  assert.ok(!result.html.includes('href="javascript:'));
  const broken = beliefView({id: 'a', path: 'broken.md', markdown: '---\ntags: [未闭合\n---\n# 标题'});
  assert.equal(broken.title, 'broken.md'); assert.ok(broken.error);
});

test("rich Markdown supports lists, quotes, tables and code", () => {
  const view = parseBelief('# 标题\n\n- 第一项\n- 第二项\n\n> 引用\n\n| 证据 | 结论 |\n| --- | --- |\n| A | B |\n\n```js\nconst x = 1\n```');
  for (const token of ['<ul>', '<blockquote>', '<table>', '<pre>']) assert.ok(view.html.includes(token));
});

test("filtered dragging preserves hidden slots and like sorting retains the manual order", () => {
  const order = ['a', 'hidden', 'b', 'c'];
  assert.deepEqual(reorderBeliefs(order, ['a', 'b', 'c'], 'c', 0), ['c', 'hidden', 'a', 'b']);
  assert.deepEqual(order, ['a', 'hidden', 'b', 'c']);
  const rows = ['b', 'c', 'a'].map(id => ({id, like_count: id === 'a' ? 2 : 3, created_at: 0, updated_at: 0}));
  assert.deepEqual(orderedBeliefs(rows, ['c', 'a', 'b'], 'likes').map(row => row.id), ['c', 'b', 'a']);
  assert.deepEqual(orderedBeliefs(rows, ['c', 'a', 'b'], 'manual').map(row => row.id), ['c', 'a', 'b']);
});

test("the daily transition follows local calendar midnight including DST", () => {
  const almostMidnight = Date.parse('2026-09-10T23:59:59+08:00');
  assert.ok(nextBeliefDay('Asia/Shanghai', almostMidnight) >= 1000);
  assert.ok(nextBeliefDay('Asia/Shanghai', almostMidnight) < 2100);
  const spring = Date.parse('2026-03-08T00:00:00-05:00');
  const delay = nextBeliefDay('America/New_York', spring);
  assert.ok(Math.abs(delay - 23 * 3600000) < 1100);
});

test("draft recovery is namespaced and rejects malformed stored values", () => {
  const storage = new Map();
  globalThis.localStorage = {getItem: key => storage.get(key)};
  storage.set('kinawatch.beliefs.drafts.v1.a', JSON.stringify({first: {id: 'first', markdown: '# 草稿', expectedFingerprint: null}, malformed: {id: 'different', markdown: 2}}));
  assert.deepEqual(Object.keys(readBeliefDrafts('a')), ['first']);
  assert.deepEqual(readBeliefDrafts('b'), {});
  delete globalThis.localStorage;
});
