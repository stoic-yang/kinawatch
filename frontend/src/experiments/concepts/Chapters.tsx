import { useMemo, useState } from "react";
import type { ScreenTimelineBlock } from "../../api";
import type { ScreenSession } from "../../lib/sessions";
import { fmtClock, fmtDuration } from "../../lib/format";
import { categoryColor } from "../../lib/colors";
import { ConceptFrame, JournalEditor, SessionNotes, ActivityList } from "./shared";
import type { ConceptProps } from "./types";
import "./chapters.css";

const CHAPTER_NAV = [
  { id: "chapters", label: "一天的章节", icon: "flow" },
  { id: "notes", label: "尾声与随记", icon: "note" },
  { id: "rhythm", label: "日子之间", icon: "rhythm" },
];

interface DayChapter {
  session: ScreenSession;
  blocks: ScreenTimelineBlock[];
  title: string;
  period: string;
  description: string;
}

function dayPeriod(iso: string, timezone: string): string {
  const hour = Number(fmtClock(iso, timezone).split(":")[0]);
  if (hour >= 5 && hour < 12) return "上午";
  if (hour >= 12 && hour < 18) return "午后";
  if (hour >= 18 && hour < 23) return "入夜";
  return "深夜";
}

function textExcerpt(value: string, length: number): string {
  const text = value.replace(/^\s*[#>*-]+\s*/gm, "").replace(/\n+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function ChapterTrace({ app, chapter }: { app: ConceptProps; chapter: DayChapter }) {
  const start = new Date(chapter.session.start).getTime();
  const end = new Date(chapter.session.end).getTime();
  const duration = Math.max(end - start, 1);
  return (
    <div className="chapter-trace">
      <svg viewBox="0 0 1000 36" preserveAspectRatio="none" role="group" aria-label="本章屏幕活动，可选择事件查看详情">
        <rect x="0" y="10" width="1000" height="16" rx="3" fill="#e9eedf" />
        {chapter.blocks.map((block, index) => {
          const blockStart = Math.max(start, new Date(block.start).getTime());
          const blockEnd = Math.min(end, new Date(block.end).getTime());
          return <rect key={`${block.start}-${index}`} x={((blockStart - start) / duration) * 1000} y="5" width={Math.max(0.9, ((blockEnd - blockStart) / duration) * 1000)} height="26" rx="1.5" fill={categoryColor(block.category)} role="button" tabIndex={0} aria-label={`${fmtClock(block.start, app.timezone)}，${block.app || block.category_label}，${fmtDuration(block.duration_seconds)}`} onClick={() => app.onInspect(block)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); app.onInspect(block); } }} />;
        })}
      </svg>
      <div><span>{fmtClock(chapter.session.start, app.timezone)}</span><span>{fmtClock(chapter.session.end, app.timezone)}</span></div>
    </div>
  );
}

