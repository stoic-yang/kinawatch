import { useMemo } from "react";
import { MarkdownLite } from "../../lib/markdown";
import { extractJournalHeadings } from "./journalOutline";

/** Read-only source sections; their anchors share the outline extractor's IDs. */
export function JournalOriginal({ text, idPrefix }: { text: string; idPrefix: string }) {
  const headings = useMemo(() => extractJournalHeadings(text), [text]);
  const preambleEnd = headings[0]?.start ?? text.length;
  return (
    <div className="journal-original-content">
      {preambleEnd > 0 && <MarkdownLite text={text.slice(0, preambleEnd)} />}
      {headings.map((heading, index) => (
        <div
          key={heading.id}
          id={`${idPrefix}-${heading.id}`}
          className="journal-original-section"
          data-heading-level={heading.level}
          tabIndex={-1}
        >
          <MarkdownLite text={text.slice(heading.start, headings[index + 1]?.start ?? text.length)} />
        </div>
      ))}
    </div>
  );
}
