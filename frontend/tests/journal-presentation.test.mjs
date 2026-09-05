import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-presentation-"));
const output = join(directory, "presentation.mjs");
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL("../src/experiments/concepts/journalPresentation.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm" });
const { presentJournal, editPresentedJournal, updateJournalPresentation } = await import(pathToFileURL(output).href);

for (const newline of ["\n", "\r\n"]) {
  const summary = ["## 一天活动小总结", "> [!abstract] 今日轨迹", "> - 合成摘要 **保留**", "", ""].join(newline);
  const advice = ["> [!tip] Kina 建议", "> 合成建议", "", ""].join(newline);
  const workflow = ["> [!abstract]- 工作流", "> <!-- kinawatch:workflow:09:00–09:30 -->", "> **09:00–09:30**", "> 用户描述", "", ""].join(newline);
  const source = "# 日记" + newline + "首段中文。" + newline + newline + summary + workflow + advice + "尾段。";
  const label = newline === "\n" ? "LF" : "CRLF";

  test(`${label}: projection hides managed workflow while preserving its source`, () => {
    const view = presentJournal(source);
    assert.equal(editPresentedJournal(view, []), source);
    assert.equal(view.summaries.length, 2);
    assert.equal(view.markdown, source.replace(summary, "").replace(advice, "").replace(workflow, ""));
    assert.ok(!view.markdown.includes("用户描述"));
    assert.ok(view.source.includes(workflow));
  });

  test(`${label}: edits around hidden sections preserve their exact bytes`, () => {
    const view = presentJournal(source);
    const first = view.markdown.indexOf("首段中文");
    const last = view.markdown.indexOf("尾段");
    const edited = editPresentedJournal(view, [{ from: first, to: first + 4, insert: "新的😀中文" }, { from: last, to: last + 2, insert: "另一段" }]);
    assert.equal(edited, source.replace("首段中文", "新的😀中文").replace("尾段", "另一段"));
    assert.ok(edited.includes(summary));
    assert.ok(edited.includes(advice));
  });

  test(`${label}: select-all, deletion and resumed typing never erase summaries`, () => {
    let current = source;
    for (const text of ["重写的普通段落", "", "重新开始写正文", "# 标题" + newline + "新的内容"]) {
      const view = presentJournal(current);
      current = editPresentedJournal(view, [{ from: 0, to: view.markdown.length, insert: text }]);
      assert.ok(current.includes(summary));
      assert.ok(current.includes(advice));
      assert.ok(current.includes(workflow));
      assert.equal(presentJournal(current).markdown.trim(), text);
      assert.equal(presentJournal(current).summaries.length, 2);
    }
  });

  test(`${label}: typing into a summary at EOF cannot become hidden quote text`, () => {
    const raw = summary.trimEnd();
    const source = editPresentedJournal(presentJournal(raw), [{ from: 0, to: 0, insert: "没有标题也能开始写" }]);
    assert.ok(source.startsWith(raw));
    assert.equal(presentJournal(source).markdown, "没有标题也能开始写");
    assert.equal(presentJournal(source).summaries[0].markdown, "- 合成摘要 **保留**");
  });

  test(`${label}: unstructured workflow prose remains visible and editable`, () => {
    const raw = ["> [!abstract] 今日轨迹", "> 合成摘要", "> [!abstract]- 工作流", "> 用户描述"].join(newline);
    const view = presentJournal(raw);
    assert.equal(view.markdown, ["> [!abstract]- 工作流", "> 用户描述"].join(newline));
    const edited = editPresentedJournal(view, [{ from: 0, to: view.markdown.length, insert: "普通正文" }]);
    assert.equal(presentJournal(edited).markdown, "普通正文");
    assert.equal(presentJournal(edited).summaries[0].markdown, "合成摘要");
  });

  test(`${label}: sequential edits never add visible whitespace or move source boundaries`, () => {
    let view = presentJournal(source);
    view = updateJournalPresentation(view, [{ from: 0, to: view.markdown.length, insert: "继续写作" }]);
    assert.equal(view.markdown, "继续写作");
    view = updateJournalPresentation(view, [{ from: 4, to: 4, insert: "，保存中也继续。" }]);
    assert.equal(view.markdown, "继续写作，保存中也继续。");
    let seed = 753;
    const random = max => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
    for (let index = 0; index < 100; index++) {
      const from = random(view.markdown.length + 1);
      const to = from + random(view.markdown.length - from + 1);
      const insert = ["正文", newline, "😀", "", "# 标题" + newline][random(5)];
      const expected = view.markdown.slice(0, from) + insert + view.markdown.slice(to);
      view = updateJournalPresentation(view, [{ from, to, insert }]);
      assert.equal(view.markdown, expected);
      assert.ok(view.source.includes(summary));
      assert.ok(view.source.includes(advice));
      assert.ok(view.source.includes(workflow));
    }
  });
}

test("code examples, HTML comments, nested quotes and unknown callouts remain in body", () => {
  const source = "```markdown\n> [!abstract] 今日轨迹\n> 示例\n```\n\n<!--\n> [!abstract] 今日轨迹\n> 注释示例\n-->\n\n> [!note] 我的提示\n> 保留\n\n- 列表\n  > [!abstract] 今日轨迹\n  > 内嵌示例\n";
  const view = presentJournal(source);
  assert.equal(view.markdown, source);
  assert.equal(view.summaries.length, 0);
});

test("managed workflow alone, including cleared entries, stays out of new prose", () => {
  for (const body of ["> 描述第一行\n>\n> > 引用\n> 最后一行", ">", "> # 内部标题\n> 用户描述", "> [!note] 描述里的 Callout\n> 这也属于工作流描述。"]) {
    const raw = "> [!abstract]- 工作流\n> <!-- kinawatch:workflow:09:00–09:30 -->\n> **09:00–09:30**\n" + body;
    let view = presentJournal(raw);
    assert.equal(view.markdown, "");
    assert.equal(view.summaries.length, 0);
    view = updateJournalPresentation(view, [{from:0,to:0,insert:"# 今天\n只写自己的日记。"}]);
    assert.ok(view.source.includes(raw));
    assert.equal(presentJournal(view.source).markdown, "# 今天\n只写自己的日记。");
  }
});

test("legacy timed descriptions are hidden without consuming adjacent user prose", () => {
  for (const workflow of [
    "> [!abstract]- 09:00–09:30 · 工作流\n> 旧描述。\n\n^workflow-0900\n\n",
    "> [!abstract]- 工作流\n> **09:00–09:30**\n> 旧描述。\n\n",
    "- **工作流 09:00–09:30**：旧描述。 ^workflow-0900\n\n",
  ]) {
    const source = "首段。\n\n" + workflow + "尾段。";
    const view = presentJournal(source);
    assert.equal(view.markdown, "首段。\n\n尾段。");
    assert.equal(editPresentedJournal(view, []), source);
  }
});

test("malformed workflow markers and code examples stay visible", () => {
  for (const raw of [
    "> [!abstract]- 工作流\n> 普通的写作想法。",
    "> [!abstract]- 工作流\n> <!-- kinawatch:workflow:09:00–09:30 -->\n> **10:00–10:30**\n> 不匹配。",
    "```markdown\n> [!abstract]- 工作流\n> <!-- kinawatch:workflow:09:00–09:30 -->\n> **09:00–09:30**\n> 示例。\n```",
  ]) assert.equal(presentJournal(raw).markdown, raw);
});
