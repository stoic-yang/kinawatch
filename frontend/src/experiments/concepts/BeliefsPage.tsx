import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, fetchBeliefs, saveBeliefs, type BeliefsResponse, type FileFingerprint } from "../../api";
import { MarkdownDocumentEditor, type MarkdownDocumentEditorHandle } from "./MarkdownDocumentEditor";
import { extractJournalHeadings } from "./journalOutline";
import "./beliefs.css";

const DRAFT_KEY = "kinawatch.beliefs.draft.v1";
type Draft = { markdown: string; fingerprint: FileFingerprint };
const sameVersion = (a: FileFingerprint, b: FileFingerprint) => a.path === b.path && a.mtime_ns === b.mtime_ns && a.size === b.size;
function readDraft(): Draft | null {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
    return typeof value?.markdown === "string" && typeof value?.fingerprint?.path === "string"
      && typeof value.fingerprint.mtime_ns === "string" && typeof value.fingerprint.size === "number" ? value : null;
  } catch { return null; }
}
function discardDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* Local storage is optional. */ } }

export function BeliefsPage({ active }: { active: boolean }) {
  const [note, setNote] = useState<BeliefsResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [remote, setRemote] = useState<BeliefsResponse | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const base = useRef<FileFingerprint | null>(null);
  const busy = useRef(false);
  const draftRevision = useRef(0);
  const editor = useRef<MarkdownDocumentEditorHandle>(null);
  const dirty = Boolean(note && draft !== note.markdown);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    const refresh = () => { if (active && !dirtyRef.current && !busy.current) setAttempt(value => value + 1); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [active]);

  useEffect(() => {
    if (!active || dirtyRef.current || busy.current) return;
    let cancelled = false;
    const revision = draftRevision.current;
    setLoading(true); setError(null);
    fetchBeliefs().then(result => {
      if (cancelled || revision !== draftRevision.current || busy.current) return;
      setNote(result);
      base.current = { ...result.journal_fingerprint };
      setDraft(result.markdown); setConflict(false); setRemote(null);
      setLoading(false);
      const cached = readDraft();
      if (cached && cached.fingerprint.path === result.journal_fingerprint.path && cached.markdown !== result.markdown) {
        base.current = cached.fingerprint;
        setDraft(cached.markdown);
        if (!sameVersion(cached.fingerprint, result.journal_fingerprint)) {
          setConflict(true); setRemote(result);
          setError("文件已有更新，你的未保存草稿已保留。请核对后选择保留哪个版本。");
        }
      } else if (cached && cached.fingerprint.path === result.journal_fingerprint.path) discardDraft();
    }).catch(reason => { if (!cancelled && revision === draftRevision.current) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active, attempt]);

  useEffect(() => {
    if (!note || !base.current) return;
    if (!dirty) {
      if (readDraft()?.fingerprint.path === note.journal_fingerprint.path) discardDraft();
      return;
    }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ markdown: draft, fingerprint: base.current })); } catch { /* The draft remains available in this page. */ }
  }, [draft, dirty, note]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const protectDraft = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [dirty, saving]);

  // Keep the page title's original Markdown prefix byte-for-byte while the
  // visible body stays editable without duplicating that title on the paper.
  const titlePrefix = /^(?:[ \t]*\r?\n)*# 我的人生信念[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/.exec(draft)?.[0] ?? "";
  const displayedMarkdown = draft.slice(titlePrefix.length);
  const headings = useMemo(() => extractJournalHeadings(displayedMarkdown), [displayedMarkdown]);
  const editable = Boolean(note?.write_enabled);
  function change(value: string) {
    if (!editable || busy.current) return;
    draftRevision.current += 1;
    setDraft(titlePrefix + value);
  }
  function cancel() {
    if (busy.current || !note) return;
    draftRevision.current += 1;
    discardDraft(); setDraft(note.markdown); setError(null); setConflict(false); setRemote(null);
    base.current = { ...note.journal_fingerprint };
    setAttempt(value => value + 1);
  }
  async function save(fingerprint = base.current) {
    if (!editable || !fingerprint || busy.current) return;
    draftRevision.current += 1;
    busy.current = true; setSaving(true); setError(null);
    try {
      const result = await saveBeliefs(draft, fingerprint);
      setNote(result); discardDraft(); setDraft(result.markdown); setConflict(false); setRemote(null);
      base.current = { ...result.journal_fingerprint };
    } catch (reason) {
      const stale = reason instanceof ApiError && reason.status === 409;
      setConflict(stale);
      setError(stale ? "文件已有更新，你的草稿未被覆盖。请先核对文件版本。" : reason instanceof Error ? reason.message : String(reason));
    } finally { busy.current = false; setSaving(false); }
  }
  async function inspectRemote() {
    try { setRemote(await fetchBeliefs()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  const updated = note && Number(note.journal_fingerprint.mtime_ns) > 0
    ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(Number(note.journal_fingerprint.mtime_ns) / 1e6) : "";

  return <section className="beliefs-page" hidden={!active} aria-label="我的人生信念">
    <header className="beliefs-heading">
      <div><h1>我的人生信念</h1><p>从经历中留下原则，也允许自己不断修订。</p></div>
      {(dirty || saving) && <div className="beliefs-actions">
        <button type="button" disabled={saving} onClick={cancel}>撤销修改</button><button className="beliefs-save" type="button" disabled={saving || !editable || conflict} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button>
      </div>}
    </header>
    {loading && !note && <p className="beliefs-loading" role="status">正在读取信念…</p>}
    {error && <div className="beliefs-error" role="alert"><p>{error}</p>{conflict ? <button type="button" disabled={saving} onClick={() => void inspectRemote()}>核对文件版本</button> : !dirty && <button type="button" onClick={() => setAttempt(value => value + 1)}>重新读取</button>}</div>}
    {remote && conflict && <section className="beliefs-conflict kw-card" aria-label="文件版本对照"><h2>文件中的版本</h2><MarkdownDocumentEditor value={remote.markdown} onChange={() => {}} readOnly ariaLabel="信念文件中的版本" placeholder="文件内容为空"/>
      <div className="beliefs-actions"><button type="button" disabled={saving} onClick={() => {
        draftRevision.current += 1;
        setNote(remote); setDraft(remote.markdown); base.current = { ...remote.journal_fingerprint };
        discardDraft(); setError(null); setConflict(false); setRemote(null);
      }}>采用文件版本</button><button type="button" disabled={saving || !editable || !remote.write_enabled} onClick={() => void save(remote.journal_fingerprint)}>用我的草稿更新</button></div>
    </section>}
    {note && <div className={`beliefs-layout${headings.length ? " has-outline" : ""}`}>
      <article className="beliefs-paper kw-card">
        <div className="beliefs-paper-meta"><span>留给自己的提醒</span>{updated && <span>更新于 {updated}</span>}</div>
        {displayedMarkdown.trim() || editable ? <MarkdownDocumentEditor ref={editor} value={displayedMarkdown} onChange={change} readOnly={saving || !editable} ariaLabel="信念正文" placeholder="写下值得反复提醒自己的事…"/>
          : <div className="beliefs-empty"><svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M10 6h20v29l-10-6-10 6V6Z"/><path d="M15 14h10m-10 6h7"/></svg><h2>让经验慢慢成为自己的信念</h2><p>记下一个提醒、它来自怎样的经历，<br/>以及下次你准备怎样行动。</p></div>}
      </article>
      {headings.length > 0 && <nav className="beliefs-outline" aria-label="信念目录"><h2>时常回看</h2>
        <button className="beliefs-outline-toggle" type="button" aria-expanded={outlineOpen} aria-controls="beliefs-outline-items" onClick={() => setOutlineOpen(value => !value)}>时常回看<span aria-hidden="true">{outlineOpen ? "−" : "+"}</span></button>
        <div id="beliefs-outline-items" className="beliefs-outline-items" data-expanded={outlineOpen}>{headings.map(heading => <button key={heading.id} type="button" data-level={heading.level} onClick={() => editor.current?.focusHeading(heading.start)}>{heading.title}</button>)}</div>
      </nav>}
    </div>}
  </section>;
}
