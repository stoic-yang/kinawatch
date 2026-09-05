import { cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, saveReviewField, type ReviewField, type FileFingerprint, type ScreenTimelineBlock } from "../../api";
import { SessionList } from "../../components/SessionList";
import { DayRibbon } from "../../components/DayRibbon";
import { MarkdownLite } from "../../lib/markdown";
import { categoryColor } from "../../lib/colors";
import { fmtClock, fmtDuration, isValidDateString } from "../../lib/format";
import { buildSessions, type ScreenSession } from "../../lib/sessions";
import { assignKinaSummaryToSessions, parseKinaSummary, type KinaSummaryEntry } from "../../lib/kinaSummary";
import { Brand, CalendarPanel, DateControls } from "../shared";
import { CONCEPTS, type ConceptId, type ConceptProps } from "./types";
import { LongformTextarea } from "./LongformTextarea";
import { RhythmWorkspace } from "./RhythmWorkspace";
import { PalettePicker } from "./PalettePicker";
import "./shared.css";
import "./sidebar-collapse.css";

const SIDEBAR_STATE_KEY = "kinawatch.sidebar.collapsed.v1";

function Icon({kind}: {kind: string}) {
  const paths: Record<string, ReactNode> = {
    day: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/></>,
    note: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18m4-12h4m-4 4h4"/></>,
    board: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m6-16v16M6 8v4m6-4v7m6-7v2"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-13 4h2m4 0h2m-8 4h2"/></>,
    rhythm: <path d="M3 15h3l3-9 4 13 3-14 2 9h3"/>,
    beliefs: <><circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5L16 8Z"/></>,
    flow: <><path d="M6 4v16m4-13h10m-10 5h7m-7 5h10"/><circle cx="6" cy="7" r="1.5"/><circle cx="6" cy="17" r="1.5"/></>,
    timeline: <><path d="M3 19h18M4 7v7m5-10v10m5-6v6m6-9v9"/></>,
  };
  return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind] ?? paths.note}</svg>;
}

function ConceptSwitcher({current}: {current: ConceptId}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && ref.current) ref.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && ref.current) ref.current.open = false; };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  const date = new URLSearchParams(window.location.search).get("date");
  return <details ref={ref} className="concept-switcher">
    <summary aria-label="切换布局方案"><span className="concept-switch-dot"/>方案 {CONCEPTS.findIndex(c => c.id === current) + 1}<span>⌄</span></summary>
    <div className="concept-switch-menu"><p>另一种工作方式</p>{CONCEPTS.map((item, index) => <a key={item.id}
      href={item.id === current ? undefined : `http://127.0.0.1:${item.port}/${date ? `?date=${encodeURIComponent(date)}` : ""}`}
      target={item.id === current ? undefined : "_blank"} rel="noopener noreferrer" aria-current={item.id === current ? "page" : undefined}>
      <small>0{index + 1}</small><span>{item.name}<em>{item.subtitle}</em></span><span aria-hidden="true">{item.id === current ? "•" : "↗"}</span>
    </a>)}</div>
  </details>;
}

