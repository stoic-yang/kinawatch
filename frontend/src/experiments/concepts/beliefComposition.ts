import MarkdownIt from "markdown-it";
import { JSON_SCHEMA, load } from "js-yaml";
import { parseBelief } from "./beliefModel";

const markdown = new MarkdownIt();
const newline = /\r\n|\n|\r/;
const sourceOnly = "这份文档的结构适合在原文中编辑。";

function sourceParts(source: string) {
  const bom = source.startsWith("\uFEFF") ? 1 : 0;
  const lines = source.slice(bom).split(/(?<=\n)|(?<=\r)(?!\n)/);
  const ending = newline.exec(source)?.[0] ?? "\n";
  let yamlStart = bom, yamlEnd = bom, bodyStart = bom;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && ["---", "..."].includes(line.trim()));
    if (end < 0) throw new Error("请在原文中补全顶部属性的结束标记。");
    yamlStart += lines[0].length;
    yamlEnd = bom + lines.slice(0, end).join("").length;
    bodyStart = yamlEnd + lines[end].length;
  }
  const yaml = source.slice(yamlStart, yamlEnd);
  const properties = yaml ? load(yaml, {schema: JSON_SCHEMA}) ?? {} : {};
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw new Error(sourceOnly);
  return {bom, ending, yamlStart, yamlEnd, bodyStart, yaml, properties: properties as Record<string, unknown>};
}

export function readBeliefComposition(source: string) {
  const parts = sourceParts(source);
  const body = source.slice(parts.bodyStart);
  const lines = body.split(/(?<=\n)|(?<=\r)(?!\n)/);
  const tokens = markdown.parse(body.replace(/\r\n?/g, "\n"), {});
  const heading = tokens.find(token => token.type === "heading_open" && token.tag === "h1");
  const map = heading?.map;
  let titleStart = parts.bodyStart, titleEnd = titleStart;
  let title = typeof parts.properties.title === "string" ? parts.properties.title : "";
  if (map) {
    if (lines.slice(0, map[0]).join("").trim()) throw new Error(sourceOnly);
    titleStart += lines.slice(0, map[0]).join("").length;
    titleEnd = parts.bodyStart + lines.slice(0, map[1]).join("").length;
    title = lines.slice(map[0], map[1]).join("").replace(/\r\n?/g, "\n").trim();
    title = /^ {0,3}#(?:\s|$)/.test(title) ? title.replace(/^ {0,3}#\s*/, "").replace(/\s+#+\s*$/, "") : title.replace(/\n=+\s*$/, "");
  }
  const gap = /^(?:[ \t]*(?:\r\n|\n|\r))*/.exec(source.slice(titleEnd))![0];
  const bodyOffset = titleEnd + gap.length;
  const tags = parseBelief(source.slice(0, parts.bodyStart) + "\n# placeholder").tags;
  return {...parts, title, tags, body: source.slice(bodyOffset), titleStart, titleEnd, bodyOffset, hasHeading: Boolean(map)};
}

export function writeBeliefTitle(source: string, title: string) {
  const fields = readBeliefComposition(source);
  const text = title.replace(/\r\n|\n|\r/g, " ");
  if (text === fields.title) return source;
  const heading = "# " + text + fields.ending;
  if (!fields.hasHeading) {
    const prefix = source.slice(0, fields.bodyStart);
    const separator = prefix.slice(fields.bom) && !/[\r\n]$/.test(prefix) ? fields.ending : "";
    return prefix + separator + heading + fields.ending + source.slice(fields.bodyStart);
  }
  return source.slice(0, fields.titleStart) + heading + source.slice(fields.titleEnd);
}

export function writeBeliefBody(source: string, body: string) {
  const fields = readBeliefComposition(source);
  if (body === fields.body) return source;
  const text = body.replace(/\r\n|\n|\r/g, fields.ending);
  const separator = fields.hasHeading && fields.bodyOffset === fields.titleEnd ? fields.ending : "";
  return source.slice(0, fields.bodyOffset) + separator + text;
}

type YamlNode = {start: number; end: number; kind: string; value: unknown; children: YamlNode[]};
function yamlRoot(source: string) {
  const stack: YamlNode[] = [];
  let root: YamlNode | undefined;
  load(source, {schema: JSON_SCHEMA, listener(event, state) {
    if (event === "open") {
      const node: YamlNode = {start: state.position, end: state.position, kind: "", value: null, children: []};
      if (stack.length) stack[stack.length - 1].children.push(node); else root = node;
      stack.push(node);
    } else {
      const node = stack.pop()!;
      node.end = Math.min(source.length, state.position); node.kind = state.kind; node.value = state.result;
    }
  }});
  while (root?.children.length === 1 && root.children[0].kind === "mapping") root = root.children[0];
  return root;
}

export function writeBeliefTags(source: string, tags: string[]) {
  const values = parseBelief("---\ntags: " + JSON.stringify(tags) + "\n---\n").tags;
  const parts = sourceParts(source);
  const array = JSON.stringify(values);
  if (parts.bodyStart === parts.bom) {
    if (!values.length) return source;
    return source.slice(0, parts.bom) + "---" + parts.ending + "tags: " + array + parts.ending + "---" + parts.ending + parts.ending + source.slice(parts.bom);
  }
  const children = yamlRoot(parts.yaml)?.children ?? [];
  const key = children.findIndex((node, index) => index % 2 === 0 && node.value === "tags");
  let yaml: string;
  if (key >= 0 && children[key + 1]) {
    const value = children[key + 1];
    // Keep trailing comments and whitespace outside the changed property value.
    const previous = parts.yaml.slice(value.start, value.end);
    const tail = /(?:[ \t]*(?:#[^\r\n]*)?(?:\r\n|\n|\r))+[ \t]*$/.exec(previous)?.[0] ?? "";
    const spacer = parts.yaml[value.start - 1] === ":" ? " " : "";
    yaml = parts.yaml.slice(0, value.start) + spacer + array + parts.yaml.slice(value.end - tail.length);
  } else {
    if (parts.yaml.trimStart().startsWith("{")) throw new Error("请切换到原文，为这份文档添加标签。");
    yaml = parts.yaml + "tags: " + array + parts.ending;
  }
  const next = load(yaml, {schema: JSON_SCHEMA}) as Record<string, unknown>;
  const other = (object: Record<string, unknown>) => Object.fromEntries(Object.entries(object).filter(([key]) => key !== "tags"));
  if (JSON.stringify(other(next)) !== JSON.stringify(other(parts.properties))) throw new Error("请在原文中修改标签，以保留关联属性。");
  return source.slice(0, parts.yamlStart) + yaml + source.slice(parts.yamlEnd);
}
