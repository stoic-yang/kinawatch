import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { ReviewField, ScreenTimelineBlock } from "../../api";
import { categoryColor } from "../../lib/colors";
import { fmtClock, fmtDuration } from "../../lib/format";
import type { ScreenSession } from "../../lib/sessions";
import { ActivityList, ConceptFrame, JournalEditor, SessionNotes } from "./shared";
import type { ConceptProps } from "./types";
import "./workbench.css";

interface AppGroup {
  name: string;
  blocks: ScreenTimelineBlock[];
  seconds: number;
  latest: number;
  sessions: Set<number>;
  titles: string[];
}

interface ActivityGroup {
  id: string;
  label: string;
  seconds: number;
  latest: number;
  blocks: ScreenTimelineBlock[];
  apps: AppGroup[];
}

const NOTE_FIELDS: { field: ReviewField; label: string; hint: string }[] = [
  { field: "freeform", label: "自由记录", hint: "从一个念头开始，也可以接着昨天的想法写。" },
  { field: "personal_summary", label: "我的总结", hint: "回看这些活动，今天最值得留下的是什么？" },
  { field: "outputs", label: "今日产出", hint: "写下今天留下的具体成果、文件或决定。" },
  { field: "next_action", label: "明天的计划", hint: "下一次回到这里，想从哪件事开始？" },
];
const NOTE_TABS = [...NOTE_FIELDS.map(({ field, label }) => ({ id: field, label })), { id: "sessions", label: "会话批注" }];

function groupActivities(blocks: ScreenTimelineBlock[], sessions: ScreenSession[]): ActivityGroup[] {
  const ranges = sessions.map((session) => ({ start: Date.parse(session.start), end: Date.parse(session.end) }));
  const groups = new Map<string, ActivityGroup & { appMap: Map<string, AppGroup> }>();
  for (const block of blocks) {
    const id = block.category || "uncategorized";
    let group = groups.get(id);
    if (!group) {
      group = { id, label: block.category_label || "未分类", seconds: 0, latest: 0, blocks: [], apps: [], appMap: new Map() };
      groups.set(id, group);
    }
    const name = block.app || "未记录应用名";
    let app = group.appMap.get(name);
    if (!app) {
      app = { name, blocks: [], seconds: 0, latest: 0, sessions: new Set(), titles: [] };
      group.appMap.set(name, app);
    }
    const seconds = Math.max(0, block.duration_seconds || 0);
    const start = Date.parse(block.start);
    const end = Date.parse(block.end);
    group.blocks.push(block);
    group.seconds += seconds;
    group.latest = Math.max(group.latest, start);
    app.blocks.push(block);
    app.seconds += seconds;
    app.latest = Math.max(app.latest, start);
    const sessionIndex = ranges.findIndex((range) => start < range.end && end > range.start);
    if (sessionIndex >= 0) app.sessions.add(sessionIndex);
  }
  return [...groups.values()].map(({ appMap, ...group }) => ({
    ...group,
    apps: [...appMap.values()].map((app) => ({
      ...app,
      titles: [...new Set([...app.blocks].sort((a, b) => b.duration_seconds - a.duration_seconds).map((block) => block.title.trim()).filter(Boolean))],
    })).sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name)),
  })).sort((a, b) => b.seconds - a.seconds || a.label.localeCompare(b.label));
}

function Arrow({ back = false }: { back?: boolean }) {
  return <svg viewBox="0 0 20 20" width="17" height="17" fill="none" aria-hidden="true" style={back ? { transform: "rotate(180deg)" } : undefined}><path d="M4 10h11m-4-4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function PenIcon() {
  return <svg viewBox="0 0 20 20" width="17" height="17" fill="none" aria-hidden="true"><path d="m12.5 3.5 4 4M4 12l9.2-9.2a1.6 1.6 0 0 1 2.3 0l1.7 1.7a1.6 1.6 0 0 1 0 2.3L8 16l-5 1 1-5Z" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 20 20" width="17" height="17" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.1" stroke="currentColor" strokeWidth="1.4" /><path d="m12.4 12.4 4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
}

function AppMark({ name }: { name: string }) {
  const letters = [...name.replace(/^(Microsoft|Google|Apple)\s+/i, "")].slice(0, 2).join("");
  return <span className="wb-app-mark" aria-hidden="true">{letters}</span>;
}

