import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, ArrowUpRight } from "lucide-react";
import { lessonState, lessonsForDay, nextLesson, schoolClock, shortDate, teachingWeek, weekDays, WEEKDAYS, type Lesson } from "./timetable";
import type { TimetableState } from "./useTimetable";
import "./timetable.css";

function LessonText({ lesson, detail = false }: { lesson: Lesson; detail?: boolean }) {
  return <><strong>{lesson.course.name}</strong><span>{lesson.course.room}</span>{detail && <small>{lesson.course.teacher} · {lesson.course.weeks_label}</small>}</>;
}

export function TimetablePeek({ state }: { state: TimetableState }) {
  const { table, now, error } = state;
  const next = useMemo(() => table ? nextLesson(table, now) : null, [table, now]);
  if (!table) return null;
  const clock = schoolClock(now, table.timezone);
  return <div className="timetable-peek">
    <a href="#timetable" aria-label="查看完整课表"><span>{next && lessonState(next, clock) === "进行中" ? "进行中的课" : "下一节课"}</span><ArrowUpRight size={14}/></a>
    {next ? <a className="timetable-peek-lesson" href="#timetable">
      <small>{next.date === clock.date ? "今天" : shortDate(next.date)} · {next.slot.start}–{next.slot.end}</small>
      <LessonText lesson={next}/>
    </a> : <p>本学期课程已结束</p>}
    {error && <small role="status">显示上次读取的课表</small>}
  </div>;
}