export function ConceptFrame({concept, app, nav, active, onNavigate, children, focusMode = false, onExitFocus, timelinePageId}: {
  concept: ConceptId; app: ConceptProps; nav: {id: string; label: string; icon?: string}[];
  active: string; onNavigate: (id: string) => void;
  focusMode?: boolean; onExitFocus?: () => void;
} & ({timelinePageId: string; children: (timeline: ReactNode) => ReactNode} | {timelinePageId?: undefined; children: ReactNode})) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return concept === "journal" && localStorage.getItem(SIDEBAR_STATE_KEY) === "true"; }
    catch { return false; }
  });
  function toggleSidebar() {
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    try { localStorage.setItem(SIDEBAR_STATE_KEY, String(collapsed)); } catch { /* Storage is optional. */ }
  }
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [rhythmOpen,setRhythmOpen] = useState(false);
  const rhythmInNavigation = nav.some(item => item.id === "weekly-rhythm");
  const activeNavigation = rhythmOpen ? "weekly-rhythm" : active;
  const rhythmReturnScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (rhythmOpen) window.scrollTo({top:0,behavior:"instant"});
    else if (rhythmReturnScroll.current !== null) {
      window.scrollTo({top:rhythmReturnScroll.current,behavior:"instant"});
      rhythmReturnScroll.current = null;
    }
  }, [rhythmOpen]);
  function showRhythm(open: boolean) {
    if (open === rhythmOpen) return;
    if (open) rhythmReturnScroll.current = window.scrollY;
    setRhythmOpen(open);
    const url = new URL(window.location.href);
    url.hash = open ? "weekly-rhythm" : active;
    if (url.href !== window.location.href) window.history.pushState(null,"",url);
  }
  const [normalTimelineOpen, setNormalTimelineOpen] = useState(true);
  const [writingTimelineOpen, setWritingTimelineOpen] = useState(false);
  const timelineOpen = timelinePageId ? active === timelinePageId && !rhythmOpen : focusMode ? writingTimelineOpen : normalTimelineOpen;
  const setTimelineOpen = focusMode ? setWritingTimelineOpen : setNormalTimelineOpen;
  const writingReturnScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!focusMode || writingReturnScroll.current === null) return;
    window.scrollTo({top:timelineOpen ? 0 : writingReturnScroll.current,behavior:"instant"});
    if (!timelineOpen) writingReturnScroll.current = null;
  }, [focusMode,timelineOpen]);
  function toggleTimeline() {
    if (focusMode && !timelineOpen) writingReturnScroll.current = window.scrollY;
    setTimelineOpen(!timelineOpen);
  }
  const selected = CONCEPTS.find(c => c.id === concept)!;
  const navRef = useRef(nav); navRef.current = nav;
  const navigateRef = useRef(onNavigate); navigateRef.current = onNavigate;
  const appRef = useRef(app); appRef.current = app;
  useEffect(() => {
    function restore() {
      const date = new URLSearchParams(window.location.search).get("date") ?? appRef.current.currentDate;
      if (isValidDateString(date) && date <= appRef.current.currentDate && date !== appRef.current.date) appRef.current.selectDate(date);
      let id = window.location.hash.slice(1);
      if (concept === "journal" && (id === "library" || id.startsWith("library-"))) {
        id = "journal";
        const url = new URL(window.location.href);
        url.hash = id;
        window.history.replaceState(window.history.state, "", url);
      }
      if (id === "weekly-rhythm") {setRhythmOpen(true);return;}
      setRhythmOpen(false);
      if (navRef.current.some(item => item.id === id)) navigateRef.current(id);
      else if (navRef.current.some(item => id.startsWith(`${item.id}-`))) navigateRef.current(navRef.current.find(item => id.startsWith(`${item.id}-`))!.id);
      else if (!id && navRef.current[0]) navigateRef.current(navRef.current[0].id);
    }
    restore(); window.addEventListener("popstate", restore); window.addEventListener("hashchange", restore);
    return () => { window.removeEventListener("popstate", restore); window.removeEventListener("hashchange", restore); };
  }, []);
  function navigate(id: string) {
    rhythmReturnScroll.current = null;
    setRhythmOpen(false);
    onNavigate(id);
    const url = new URL(window.location.href); url.hash = id;
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
    window.scrollTo({top: 0, behavior: "instant"});
  }
  const timeline = <section id="concept-timeline" className={`concept-timeline ${concept === "journal" ? "kw-card" : ""}`} aria-label="可缩放的当日时间线" hidden={!timelineOpen}>
    {concept === "journal" ? <div className="rhythm-heading journal-timeline-heading">
      <h2>时间线</h2>
      <div className="rhythm-summary journal-timeline-summary" role="group" aria-label="当日活动概览">
        {app.day && app.windowLabel !== "暂无活动" && <span className="kw-metric-pill" data-metric="window"><b>{app.windowLabel}</b><small>活动窗口</small></span>}
        <span className="kw-metric-pill" data-metric="screen"><b>{app.screenTime}</b><small>屏幕时间</small></span>
        {(app.day?.quality.time_accounting.passive_media_seconds ?? 0) > 0 && <span className="kw-metric-pill" data-metric="passive"><b>{app.passiveTime}</b><small>被动观看</small></span>}
      </div>
    </div> : <div className="concept-timeline-heading"><h2>{app.dateLabel}<span>时间线</span></h2><p>拖动平移 · ⌘ / Ctrl + 滚轮缩放 · 点击活动查看详情</p></div>}
    {app.day && app.displayDay ? <>
      <DayRibbon key={app.date} rangeStart={app.day.range.start} rangeEnd={app.day.range.end} timezone={app.timezone} timeline={app.displayDay.timeline} onSelectBlock={app.onInspect} showControls={concept !== "journal"} touchZoom={concept === "journal"} isVisible={timelineOpen}/>
      {!app.displayDay.timeline.some(block => block.kind === "screen") && <p className="concept-timeline-empty">当前日期与筛选条件下没有屏幕活动。</p>}
    </> : <p className="concept-timeline-empty">{app.dateLabel} 的时间线尚未载入。</p>}
  </section>;
  return <div className={`theme-page theme-grove concept-page concept-${concept} ${focusMode ? "concept-writing-mode" : ""}${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`} id="top" data-concept={concept}>
    <aside className="grove-rail concept-rail" aria-label="侧边栏" hidden={focusMode}>
      <div className="concept-brand-row"><div className="grove-identity"><Brand/>{concept !== "journal" && <p><span className="grove-seed"/>林间 <span>GROVE</span></p>}</div>{concept === "journal" ?
        <button className="concept-sidebar-toggle" type="button" onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"} title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
          aria-expanded={!sidebarCollapsed} aria-controls="concept-sidebar-details">
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d={sidebarCollapsed ? "m13 9 3 3-3 3" : "m16 9-3 3 3 3"}/>
          </svg>
        </button> : <ConceptSwitcher current={concept}/>}</div>
      <nav className="concept-navigation" aria-label="主要页面">{nav.map(item => <button key={item.id} type="button" aria-current={activeNavigation === item.id ? "page" : undefined}
        aria-label={item.label} title={sidebarCollapsed ? item.label : undefined}
        onClick={() => item.id === "weekly-rhythm" ? showRhythm(true) : navigate(item.id)}><Icon kind={item.icon ?? "note"}/><span>{item.label}</span>{activeNavigation === item.id && <i/>}</button>)}</nav>
      {concept === "journal" ? <section id="concept-sidebar-details" className="grove-calendar concept-calendar concept-sidebar-sections" aria-label="日历、分类与应用" hidden={sidebarCollapsed}>
        {isValidElement<{ independentSections?: boolean }>(app.calendar) ? cloneElement(app.calendar, { independentSections: true }) : app.calendar}
      </section> : <>
        <button className="concept-calendar-toggle" type="button" aria-expanded={calendarOpen} onClick={() => setCalendarOpen(!calendarOpen)}><Icon kind="calendar"/>日历与分类<span>{calendarOpen ? "−" : "+"}</span></button>
        <section className={`grove-calendar concept-calendar ${calendarOpen ? "is-open" : ""}`} aria-label="日期与分类"><CalendarPanel>{app.calendar}</CalendarPanel></section>
      </>}
      {concept === "journal" && <div className="concept-sidebar-appearance"><PalettePicker showLabel={!sidebarCollapsed}/></div>}
      {concept !== "journal" && <div className="grove-rail-footer"><svg viewBox="0 0 28 28" width="24" height="24" fill="none" aria-hidden="true"><path d="M7 22c1-10 5-16 15-16 0 10-6 14-14 14m0 0L19 9" stroke="currentColor" strokeWidth="1.3"/></svg><span>留意时间，也留意自己。</span></div>}
    </aside>
    <div className="concept-workspace">
      {concept !== "journal" && <header className="concept-topbar">
        <div className="concept-breadcrumb"><span>{selected.name}</span>{(rhythmOpen || nav.find(item => item.id === active)?.label !== selected.name) && <><b>/</b><span>{rhythmOpen ? "七日节律" : nav.find(item => item.id === active)?.label ?? selected.subtitle}</span></>}</div>
        <div className="concept-topbar-actions">
          {focusMode && <button type="button" className="concept-focus-exit" onClick={onExitFocus}>← 退出专注</button>}
          {!rhythmInNavigation && <button type="button" className="concept-rhythm-toggle" aria-pressed={rhythmOpen} aria-controls="concept-rhythm-workspace" onClick={() => showRhythm(!rhythmOpen)}><Icon kind="rhythm"/><span>七日节律</span></button>}
          {!timelinePageId && <button type="button" className="concept-timeline-toggle" aria-expanded={timelineOpen} aria-controls="concept-timeline" onClick={toggleTimeline}><Icon kind="timeline"/><span>可缩放时间线</span><span aria-hidden="true">{timelineOpen ? "⌃" : "⌄"}</span></button>}
          <DateControls date={app.date} currentDate={app.currentDate} onSelect={app.selectDate}/>
        </div>
      </header>}
      {!timelinePageId && timeline}
      <main className="concept-content">{(concept !== "journal" || active !== "beliefs" || rhythmOpen) && <>{app.status}{app.warnings}</>}
        <section id="concept-rhythm-workspace" className="concept-rhythm-workspace" hidden={!rhythmOpen} aria-label={concept === "journal" ? "节律空间" : "七日节律空间"}>
          {!rhythmInNavigation && <button type="button" className="concept-rhythm-return" onClick={() => showRhythm(false)}>← 返回{nav.find(item => item.id === active)?.label ?? selected.name}</button>}
          <RhythmWorkspace variant={concept === "journal" ? "overview" : "week"} currentDate={app.currentDate} selectedDate={app.date} dayMode={app.dayMode} dayStartClock={app.dayStartClock} timezone={app.timezone} visible={rhythmOpen}
            onSelect={date => {if(date !== app.date)app.selectDate(date);if(timelinePageId)navigate(timelinePageId);else {setTimelineOpen(true);window.scrollTo({top:0,behavior:"instant"});}}} />
        </section>
        <div className="concept-main-pages" hidden={rhythmOpen}>{typeof children === "function" ? children(timeline) : children}</div>
      </main>
    </div>
    {app.overlay}
  </div>;
}

