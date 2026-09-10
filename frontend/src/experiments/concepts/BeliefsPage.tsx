import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Code, FileText, GripVertical, Pencil, Plus, Search, SlidersHorizontal, ThumbsUp } from "lucide-react";
import { ApiError, fetchBeliefLibrary, saveBeliefDocument, saveBeliefState, type BeliefLibraryResponse, type BeliefRecord } from "../../api";
import { beliefView, draftKey, EMPTY_BELIEF, nextBeliefDay, orderedBeliefs, parseBelief, readBeliefDrafts, reorderBeliefs, type BeliefDraft, type BeliefSort, type BeliefView } from "./beliefModel";
import "./beliefs.css";

const PAGE_SIZE = 8;
export function BeliefsPage({ active }: { active: boolean }) {
  const [library, setLibrary] = useState<BeliefLibraryResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, BeliefDraft>>({});
  const [mode, setMode] = useState<"list" | "reading" | "edit">("list");
  const [selected, setSelected] = useState<string | null>(null);
  const [source, setSource] = useState(false), [preview, setPreview] = useState(false);
  const [query, setQuery] = useState(""), [scope, setScope] = useState("all"), [tag, setTag] = useState("");
  const [sort, setSort] = useState<BeliefSort>("manual"), [page, setPage] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [status, setStatus] = useState("");
  const [conflict, setConflict] = useState<{id: string; remote?: BeliefRecord} | null>(null);
  const [drag, setDrag] = useState<{id: string; y: number; before: string | null} | null>(null);
  const generation = useRef(0), writing = useRef(false), namespace = useRef("");
  const draftsRef = useRef(drafts), textarea = useRef<HTMLTextAreaElement>(null), list = useRef<HTMLUListElement>(null);
  const dragSession = useRef<{id: string; start: number; index: number; subset: string[]; active: boolean} | null>(null);
  const accept = useCallback((value: BeliefLibraryResponse) => {
    if (namespace.current !== value.namespace) {
      namespace.current = value.namespace;
      const restored = readBeliefDrafts(value.namespace); draftsRef.current = restored; setDrafts(restored);
      setSelected(null); setMode("list"); setConflict(null);
    }
    setLibrary(value);
  }, []);
  const refresh = useCallback(async () => {
    if (writing.current) return;
    const request = ++generation.current;
    try { const value = await fetchBeliefLibrary(); if (request === generation.current) { accept(value); setError(""); } }
    catch (reason) { if (request === generation.current) setError((reason as Error).message); }
  }, [accept]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const focus = () => { void refresh(); }, visibility = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visibility); };
  }, [active, refresh]);
  useEffect(() => {
    if (!active || !library) return;
    const timer = window.setTimeout(() => void refresh(), nextBeliefDay(library.timezone));
    return () => window.clearTimeout(timer);
  }, [active, library, refresh]);
  function keepDrafts(value: Record<string, BeliefDraft>) {
    draftsRef.current = value; setDrafts(value);
    try { localStorage.setItem(draftKey(namespace.current), JSON.stringify(value)); }
    catch { setError("浏览器无法保留草稿，请在关闭页面前保存到文件。"); }
  }
  function discardDraft(id: string) { const next = {...draftsRef.current}; delete next[id]; keepDrafts(next); }
  const rows = useMemo(() => (library?.records ?? []).map(beliefView), [library]);
  const current = rows.find(item => item.id === selected), draft = selected ? drafts[selected] : undefined;
  const parsedDraft = useMemo(() => {
    try { return parseBelief(draft?.markdown ?? ""); }
    catch (reason) { return {title: "", tags: [], html: "", error: (reason as Error).message}; }
  }, [draft?.markdown]);
  const tags = useMemo(() => {
    const counts = new Map<string, {name: string; count: number}>();
    for (const row of rows) for (const name of row.tags) {const key = name.toLowerCase(), previous = counts.get(key); counts.set(key, {name: previous?.name ?? name, count: (previous?.count ?? 0) + 1});}
    return [...counts].sort((a, b) => a[1].name.localeCompare(b[1].name, "zh-CN"));
  }, [rows]);
  const effectiveTag = tag === "untagged" || tags.some(([key]) => key === tag.slice(4)) ? tag : "";
  const matched = useMemo(() => orderedBeliefs(rows, library?.order ?? [], sort).filter(item =>
    (scope === "all" || item.pinned) && (!effectiveTag || (effectiveTag === "untagged" ? !item.tags.length : item.tags.some(value => value.toLowerCase() === effectiveTag.slice(4))))
    && (!query.trim() || [item.title, item.markdown, ...item.tags.map(value => "#" + value)].join(" ").toLowerCase().includes(query.trim().toLowerCase()))
  ), [rows, library?.order, sort, scope, effectiveTag, query]);
  const pages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1);
  const shown = matched.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const newDraft = Object.values(drafts).find(item => item.expectedFingerprint === null), editable = Boolean(library?.write_enabled) && !busy;
  useLayoutEffect(() => { const element = textarea.current; if (element) {element.style.height = "auto"; element.style.height = Math.max(320, element.scrollHeight + 2) + "px";} }, [mode, preview, draft?.markdown, active]);
  useEffect(() => {
    if (mode !== "edit" || preview) return;
    const element = textarea.current; element?.focus();
    if (element?.value === EMPTY_BELIEF) {const at = EMPTY_BELIEF.indexOf("# ") + 2; element.setSelectionRange(at, at);}
  }, [mode, selected, preview]);
  function back() { setMode("list"); setSelected(null); setConflict(null); setError(""); }
  function open(id: string) {setSelected(id); setSource(false); setPreview(false); setConflict(null); setError(""); setMode(draftsRef.current[id] ? "edit" : "reading");}
  function edit() {
    if (!current || !editable) return;
    if (!draftsRef.current[current.id]) keepDrafts({...draftsRef.current, [current.id]: {id: current.id, markdown: current.markdown, expectedFingerprint: current.fingerprint}});
    setMode("edit"); setPreview(false); setConflict(null); setError("");
  }
  function create() {
    if (!editable) return;
    const id = newDraft?.id ?? "b-" + crypto.randomUUID().replaceAll("-", "");
    if (!newDraft) keepDrafts({...draftsRef.current, [id]: {id, markdown: EMPTY_BELIEF, expectedFingerprint: null}});
    setSelected(id); setMode("edit"); setPreview(false); setConflict(null); setError(""); setToolsOpen(false);
  }
  function finishSave(value: BeliefLibraryResponse, saved: BeliefDraft) {
    accept(value); discardDraft(saved.id); setMode("reading"); setSource(false); setConflict(null); setError("");
    if (saved.expectedFingerprint === null) {setQuery(""); setScope("all"); setTag(""); setSort("manual"); setPage(0);}
    setStatus("Markdown 文件已保存。");
  }
  async function save(overwrite = false) {
    if (!draft || !library || writing.current || !library.write_enabled) return;
    if (parsedDraft.error || !parsedDraft.title) {setError(parsedDraft.error || "用 # 写下信念标题。"); setPreview(false); return;}
    const pending = {...draft}; writing.current = true; setBusy(true); ++generation.current; setError("");
    try {
      const latest = await fetchBeliefLibrary();
      if (latest.namespace !== library.namespace) throw new Error("信念存储位置已变化，请刷新页面；当前草稿仍已保留。");
      setLibrary(latest);
      const remote = latest.records.find(item => item.id === pending.id);
      if (remote && !remote.legacy && remote.markdown === pending.markdown) {finishSave(latest, pending); return;}
      const expected = overwrite ? conflict?.remote?.fingerprint ?? null : pending.expectedFingerprint;
      if ((remote?.fingerprint ?? null) !== expected || (!remote && pending.expectedFingerprint !== null)) {setConflict({id: pending.id, remote}); throw new ApiError(409, "文件已变化，草稿已保留。请核对两个版本。");}
      finishSave(await saveBeliefDocument({namespace: latest.namespace, id: pending.id, markdown: pending.markdown, expected_fingerprint: expected}), pending);
    } catch (reason) {
      setError((reason as Error).message);
      if (reason instanceof ApiError && reason.status === 409) try {const value = await fetchBeliefLibrary(); if (value.namespace === library.namespace) {setLibrary(value); setConflict({id: pending.id, remote: value.records.find(item => item.id === pending.id)});}} catch { /* Preserve the draft. */ }
    } finally {writing.current = false; setBusy(false);}
  }
  async function manage(action: "like" | "pin" | "order", item?: BeliefView, order?: string[]) {
    if (!library || writing.current || !library.write_enabled) return;
    writing.current = true; setBusy(true); ++generation.current; setError("");
    try {
      const base = {namespace: library.namespace, expected_revision: library.revision};
      const value = await saveBeliefState(action === "order" ? {...base, action, order: order!} : action === "like" ? {...base, action, id: item!.id, value: !item!.liked_today, day: library.today} : {...base, action, id: item!.id, value: !item!.pinned});
      accept(value); setStatus(action === "order" ? "手动顺序已保存。" : action === "pin" ? "常用状态已保存。" : item!.liked_today ? "已取消今日点赞。" : "今日已点赞。");
    } catch (reason) {setError((reason as Error).message); try {accept(await fetchBeliefLibrary());} catch { /* Keep the previous snapshot. */ }}
    finally {writing.current = false; setBusy(false);}
  }
  function likeButton(item: BeliefView) {
    return <button type="button" className="belief-like" disabled={!editable} aria-pressed={item.liked_today} aria-label={(item.liked_today ? "取消今日点赞：" : "今日点赞：") + item.title + "，累计 " + item.like_count + " 次"} title={item.liked_today ? "今日已点赞，点击取消" : "每天可点赞一次"} onClick={() => void manage("like", item)}><ThumbsUp size={15}/><span>{item.like_count}</span></button>;
  }
  function move(id: string, direction: number) {
    if (!library || !editable || sort !== "manual") return;
    const subset = matched.map(item => item.id), index = subset.indexOf(id) + direction;
    if (index < 0 || index >= subset.length) return;
    setPage(Math.floor(index / PAGE_SIZE)); void manage("order", undefined, reorderBeliefs(library.order, subset, id, index));
  }
  function pointerDown(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (!editable || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const subset = shown.map(item => item.id); dragSession.current = {id, start: event.clientY, index: subset.indexOf(id), subset, active: false};
  }
  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const session = dragSession.current;
    if (!session || (!session.active && Math.abs(event.clientY - session.start) < 5)) return;
    session.active = true; event.preventDefault();
    const others = [...(list.current?.querySelectorAll<HTMLLIElement>("[data-belief-id]") ?? [])].filter(element => element.dataset.beliefId !== session.id);
    let index = others.findIndex(element => {const rect = element.getBoundingClientRect(); return event.clientY < rect.top + rect.height / 2;});
    if (index < 0) index = others.length;
    session.index = index; setDrag({id: session.id, y: event.clientY - session.start, before: others[index]?.dataset.beliefId ?? null});
  }
  function endDrag(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const session = dragSession.current; dragSession.current = null; setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && session?.active && library) void manage("order", undefined, reorderBeliefs(library.order, session.subset, session.id, session.index));
  }
  function filterTag(value: string) {setTag("tag:" + value.toLowerCase()); setPage(0); back();}
  function renderedDocument(item: {html: string; tags: string[]; error: string}, editing = false) {
    return <>{item.tags.length > 0 && <div className="belief-document-tags" aria-label="信念标签">{item.tags.map(value => editing ? <span className="belief-tag" key={value}>#{value}</span> : <button className="belief-tag" type="button" key={value} onClick={() => filterTag(value)}>#{value}</button>)}</div>}{item.error ? <p role="alert">{item.error}</p> : <div className="belief-markdown" dangerouslySetInnerHTML={{__html: item.html}}/>}</>;
  }
  return <section className="beliefs-page" hidden={!active} aria-label="我的人生信念" aria-busy={busy}>
    <div className="beliefs-layout"><div className="beliefs-main">
      <header className="beliefs-heading"><h1>我的人生信念</h1>{mode === "list" && library && <span>{matched.length} 条</span>}<button type="button" className="belief-icon belief-mobile-tools" aria-label="搜索与整理信念" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}><SlidersHorizontal size={17}/></button></header>
      <span className="belief-sr-only" role="status">{status}</span>
      {error && <div className="belief-error" role="alert"><p>{error}</p>{mode !== "edit" && <button type="button" disabled={busy} onClick={() => void refresh()}>刷新</button>}</div>}
      {!library && !error && <p className="belief-empty">正在读取信念…</p>}
      {library && !library.write_enabled && <p className="belief-readonly">当前为只读；启用日记写入后可编辑、点赞和调整顺序。</p>}
      {library && mode === "list" && <><ul className="belief-list" ref={list} data-drop-end={Boolean(drag && !drag.before)} aria-label="信念列表">
        {shown.map(item => <li key={item.id} data-belief-id={item.id} className={(drag?.id === item.id ? "is-dragging " : "") + (drag?.before === item.id ? "is-drop-before" : "")} style={drag?.id === item.id ? {"--belief-drag-y": drag.y + "px"} as CSSProperties : undefined}>
          {sort === "manual" ? <button type="button" className="belief-grip" disabled={!editable} aria-label={"拖动调整顺序：" + item.title} title="拖动排序，也可用 ↑ ↓" onPointerDown={event => pointerDown(event, item.id)} onPointerMove={pointerMove} onPointerUp={event => endDrag(event)} onPointerCancel={event => endDrag(event, true)} onLostPointerCapture={() => {dragSession.current = null; setDrag(null);}} onKeyDown={event => {if (["ArrowUp", "ArrowDown"].includes(event.key)) {event.preventDefault(); move(item.id, event.key === "ArrowUp" ? -1 : 1);} if (event.key === "Escape") {dragSession.current = null; setDrag(null);}}}><GripVertical size={14}/></button> : <span/>}
          <button type="button" className="belief-open" onClick={() => open(item.id)} aria-label={"打开：" + item.title + (drafts[item.id] ? "，有未保存草稿" : "")}>{item.title}</button>{likeButton(item)}
        </li>)}{!shown.length && <li className="belief-empty">{query || effectiveTag ? "没有符合条件的信念。" : scope === "pinned" ? "将常用的信念留在这里。" : "写下值得记住的一句话。"}</li>}
      </ul><div className="belief-pagination"><span>{matched.length ? (currentPage * PAGE_SIZE + 1) + "–" + Math.min((currentPage + 1) * PAGE_SIZE, matched.length) + " / " + matched.length : ""}</span><div><button type="button" className="belief-icon" aria-label="上一页信念" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ArrowLeft size={16}/></button><button type="button" className="belief-icon" aria-label="下一页信念" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}><ArrowRight size={16}/></button></div></div></>}
      {mode === "reading" && current && <article className="belief-document" aria-label="Markdown 信念文档">
        <div className="belief-document-toolbar"><button type="button" disabled={busy} onClick={back}><ArrowLeft size={16}/>返回列表</button><div><button type="button" onClick={() => setSource(!source)}>{source ? <BookOpen size={16}/> : <Code size={16}/>}{source ? "阅读" : "原文"}</button><button type="button" disabled={!editable} onClick={edit}><Pencil size={15}/>编辑</button></div></div>
        <div className="belief-file-name" title={current.path}><FileText size={14}/><span>{current.title}.md</span></div>
        {source || current.error ? <pre className="belief-source" aria-label="Markdown 原文">{current.markdown}</pre> : renderedDocument(current)}
        <div className="belief-document-actions"><button type="button" disabled={!editable} aria-pressed={current.pinned} onClick={() => void manage("pin", current)}>{current.pinned ? "取消常用" : "设为常用"}</button>{likeButton(current)}</div>
      </article>}
      {mode === "edit" && draft && <article className="belief-document" aria-label="编辑 Markdown 信念">
        <div className="belief-document-toolbar"><button type="button" disabled={busy} onClick={back}><ArrowLeft size={16}/>返回列表</button><button type="button" disabled={busy} onClick={() => {if (parsedDraft.error && !preview) {setError(parsedDraft.error); return;} setPreview(!preview);}}>{preview ? <Code size={16}/> : <BookOpen size={16}/>}{preview ? "返回编辑" : "预览"}</button></div>
        <div className="belief-file-name"><FileText size={14}/><span>{parsedDraft.title || "未命名信念"}.md</span></div>
        {preview ? renderedDocument(parsedDraft, true) : <><label className="belief-sr-only" htmlFor="belief-markdown-input">Markdown 内容</label><textarea id="belief-markdown-input" ref={textarea} value={draft.markdown} disabled={!editable} spellCheck={false} autoCapitalize="off" aria-describedby="belief-format-help" onChange={event => {keepDrafts({...draftsRef.current, [draft.id]: {...draft, markdown: event.target.value}}); setError("");}} onKeyDown={event => {if ((event.metaKey || event.ctrlKey) && event.key === "s") {event.preventDefault(); void save();}}}/><p className="belief-format-help" id="belief-format-help"># 标题 · tags: [标签一, 标签二] · 正文也可写 #标签</p></>}
        {conflict?.id === draft.id && <div className="belief-conflict">{conflict.remote ? <><details><summary>查看文件中的版本</summary><pre className="belief-source">{conflict.remote.markdown}</pre></details><div><button type="button" disabled={busy} onClick={() => {discardDraft(draft.id); setConflict(null); setError(""); setMode("reading");}}>采用文件版本</button><button type="button" disabled={busy} onClick={() => void save(true)}>用我的草稿覆盖</button></div></> : <button type="button" disabled={busy} onClick={() => {const id = "b-" + crypto.randomUUID().replaceAll("-", ""); const next = {...draftsRef.current, [id]: {...draft, id, expectedFingerprint: null}}; delete next[draft.id]; keepDrafts(next); setSelected(id); setConflict(null); setError("");}}>另存为新信念</button>}</div>}
        <div className="belief-save-row"><button type="button" disabled={busy} onClick={() => {discardDraft(draft.id); setConflict(null); setError(""); setMode(current ? "reading" : "list"); if (!current) setSelected(null);}}>取消</button><button type="button" className="belief-save" disabled={!editable || Boolean(conflict)} onClick={() => void save()}>{busy ? "保存中…" : current ? "保存修改" : "保存信念"}</button></div>
      </article>}
      {mode === "reading" && library && !current && <div className="belief-empty">文件已移走或删除。<button type="button" onClick={back}>返回列表</button></div>}
    </div><aside className="belief-browser" data-open={toolsOpen} aria-label="信念浏览管理"><h2>浏览</h2>
      <label className="belief-search"><Search size={15}/><input type="search" aria-label="搜索信念" placeholder="搜索信念…" disabled={busy} value={query} onChange={event => {setQuery(event.target.value); setPage(0); back();}}/></label>
      <nav className="belief-scope" aria-label="浏览范围"><button type="button" disabled={busy} aria-pressed={scope === "all"} onClick={() => {setScope("all"); setPage(0); back();}}>全部信念<span>{rows.length}</span></button><button type="button" disabled={busy} aria-pressed={scope === "pinned"} onClick={() => {setScope("pinned"); setPage(0); back();}}>常用<span>{rows.filter(item => item.pinned).length}</span></button></nav>
      <label className="belief-filter">排序<select aria-label="信念排序方式" value={sort} disabled={busy} onChange={event => {setSort(event.target.value as BeliefSort); setPage(0); back();}}><option value="manual">手动顺序</option><option value="likes">点赞最多</option><option value="recent">最近加入</option><option value="updated">最近修改</option></select></label>
      <label className="belief-filter">标签<select aria-label="按标签筛选" value={effectiveTag} disabled={busy || !tags.length} onChange={event => {setTag(event.target.value); setPage(0); back();}}><option value="">{tags.length ? "全部标签" : "尚未添加标签"}</option>{tags.length > 0 && <option value="untagged">未添加标签</option>}{tags.map(([key, value]) => <option key={key} value={"tag:" + key}>{value.name} · {value.count}</option>)}</select></label>
      <button type="button" className="belief-add" disabled={!editable} onClick={create}><Plus size={16}/>新增信念</button>{newDraft && <button type="button" className="belief-resume" disabled={busy} onClick={create}>继续未完成的信念</button>}
    </aside></div>
  </section>;
}
