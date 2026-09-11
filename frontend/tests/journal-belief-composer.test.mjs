import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-composer-"));
after(() => rm(directory, {recursive: true, force: true}));
await build({entryPoints: [fileURLToPath(new URL("../src/experiments/concepts/beliefComposition.ts", import.meta.url))], outfile: join(directory, "composition.mjs"), bundle: true, platform: "node", format: "esm"});
const {readBeliefComposition, writeBeliefTitle, writeBeliefTags, writeBeliefBody} = await import(pathToFileURL(join(directory, "composition.mjs")).href);

test("a short belief can be composed without showing Markdown scaffolding", () => {
  const blank = '#\n\n';
  assert.equal(readBeliefComposition(blank).title, '');
  assert.equal(readBeliefComposition(blank).body, '');
  assert.equal(readBeliefComposition('# \n\n').title, '');
  let source = writeBeliefTitle(blank, '先看证据，再做判断');
  source = writeBeliefTags(source, ['专注', '实践', '实践']);
  source = writeBeliefBody(source, '> 先记下观察。\n\n- 一次小实验\n');
  const fields = readBeliefComposition(source);
  assert.equal(fields.title, '先看证据，再做判断');
  assert.deepEqual(fields.tags, ['专注', '实践']);
  assert.equal(fields.body, '> 先记下观察。\n\n- 一次小实验\n');
  assert.match(source, /^---\ntags: \["专注","实践"\]\n---\n\n# 先看证据，再做判断/);
});

test("title and body edits preserve BOM, line endings and unrelated properties byte for byte", () => {
  const prefix = '\ufeff---\r\naliases: ["旧称"] # preserve\r\ntags: [专注]\r\ncustom:\r\n  nested: true\r\n---\r\n\r\n';
  const source = prefix + '# 旧标题\r\n\r\n原正文。\r\n';
  const renamed = writeBeliefTitle(source, '新标题');
  assert.equal(renamed, prefix + '# 新标题\r\n\r\n原正文。\r\n');
  assert.equal(writeBeliefBody(renamed, '新正文。\n下一行。'), prefix + '# 新标题\r\n\r\n新正文。\r\n下一行。');
  assert.equal(writeBeliefTitle(source, '旧标题'), source);
  assert.equal(writeBeliefBody(source, '原正文。\r\n'), source);
});

test("tag changes replace only the YAML value and preserve adjacent comments and properties", () => {
  const source = '\ufeff---\r\n# before\r\ntags:\r\n  - 专注\r\n  - 实践\r\n# unrelated comment\r\naliases: [旧称]\r\ncustom: 7\r\n---\r\n# 原则\r\n\r\n正文。';
  const updated = writeBeliefTags(source, ['复盘']);
  assert.equal(updated, '\ufeff---\r\n# before\r\ntags: ["复盘"]\r\n# unrelated comment\r\naliases: [旧称]\r\ncustom: 7\r\n---\r\n# 原则\r\n\r\n正文。');
  const inline = '---\n"tags": [专注] # keep inline\naliases: [旧称]\n---\n# 原则';
  assert.equal(writeBeliefTags(inline, []), '---\n"tags": [] # keep inline\naliases: [旧称]\n---\n# 原则');
  const flow = '---\n{tags: [专注], custom: true}\n---\n# 原则';
  assert.equal(writeBeliefTags(flow, ['实践']), '---\n{tags: ["实践"], custom: true}\n---\n# 原则');
});

test("existing Markdown formatting survives tag edits and opening the writing view", () => {
  const source = '# **先看证据**，再判断\n\n> 一段说明\n\n```md\n# 代码中的标题\n```\n';
  const fields = readBeliefComposition(source);
  assert.equal(fields.title, '**先看证据**，再判断');
  assert.equal(writeBeliefTitle(source, fields.title), source);
  const updated = writeBeliefTags(source, ['专注']);
  assert.ok(updated.endsWith(source));
  assert.equal(readBeliefComposition(updated).body, fields.body);
  assert.throws(() => readBeliefComposition('前置说明。\n\n# 标题\n\n正文。'), /原文/);
  assert.throws(() => readBeliefComposition('---\ntags: [未闭合\n---\n# 标题'));
});

test("tag edits cannot change the meaning of aliases in other YAML properties", () => {
  const source = '---\ntags: &shared [专注]\nother: *shared\n---\n# 原则';
  assert.throws(() => writeBeliefTags(source, ['实践']));
});

test("title-only YAML notes and setext headings remain editable", () => {
  assert.equal(writeBeliefTitle('---\ntags: []\n---', '标题'), '---\ntags: []\n---\n# 标题\n\n');
  const source = '---\ntitle: 原标题\naliases: [旧称]\n---\n正文。';
  assert.equal(readBeliefComposition(source).body, '正文。');
  const updated = writeBeliefTitle(source, '新标题');
  assert.match(updated, /aliases: \[旧称\]\n---\n# 新标题\n\n正文。$/);
  const setext = '标题\n====\n\n正文。';
  assert.equal(readBeliefComposition(setext).title, '标题');
  assert.equal(writeBeliefTitle(setext, '修改'), '# 修改\n\n正文。');
});