const FIELD_LABELS: Record<ReviewField, string> = {personal_summary:"我的总结",outputs:"今日产出",next_action:"明天的计划",freeform:"自由记录"};
const FIELD_HINTS: Record<ReviewField, string> = {personal_summary:"回头看，今天最值得留下的是什么？",outputs:"记录今天留下的具体产出。",next_action:"把明天想做的事先放在这里。",freeform:"从一个念头开始，写下今天。"};

export function GuardedNotebook({app}: {app:ConceptProps}) {
  const [editingFingerprint,setEditingFingerprint] = useState<FileFingerprint|null>(null);
  if (!app.day || !isValidElement<{journalFingerprint:FileFingerprint;onDaySaved:()=>Promise<void>}>(app.notes)) return null;
  return <div className="concept-notebook" onClickCapture={event=>{
    const button=(event.target as Element).closest("button");
    if (button?.matches(".review-field-action")) setEditingFingerprint({...app.day!.cache.journal_fingerprint});
    else if (button?.closest(".review-editor") && !button.matches(".review-editor-save")) setEditingFingerprint(null);
  }}>{cloneElement(app.notes,{journalFingerprint:editingFingerprint??app.day.cache.journal_fingerprint,onDaySaved:async()=>{await app.onDaySaved();setEditingFingerprint(null);}})}</div>;
}