function ChapterDetail({ app, chapter, index, total, onIndex, onPrevious, onNext, onNotes }: {
  app: ConceptProps;
  chapter: DayChapter;
  index: number;
  total: number;
  onIndex: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onNotes: () => void;
}) {
  const [application, setApplication] = useState("");
  const apps = useMemo(() => {
    const values = new Map<string, { app: string; seconds: number; category: string }>();
    for (const block of chapter.blocks) {
      const name = block.app || "未知应用";
      const current = values.get(name) ?? { app: name, seconds: 0, category: block.category };
      current.seconds += block.duration_seconds;
      values.set(name, current);
    }
    return [...values.values()].sort((a, b) => b.seconds - a.seconds);
  }, [chapter.blocks]);
  const matchingBlocks = application ? chapter.blocks.filter((block) => (block.app || "未知应用") === application) : chapter.blocks;

  return (
    <article className="chapter-detail-page">
      <nav className="chapter-detail-navigation" aria-label="章节导航">
        <button type="button" onClick={onIndex}><span aria-hidden="true">←</span>章节目录</button>
        <span>{String(index + 1).padStart(2, "0")} <span aria-hidden="true">/</span> {String(total).padStart(2, "0")}</span>
        <div><button type="button" aria-label="上一章" disabled={!onPrevious} onClick={onPrevious}>←</button><button type="button" aria-label="下一章" disabled={!onNext} onClick={onNext}>→</button></div>
      </nav>

      <header className="chapter-detail-cover">
        <span className="chapter-detail-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
        <div className="chapter-detail-cover-copy"><p>{app.dateLabel} <span aria-hidden="true">/</span> {chapter.period}</p><h1>{chapter.title}</h1><span>{chapter.session.topApps.map((item) => item.app).join(" · ") || "这一天的一个活动片段"}</span></div>
        <div className="chapter-detail-times"><span>{fmtClock(chapter.session.start, app.timezone)}<span aria-hidden="true">—</span>{fmtClock(chapter.session.end, app.timezone)}</span><small>屏幕活动 {fmtDuration(chapter.session.seconds)}</small></div>
      </header>

      <div className="chapter-detail-body">
        <section className="chapter-description" aria-label="这一章的描述">
          <div className="chapter-small-heading"><span>这一章，发生了什么</span><span>THE STORY</span></div>
          <SessionNotes app={app} sessions={[chapter.session]} />
          <details className="chapter-time-fold"><summary><span>展开本章的时间纹理</span><span aria-hidden="true">＋</span></summary><ChapterTrace app={app} chapter={chapter} /></details>
          <button className="chapter-add-to-day" type="button" onClick={onNotes}><span>还有想写下的？</span>回到当天的随记 <span aria-hidden="true">↗</span></button>
        </section>

        <aside className="chapter-evidence" aria-label="这一章的活动证据">
          <div className="chapter-small-heading"><span>出场的应用</span><span>IN THIS CHAPTER</span></div>
          <div className="chapter-app-cast">
            <button type="button" className={!application ? "is-active" : ""} aria-pressed={!application} onClick={() => setApplication("")}><span className="chapter-cast-all" aria-hidden="true">∷</span><span>全部活动</span><small>{chapter.blocks.length} 条</small></button>
            {apps.map((item) => <button type="button" key={item.app} className={application === item.app ? "is-active" : ""} aria-pressed={application === item.app} onClick={() => setApplication(application === item.app ? "" : item.app)}><i style={{ background: categoryColor(item.category) }} /><span>{item.app}</span><small>{fmtDuration(item.seconds)}</small></button>)}
          </div>
          <div className="chapter-event-heading"><h2>{application || "活动细节"}</h2><span>{matchingBlocks.length} 条</span></div>
          <ActivityList app={app} blocks={matchingBlocks} limit={8} />
        </aside>
      </div>

      <footer className="chapter-detail-footer"><button type="button" onClick={onIndex}>返回目录</button>{onNext ? <button type="button" className="chapter-next-page" onClick={onNext}><span>继续读</span>下一章 <span aria-hidden="true">→</span></button> : <button type="button" className="chapter-next-page" onClick={onNotes}><span>接下来</span>写下尾声 <span aria-hidden="true">→</span></button>}</footer>
    </article>
  );
}

