import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, BookOpen, Code, Plus, Tag, X } from "lucide-react";
import { beliefTagLabel, parseBelief } from "./beliefModel";
import { readBeliefComposition, writeBeliefBody, writeBeliefTags, writeBeliefTitle } from "./beliefComposition";

interface Props {
  value: string;
  disabled: boolean;
  busy: boolean;
  existing: boolean;
  canSave: boolean;
  suggestedTags: string[];
  conflict: ReactNode;
  onChange(value: string): void;
  onBack(): void;
  onCancel(): void;
  onSave(value?: string): void;
}

export function BeliefComposer({value, disabled, busy, existing, canSave, suggestedTags, conflict, onChange, onBack, onCancel, onSave}: Props) {
  const composition = useMemo(() => {
    try { return {fields: readBeliefComposition(value), error: ""}; }
    catch (reason) { return {fields: null, error: (reason as Error).message}; }
  }, [value]);
  const [view, setView] = useState<"write" | "source" | "preview">(() => composition.fields ? "write" : "source");
  const [detailsOpen, setDetailsOpen] = useState(() => Boolean(composition.fields?.body.trim()));
  const [addingTag, setAddingTag] = useState(false), [tagText, setTagText] = useState("");
  const [error, setError] = useState("");
  const titleInput = useRef<HTMLTextAreaElement>(null), bodyInput = useRef<HTMLTextAreaElement>(null), sourceInput = useRef<HTMLTextAreaElement>(null), tagInput = useRef<HTMLInputElement>(null);
  const focusDetails = useRef(false);
  const container = useRef<HTMLElement>(null);
  const fields = composition.fields;
  const preview = useMemo(() => {
    try { return parseBelief(value); } catch { return null; }
  }, [value]);
  const currentTags = fields?.tags ?? [];
  const suggestions = suggestedTags.filter(name => !currentTags.some(tag => tag.toLowerCase() === name.toLowerCase()) && (!tagText || name.toLowerCase().includes(tagText.toLowerCase()))).slice(0, 6);
  const resizeInputs = useCallback(() => {
    for (const element of [titleInput.current, bodyInput.current, sourceInput.current]) if (element) {
      element.style.height = "auto"; element.style.height = element.scrollHeight + "px";
    }
  }, []);
  useLayoutEffect(() => {
    resizeInputs();
    if (focusDetails.current && bodyInput.current) { bodyInput.current.focus(); focusDetails.current = false; }
  }, [value, view, detailsOpen, resizeInputs]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let width = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width !== width) { width = entry.contentRect.width; resizeInputs(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [resizeInputs]);
  useEffect(() => { (view === "source" ? sourceInput.current : view === "write" ? titleInput.current : null)?.focus(); }, [view]);
  useEffect(() => { if (addingTag) tagInput.current?.focus(); }, [addingTag]);
  function change(edit: () => string) {
    try { onChange(edit()); setError(""); } catch (reason) { setError((reason as Error).message); }
  }
  function addTag(name = tagText) {
    if (!name.trim()) return;
    try {
      onChange(writeBeliefTags(value, [...currentTags, name.trim().replace(/^#/, "")]));
      setTagText(""); setError(""); tagInput.current?.focus();
    } catch (reason) { setError((reason as Error).message); }
  }
  function flushTag() {
    const next = tagText.trim() ? writeBeliefTags(value, [...currentTags, tagText.trim().replace(/^#/, "")]) : value;
    if (next !== value) onChange(next);
    setTagText(""); setAddingTag(false); setError("");
    return next;
  }
  function switchView(next: typeof view) {
    try { flushTag(); setView(next); if (fields?.body.trim()) setDetailsOpen(true); }
    catch (reason) { setError((reason as Error).message); }
  }
  function back() {
    try { flushTag(); onBack(); } catch (reason) { setError((reason as Error).message); }
  }
  function openDetails() { focusDetails.current = true; setDetailsOpen(true); }
  function save() {
    if (!canSave || disabled) return;
    try {
      onSave(flushTag());
    } catch (reason) { setError((reason as Error).message); }
  }
  return <article className="belief-composer" ref={container} aria-label="写下信念" onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key === "s") {event.preventDefault(); save();}
  }}>
    <div className="belief-composer-toolbar">
      <button type="button" disabled={busy} onClick={back}><ArrowLeft size={15}/>返回</button>
      <div className="belief-composer-views" aria-label="编辑方式">
        <button type="button" disabled={busy || !fields} aria-pressed={view === "write"} onClick={() => switchView("write")}>写作</button>
        <button type="button" disabled={busy} aria-pressed={view === "source"} onClick={() => switchView("source")}><Code size={14}/>原文</button>
        <button type="button" disabled={busy || !preview?.title} aria-label="预览信念" aria-pressed={view === "preview"} onClick={() => switchView("preview")}><BookOpen size={14}/></button>
      </div>
    </div>
    {view === "write" && fields && <div className="belief-writing-surface">
      <p className="belief-composer-kicker">{existing ? "重新打磨这句话" : "值得记住的一句话"}</p>
      <textarea className="belief-composer-title" ref={titleInput} rows={1} aria-label="信念标题" placeholder="写下你的信念…" value={fields.title} disabled={disabled} spellCheck={false} onChange={event => change(() => writeBeliefTitle(value, event.target.value))} onKeyDown={event => {if (event.key === "Enter" && !event.nativeEvent.isComposing) {event.preventDefault(); openDetails();}}}/>
      <div className="belief-composer-tags" aria-label="编辑标签">
        {currentTags.map(tag => <span className="belief-composer-tag" key={tag}><span>{beliefTagLabel(tag)}</span><button type="button" disabled={disabled} aria-label={"移除标签：" + beliefTagLabel(tag)} onClick={() => change(() => writeBeliefTags(value, currentTags.filter(name => name !== tag)))}><X size={12}/></button></span>)}
        {!addingTag ? <button type="button" className="belief-tag-add" disabled={disabled} onClick={() => setAddingTag(true)}><Tag size={13}/>添加标签</button> : <div className="belief-tag-entry">
          <input ref={tagInput} aria-label="新标签" placeholder="标签名称" autoComplete="off" value={tagText} disabled={disabled} onChange={event => setTagText(event.target.value)} onKeyDown={event => {if (event.nativeEvent.isComposing) return; if (event.key === "Enter") {event.preventDefault(); addTag();} if (event.key === "Escape") {setAddingTag(false); setTagText("");}}}/>
          <button type="button" disabled={disabled || !tagText.trim()} aria-label="添加这个标签" onClick={() => addTag()}><Plus size={14}/></button>
          {suggestions.length > 0 && <div className="belief-tag-suggestions" aria-label="已有标签">{suggestions.map(name => <button type="button" key={name} disabled={disabled} onClick={() => addTag(name)}>{beliefTagLabel(name)}</button>)}</div>}
        </div>}
      </div>
      {detailsOpen ? <div className="belief-composer-details"><div><span>补充说明</span><button type="button" disabled={busy} onClick={() => setDetailsOpen(false)}>收起</button></div><textarea ref={bodyInput} rows={5} aria-label="补充说明" placeholder="记下经历、例子，或它适用的时刻…" value={fields.body} disabled={disabled} spellCheck={false} onChange={event => change(() => writeBeliefBody(value, event.target.value))}/></div> : <button type="button" className="belief-details-toggle" disabled={busy} onClick={openDetails}><Plus size={14}/>{fields.body.trim() ? "展开补充说明" : "补充说明"}</button>}
    </div>}
    {view === "source" && <div className="belief-composer-source"><textarea ref={sourceInput} rows={9} aria-label="Markdown 原文编辑" spellCheck={false} value={value} disabled={disabled} onChange={event => {onChange(event.target.value); setError("");}}/>{composition.error && <p className="belief-composer-note">{composition.error}</p>}</div>}
    {view === "preview" && preview && <div className="belief-composer-preview"><div className="belief-document-tags">{preview.tags.map(tag => <span className="belief-tag" key={tag}>{beliefTagLabel(tag)}</span>)}</div><div className="belief-markdown" dangerouslySetInnerHTML={{__html: preview.html}}/></div>}
    {error && <p className="belief-composer-error" role="alert">{error}</p>}
    {conflict}
    <footer className="belief-composer-footer"><button type="button" className="belief-composer-cancel" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="belief-save" disabled={!canSave || disabled || !preview?.title} onClick={save}>{busy ? "保存中…" : existing ? "保存修改" : "保存信念"}</button></footer>
  </article>;
}