type JournalEditorProps = {app: ConceptProps; field: ReviewField; title?: string; placeholder?: string; longform?: boolean; visible?: boolean};
export function JournalEditor(props: JournalEditorProps) {
  return <JournalFieldEditor key={`${props.app.date}:${props.app.day?.journal.path ?? ""}:${props.field}`} {...props}/>;
}
function JournalFieldEditor({app,field,title,placeholder,longform=false,visible=true}: JournalEditorProps) {
  const [editing,setEditing] = useState(false);
  const [draft,setDraft] = useState("");
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [bodyOpen,setBodyOpen] = useState(true);
  const fingerprint = useRef<FileFingerprint|null>(null);
  const journal = app.day?.journal;
  const label = title ?? FIELD_LABELS[field];
  const value = !journal ? "" : field === "personal_summary" ? journal.personal_summary_markdown : field === "outputs" ? journal.outputs.map(item => `- ${item}`).join("\n") : field === "next_action" ? journal.next_action_markdown : journal.freeform_markdown;
  const body = field === "freeform" ? journal?.body_markdown ?? "" : "";
  useEffect(() => {setEditing(false);setDraft("");setSaving(false);setError(null);fingerprint.current=null;},[app.date,journal?.path,app.journalWriteEnabled,field]);
  useEffect(() => {
    if (!editing || draft === value) return;
    const protect = (event: BeforeUnloadEvent) => {event.preventDefault();event.returnValue="";};
    window.addEventListener("beforeunload",protect);
    return () => window.removeEventListener("beforeunload",protect);
  },[editing,draft,value]);
  function edit() {if (!app.day || !app.journalWriteEnabled) return; fingerprint.current={...app.day.cache.journal_fingerprint};setDraft(value);setError(null);setEditing(true);if(longform)setBodyOpen(false);}
  async function save() {
    if (!app.day || !app.journalWriteEnabled || !draft.trim() || saving || !fingerprint.current) return;
    setSaving(true);setError(null);
    try {await saveReviewField({date:app.date,field,markdown:draft,expected_fingerprint:fingerprint.current});setEditing(false);await app.onDaySaved();}
    catch(reason) {setError(reason instanceof ApiError && reason.status===409 ? `${reason.message} 请先检查最新内容，当前草稿已保留。` : reason instanceof Error ? reason.message : String(reason));}
    finally {setSaving(false);}
  }
  return <section className={`concept-journal-field field-${field} ${editing ? "is-editing" : ""} ${longform ? "concept-longform" : ""}`} data-field={field}>
    <header><h3>{label}</h3>{!editing && app.journalWriteEnabled && app.day && <button type="button" className="concept-edit-note" onClick={edit} aria-label={`编辑${label}`}>{value ? "编辑" : "开始写"}<span aria-hidden="true">↗</span></button>}{!app.journalWriteEnabled && <small>只读</small>}</header>
    {body.trim() && (longform ? <details className="concept-existing-journal" open={bodyOpen} onToggle={event=>setBodyOpen(event.currentTarget.open)}><summary>已有日记<span>原文只读</span></summary><div className="concept-journal-body"><MarkdownLite text={body}/></div>{journal?.open_url && <a href={journal.open_url}>在 Obsidian 编辑原文 ↗</a>}</details> : <div className="concept-journal-body"><MarkdownLite text={body}/></div>)}
    {editing ? <div className="concept-field-editor">{longform ? <LongformTextarea visible={visible} autoFocus aria-label={label} value={draft} rows={12} maxLength={8000} placeholder={placeholder ?? FIELD_HINTS[field]} disabled={saving} onChange={event=>setDraft(event.target.value)}/> : <textarea autoFocus aria-label={label} value={draft} rows={field === "freeform" ? 12 : 5} maxLength={8000} placeholder={placeholder ?? FIELD_HINTS[field]} disabled={saving} onChange={event=>setDraft(event.target.value)}/>}
      {error && <p role="alert" className="concept-save-error">{error}</p>}<footer><span>{longform && <span className="concept-character-count">{draft.length.toLocaleString()} / 8,000 字符<span aria-hidden="true"> · </span></span>}未保存的草稿</span><div><button type="button" disabled={saving} onClick={()=>{setEditing(false);setDraft("");setError(null);}}>取消</button><button type="button" className="concept-save-note" disabled={saving || !draft.trim()} onClick={()=>void save()}>{saving ? "保存中…" : "保存"}</button></div></footer></div>
      : value.trim() ? <MarkdownLite text={value}/> : !body.trim() ? <p className="concept-note-placeholder">{placeholder ?? FIELD_HINTS[field]}</p> : null}
  </section>;
}

