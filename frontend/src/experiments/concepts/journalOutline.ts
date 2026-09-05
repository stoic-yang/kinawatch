export interface JournalHeading {
  level: number;
  title: string;
  /** Start of the complete heading line, including its indentation and #. */
  start: number;
  /** Exclusive line end, without CR/LF. Offsets refer to the input's UTF-16 text. */
  end: number;
  /** One-based physical line number. */
  line: number;
  /** Deterministic, document-unique suffix; the renderer supplies its own prefix. */
  id: string;
}

function plainHeadingTitle(text: string): string {
  const literals: string[] = [];
  const keepLiteral = (value: string) => `\u0000${literals.push(value) - 1}\u0000`;
  let title = text
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, (_match, value: string) => keepLiteral(value))
    .replace(/(?<!`)(`+)(?!`)(.*?)\1(?!`)/g, (_match, _ticks: string, value: string) => keepLiteral(value.trim()))
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_match, target: string, label?: string) => label || target)
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/!?\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:\/\/[^>]+|[^<>\s]+@[^<>\s]+)>/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "");

  // Two passes also unwrap a common nested pair, such as **bold _emphasis_**.
  for (let pass = 0; pass < 2; pass += 1) {
    title = title
      .replace(/(\*{1,3})(\S(?:.*?\S)?)\1/g, "$2")
      .replace(/(?<![\p{L}\p{N}])(_{1,3})(\S(?:.*?\S)?)\1(?![\p{L}\p{N}])/gu, "$2")
      .replace(/(~~|==)(\S(?:.*?\S)?)\1/g, "$2");
  }
  return title.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => literals[Number(index)])
    .replace(/[ \t]+/g, " ").trim();
}

/**
 * Extract ATX headings without changing the source text. For textarea selection,
 * pass its current value so offsets use the same line-ending representation.
 * Setext headings and headings nested inside quotes/lists are intentionally absent.
 */
export function extractJournalHeadings(text: string): JournalHeading[] {
  const headings: JournalHeading[] = [];
  const usedIds = new Set<string>();
  let fence: { marker: string; length: number } | null = null;
  let lineNumber = 0;

  for (const match of text.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g)) {
    if (match[0] === "") break;
    lineNumber += 1;
    const line = match[1];
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker
        && fenceMatch[1].length >= fence.length && /^[ \t]*$/.test(fenceMatch[2])) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch && (fenceMatch[1][0] !== "`" || !fenceMatch[2].includes("`"))) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }

    // A tab or four leading spaces makes an indented code line, not an ATX heading.
    const headingMatch = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
    if (!headingMatch) continue;
    const sourceTitle = (headingMatch[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "");
    const title = plainHeadingTitle(sourceTitle);
    if (!title) continue;
    const slug = title.normalize("NFKC").toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "untitled";
    const base = `heading-${slug}`;
    let id = base;
    let occurrence = 2;
    while (usedIds.has(id)) id = `${base}-${occurrence++}`;
    usedIds.add(id);
    headings.push({
      level: headingMatch[1].length,
      title,
      start: match.index,
      end: match.index + line.length,
      line: lineNumber,
      id,
    });
  }
  return headings;
}
