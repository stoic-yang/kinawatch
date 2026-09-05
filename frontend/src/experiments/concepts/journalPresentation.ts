import { markdownLanguage } from "@codemirror/lang-markdown";

export type MarkdownEdit = { from: number; to: number; insert: string };
type SourceRange = { from: number; to: number };
type VisibleRange = SourceRange & { visibleFrom: number; visibleTo: number };
export type JournalPresentation = {
  source: string;
  markdown: string;
  summaries: { title: string; markdown: string }[];
  hidden: SourceRange[];
  visible: VisibleRange[];
};

const SUMMARY_TITLES = new Set(["今日轨迹", "一天活动小总结", "一天活动小总结（Kina 生成）", "Kina 总结", "Kina总结", "Kina 建议", "Kina建议"]);
const CALLOUT_HEADER = /^ {0,3}>[ \t]*\[![\w-]+\][+-]?[ \t]*(.*?)[ \t]*$/;
const CLOCK = "(?:[01]\\d|2[0-3]):[0-5]\\d";
const TIMED_ENTRY = `(${CLOCK})(?:\\s*[–—-]\\s*(${CLOCK}))?`;
const WORKFLOW_MARKER = new RegExp(`^\\s*<!--\\s*kinawatch:workflow:${TIMED_ENTRY}\\s*-->\\s*$`);
const WORKFLOW_HEADING = new RegExp(`^\\s*\\*\\*${TIMED_ENTRY}\\*\\*\\s*$`);
const WORKFLOW_TITLE = new RegExp(`^(?:${TIMED_ENTRY}\\s*[·•]\\s*工作流|工作流\\s*[·•]\\s*${TIMED_ENTRY})$`);
const WORKFLOW_LINE = new RegExp(`^\\s*[-*+]\\s+\\*\\*工作流\\s+${TIMED_ENTRY}\\*\\*\\s*[：:]\\s*\\S.*$`);
const lineStart = (text: string, at: number) => Math.max(text.lastIndexOf("\n", at - 1), text.lastIndexOf("\r", at - 1)) + 1;
const throughBlankLines = (text: string, at: number) => at + /^(?:[ \t]*(?:\r\n|\r|\n))*/.exec(text.slice(at))![0].length;

function isWorkflow(title: string, body: string[]): boolean {
  if (WORKFLOW_TITLE.test(title)) return body.some(line => line.trim());
  if (title !== "工作流") return false;
  const markers = body.map((line, index) => ({ match: WORKFLOW_MARKER.exec(line), index })).filter(entry => entry.match);
  if (markers.length) {
    if (body.slice(0, markers[0].index).some(line => line.trim())) return false;
    return markers.every(({ match, index }) => {
      const heading = WORKFLOW_HEADING.exec(body[index + 1] ?? "");
      return heading && heading[1] === match![1] && heading[2] === match![2];
    });
  }
  // Legacy groups have timed headings without machine markers. A plain
  // user-authored callout named 工作流 must remain part of the journal.
  const lines = body.filter(line => line.trim());
  return lines.length > 1 && WORKFLOW_HEADING.test(lines[0])
    && lines.every((line, index) => !WORKFLOW_HEADING.test(line)
      || index + 1 < lines.length && !WORKFLOW_HEADING.test(lines[index + 1]));
}

/** Project managed workflow and Kina sections out of prose, preserving source. */
export function presentJournal(source: string): JournalPresentation {
  const ranges: SourceRange[] = [];
  const summaries: JournalPresentation["summaries"] = [];
  const tree = markdownLanguage.parser.parse(source);
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === "BulletList") {
      for (let item = node.firstChild; item; item = item.nextSibling) {
        const raw = source.slice(item.from, item.to);
        if (item.name === "ListItem" && !/[\r\n]/.test(raw) && WORKFLOW_LINE.test(raw)) {
          ranges.push({ from: lineStart(source, item.from), to: throughBlankLines(source, item.to) });
        }
      }
    }
    // Top-level syntax nodes exclude examples inside code fences, comments and lists.
    if (node.name !== "Blockquote") continue;
    const raw = source.slice(node.from, node.to);
    const lines = [...raw.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g)].filter(match => match[0]);
    if (!CALLOUT_HEADER.test(lines[0]?.[1] ?? "")) continue;
    const headers = lines.map((line, index) => ({ line, index, title: CALLOUT_HEADER.exec(line[1])?.[1] }))
      .filter((item): item is typeof item & { title: string } => item.title !== undefined);
    for (let index = 0; index < headers.length; index++) {
      const entry = headers[index];
      const next = headers[index + 1];
      const bodyLines = lines.slice(entry.index + 1, next?.index ?? lines.length)
        .map(line => line[1].replace(/^ {0,3}>[ \t]?/, ""));
      const summary = SUMMARY_TITLES.has(entry.title);
      const workflow = isWorkflow(entry.title, lines.slice(entry.index + 1)
        .map(line => line[1].replace(/^ {0,3}>[ \t]?/, "")));
      if (!summary && !workflow) continue;
      const from = lineStart(source, node.from + entry.line.index);
      let to = next && !workflow ? lineStart(source, node.from + next.line.index) : throughBlankLines(source, node.to);
      if (workflow && WORKFLOW_TITLE.test(entry.title)) {
        const start = new RegExp(CLOCK).exec(entry.title)![0].replace(":", "");
        const anchor = new RegExp(`^[ \\t]*\\^workflow-${start}[ \\t]*(?=\\r|\\n|$)`).exec(source.slice(to));
        if (anchor) to = throughBlankLines(source, to + anchor[0].length);
      }
      ranges.push({ from, to });
      // The backend owns the complete workflow quote. Callout-looking lines
      // inside a saved description are still that description's content.
      if (workflow) break;
      if (summary) summaries.push({ title: entry.title, markdown: bodyLines.join("\n").trim() });

      const previous = node.prevSibling;
      if (summary && index === 0 && previous?.name === "ATXHeading2"
          && /^##[ \t]+一天活动小总结[ \t]*#*[ \t]*$/.test(source.slice(previous.from, previous.to).trimEnd())
          && !source.slice(previous.to, from).trim()) {
        ranges.push({ from: lineStart(source, previous.from), to: previous.to });
      }
    }
  }
  const hidden: SourceRange[] = [];
  for (const range of ranges.sort((a, b) => a.from - b.from)) {
    const previous = hidden.at(-1);
    if (previous && (range.from <= previous.to || !source.slice(previous.to, range.from).trim())) previous.to = Math.max(previous.to, range.to);
    else hidden.push({ ...range });
  }
  return withRanges(source, hidden, summaries);
}

