import { useMemo, useRef, useState, type CSSProperties } from "react";
import type { ScreenTimelineBlock } from "../../api";
import { categoryColor } from "../../lib/colors";
import { fmtClock, fmtDuration } from "../../lib/format";
import { ActivityList, ConceptFrame, SessionNotes } from "./shared";
import type { ConceptProps } from "./types";
import { DaymapNotebook } from "./DaymapNotebook";
import "./daymap.css";

const HOUR = 3_600_000;
const PIXELS_PER_HOUR = 66;
const NAV = [
  { id: "canvas", label: "日程画布", icon: "calendar" },
  { id: "activities", label: "活动目录", icon: "flow" },
  { id: "journal", label: "笔记空间", icon: "note" },
];

function CalendarGlyph() {
  return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect x="7" y="8" width="26" height="27" rx="5" stroke="currentColor" strokeWidth="1.4" /><path d="M7 16h26M14 5v7m12-7v7m-13 8h8m-8 6h14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
}

export function Daymap(app: ConceptProps) {
  const [page, setPage] = useState("canvas");
  const [extent, setExtent] = useState<"activity" | "day">("activity");
  const [selection, setSelection] = useState<{ date: string; start: string } | null>(null);
  const [query, setQuery] = useState("");
  const [focusMode, setFocusMode] = useState(false);
  const selectedCard = useRef<HTMLButtonElement>(null);
  const inspector = useRef<HTMLElement>(null);

  const blocks = useMemo(() => app.displayDay?.timeline.filter((block): block is ScreenTimelineBlock => block.kind === "screen") ?? [], [app.displayDay]);
  const sessions = useMemo(() => app.sessions.map((session) => ({
    ...session,
    blocks: blocks.filter((block) => Date.parse(block.start) < Date.parse(session.end) && Date.parse(block.end) > Date.parse(session.start)),
  })), [app.sessions, blocks]);
  const selectedIndex = Math.max(0, sessions.findIndex((session) => selection?.date === app.date && selection.start === session.start));
  const selected = sessions[selectedIndex];
  const dayStart = app.day ? Date.parse(app.day.range.start) : 0;
  const dayEnd = app.day ? Date.parse(app.day.range.end) : 0;
  let canvasStart = dayStart;
  let canvasEnd = dayEnd;
  if (extent === "activity" && sessions.length) {
    canvasStart = Math.max(dayStart, dayStart + (Math.floor((Date.parse(sessions[0].start) - dayStart) / HOUR) - 1) * HOUR);
    canvasEnd = Math.min(dayEnd, dayStart + (Math.ceil((Date.parse(sessions[sessions.length - 1].end) - dayStart) / HOUR) + 1) * HOUR);
    if (canvasEnd - canvasStart < 6 * HOUR) {
      canvasEnd = Math.min(dayEnd, canvasStart + 6 * HOUR);
      canvasStart = Math.max(dayStart, canvasEnd - 6 * HOUR);
    }
  }
  const span = Math.max(HOUR, canvasEnd - canvasStart);
  const paperHeight = (span / HOUR) * PIXELS_PER_HOUR;
  const ticks = Array.from({ length: Math.floor(span / HOUR) + 1 }, (_, index) => canvasStart + index * HOUR);
  const results = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return search ? blocks.filter((block) => `${block.app} ${block.title} ${block.category_label}`.toLocaleLowerCase().includes(search)) : blocks;
  }, [blocks, query]);

  function selectSession(start: string, reveal = false) {
    setSelection({ date: app.date, start });
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    if (reveal && window.matchMedia("(max-width: 760px)").matches) inspector.current?.scrollIntoView({ block: "start", behavior });
  }

  function changePage(next: string) {
    setPage(next);
    const url = new URL(window.location.href);
    url.hash = next;
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  return <ConceptFrame concept="daymap" app={app} nav={NAV} active={page} onNavigate={setPage} focusMode={page === "journal" && focusMode} onExitFocus={() => setFocusMode(false)}>
    <div className="daymap-app">
      <section className="dm-page" hidden={page !== "canvas"} aria-label="日程画布">
        <header className="dm-page-head">
          <div><span className="dm-eyebrow">DAYMAP / 每日活动画布</span><h1>一天，沿时间展开。</h1><p><time dateTime={app.date}>{app.dateLabel}</time><span>·</span>{app.weekday}<span>·</span>{app.sessions.length} 段活动</p></div>
          <button type="button" className="dm-write-link" onClick={() => changePage("journal")}><span>写下这一天</span><span aria-hidden="true">↗</span></button>
        </header>

        <div className="dm-workspace">
          <div className="dm-calendar-column">
            <div className="dm-calendar-toolbar">
              <div className="dm-extent" role="group" aria-label="画布时间范围">
                <button type="button" aria-pressed={extent === "activity"} onClick={() => setExtent("activity")}>活动区间</button>
                <button type="button" aria-pressed={extent === "day"} onClick={() => setExtent("day")}>完整一天</button>
              </div>
              <button type="button" className="dm-locate" disabled={!selected} onClick={() => selectedCard.current?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}><span aria-hidden="true">⌾</span>定位所选</button>
            </div>
            <div className="dm-day-lane-heading"><span>时间</span><div><b>{app.dateLabel}</b><small>{app.screenTime} 屏幕时间</small></div></div>

            {sessions.length ? <div className="dm-calendar-scroll" aria-label="纵向活动时间画布" tabIndex={0}>
              <div className="dm-calendar-paper" style={{ height: paperHeight + 32 }}>
                {ticks.map((instant) => <div className="dm-time-row" key={instant} style={{ top: 16 + ((instant - canvasStart) / HOUR) * PIXELS_PER_HOUR }} aria-hidden="true"><time>{fmtClock(new Date(instant).toISOString(), app.timezone)}</time><i /></div>)}
                {sessions.map((session, index) => {
                  const start = Math.max(canvasStart, Date.parse(session.start));
                  const end = Math.min(canvasEnd, Date.parse(session.end));
                  if (end <= start) return null;
                  const height = ((end - start) / HOUR) * PIXELS_PER_HOUR;
                  const duration = Math.max(1, Date.parse(session.end) - Date.parse(session.start));
                  const color = categoryColor(session.categories[0]?.category ?? "uncategorized");
                  const active = selected?.start === session.start;
                  const clock = `${fmtClock(session.start, app.timezone)} — ${fmtClock(session.end, app.timezone)}`;
                  return <button type="button" key={session.start} ref={active ? selectedCard : undefined}
                    className={`dm-session-block ${active ? "is-selected" : ""} ${height < 60 ? "is-compact" : ""} ${height < 24 ? "is-tiny" : ""}`}
                    style={{ top: 16 + ((start - canvasStart) / HOUR) * PIXELS_PER_HOUR, height: Math.max(height, 4), "--session-color": color } as CSSProperties}
                    aria-pressed={active} aria-label={`选择第${index + 1}段活动，${clock}，${session.topApps.map((item) => item.app).join("、")}，屏幕时间${fmtDuration(session.seconds)}`}
                    onClick={() => selectSession(session.start, true)}>
                    <span className="dm-session-time-label">{clock}<span>#{String(index + 1).padStart(2, "0")}</span></span>
                    <strong>{session.topApps[0]?.app || session.categories[0]?.label || "屏幕活动"}</strong>
                    {height > 94 ? <span className="dm-session-caption">{session.topApps.slice(1).map((item) => item.app).join(" · ") || session.categories.map((item) => item.label).slice(0, 2).join(" · ")}</span> : null}
                    {height > 115 ? <small className="dm-session-duration">{fmtDuration(session.seconds)} 屏幕活动</small> : null}
                    <span className="dm-event-stitch" aria-hidden="true">{session.blocks.map((block, blockIndex) => <i key={`${block.start}-${blockIndex}`} style={{ top: `${((Date.parse(block.start) - Date.parse(session.start)) / duration) * 100}%`, height: `${((Date.parse(block.end) - Date.parse(block.start)) / duration) * 100}%`, background: categoryColor(block.category) }} />)}</span>
                  </button>;
                })}
              </div>
            </div> : <div className="dm-no-activity"><CalendarGlyph /><h2>{app.day ? "还没有落在画布上的活动。" : "正在展开这一天。"}</h2><p>{app.day ? "可以先记下今天的想法，活动记录会在这里沿时间出现。" : "活动片段将按照真实发生时间排列。"}</p>{app.day ? <button type="button" onClick={() => changePage("journal")}>去笔记空间 <span aria-hidden="true">↗</span></button> : null}</div>}
            <footer className="dm-canvas-foot"><span><i />色带对应屏幕活动，间隙保留留白</span><span>{app.timezone}</span></footer>
          </div>

          <aside className="dm-session-inspector" ref={inspector} aria-label="所选活动说明">
            <div className="dm-inspector-eyebrow"><span>SESSION DETAILS</span><span>活动详情</span></div>
            {selected ? <>
              <header className="dm-selected-heading"><div><span>当前选中</span><h2>第 {String(selectedIndex + 1).padStart(2, "0")} 段活动</h2></div><div className="dm-session-stepper"><button type="button" aria-label="上一段活动" disabled={selectedIndex === 0} onClick={() => selectSession(sessions[selectedIndex - 1].start)}>‹</button><button type="button" aria-label="下一段活动" disabled={selectedIndex >= sessions.length - 1} onClick={() => selectSession(sessions[selectedIndex + 1].start)}>›</button></div></header>
              <p className="dm-selected-clock">{fmtClock(selected.start, app.timezone)}<span>—</span>{fmtClock(selected.end, app.timezone)}</p>
              <div className="dm-selected-facts"><span><b>{fmtDuration(selected.seconds)}</b>屏幕活动</span><span><b>{selected.blocks.length}</b>条活动记录</span></div>
              <div className="dm-selection-note-heading"><span>这一段，在做什么？</span><i /></div>
              <div className="dm-session-note-panels">{sessions.map((session) => <div key={session.start} hidden={selected.start !== session.start}><SessionNotes app={app} sessions={[session]} /></div>)}</div>
              <details className="dm-source-events"><summary><span>查看活动记录</span><small>{selected.blocks.length} 条</small><span aria-hidden="true">⌄</span></summary><p>点击一条记录，查看原始事件与校正信息。</p><ActivityList app={app} blocks={selected.blocks} limit={8} /></details>
            </> : <div className="dm-inspector-empty"><span aria-hidden="true">↖</span><h2>留一个位置，给正在回看的片段。</h2><p>点击画布中的活动块，查看应用、时间和这一段的说明。</p></div>}
          </aside>
        </div>
      </section>

      <section className="dm-page dm-directory-page" hidden={page !== "activities"} aria-label="活动目录">
        <header className="dm-page-head"><div><span className="dm-eyebrow">ACTIVITY DIRECTORY</span><h1>找到某一个瞬间。</h1><p>{app.dateLabel}<span>·</span>{blocks.length} 条屏幕活动记录</p></div><button type="button" className="dm-write-link" onClick={() => changePage("canvas")}>回到日程画布 <span aria-hidden="true">↗</span></button></header>
        <label className="dm-search"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.5" /><path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.5" /></svg><span className="theme-sr-only">搜索活动</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索应用、窗口标题或分类…" /><span>{results.length} 条</span></label>
        <div className="dm-directory-list"><div className="dm-directory-labels"><span>发生时间</span><span>应用与内容</span><span>屏幕时间</span></div>{results.length ? <ActivityList app={app} blocks={results} limit={36} /> : <p className="dm-search-empty">{query.trim() ? "没有匹配的活动，试试其他关键词。" : "这一天还没有屏幕活动记录。"}</p>}</div>
      </section>

      <section className="dm-page dm-notebook-page" hidden={page !== "journal"} aria-label="独立笔记空间">
        <DaymapNotebook app={app} visible={page === "journal"} focusMode={focusMode} onFocusChange={setFocusMode} onReturn={() => {setFocusMode(false);changePage("canvas");}} />
      </section>
    </div>
  </ConceptFrame>;
}
