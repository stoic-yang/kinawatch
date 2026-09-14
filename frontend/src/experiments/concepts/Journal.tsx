import { cloneElement, isValidElement, lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { DatePicker } from "../../components/DatePicker";
import { fmtClock } from "../../lib/format";
import { ConceptFrame, SessionNotes } from "./shared";
import type { ConceptProps } from "./types";
import { MarkdownDocumentEditor, type MarkdownDocumentEditorHandle } from "./MarkdownDocumentEditor";
import { journalDocumentSession } from "./journalDocumentStore";
import { extractJournalHeadings, type JournalHeading } from "./journalOutline";
import { JournalTimeline } from "./JournalTimeline";
import { presentJournal, updateJournalPresentation, type JournalPresentation } from "./journalPresentation";
import { HealthDiarySummary, HealthPage } from "./HealthPage";
import { usePersonalHealth } from "./personalHealth";
import { WordsPage } from "./WordsPage";
import { TimetablePage, TimetablePeek } from "./TimetablePage";
import { useTimetable } from "./useTimetable";
import "./journal.css";

const JOURNAL_NAV = [
  { id: "journal", label: "日记", icon: "note" },
  { id: "timetable", label: "课表", icon: "calendar" },
  { id: "reference", label: "时间线", icon: "timeline" },
  { id: "weekly-rhythm", label: "节律", icon: "rhythm" },
  { id: "health", label: "健康", icon: "health" },
  { id: "words", label: "单词", icon: "words" },
  { id: "beliefs", label: "信念", icon: "beliefs" },
  { id: "servers", label: "服务器", icon: "server" },
];
const BeliefsPage = lazy(() => import("./BeliefsPage").then(module => ({default: module.BeliefsPage})));
const ServersPage = lazy(() => import("./ServersPage").then(module => ({default: module.ServersPage})));

export function Journal(app: ConceptProps) {
  const [page, setPage] = useState("journal");
  const [beliefsOpened, setBeliefsOpened] = useState(false);
  useEffect(() => {if (page === "beliefs") setBeliefsOpened(true);}, [page]);
  const health = usePersonalHealth(page === "health" || page === "journal");
  const timetable = useTimetable(page === "timetable" || page === "journal");
  const session = useMemo(() => journalDocumentSession(app.date), [app.date]);
  const documentState = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const editor = useRef<MarkdownDocumentEditorHandle>(null);
  const presented = useRef<{ date: string; view: JournalPresentation } | null>(null);
  if (!presented.current || presented.current.date !== app.date || presented.current.view.source !== documentState.text) {
    presented.current = { date: app.date, view: presentJournal(documentState.text) };
  }
  const presentation = presented.current.view;
  const headings = useMemo(() => extractJournalHeadings(presentation.markdown), [presentation.markdown]);
  const refreshedRevision = useRef({date: app.date, revision: documentState.savedRevision});
  const onSaved = useRef(app.onDaySaved);
  onSaved.current = app.onDaySaved;

  useEffect(() => {
    void session.load();
    const refresh = () => { if (page === "journal") { if (session.dirty) void session.flush(); else void session.load(); } };
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); void session.flush(); };
  }, [session, page]);
  useEffect(() => {
    if (refreshedRevision.current.date !== app.date) {
      refreshedRevision.current = {date: app.date, revision: documentState.savedRevision};
    } else if (refreshedRevision.current.revision !== documentState.savedRevision) {
      refreshedRevision.current.revision = documentState.savedRevision;
      void onSaved.current().catch(() => { /* The saved document already has its acknowledged version. */ });
    }
  }, [app.date, documentState.savedRevision]);
  const headingBase = Math.min(...headings.map(heading => heading.level), 6);
  const weekday = app.weekday.startsWith("星期") ? app.weekday : `星期${app.weekday}`;

  function jumpToHeading(heading: JournalHeading) {
    editor.current?.focusHeading(heading.start);
  }

  return (
    <ConceptFrame concept="journal" app={app} nav={JOURNAL_NAV} active={page} onNavigate={setPage} timelinePageId="reference">{timeline => (
      <div className="journal-concept">
        {(beliefsOpened || page === "beliefs") && <Suspense fallback={page === "beliefs" ? <p role="status">正在读取信念…</p> : null}><BeliefsPage active={page === "beliefs"}/></Suspense>}
        <HealthPage active={page === "health"} app={app} state={health}/>
        <WordsPage active={page === "words"} app={app}/>
        <TimetablePage active={page === "timetable"} state={timetable}/>
        {page === "servers" && <Suspense fallback={<p role="status">正在读取服务器…</p>}><ServersPage active/></Suspense>}
        <section className="journal-writing-page" hidden={page !== "journal"} aria-label="日记">
          <div className="journal-writing-layout">
            <aside className="journal-context kw-card" aria-label="日记参考与大纲"><div className="journal-context-content">
              <div className="journal-activity-panel">
                <JournalTimeline day={app.day} displayDay={app.displayDay} timezone={app.timezone} visible={page === "journal"} />
                <div className="journal-activity-status">{app.status}</div>
              </div>
              {app.warnings}
              {headings.length > 0 && <nav className="journal-outline" aria-label="日记标题大纲">
                <h2>大纲</h2>
                {headings.map(heading => <button type="button" key={heading.id} data-level={heading.level} title={heading.title} style={{paddingLeft: `${8 + (heading.level - headingBase) * 12}px`}} onClick={() => jumpToHeading(heading)}>
                  <span>{heading.title}</span>
                </button>)}
              </nav>}
            </div></aside>

            <article className="journal-manuscript kw-card" id="journal-body" data-dirty={session.dirty} data-save-state={documentState.status}>
              <header className="journal-paper-header">
                <div><h1 className="kw-document-title"><time dateTime={app.date}>{app.year}年{app.dateLabel}</time></h1><span>{weekday} · 第 {app.weekNumber} 周</span></div>
              </header>
              <div className="journal-entry" onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void session.flush();
              }}>
                {documentState.document && <MarkdownDocumentEditor key={app.date} ref={editor} value={presentation.markdown} onChange={(_value, edits) => {
                  const next = updateJournalPresentation(presented.current!.view, edits);
                  presented.current = { date: app.date, view: next };
                  session.change(next.source);
                }} readOnly={!documentState.document.write_enabled} ariaLabel="日记正文" />}
                {documentState.error && <div className="journal-document-error" role="alert">
                  <p>{documentState.error}</p>
                  {documentState.status === "conflict"
                    ? <button type="button" onClick={() => void session.inspectConflict()}>核对文件版本</button>
                    : <button type="button" onClick={() => void session.retry()}>重试同步</button>}
                </div>}
                {documentState.remote && <section className="journal-document-conflict" aria-label="文件版本对照">
                  <h2>文件中的版本</h2>
                  <MarkdownDocumentEditor value={documentState.remote.markdown} onChange={() => {}} readOnly ariaLabel="文件中的版本" />
                  <div><button type="button" onClick={() => session.resolveConflict("remote")}>采用文件版本</button><button type="button" onClick={() => session.resolveConflict("draft")}>保存我的版本</button></div>
                </section>}
              </div>
            </article>

            <aside className="journal-day-sidebar grove-calendar kw-card" aria-label="当日日历与活动">
              <div className="journal-day-sidebar-content">
                <TimetablePeek state={timetable}/>
                {isValidElement<{ independentSections?: boolean; healthSummary?: ReactNode }>(app.calendar)
                  ? cloneElement(app.calendar, { independentSections: true, healthSummary: health.snapshot?.available ? <HealthDiarySummary state={health} date={app.date}/> : undefined })
                  : app.calendar}
              </div>
            </aside>
          </div>
        </section>

        <section className="journal-reference-page kw-page" hidden={page !== "reference"} aria-label="时间线">
          <header className="journal-reference-heading kw-page-heading">
            <div className="journal-reference-title"><h1 className="kw-page-title"><time dateTime={app.date}>{app.dateLabel}</time></h1><span>{app.year}年 · 第 {app.weekNumber} 周 · {weekday}</span></div>
            <DatePicker date={app.date} maxDate={app.currentDate} active={page === "reference"} label="时间线日期" onSelect={app.selectDate}/>
          </header>
          {timeline}
          <div className="journal-reference-desk kw-card">
            <header className="journal-reference-context">
              <h2>工作流</h2><span>{app.day ? `${app.sessions.length} 个时段` : "正在载入"}</span>
            </header>
            <div className="journal-workflow" aria-label="按时间排列的工作流">
              {app.sessions.length ? app.sessions.map((session, index) => (
                <section className="journal-workflow-segment" id={`journal-session-${index}`} key={`${app.date}-${session.start}`} aria-label={`${fmtClock(session.start, app.timezone)} 至 ${fmtClock(session.end, app.timezone)} 的活动`}>
                  <SessionNotes app={app} sessions={[session]} descriptionLayout="aside" />
                </section>
              )) : app.day && app.day.workflows.sessions.length === 0 ? <p className="empty-hint">暂无满 15 分钟的工作流。</p> : app.day?.timeline.some((block) => block.kind === "screen") ? <p className="empty-hint">当前筛选下没有活动，可以在日记右侧恢复分类。</p> : app.day ? <SessionNotes app={app} sessions={[]} /> : null}
            </div>
          </div>

        </section>

      </div>
    )}
    </ConceptFrame>
  );
}
