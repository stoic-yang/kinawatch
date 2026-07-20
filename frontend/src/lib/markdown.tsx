import type { ReactNode } from "react";

// Deliberately tiny renderer: journal text is trusted local Markdown, but we
// only style what the review panel needs (paragraphs, list lines, wikilinks,
// bold, inline code). Everything else stays literal text.
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\[\[([^\]]+)\]\]|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const target = m[1].split("|")[0];
      const label = m[1].split("|")[1] ?? target;
      nodes.push(
        <span key={`${keyBase}-${i++}`} className="wikilink" title={target}>
          {label}
        </span>,
      );
    } else if (m[2] !== undefined) {
      nodes.push(<strong key={`${keyBase}-${i++}`}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      nodes.push(<code key={`${keyBase}-${i++}`}>{m[3]}</code>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const numbered = /^(\d+)[.、]\s*(.*)$/.exec(trimmed);
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) {
      out.push(
        <p key={idx} className="md-heading">
          {renderInline(heading[1], `h${idx}`)}
        </p>,
      );
    } else if (bullet) {
      out.push(
        <p key={idx} className="md-bullet">
          {renderInline(bullet[1], `b${idx}`)}
        </p>,
      );
    } else if (numbered) {
      out.push(
        <p key={idx} className="md-numbered">
          <span className="md-num">{numbered[1]}</span>
          {renderInline(numbered[2], `n${idx}`)}
        </p>,
      );
    } else {
      out.push(<p key={idx}>{renderInline(trimmed, `p${idx}`)}</p>);
    }
  });
  return <div className="md">{out}</div>;
}
