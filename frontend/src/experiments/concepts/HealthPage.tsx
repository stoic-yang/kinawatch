import { useEffect, useRef, useState } from "react";
import type { ConceptProps } from "./types";
import { DatePicker } from "../../components/DatePicker";
import { healthClock, healthWindow, meanSleep, nightPosition, shiftHealthDate, sleepDuration,
  type HealthDay, type PersonalHealthState } from "./personalHealth";
import "./health.css";

const numbers = new Intl.NumberFormat("zh-CN");
const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const fullDate = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
function Moon() {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M20.5 13.2A8.7 8.7 0 0 1 10.8 3.5 8.7 8.7 0 1 0 20.5 13.2Z"/></svg>;
}

function DayBars({ days, selected, kind, onSelect }: {
  days: HealthDay[]; selected: string; kind: "sleep" | "steps"; onSelect: (date: string) => void;
}) {
  const values = days.map(day => kind === "sleep" ? day.sleep?.minutes ?? null : day.steps?.count ?? null);
  const maximum = Math.max(kind === "sleep" ? 600 : 5000, ...values.filter((v): v is number => v !== null));
  return <div className={`health-bars health-bars-${kind}`} data-density={days.length > 7 ? "month" : "week"}>
    <span className="health-chart-ceiling">{kind === "sleep" ? `${Math.ceil(maximum / 60)} 小时` : `${numbers.format(maximum)} 步`}</span>
    <div className="health-bars-grid" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
      {days.map((day, index) => {
        const value = values[index];
        const description = kind === "sleep" ? sleepDuration(value) : value === null ? "未记录" : `${numbers.format(value)} 步`;
        return <button type="button" key={day.date} className="health-bar-column" aria-pressed={selected === day.date}
          aria-label={`${fullDate(day.date)}，${kind === "sleep" ? "睡眠时长" : "步数"}，${description}`}
          onClick={() => onSelect(day.date)}>
          <span className="health-bar-space"><span className="health-bar-value" aria-hidden="true">{value === null ? "—" : kind === "sleep" ? `${(value / 60).toFixed(1)}h` : numbers.format(value)}</span>
            {value === null ? <span className="health-bar-missing"/> : <span className="health-bar-fill" style={{ height: `${Math.max(1, value / maximum * 100)}%` }}/>}</span>
          <span className="health-bar-date">{days.length <= 7 || index % 5 === 0 || index === days.length - 1 ? shortDate(day.date) : ""}</span>
        </button>;
      })}
    </div>
  </div>;
}

export function HealthDiarySummary({ state, date }: { state: PersonalHealthState; date: string }) {
  if (!state.snapshot?.available) return null;
  const day = state.snapshot.days.find(item => item.date === date);
  return <section className="health-diary-summary" aria-label="当日健康摘要">
    <h2 className="health-diary-heading">健康</h2>
    <div><span>睡眠时长</span><strong>{sleepDuration(day?.sleep?.minutes)}</strong></div>
    <div><span>步数</span><strong>{day?.steps ? numbers.format(day.steps.count) : "未记录"}</strong></div>
  </section>;
}

