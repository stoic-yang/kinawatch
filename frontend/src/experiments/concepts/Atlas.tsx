import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { RangeDay, ScreenTimelineBlock } from "../../api";
import { categoryColor } from "../../lib/colors";
import { fmtClock, fmtDuration, parseLocalDate, shiftDate, weekdayShort } from "../../lib/format";
import { ActivityList, ConceptFrame, JournalEditor, SessionNotes } from "./shared";
import type { ConceptProps } from "./types";
import "./atlas.css";

const NAV = [
  { id: "map", label: "七日活动地图", icon: "calendar" },
  { id: "day", label: "日详情", icon: "day" },
  { id: "journal", label: "笔记档案", icon: "note" },
];

function shortDate(date: string) {
  const parsed = parseLocalDate(date);
  return `${parsed.getMonth() + 1}.${String(parsed.getDate()).padStart(2, "0")}`;
}

function hourLabel(start: string, index: number) {
  const [hour, minute] = start.split(":").map(Number);
  const total = hour * 60 + minute + index * 60;
  const clock = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  return `${clock}${total >= 24 * 60 ? " +1" : ""}`;
}

function NoteMark() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="M4 2.5h6l2 2v9H4zM9.5 2.5v3H12M6 8h4m-4 2h3" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function Atlas(app: ConceptProps) {
  const [page, setPage] = useState("map");
  const [anchor, setAnchor] = useState(app.date);
  const [mapData, setMapData] = useState<Record<string, RangeDay>>({});
  const [startClock, setStartClock] = useState<string | null>(null);
  const mapDates = useMemo(() => Array.from({ length: 7 }, (_, index) => shiftDate(anchor, index - 6)).filter((date) => date >= "2026-01-01" && date <= app.currentDate), [anchor, app.currentDate]);

  useEffect(() => {
    if (page === "map") setAnchor(app.date);
  }, [app.date, page]);

  useEffect(() => {
    // Keep the original map while drilling into a day. Only received records
    // enter the map; an absent response is never rendered as zero activity.
    setMapData((previous) => {
      const next: Record<string, RangeDay> = {};
      for (const date of mapDates) if (previous[date]) next[date] = previous[date];
      for (const day of app.days) if (mapDates.includes(day.date)) next[day.date] = day;
      return next;
    });
  }, [app.days, mapDates]);

  useEffect(() => {
    if (app.day) setStartClock(fmtClock(app.day.range.start, app.timezone));
  }, [app.day, app.timezone]);

  const loaded = mapDates.map((date) => mapData[date]).filter((day): day is RangeDay => Boolean(day));
  const completeRange = loaded.length === mapDates.length;
  const totalSeconds = loaded.reduce((sum, day) => sum + day.overview.active_seconds, 0);
  const notedDays = loaded.filter((day) => day.overview.review_has_content).length;
  const blocks = useMemo(() => app.displayDay?.timeline.filter((block): block is ScreenTimelineBlock => block.kind === "screen") ?? [], [app.displayDay]);
  const details = useMemo(() => app.sessions.map((session) => ({
    session,
    blocks: blocks.filter((block) => Date.parse(block.start) < Date.parse(session.end) && Date.parse(block.end) > Date.parse(session.start)),
  })), [app.sessions, blocks]);

  function changePage(next: string, date: string) {
    app.selectDate(date);
    setPage(next);
    const url = new URL(window.location.href);
    url.hash = next;
    if (date === app.currentDate) url.searchParams.delete("date");
    else url.searchParams.set("date", date);
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function openDate(date: string) {
    changePage("day", date);
  }

  function shiftMap(delta: -1 | 1) {
    const candidate = shiftDate(anchor, delta * 7);
    const next = candidate > app.currentDate ? app.currentDate : candidate < "2026-01-01" ? "2026-01-01" : candidate;
    app.selectDate(next);
    setAnchor(next);
  }

  return <ConceptFrame concept="atlas" app={app} nav={NAV} active={page} onNavigate={setPage}>
    <div className="atlas-app">
      <section hidden={page !== "map"} className="atlas-map-page" aria-label="近七天的活动地图">
        <header className="atlas-page-heading"><div><span className="atlas-eyebrow">ATLAS / 一周的切面</span><h1>从七天，看见一天。</h1><p>在并排的时间里，找到想要回看的片段。</p></div><div className="atlas-range-totals"><div><span>{mapDates.length === 7 ? "七日屏幕时间" : "所选范围屏幕时间"}</span><strong>{completeRange ? fmtDuration(totalSeconds) : "—"}</strong></div><div><span>留下笔记</span><strong>{completeRange ? notedDays : "—"}<small> 天</small></strong></div></div></header>

        <div className="atlas-map-heading"><div><span className="atlas-range-label">近七天</span><h2>{shortDate(mapDates[0])}<span>—</span>{shortDate(anchor)}<small>{parseLocalDate(anchor).getFullYear()}</small></h2></div><div className="atlas-map-navigation"><button type="button" onClick={() => { setAnchor(app.currentDate); app.selectDate(app.currentDate); }} disabled={anchor === app.currentDate}>最近七天</button><span /><button type="button" aria-label="查看前七天" disabled={anchor <= "2026-01-01"} onClick={() => shiftMap(-1)}>‹</button><button type="button" aria-label="查看后七天" disabled={anchor >= app.currentDate} onClick={() => shiftMap(1)}>›</button></div></div>

        <div className="atlas-map-surface">
          <div className="atlas-map-legend"><span><i />记录活动分布</span><span>每行一小时 · 条长表示该小时的活动比例</span><span className="atlas-swipe-hint">左右滑动查看日期 <b aria-hidden="true">↔</b></span></div>
          <div className="atlas-map-scroller" aria-label="横向浏览七天，点击日期打开日详情" tabIndex={0}>
            <div className="atlas-map-grid" style={{ "--atlas-days": mapDates.length } as CSSProperties}>
              <div className="atlas-map-axis" aria-hidden="true"><div className="atlas-axis-header">时刻</div><div className="atlas-axis-hours">{[0, 6, 12, 18, 24].map((hour) => <span key={hour} style={{ top: `${(hour / 24) * 100}%` }}>{startClock ? hourLabel(startClock, hour) : "—"}</span>)}</div></div>
              {mapDates.map((date) => {
                const day = mapData[date];
                const hours = day?.rhythm?.hourly_active_seconds;
                const today = date === app.currentDate;
                const active = date === app.date;
                return <button type="button" className={`atlas-day-column ${active ? "is-selected" : ""} ${today ? "is-today" : ""} ${day ? "" : "is-loading"}`} key={date} onClick={() => openDate(date)} disabled={!day}
                  aria-label={`${date} 星期${weekdayShort(date)}，${day ? `屏幕时间${fmtDuration(day.overview.active_seconds)}，${day.overview.review_has_content ? "有笔记" : "暂无笔记"}，打开日详情` : "正在读取"}`}>
                  <div className="atlas-column-head"><span>星期{weekdayShort(date)}{today ? <small>今天</small> : null}</span><time dateTime={date}>{shortDate(date)}</time><strong>{day ? fmtDuration(day.overview.active_seconds) : "读取中"}</strong></div>
                  <div className="atlas-hour-map" aria-hidden="true">{hours ? hours.map((seconds, hour) => <div className="atlas-hour-row" key={hour}><span style={{ width: `${Math.min(100, Math.max(0, seconds / 36))}%` }} /></div>) : <span className="atlas-hours-unavailable">{day ? "暂无分布数据" : "正在读取"}</span>}</div>
                  <div className="atlas-day-foot">{day ? <><span className={`atlas-day-note ${day.overview.review_has_content ? "has-note" : ""}`}><NoteMark />{day.overview.review_has_content ? "已留笔记" : "尚无笔记"}</span><span className="atlas-open-day">打开这一天 <b aria-hidden="true">↗</b></span>{!day.quality.complete ? <span className="atlas-source-warning">来源不完整</span> : null}</> : <span className="atlas-day-note">等待活动数据</span>}</div>
                </button>;
              })}
            </div>
          </div>
          <footer className="atlas-map-foot"><span>点进一天，展开活动与文字记录。</span><span className="atlas-timezone">{app.timezone}</span></footer>
        </div>
      </section>

      <section hidden={page !== "day"} className="atlas-detail-page" aria-label="完整日详情">
        <button type="button" className="atlas-back" onClick={() => changePage("map", anchor)}><span aria-hidden="true">←</span>返回 {shortDate(mapDates[0])} — {shortDate(anchor)} 的地图</button>
        <header className="atlas-detail-heading"><div><span className="atlas-eyebrow">ONE DAY, CLOSER</span><h1>{app.dateLabel}<small>{app.weekday}</small></h1><p>{app.screenTime} 屏幕时间<span>·</span>{app.sessions.length} 段活动<span>·</span>{blocks.length} 条记录</p></div><button type="button" className="atlas-notes-link" onClick={() => changePage("journal", app.date)}><NoteMark />打开这一天的笔记 <span aria-hidden="true">↗</span></button></header>
        <div className="atlas-detail-layout">
          <div className="atlas-session-story"><div className="atlas-section-label"><span>逐段回看</span><small>ACTIVITY CHAPTERS</small></div>
            {details.length ? details.map(({ session, blocks: sessionBlocks }, index) => <details className="atlas-session-card" key={`${app.date}-${session.start}`} open style={{ "--atlas-category": categoryColor(session.categories[0]?.category ?? "uncategorized") } as CSSProperties}>
              <summary><span className="atlas-session-index">{String(index + 1).padStart(2, "0")}</span><span className="atlas-session-title"><strong>{session.topApps[0]?.app || "屏幕活动"}</strong><small>{fmtClock(session.start, app.timezone)} — {fmtClock(session.end, app.timezone)}</small></span><span className="atlas-session-total">{fmtDuration(session.seconds)}<small>屏幕时间</small></span><span className="atlas-card-chevron" aria-hidden="true">⌄</span></summary>
              <div className="atlas-session-content"><SessionNotes app={app} sessions={[session]} /><div className="atlas-events-label"><span>活动记录</span><small>{sessionBlocks.length} 条 · 点击查看原始事件</small></div><ActivityList app={app} blocks={sessionBlocks} limit={6} /></div>
            </details>) : <div className="atlas-empty-day"><span aria-hidden="true">◌</span><h2>{app.day ? "这一天还没有活动片段。" : "正在走近这一天。"}</h2><p>{app.day ? "仍然可以在笔记里，留下属于这一天的记录。" : "已选择日期，活动与说明即将展开。"}</p></div>}
          </div>
          <aside className="atlas-day-margin" aria-label="当日分类与总结">
            <section className="atlas-category-index"><div className="atlas-section-label"><span>时间去向</span><small>BY CATEGORY</small></div>{app.displayDay?.categories.length ? app.displayDay.categories.map((category) => <div className="atlas-category-row" key={category.category}><div><i style={{ background: categoryColor(category.category) }} /><span>{category.label}</span><strong>{fmtDuration(category.duration_seconds)}</strong></div><span className="atlas-category-track"><i style={{ width: `${Math.min(100, Math.max(0, category.share * 100))}%`, background: categoryColor(category.category) }} /></span></div>) : <p className="atlas-margin-empty">还没有可展示的分类记录。</p>}</section>
            <div className="atlas-day-annotation"><span className="atlas-note-pin" aria-hidden="true" /><JournalEditor app={app} field="personal_summary" title="给这一天的一句话" placeholder="回头看看，为今天写下一句自己的注脚。" /></div>
            <button type="button" className="atlas-margin-link" onClick={() => changePage("journal", app.date)}>打开完整笔记档案 <span aria-hidden="true">↗</span></button>
          </aside>
        </div>
      </section>

      <section hidden={page !== "journal"} className="atlas-journal-page" aria-label="笔记档案">
        <button type="button" className="atlas-back" onClick={() => changePage("map", anchor)}><span aria-hidden="true">←</span>回到七日活动地图</button>
        <header className="atlas-page-heading"><div><span className="atlas-eyebrow">THE NOTE ARCHIVE</span><h1>把时间，留成文字。</h1><p>{app.dateLabel}<span>·</span>常驻、日、周、月记录</p></div><button type="button" className="atlas-notes-link" onClick={() => changePage("day", app.date)}>查看当日活动 <span aria-hidden="true">↗</span></button></header>
        <div className="atlas-journal-desk"><div className="atlas-journal-spine" aria-hidden="true"><span>NOTES / ATLAS</span><b>{parseLocalDate(app.date).getFullYear()}</b></div><div className="atlas-journal-sheet">{app.notes}</div></div>
      </section>
    </div>
  </ConceptFrame>;
}
