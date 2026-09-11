import MarkdownIt from "markdown-it";
import { JSON_SCHEMA, load } from "js-yaml";
import type { BeliefRecord } from "../../api";

export const EMPTY_BELIEF = "---\ntags: []\n---\n\n# \n\n";
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[character]!));
export function beliefTagLabel(tag: string) { return tag.split("/").filter(Boolean).join(" · "); }
const markdown = new MarkdownIt({ html: false, breaks: false, typographer: false });
markdown.inline.ruler.before("text", "belief_tag", (state, silent) => {
  // markdown-it tracks nested links here; its community types omit this field.
  if (state.src[state.pos] !== "#" || (state as typeof state & {linkLevel: number}).linkLevel > 0) return false;
  if (state.pos > 0 && !/[\s([{（【，。；：！？]/u.test(state.src[state.pos - 1])) return false;
  const match = /^#([\p{L}_-][\p{L}\p{M}\p{N}_/-]*)/u.exec(state.src.slice(state.pos, state.posMax));
  if (!match) return false;
  if (!silent) state.push("belief_tag", "", 0).content = match[1];
  state.pos += match[0].length;
  return true;
});
markdown.renderer.rules.belief_tag = (tokens, index) => `<span class="belief-inline-tag">${escape(beliefTagLabel(tokens[index].content))}</span>`;
markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};

export function parseBelief(source: string) {
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  let properties: Record<string, unknown> = {}, body = text;
  if (lines[0].trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && ["---", "..."].includes(line.trim()));
    if (end < 0) throw new Error("顶部属性需要用另一行 --- 结束。");
    let parsed: unknown;
    try { parsed = load(lines.slice(1, end).join("\n"), { schema: JSON_SCHEMA }) ?? {}; }
    catch { throw new Error("顶部属性格式有误，请检查缩进和括号，例如 tags: [专注, 实践]。"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("顶部属性请写成键值，例如 tags: [专注, 实践]。");
    properties = parsed as Record<string, unknown>;
    body = lines.slice(end + 1).join("\n");
  }
  const tokens = markdown.parse(body, {});
  const index = tokens.findIndex(token => token.type === "heading_open" && token.tag === "h1");
  const title = (index < 0 ? "" : (tokens[index + 1].children ?? []).map(token => token.type === "belief_tag" ? beliefTagLabel(token.content) : ["softbreak", "hardbreak"].includes(token.type) ? " " : ["text", "code_inline", "image"].includes(token.type) ? token.content : "").join("").trim())
    || (typeof properties.title === "string" ? properties.title.trim() : "");
  const values: unknown[] = properties.tags == null ? [] : Array.isArray(properties.tags) ? [...properties.tags] : [properties.tags];
  for (const token of tokens) for (const child of token.children ?? []) if (child.type === "belief_tag") values.push(child.content);
  const tags = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== "string") throw new Error("标签请写成文字，例如 tags: [专注, 实践]。");
    const tag = value.trim().replace(/^#/, "");
    if (!/^[\p{L}_-][\p{L}\p{M}\p{N}_/-]*$/u.test(tag)) throw new Error("标签不能包含空格或以数字开头，可用中文、字母、数字、_、- 和 /。");
    if (!tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
  }
  return { title, tags: [...tags.values()], html: markdown.renderer.render(tokens, markdown.options, {}), error: "" };
}

export function beliefView(record: BeliefRecord) {
  try {
    const parsed = parseBelief(record.markdown);
    return { ...record, ...parsed, title: parsed.title || record.path.split("/").at(-1)!.replace(/\.md$/, "") };
  } catch (error) {
    return { ...record, title: record.path.split("/").at(-1)!, tags: [], html: "", error: (error as Error).message };
  }
}
export type BeliefView = ReturnType<typeof beliefView>;
export type BeliefSort = "manual" | "likes" | "recent" | "updated";

export function beliefTagIndex(records: Pick<BeliefView, "tags">[], pendingTags: string[] = []) {
  const tags = new Map<string, {key: string; name: string; count: number}>();
  for (const record of records) for (const name of record.tags) {
    const key = name.toLowerCase(), previous = tags.get(key);
    tags.set(key, {key, name: previous?.name ?? name, count: (previous?.count ?? 0) + 1});
  }
  for (const name of pendingTags) {
    const key = name.toLowerCase();
    if (!tags.has(key)) tags.set(key, {key, name, count: 0});
  }
  return [...tags.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function orderedBeliefs(records: BeliefView[], order: string[], sort: BeliefSort) {
  const ranks = new Map(order.map((id, index) => [id, index]));
  return [...records].sort((a, b) => {
    const tie = (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity);
    return (sort === "likes" ? b.like_count - a.like_count : sort === "recent" ? b.created_at - a.created_at : sort === "updated" ? b.updated_at - a.updated_at : 0) || tie;
  });
}

export function reorderBeliefs(order: string[], subset: string[], id: string, index: number) {
  if (!subset.includes(id) || new Set(subset).size !== subset.length || subset.some(item => !order.includes(item))) return order;
  const next = subset.filter(item => item !== id);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, id);
  const included = new Set(subset); let position = 0;
  return order.map(item => included.has(item) ? next[position++] : item);
}

export function nextBeliefDay(timezone: string, now = Date.now()) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = formatter.format(now);
  let low = now, high = now + 36 * 60 * 60 * 1000;
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2);
    if (formatter.format(middle) === today) low = middle; else high = middle;
  }
  return Math.max(1000, high - now + 50);
}

export interface BeliefDraft {
  id: string;
  markdown: string;
  expectedFingerprint: string | null;
}
export function draftKey(namespace: string) { return `kinawatch.beliefs.drafts.v1.${namespace}`; }
export function readBeliefDrafts(namespace: string): Record<string, BeliefDraft> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(draftKey(namespace)) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, draft]) => draft && draft.id === key && typeof draft.markdown === "string" && (draft.expectedFingerprint === null || typeof draft.expectedFingerprint === "string")));
  } catch { return {}; }
}