export function TimetablePage({ active, state }: { active: boolean; state: TimetableState }) {
  const { table, now, error, loading, reload } = state;
  const clock = schoolClock(now, table?.timezone ?? "Asia/Shanghai");
  const currentWeek = table ? teachingWeek(table, clock.date) : 1;
  const defaultWeek = table ? Math.max(1, Math.min(table.weeks, currentWeek)) : 1;
  const [selection, setSelection] = useState<{ term: string; week: number } | null>(null);
  const termKey = table ? `${table.term}:${table.week1_monday}:${table.weeks}` : "";
  const week = selection?.term === termKey ? selection.week : defaultWeek;
  const next = useMemo(() => table ? nextLesson(table, now) : null, [table, now]);
  const today = table ? lessonsForDay(table, clock.date) : [];
  const days = table ? weekDays(table, week) : [];
  const setWeek = (value: number) => setSelection({ term: termKey, week: value });
  const todayException = table?.exceptions.find(entry => entry.date === clock.date);
  return <section className="timetable-page kw-page" hidden={!active} aria-label="课表">
    <header className="kw-page-heading">
      <div><h1 className="kw-page-title">课表</h1>{table && <p className="timetable-subtitle">{table.school} · {table.term}</p>}</div>
      {table && <div className="timetable-navigation" aria-label="教学周导航">
        <button type="button" aria-label="上一教学周" disabled={week <= 1} onClick={() => setWeek(week - 1)}><ChevronLeft size={16}/></button>
        <select aria-label="教学周" value={week} onChange={event => setWeek(Number(event.target.value))}>
          {Array.from({ length: table.weeks }, (_, index) => <option key={index + 1} value={index + 1}>第 {index + 1} 周{index + 1 === currentWeek ? " · 本周" : ""}</option>)}
        </select>
        <button type="button" aria-label="下一教学周" disabled={week >= table.weeks} onClick={() => setWeek(week + 1)}><ChevronRight size={16}/></button>
        <button type="button" className="timetable-home" onClick={() => setSelection(null)}>{currentWeek < 1 ? "开学周" : currentWeek > table.weeks ? "最后一周" : "本周"}</button>
      </div>}
    </header>
    {error && <p className="timetable-error" role="alert">{error} {table && "当前显示上次读取的课表。"}<button type="button" onClick={reload} disabled={loading}>重试</button></p>}
    {!table ? <div className="timetable-empty" role="status"><CalendarDays size={32}/><h2>{loading ? "正在读取课表…" : error ? "课表暂时不可用" : "还没有课表"}</h2>{!loading && !error && <p>导入学期课表后，可在这里查看课程时间和教室。</p>}</div> : <>
      <div className="timetable-overview">
        <section className="timetable-next" aria-label="下一节课">
          <h2>{next && lessonState(next, clock) === "进行中" ? "进行中" : "下一节课"}</h2>
          {next ? <><p className="timetable-next-time">{next.slot.start}<span>–{next.slot.end}</span></p>
            <p className="timetable-next-name">{next.course.name}</p>
            <p className="timetable-next-meta">{next.date === clock.date ? "今天" : shortDate(next.date)} · {WEEKDAYS[(new Date(`${next.date}T00:00:00Z`).getUTCDay() + 6) % 7]} · {next.course.room}</p>
          </> : <p className="timetable-no-class">本学期课程已结束</p>}
        </section>
        <section className="timetable-today" aria-label="今日课程">
          <header><h2>今天</h2><span>{shortDate(clock.date)}{currentWeek >= 1 && currentWeek <= table.weeks ? ` · 第 ${currentWeek} 周` : ""}</span></header>
          {todayException && <p className="timetable-day-note">{todayException.label}</p>}
          {today.length ? <ul>{today.map(lesson => <li key={lesson.course.id} data-state={lessonState(lesson, clock)}>
            <time>{lesson.slot.start}–{lesson.slot.end}</time><span><strong>{lesson.course.name}</strong><small>{lesson.course.room}</small></span><em>{lessonState(lesson, clock)}</em>
          </li>)}</ul> : <p className="timetable-no-class">{currentWeek < 1 ? `${shortDate(table.week1_monday)}开学，先看看第一周的课程。` : currentWeek > table.weeks ? "本学期课程已结束。" : todayException?.follows === null ? "今天放假，没有课程。" : "今天没有课。"}</p>}
        </section>
      </div>
      <div className="timetable-week-heading"><h2>第 {week} 周</h2><span>{shortDate(days[0].date)} – {shortDate(days[6].date)}</span></div>
      <div className="timetable-grid-scroll" role="region" aria-label="一周课表，可横向滚动" tabIndex={0}>
        <table className="timetable-grid">
          <caption className="timetable-sr-only">{table.term}，第 {week} 教学周</caption>
          <thead><tr><th scope="col">节次</th>{days.map((day, index) => <th scope="col" key={day.date} data-today={day.date === clock.date}><span>{WEEKDAYS[index]}</span><time dateTime={day.date}>{Number(day.date.slice(5, 7))}/{Number(day.date.slice(8))}</time>{day.exception && <small title={day.exception.label}>{day.exception.follows ? "补课" : "放假"}</small>}</th>)}</tr></thead>
          <tbody>{table.slots.map(slot => <tr key={slot.id}><th scope="row"><strong>{slot.label}</strong><span>{slot.start}<br/>{slot.end}</span></th>{days.map(day => {
            const lessons = day.lessons.filter(item => item.slot.id === slot.id);
            return <td key={day.date} data-today={day.date === clock.date}>
              {lessons.map(lesson => <article key={lesson.course.id} className="timetable-lesson" data-current={lessonState(lesson, clock) === "进行中"}>
                <LessonText lesson={lesson} detail/>{day.exception?.follows && <small>{day.exception.label}</small>}
                {lessons.length > 1 && <em>时间重叠</em>}
              </article>)}
            </td>;
          })}</tr>)}</tbody>
        </table>
      </div>
      <details className="timetable-sources"><summary>课表与校历说明</summary><p>按导入课表的教学周、单双周和教室显示。教学第 1 周从 {table.week1_monday} 开始，时间使用 {table.timezone}。临时调课需更新课表数据。</p>
        {table.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}<ArrowUpRight size={12}/></a>)}
        {table.exceptions.filter(entry => entry.follows).map(entry => <p key={entry.date}>{shortDate(entry.date)}：{entry.label}</p>)}
      </details>
    </>}
  </section>;
}