export function Workbench(props: ConceptProps) {
  const [page, setPage] = useState("board");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("duration");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [detailQuery, setDetailQuery] = useState("");
  const [noteTab, setNoteTab] = useState("freeform");
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const notesRef = useRef<HTMLElement>(null);
  const detailTitleRef = useRef<HTMLHeadingElement>(null);
  const blocks = useMemo(() => props.displayDay?.timeline.filter((block): block is ScreenTimelineBlock => block.kind === "screen") ?? [], [props.displayDay]);
  const groups = useMemo(() => groupActivities(blocks, props.sessions), [blocks, props.sessions]);
  const visibleGroups = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const selected = search ? groupActivities(blocks.filter((block) => [block.category_label, block.app, block.title].some((value) => value.toLocaleLowerCase().includes(search))), props.sessions) : groups;
    return sort === "latest" ? [...selected].sort((a, b) => b.latest - a.latest) : selected;
  }, [blocks, groups, props.sessions, query, sort]);
  const category = groups.find((group) => group.id === selectedCategory);
  const availableApps = category?.apps ?? groups.flatMap((group) => group.apps);
  const appNames = [...new Set(availableApps.map((app) => app.name))];
  const detailBlocks = useMemo(() => {
    const search = detailQuery.trim().toLocaleLowerCase();
    return blocks.filter((block) => (!selectedCategory || (block.category || "uncategorized") === selectedCategory)
      && (!selectedApp || (block.app || "未记录应用名") === selectedApp)
      && (!search || `${block.app} ${block.title}`.toLocaleLowerCase().includes(search)));
  }, [blocks, detailQuery, selectedCategory, selectedApp]);
  const totalSeconds = blocks.reduce((sum, block) => sum + block.duration_seconds, 0);
  const uniqueApps = new Set(blocks.map((block) => block.app)).size;

  useEffect(() => {
    setSelectedCategory(null);
    setSelectedApp(null);
    setDetailQuery("");
  }, [props.date]);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === notesRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  useEffect(() => {
    if (page === "activity") detailTitleRef.current?.focus({ preventScroll: true });
  }, [page]);

  function selectPage(next: string) {
    if (next !== "notes" && document.fullscreenElement === notesRef.current) void document.exitFullscreen().catch(() => undefined);
    setPage(next);
  }

  function navigate(next: string) {
    selectPage(next);
    const url = new URL(window.location.href);
    url.hash = next;
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
  }

  function openActivity(categoryId: string | null, appName: string | null = null) {
    setSelectedCategory(categoryId);
    setSelectedApp(appName);
    setDetailQuery("");
    navigate("activity");
    window.scrollTo({ top: 0 });
  }

  async function toggleFullscreen() {
    setFullscreenError("");
    try {
      if (document.fullscreenElement === notesRef.current) await document.exitFullscreen();
      else await notesRef.current?.requestFullscreen();
    } catch {
      setFullscreenError("当前浏览器无法进入全屏，可以继续在这里书写。");
    }
  }

  function moveNoteTab(event: KeyboardEvent<HTMLDivElement>) {
    const index = NOTE_TABS.findIndex((tab) => tab.id === noteTab);
    const next = event.key === "ArrowRight" ? (index + 1) % NOTE_TABS.length
      : event.key === "ArrowLeft" ? (index + NOTE_TABS.length - 1) % NOTE_TABS.length
      : event.key === "Home" ? 0 : event.key === "End" ? NOTE_TABS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    setNoteTab(NOTE_TABS[next].id);
    document.getElementById(`wb-tab-${NOTE_TABS[next].id}`)?.focus();
  }

  return <ConceptFrame concept="workbench" app={props}
    nav={[{ id: "board", label: "活动工作台", icon: "board" }, { id: "activity", label: "活动明细", icon: "flow" }, { id: "notes", label: "书写空间", icon: "note" }]}
    active={page} onNavigate={selectPage}>
    <section className="wb-board-page wb-page" hidden={page !== "board"} aria-label="活动工作台">
      <header className="wb-page-heading">
        <div><p className="wb-eyebrow">A PLACE FOR YOUR WORK</p><h1>活动工作台<span className="wb-heading-dot" /></h1><p className="wb-description">把一天的活动，放回各自的上下文。</p></div>
        <button type="button" className="wb-write-button" onClick={() => navigate("notes")}><PenIcon /><span>打开书写空间</span><Arrow /></button>
      </header>

      <div className="wb-board-caption"><span className="wb-date-stamp">{props.dateLabel}<span>{props.weekday.startsWith("星期") ? props.weekday : `星期${props.weekday}`}</span></span><span>{props.displayDay ? `${groups.length} 个活动主题 · ${uniqueApps} 个应用` : "当天活动"}</span><span className="wb-recorded-time">屏幕记录 <strong>{props.displayDay ? fmtDuration(totalSeconds) : "—"}</strong></span></div>

      <div className="wb-board-toolbar">
        <div className="wb-view-label"><svg viewBox="0 0 18 18" width="16" height="16" fill="none" aria-hidden="true"><rect x="2" y="3" width="4" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" /><rect x="7" y="3" width="4" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" /><rect x="12" y="3" width="4" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" /></svg>按活动主题</div>
        <label className="wb-search"><SearchIcon /><span className="theme-sr-only">搜索活动工作台</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索应用或窗口标题" aria-label="搜索活动工作台" />{query && <button type="button" onClick={() => setQuery("")} aria-label="清空工作台搜索">×</button>}</label>
        <label className="wb-sort"><span className="theme-sr-only">活动主题排序</span><select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="活动主题排序"><option value="duration">累计时长</option><option value="latest">最近活动</option></select></label>
      </div>

      {visibleGroups.length ? <div className="wb-board" aria-label="按分类分列的活动看板">
        {visibleGroups.map((group) => <section className="wb-column" key={group.id} style={{ "--wb-category": categoryColor(group.id) } as CSSProperties}>
          <header className="wb-column-heading"><h2><button type="button" onClick={() => openActivity(group.id)} aria-label={`查看${group.label}的全部活动`}><span className="wb-category-dot" /><span className="wb-column-label">{group.label}</span><span className="wb-column-count">{group.apps.length}</span></button></h2><span>{fmtDuration(group.seconds)}</span></header>
          <div className="wb-column-cards">{group.apps.slice(0, 4).map((app) => <button type="button" className="wb-app-card" key={app.name} onClick={() => openActivity(group.id, app.name)} aria-label={`查看${group.label}中${app.name}的活动`}>
            <span className="wb-card-app"><AppMark name={app.name} /><span><strong>{app.name}</strong><small>{app.sessions.size ? `${app.sessions.size} 段会话` : `${app.blocks.length} 条活动`}</small></span><span className="wb-card-arrow"><Arrow /></span></span>
            <span className="wb-card-titles">{app.titles.length ? app.titles.slice(0, 2).map((title) => <span key={title}>{title}</span>) : <span className="wb-title-missing">未记录窗口标题</span>}</span>
            <span className="wb-card-footer"><span>{fmtDuration(app.seconds)}</span><span>最近 {fmtClock(new Date(app.latest).toISOString(), props.timezone)}</span></span>
          </button>)}</div>
          <button type="button" className="wb-column-more" onClick={() => openActivity(group.id)}><span>{group.apps.length > 4 ? `查看全部 ${group.apps.length} 个应用` : `查看 ${group.blocks.length} 条活动`}</span><Arrow /></button>
        </section>)}
      </div> : <div className="wb-empty-state"><span className="wb-empty-mark" aria-hidden="true">⌗</span><h2>{query ? "没有找到相符的活动" : props.displayDay ? "这一天还没有屏幕活动记录" : "当天活动尚未载入"}</h2><p>{query ? "换一个应用名或窗口标题试试。" : "有记录后，它们会按活动主题出现在这里。"}</p>{query && <button type="button" onClick={() => setQuery("")}>清空搜索</button>}</div>}

      <div className="wb-writing-invitation"><span className="wb-invitation-icon"><PenIcon /></span><div><strong>活动留下痕迹，笔记留下想法。</strong><p>为今天做过的事，补上自己的解释。</p></div><button type="button" onClick={() => navigate("notes")}>去写几句<Arrow /></button></div>
    </section>

    <section className="wb-detail-page wb-page" hidden={page !== "activity"} aria-label="活动明细">
      <button type="button" className="wb-back-link" onClick={() => navigate("board")}><Arrow back />活动工作台</button>
      <header className="wb-detail-heading"><div><p className="wb-eyebrow">{category?.label ?? "ALL ACTIVITY"}</p><h1 ref={detailTitleRef} tabIndex={-1}>{selectedApp ?? category?.label ?? "活动明细"}</h1><p>{props.dateLabel}<span>·</span>{detailBlocks.length} 条活动<span>·</span>{fmtDuration(detailBlocks.reduce((sum, block) => sum + block.duration_seconds, 0))}</p></div><button type="button" className="wb-secondary-button" onClick={() => navigate("notes")}><PenIcon />记下想法</button></header>
      <div className="wb-detail-layout">
        <nav className="wb-detail-categories" aria-label="活动明细分类"><p>活动主题</p><button type="button" aria-current={!selectedCategory ? "true" : undefined} onClick={() => { setSelectedCategory(null); setSelectedApp(null); }}><span>全部活动</span><small>{blocks.length}</small></button>{groups.map((group) => <button type="button" key={group.id} aria-current={selectedCategory === group.id ? "true" : undefined} onClick={() => { setSelectedCategory(group.id); setSelectedApp(null); }}><i style={{ background: categoryColor(group.id) }} /><span>{group.label}</span><small>{fmtDuration(group.seconds)}</small></button>)}</nav>
        <div className="wb-detail-records"><div className="wb-record-toolbar"><label className="wb-search"><SearchIcon /><span className="theme-sr-only">搜索活动明细</span><input type="search" value={detailQuery} onChange={(event) => setDetailQuery(event.target.value)} placeholder="在这些活动中查找" aria-label="搜索活动明细" /></label><span>按发生时间排列</span></div><div className="wb-app-filters" aria-label="按应用筛选"><button type="button" aria-pressed={!selectedApp} onClick={() => setSelectedApp(null)}>所有应用</button>{appNames.map((name) => <button type="button" key={name} aria-pressed={selectedApp === name} onClick={() => setSelectedApp(name)}>{name}</button>)}</div>
          {detailBlocks.length ? <ActivityList app={props} blocks={detailBlocks} limit={36} /> : <div className="wb-empty-state wb-detail-empty"><h2>没有相符的活动</h2><p>试试切换分类、应用，或清空搜索。</p><button type="button" onClick={() => { setSelectedCategory(null); setSelectedApp(null); setDetailQuery(""); }}>查看全部活动</button></div>}
        </div>
      </div>
    </section>

    <section ref={notesRef} className="wb-notes-page wb-page" hidden={page !== "notes"} aria-label="书写空间">
      <div className="wb-notes-topline"><button type="button" className="wb-back-link" onClick={() => navigate("board")}><Arrow back />回到工作台</button><button type="button" className="wb-fullscreen-button" onClick={() => void toggleFullscreen()} aria-pressed={fullscreen}><svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d={fullscreen ? "M3 7h4V3m6 0v4h4M3 13h4v4m6 0v-4h4" : "M3 7V3h4m6 0h4v4M3 13v4h4m6 0h4v-4"} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>{fullscreen ? "退出全屏" : "全屏书写"}</button></div>
      <div className="wb-notes-wrap"><header className="wb-notes-heading"><p className="wb-eyebrow">ROOM FOR A THOUGHT</p><h1>书写空间</h1><p>{props.dateLabel}<span>·</span>把今天的想法留在这里。</p></header>
        <div className="wb-note-tabs" role="tablist" aria-label="选择书写内容" onKeyDown={moveNoteTab}>{NOTE_TABS.map(({ id, label }) => <button type="button" role="tab" id={`wb-tab-${id}`} aria-controls={`wb-panel-${id}`} aria-selected={noteTab === id} tabIndex={noteTab === id ? 0 : -1} key={id} onClick={() => setNoteTab(id)}>{label}</button>)}</div>
        {fullscreenError && <p className="wb-fullscreen-error" role="status">{fullscreenError}</p>}
        <div className="wb-writing-sheet">{NOTE_FIELDS.map(({ field, label, hint }) => <div key={field} id={`wb-panel-${field}`} role="tabpanel" aria-labelledby={`wb-tab-${field}`} hidden={noteTab !== field}><JournalEditor app={props} field={field} title={label} placeholder={hint} /></div>)}<div id="wb-panel-sessions" role="tabpanel" aria-labelledby="wb-tab-sessions" hidden={noteTab !== "sessions"}><div className="wb-session-intro"><h2>给每段会话加上自己的解释</h2><p>这里的文字会保留在当天的工作流中。</p></div><SessionNotes app={props} sessions={props.sessions} /></div></div>
        <p className="wb-writing-footnote"><span aria-hidden="true">↳</span> 切回工作台看看，再回来接着写。</p>
      </div>
    </section>
  </ConceptFrame>;
}