export function SessionNotes({app,sessions,descriptionLayout}: {app: ConceptProps;sessions?: ScreenSession[];descriptionLayout?: "below" | "aside"}) {
  if (!app.day) return null;
  const starts = new Set((sessions ?? app.sessions).map(session => session.start));
  // A filter must not move a removed session's description into another one.
  // Establish attribution using the original day, then refine it only among
  // the surviving pieces of that same original session.
  const originalSessions = buildSessions(app.day);
  const originalEntries = assignKinaSummaryToSessions(parseKinaSummary(app.day.journal.activity_summary_markdown), originalSessions, app.timezone);
  const visibleEntries: KinaSummaryEntry[][] = app.sessions.map(() => []);
  originalSessions.forEach((original,index) => {
    const candidates = app.sessions.filter(session => Date.parse(session.start) < Date.parse(original.end) && Date.parse(session.end) > Date.parse(original.start));
    const assigned = assignKinaSummaryToSessions(originalEntries[index], candidates, app.timezone);
    candidates.forEach((session,candidate) => visibleEntries[app.sessions.indexOf(session)].push(...assigned[candidate]));
  });
  const journal = originalSessions.length === 0 ? app.day.journal : {...app.day.journal, activity_summary_markdown: visibleEntries
    .flatMap((entries,index) => starts.has(app.sessions[index].start) ? entries : [])
    .map(entry => `> - \`${entry.approximate ? "约" : ""}${entry.startTime}–${entry.endTime}\` ${entry.text}`).join("\n")};
  return <div className="concept-session-notes"><SessionList key={`${app.date}:${journal.path}`} date={app.date}
    sessions={sessions ?? app.sessions} journal={journal} descriptionLayout={descriptionLayout}
    journalFingerprint={app.day.cache.journal_fingerprint} timezone={app.timezone} writeEnabled={app.journalWriteEnabled}
    onSaved={app.onDaySaved}/></div>;
}

