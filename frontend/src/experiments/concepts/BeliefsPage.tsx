import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { beliefsDocument } from "./beliefsDocumentStore";
import { MarkdownDocumentEditor, type MarkdownDocumentEditorHandle } from "./MarkdownDocumentEditor";
import { extractJournalHeadings } from "./journalOutline";
import "./beliefs.css";

export function BeliefsPage({ active }: { active: boolean }) {
  const snapshot = useSyncExternalStore(beliefsDocument.subscribe, beliefsDocument.getSnapshot);
  const { document: note, text: draft, error, remote } = snapshot;
  const saving = snapshot.status === "saving";
  const conflict = snapshot.status === "conflict";
  const loading = snapshot.status === "loading";
  const [outlineOpen, setOutlineOpen] = useState(false);
  const editor = useRef<MarkdownDocumentEditorHandle>(null);

  useEffect(() => {
    if (!active) return;
    void beliefsDocument.load();
    const refresh = () => { void beliefsDocument.load(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [active]);

  // Keep the page title's original Markdown prefix byte-for-byte while the
  // visible body stays editable without duplicating that title on the paper.
  const titlePrefix = /^(?:[ \t]*\r?\n)*# 我的人生信念[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/.exec(draft)?.[0] ?? "";
  const displayedMarkdown = draft.slice(titlePrefix.length);
  const headings = useMemo(() => extractJournalHeadings(displayedMarkdown), [displayedMarkdown]);
  const editable = Boolean(note?.write_enabled);
  function change(value: string) { beliefsDocument.change(titlePrefix + value); }
  const updated = note && Number(note.journal_fingerprint.mtime_ns) > 0
    ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(Number(note.journal_fingerprint.mtime_ns) / 1e6) : "";

  return <section className="beliefs-page" hidden={!active} aria-label="我的人生信念">
    <header className="beliefs-heading">
      <div><h1>我的人生信念</h1><p>从经历中留下原则，也允许自己不断修订。</p></div>
    </header>
    {loading && !note && <p className="beliefs-loading" role="status">正在读取信念…</p>}
    {error && <div className="beliefs-error" role="alert"><p>{error}</p>{conflict ? <button type="button" disabled={saving} onClick={() => void beliefsDocument.inspectConflict()}>核对文件版本</button> : <button type="button" disabled={saving} onClick={() => void beliefsDocument.retry()}>{beliefsDocument.dirty ? "重试保存" : "重新读取"}</button>}</div>}
    {remote && conflict && <section className="beliefs-conflict kw-card" aria-label="文件版本对照"><h2>文件中的版本</h2><MarkdownDocumentEditor value={remote.markdown} onChange={() => {}} readOnly ariaLabel="信念文件中的版本" placeholder="文件内容为空"/>
      <div className="beliefs-actions"><button type="button" disabled={saving} onClick={() => beliefsDocument.resolveConflict("remote")}>采用文件版本</button><button type="button" disabled={saving || !editable || !remote.write_enabled} onClick={() => beliefsDocument.resolveConflict("draft")}>用我的草稿更新</button></div>
    </section>}
    {note && <div className={`beliefs-layout${headings.length ? " has-outline" : ""}`}>
      <article className="beliefs-paper kw-card">
        <div className="beliefs-paper-meta"><span>留给自己的提醒</span>{updated && <span>更新于 {updated}</span>}</div>
        {displayedMarkdown.trim() || editable ? <MarkdownDocumentEditor ref={editor} value={displayedMarkdown} onChange={change} readOnly={!editable} ariaLabel="信念正文" placeholder="写下值得反复提醒自己的事…"/>
          : <div className="beliefs-empty"><svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M10 6h20v29l-10-6-10 6V6Z"/><path d="M15 14h10m-10 6h7"/></svg><h2>让经验慢慢成为自己的信念</h2><p>记下一个提醒、它来自怎样的经历，<br/>以及下次你准备怎样行动。</p></div>}
      </article>
      {headings.length > 0 && <nav className="beliefs-outline" aria-label="信念目录"><h2>时常回看</h2>
        <button className="beliefs-outline-toggle" type="button" aria-expanded={outlineOpen} aria-controls="beliefs-outline-items" onClick={() => setOutlineOpen(value => !value)}>时常回看<span aria-hidden="true">{outlineOpen ? "−" : "+"}</span></button>
        <div id="beliefs-outline-items" className="beliefs-outline-items" data-expanded={outlineOpen}>{headings.map(heading => <button key={heading.id} type="button" data-level={heading.level} onClick={() => editor.current?.focusHeading(heading.start)}>{heading.title}</button>)}</div>
      </nav>}
    </div>}
  </section>;
}