export function Chapters(app: ConceptProps) {
  const [page, setPage] = useState("chapters");
  const [selectedStart, setSelectedStart] = useState<string | null>(null);
  const chapters = useMemo<DayChapter[]>(() => {
    const blocks = app.displayDay?.timeline.filter((block): block is ScreenTimelineBlock => block.kind === "screen") ?? [];
    return app.sessions.map((session) => {
      const start = new Date(session.start).getTime();
      const end = new Date(session.end).getTime();
      const manualNote = app.day?.journal.workflow_notes.find((note) => note.start_time === fmtClock(session.start, app.timezone));
      return { session, blocks: blocks.filter((block) => new Date(block.start).getTime() < end && new Date(block.end).getTime() > start), title: session.categories[0]?.label || session.topApps[0]?.app || "活动片段", period: dayPeriod(session.start, app.timezone), description: manualNote?.note ?? "" };
    });
  }, [app.displayDay, app.sessions, app.day, app.timezone]);
  const selectedIndex = chapters.findIndex((chapter) => chapter.session.start === selectedStart);
  const journalExcerpt = textExcerpt([app.day?.journal.body_markdown, app.day?.journal.freeform_markdown].filter(Boolean).join("\n"), 220);
  const days = useMemo(() => [...app.days].sort((a, b) => b.date.localeCompare(a.date)), [app.days]);
  const weekday = app.weekday.startsWith("星期") ? app.weekday : `星期${app.weekday}`;

  function goTo(id: string) {
    setPage(id);
    const url = new URL(window.location.href);
    url.hash = id;
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function openChapter(start: string) {
    setSelectedStart(start);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function closeChapter() {
    setSelectedStart(null);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  return (
    <ConceptFrame concept="chapters" app={app} nav={CHAPTER_NAV} active={page} onNavigate={(id) => { setPage(id); if (id === "chapters") setSelectedStart(null); }}>
      <div className="chapters-concept">
        <section hidden={page !== "chapters"} aria-label="一天的章节">
          <div className="chapters-index-page" hidden={selectedIndex >= 0}>
            <header className="chapters-page-heading"><div><p>THE CHAPTERS OF A DAY</p><h1>{app.dateLabel}<span>，按章节读。</span></h1><span>{weekday} <span aria-hidden="true">·</span> {app.day ? `${chapters.length} 个活动片段` : "正在翻开这一天"}</span></div><span className="chapters-volume">{app.year}<br />VOL. {String(app.weekNumber).padStart(2, "0")}</span></header>

            <div className="chapters-index-layout">
              <aside className="chapter-preface" aria-label="这一天的开篇">
                <div className="chapter-preface-label"><span>序</span><span>BEFORE THE CHAPTERS</span></div>
                <JournalEditor app={app} field="personal_summary" title="写在前面" placeholder="为这一天留下一句开场。" />
                {journalExcerpt && <div className="chapter-diary-excerpt"><span>日记里的几句话</span><p>{journalExcerpt}</p><button type="button" onClick={() => goTo("notes")}>继续读随记 <span aria-hidden="true">↗</span></button></div>}
                <div className="chapter-preface-foot"><svg width="35" height="35" viewBox="0 0 35 35" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true"><path d="M17 30V5M6 11c8 0 11 5 11 12m12-12c-8 0-12 5-12 12M8 23c4 0 6 3 9 6m10-6c-4 0-7 3-10 6" /></svg><span>每一个片段，都有它的上下文。</span></div>
              </aside>

              <div className="chapter-catalog-wrap">
                <div className="chapter-catalog-heading"><h2>本日目录</h2><span>打开一章，看看里面发生了什么。</span></div>
                {chapters.length ? <ol className="chapter-catalog">{chapters.map((chapter, index) => {
                  const next = chapters[index + 1];
                  const gap = next ? (new Date(next.session.start).getTime() - new Date(chapter.session.end).getTime()) / 1000 : 0;
                  return <li key={chapter.session.start}>
                    <button type="button" className="chapter-open" onClick={() => openChapter(chapter.session.start)} aria-label={`打开第 ${index + 1} 章：${chapter.title}，${fmtClock(chapter.session.start, app.timezone)} 至 ${fmtClock(chapter.session.end, app.timezone)}`}>
                      <span className="chapter-catalog-number">{String(index + 1).padStart(2, "0")}</span>
                      <span className="chapter-catalog-copy"><span className="chapter-catalog-period">{chapter.period}<span aria-hidden="true">·</span>{fmtClock(chapter.session.start, app.timezone)} — {fmtClock(chapter.session.end, app.timezone)}</span><strong>{chapter.title}</strong><span className="chapter-catalog-excerpt">{chapter.description ? textExcerpt(chapter.description, 110) : chapter.session.topApps.map((item) => item.app).join(" · ") || "打开这一章，补充活动描述。"}</span></span>
                      <span className="chapter-catalog-edge"><span>{fmtDuration(chapter.session.seconds)}</span><span className="chapter-open-arrow" aria-hidden="true">↗</span></span>
                    </button>
                    {next && gap > 0 && <div className="chapter-between"><span aria-hidden="true" /><span>相隔 {fmtDuration(gap)}</span><span aria-hidden="true" /></div>}
                  </li>;
                })}</ol> : <div className="chapter-empty"><span aria-hidden="true">01</span><h2>这一天还没有活动章节。</h2><p>文字可以先留下来。</p><button type="button" onClick={() => goTo("notes")}>写一段随记 <span aria-hidden="true">↗</span></button></div>}
                <button type="button" className="chapter-epilogue-link" onClick={() => goTo("notes")}><span className="chapter-epilogue-glyph" aria-hidden="true">尾</span><span>故事之后，留一点自己的话。<small>随记、产出与明天的计划</small></span><span aria-hidden="true">→</span></button>
                <p className="chapter-grouping-note">活动间隔超过 15 分钟时，开启下一章。</p>
              </div>
            </div>
          </div>

          {chapters.map((chapter, index) => <div key={`${app.date}-${chapter.session.start}`} hidden={selectedIndex !== index}><ChapterDetail app={app} chapter={chapter} index={index} total={chapters.length} onIndex={closeChapter} onPrevious={index > 0 ? () => openChapter(chapters[index - 1].session.start) : undefined} onNext={index < chapters.length - 1 ? () => openChapter(chapters[index + 1].session.start) : undefined} onNotes={() => goTo("notes")} /></div>)}
        </section>

        <section className="chapters-notes-page" hidden={page !== "notes"} aria-label="尾声与随记">
          <header className="chapters-page-heading"><div><p>AFTER THE CHAPTERS</p><h1>写下尾声。</h1><span>{app.dateLabel} <span aria-hidden="true">·</span> 故事也由你来讲。</span></div><button type="button" className="chapter-plain-button" onClick={() => { closeChapter(); goTo("chapters"); }}>返回目录 <span aria-hidden="true">↗</span></button></header>
          <div className="chapters-notes-paper"><div className="chapter-notes-main"><JournalEditor app={app} field="freeform" title="这一天的随记" placeholder="活动记录之外，今天还有哪些值得留下的事？" /></div><div className="chapter-notes-margins"><JournalEditor app={app} field="outputs" title="这一篇留下了什么" placeholder="今天完成了哪些具体产出？" /><JournalEditor app={app} field="next_action" title="下一篇，从这里开始" placeholder="明天，你想接着推进什么？" /></div></div>
          <details className="chapters-long-notes"><summary>常驻笔记与周期复盘 <span aria-hidden="true">＋</span></summary>{app.notes}</details>
        </section>

        <section className="chapters-rhythm-page" hidden={page !== "rhythm"} aria-label="日子之间">
          <header className="chapters-page-heading"><div><p>THE DAYS BETWEEN</p><h1>日子之间。</h1><span>选一天，重新翻开它的章节。</span></div></header>
          <ol className="chapters-day-books">{days.map((day) => {
            const category = [...day.categories].sort((a, b) => b.duration_seconds - a.duration_seconds)[0];
            return <li key={day.date}><button type="button" className={day.date === app.date ? "is-selected" : ""} aria-current={day.date === app.date ? "date" : undefined} onClick={() => { app.selectDate(day.date); setSelectedStart(null); goTo("chapters"); }}><span className="chapter-day-book-date"><span>{Number(day.date.slice(5, 7))}月</span><strong>{day.date.slice(8)}</strong></span><span className="chapter-day-book-copy"><span>{day.date === app.date ? "正在阅读的这一天" : "翻开这一天"}</span><strong>{fmtDuration(day.overview.active_seconds)}<span>屏幕活动</span></strong>{category && <small><i style={{ background: categoryColor(category.category) }} />主要分类 · {category.label}</small>}</span><span className="chapter-day-book-arrow" aria-hidden="true">↗</span></button></li>;
          })}</ol>
          {!days.length && <p className="chapter-rhythm-empty">还没有可以翻阅的日期。</p>}
          <details className="chapters-rhythm-detail"><summary>展开更长时间的节律 <span aria-hidden="true">＋</span></summary>{app.rhythm}</details>
        </section>
      </div>
    </ConceptFrame>
  );
}