export function HealthPage({ active, app, state }: { active: boolean; app: ConceptProps; state: PersonalHealthState }) {
  const [span, setSpan] = useState(7);
  const [end, setEnd] = useState(app.date);
  const input = useRef<HTMLInputElement>(null);
  const { snapshot, loading, error, importing } = state;
  useEffect(() => {
    if (app.date > end || app.date < shiftHealthDate(end, 1 - span)) setEnd(app.date);
  }, [app.date, end, span]);
  const days = healthWindow(snapshot, end, span);
  const selected = snapshot?.days.find(day => day.date === app.date);
  const sleep = selected?.sleep;
  const average = meanSleep(days);
  const rangeEnd = snapshot?.exported_at?.slice(0, 10);
  // A partially observed export day is excluded from the steps daily mean.
  const stepDays = days.filter(day => day.steps !== null && day.date !== rangeEnd);
  const stepAverage = stepDays.length ? Math.round(stepDays.reduce((sum, day) => sum + day.steps!.count, 0) / stepDays.length) : null;
  const timingDays = days.slice(-7);
  function goPeriod(direction: number) {
    const next = [shiftHealthDate(end, direction * span), app.currentDate].sort()[0];
    setEnd(next); app.selectDate(next);
  }
  const importButton = <button type="button" className="health-import" disabled={importing || !snapshot} onClick={() => input.current?.click()}>{importing ? "正在导入…" : snapshot?.available ? "更新健康数据" : "导入健康数据"}</button>;
  return <section className="health-page" hidden={!active} aria-label="健康">
    <input ref={input} type="file" accept=".zip,application/zip" hidden aria-label="选择 Apple 健康导出文件" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (file) void state.importFile(file);
    }}/>
    <header className="health-heading">
      <div className="health-title-group"><h1>健康</h1>{snapshot?.available && <div className="kw-segmented-control" aria-label="健康查看范围">{[7, 30].map(value => <button type="button" key={value} aria-pressed={span === value} className={span === value ? "is-active" : ""} onClick={() => setSpan(value)}>近 {value} 天</button>)}</div>}</div>
      <div className="health-heading-actions">{snapshot?.available && <>
        <div className="health-period-nav"><button type="button" aria-label="上一个健康周期" onClick={() => goPeriod(-1)}>‹</button><span>{shortDate(days[0].date)} — {shortDate(end)}</span><button type="button" aria-label="下一个健康周期" disabled={end >= app.currentDate} onClick={() => goPeriod(1)}>›</button></div>
        <DatePicker date={app.date} maxDate={app.currentDate} active={active} label="健康记录日期" onSelect={date => { setEnd(date); app.selectDate(date); }}/>
      </>}{importButton}</div>
    </header>
    {error && <div className="health-error" role="alert">{error}<button type="button" onClick={state.reload} disabled={importing}>重新读取</button></div>}
    {loading && !snapshot && <p className="health-loading" role="status">正在读取健康记录…</p>}
    {importing && <p className="health-loading" role="status">正在整理睡眠和步数，请稍候。</p>}
    {snapshot && !snapshot.available && <div className="health-empty"><Moon/><h2>从一晚睡眠开始</h2><p>导入 Apple 健康的 export.zip，回看睡眠时长、作息时间与每日步数。<br/>文件会在这台电脑上处理。</p>{importButton}<small>iPhone 健康 → 头像 → 导出所有健康数据</small></div>}
    {snapshot?.available && <>
      <div className="health-overview">
        <article className="health-sleep-card"><div className="health-card-kicker"><span><Moon/>睡眠时长</span></div>
          <div className="health-metric-content">
            <strong className={`health-big-number ${!sleep ? "is-missing" : ""}`}>{sleepDuration(sleep?.minutes)}</strong>
            <p className="health-period-average">近 {span} 天平均 <b>{sleepDuration(average)}</b></p>
            {sleep && <p>主要时段 {healthClock(sleep.start)} — {healthClock(sleep.end)}</p>}
            {sleep && sleep.sessions.length > 1 && <p>另含 {sleep.sessions.length - 1} 段小睡 · {sleepDuration(sleep.minutes - sleep.main_minutes)}</p>}
          </div>
        </article>
        <article className="health-steps-card"><div className="health-card-kicker"><span>步数</span></div>
          <div className="health-metric-content">
            <strong className={`health-big-number ${!selected?.steps ? "is-missing" : ""}`}>{selected?.steps ? numbers.format(selected.steps.count) : "未记录"}</strong>
            <p className="health-period-average">近 {span} 天日均 <b>{stepAverage === null ? "未记录" : `${numbers.format(stepAverage)} 步`}</b></p>
          </div>
        </article>
      </div>
      <article className="health-duration-card"><header className="health-section-heading"><h2>睡眠时长</h2></header><DayBars days={days} selected={app.date} kind="sleep" onSelect={app.selectDate}/></article>
      <div className="health-detail-grid">
        <article className="health-timing-card"><header className="health-section-heading"><div><h2>作息时间</h2><p>最近 7 天的主要睡眠时段</p></div></header><div className="health-clock-axis"><span>18:00</span><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span></div>
          {timingDays.map(day => {
            const item = day.sleep;
            const left = item ? nightPosition(item.start) : 0;
            const width = item ? Math.min(100 - left, (Date.parse(item.end) - Date.parse(item.start)) / 86400000 * 100) : 0;
            return <button type="button" className="health-timing-row" key={day.date} aria-pressed={day.date === app.date} onClick={() => app.selectDate(day.date)} aria-label={`${fullDate(day.date)}，${item ? `${healthClock(item.start)}至${healthClock(item.end)}` : "未记录"}`}><span>{shortDate(day.date)}</span><span className="health-night-track">{item ? <span className="health-night-interval" style={{ left: `${left}%`, width: `${width}%` }}/>: <span className="health-no-night">未记录</span>}</span><small>{item ? `${healthClock(item.start)}–${healthClock(item.end)}` : "—"}</small></button>;
          })}
        </article>
        <article className="health-steps-chart"><header className="health-section-heading"><h2>每日步数</h2></header><DayBars days={days} selected={app.date} kind="steps" onSelect={app.selectDate}/></article>
      </div>
    </>}
  </section>;
}