function withRanges(source: string, hidden: SourceRange[], summaries: JournalPresentation["summaries"]): JournalPresentation {
  const visible: VisibleRange[] = [];
  let sourceAt = 0, visibleAt = 0;
  for (const range of [...hidden, { from: source.length, to: source.length }]) {
    if (sourceAt < range.from) {
      const length = range.from - sourceAt;
      visible.push({ from: sourceAt, to: range.from, visibleFrom: visibleAt, visibleTo: visibleAt + length });
      visibleAt += length;
    }
    sourceAt = range.to;
  }
  return { source, markdown: visible.map(range => source.slice(range.from, range.to)).join(""), summaries, hidden, visible };
}

function applyEdits(source: string, edits: MarkdownEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.from - a.from || b.to - a.to)) {
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  }
  return result;
}

/** Apply editor offsets only to visible prose, never to the sidebar's source. */
export function updateJournalPresentation(view: JournalPresentation, edits: readonly MarkdownEdit[]): JournalPresentation {
  if (!edits.length) return view;
  const sourceEdits: MarkdownEdit[] = [];
  for (const edit of edits) {
    const deletions = view.visible.filter(range => range.visibleFrom < edit.to && range.visibleTo > edit.from)
      .map(range => ({
        from: range.from + Math.max(edit.from - range.visibleFrom, 0),
        to: range.from + Math.min(edit.to - range.visibleFrom, range.to - range.from),
        insert: "",
      }));
    if (deletions.length) deletions[0].insert = edit.insert;
    else {
      const range = view.visible.find(item => item.visibleFrom <= edit.from && item.visibleTo >= edit.from);
      const at = range ? range.from + edit.from - range.visibleFrom : view.source.length;
      deletions.push({ from: at, to: at, insert: edit.insert });
    }
    sourceEdits.push(...deletions);
  }
  let result = applyEdits(view.source, sourceEdits);
  const newline = /\r\n|\r|\n/.exec(view.source)?.[0] ?? "\n";
  const shifted: SourceRange[] = [];
  for (const range of view.hidden) {
    const delta = sourceEdits.filter(edit => edit.to <= range.from)
      .reduce((total, edit) => total + edit.insert.length - (edit.to - edit.from), 0);
    const from = range.from + delta, to = from + range.to - range.from;
    const previous = shifted.at(-1);
    if (previous?.to === from) previous.to = to;
    else shifted.push({ from, to });
  }
  const separators: (MarkdownEdit & { owner: number })[] = [];
  for (const [owner, { from, to }] of shifted.entries()) {
    // A blank line prevents new prose from becoming a lazy continuation of the
    // hidden blockquote, including a summary-only note or a select-all edit.
    if (from > 0) {
      const before = /(?:[ \t]*(?:\r\n|\r|\n))*[ \t]*$/.exec(result.slice(0, from))![0];
      const breaks = (before.match(/\r\n|\r|\n/g) ?? []).length;
      if (breaks < 2) separators.push({ from, to: from, insert: newline.repeat(2 - breaks), owner });
    }
    if (to < result.length) {
      const tail = /(?:[ \t]*(?:\r\n|\r|\n))*[ \t]*$/.exec(result.slice(from, to))![0];
      const head = /^[ \t]*(?:(?:\r\n|\r|\n)[ \t]*)*/.exec(result.slice(to))![0];
      const breaks = ((tail + head).match(/\r\n|\r|\n/g) ?? []).length;
      if (breaks < 2) separators.push({ from: to, to, insert: newline.repeat(2 - breaks), owner });
    }
  }
  result = applyEdits(result, separators);
  const hidden = shifted.map((range, owner) => {
    const delta = separators.filter(edit => edit.from < range.from || edit.from === range.from && edit.owner !== owner)
      .reduce((total, edit) => total + edit.insert.length, 0);
    const added = separators.filter(edit => edit.owner === owner).reduce((total, edit) => total + edit.insert.length, 0);
    return { from: range.from + delta, to: range.to + delta + added };
  });
  // Structural separators belong to the hidden view. They must not appear as
  // editor changes or move the caret when a save acknowledgement arrives.
  return withRanges(result, hidden, view.summaries);
}

export function editPresentedJournal(view: JournalPresentation, edits: readonly MarkdownEdit[]): string {
  return updateJournalPresentation(view, edits).source;
}