export function ActivityList({app,blocks,limit=24}: {app: ConceptProps;blocks?: ScreenTimelineBlock[];limit?:number}) {
  const [expanded,setExpanded] = useState(false);
  useEffect(()=>setExpanded(false),[app.date]);
  const events = blocks ?? app.displayDay?.timeline.filter((block):block is ScreenTimelineBlock=>block.kind==="screen") ?? [];
  const visible = expanded ? events : events.slice(0,limit);
  return <div className="concept-activity-list">{visible.length ? visible.map((block,index)=><button type="button" className="concept-event" key={`${block.start}-${block.app}-${index}`} onClick={()=>app.onInspect(block)}>
    <span className="concept-event-time">{fmtClock(block.start,app.timezone)}</span><span className="concept-event-dot" style={{background:categoryColor(block.category)}}/><span className="concept-event-main"><strong>{block.app || block.category_label}</strong><span>{block.title || block.category_label}</span></span><small>{fmtDuration(block.duration_seconds)}</small><span aria-hidden="true">↗</span>
  </button>):<p className="empty-hint">这一天还没有记录到活动。</p>}{events.length>limit && <button type="button" className="concept-more" onClick={()=>setExpanded(!expanded)}>{expanded ? "收起活动" : `查看其余 ${events.length-limit} 条活动`}</button>}</div>;
}
