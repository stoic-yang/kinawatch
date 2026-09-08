import { useEffect, useRef, useState } from "react";
import type { ConceptProps } from "./types";
import { DatePicker } from "../../components/DatePicker";
import { healthClock, healthWindow, meanSleep, nightPosition, shiftHealthDate, sleepDuration,
  type PersonalHealthState } from "./personalHealth";
import { HealthTrend } from "./HealthTrend";
import "./health.css";

const numbers = new Intl.NumberFormat("zh-CN");
const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const fullDate = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
const rangeDate = (date: string) => `${date.slice(0, 4)}年${fullDate(date)}`;
function Moon() {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M20.5 13.2A8.7 8.7 0 0 1 10.8 3.5 8.7 8.7 0 1 0 20.5 13.2Z"/></svg>;
}

export function HealthDiarySummary({ state, date }: { state: PersonalHealthState; date: string }) {
  if (!state.snapshot?.available) return null;
  const day = state.snapshot.days.find(item => item.date === date);
  return <dl className="health-diary-summary" aria-label="当日健康摘要">
    <div><dt>睡眠时长</dt><dd>{sleepDuration(day?.sleep?.minutes)}</dd></div>
    <div><dt>步数</dt><dd>{day?.steps ? numbers.format(day.steps.count) : "未记录"}</dd></div>
  </dl>;
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
  const sync = snapshot?.sync;
  const syncMessage = sync?.enabled
    ? sync.state === "error" ? sync.error
      : sync.state === "ready" ? `最近同步 ${new Date(sync.exported_at!).toLocaleString("zh-CN")}`
      : "在 iPhone 运行“KinaWatch 健康同步”，iCloud 文件到达后即可读取。"
    : snapshot?.exported_at ? `导出时间 ${new Date(snapshot.exported_at).toLocaleString("zh-CN")}` : "";
  const visibleError = error || (sync?.enabled && sync.state === "error" ? sync.error : null);
  const importButton = <button type="button" className="health-import" disabled={importing || !snapshot} onClick={() => input.current?.click()}>{importing ? "正在导入…" : "导入完整历史"}</button>;
  return <section className="health-page kw-page" hidden={!active} aria-label="健康">
    <input ref={input} type="file" accept=".zip,application/zip" hidden aria-label="选择 Apple 健康导出文件" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (file) void state.importFile(file);
    }}/>
    <header className="health-heading kw-page-heading">
      <div className="health-title-group"><h1 className="kw-page-title">健康</h1>{snapshot?.available && <p className="health-range-title"><time dateTime={days[0].date}>{rangeDate(days[0].date)}</time><span>—</span><time dateTime={end}>{rangeDate(end)}</time></p>}</div>
      <div className="health-heading-actions">{snapshot?.available && <>
        <div className="kw-segmented-control" role="group" aria-label="健康查看范围">{[7, 30].map(value => <button type="button" key={value} aria-pressed={span === value} onClick={() => setSpan(value)}>近 {value} 天</button>)}</div>
        <div className="health-period-nav" role="group" aria-label="健康周期切换"><button type="button" aria-label="上一个健康周期" onClick={() => goPeriod(-1)}>‹</button><button type="button" aria-label="下一个健康周期" disabled={end >= app.currentDate} onClick={() => goPeriod(1)}>›</button></div>
        <DatePicker date={app.date} maxDate={app.currentDate} active={active} label="健康记录日期" onSelect={date => { setEnd(date); app.selectDate(date); }}/>
      </>}<button type="button" className="health-import" title={syncMessage || undefined} onClick={state.reload} disabled={loading || importing}>{loading ? "正在读取…" : "更新健康数据"}</button></div>
    </header>
    {visibleError && <div className="health-error" role="alert">{visibleError}<button type="button" onClick={state.reload} disabled={importing}>重新读取</button></div>}
    {sync?.enabled && sync.state !== "ready" && sync.state !== "error" && <p className="health-loading" role="status">{syncMessage}</p>}
    {loading && !snapshot && <p className="health-loading" role="status">正在读取健康记录…</p>}
    {importing && <p className="health-loading" role="status">正在整理睡眠和步数，请稍候。</p>}
    {snapshot && !snapshot.available && <div className="health-empty"><Moon/><h2>从一晚睡眠开始</h2><p>导入 Apple 健康的 export.zip，回看睡眠时长、作息时间与每日步数。<br/>文件会在这台电脑上处理。</p>{importButton}<small>iPhone 健康 → 头像 → 导出所有健康数据</small></div>}
    {snapshot?.available && <>
      <article className="health-duration-card health-chart-card kw-card" aria-label="睡眠时长">
        <header className="health-section-heading"><h2>睡眠时长</h2><div className="health-stats">
          <span className="kw-metric-pill"><strong>{sleepDuration(sleep?.minutes)}</strong><small>当日</small></span>
          <span className="kw-metric-pill"><strong>{sleepDuration(average)}</strong><small>近 {span} 天平均</small></span>
          {sleep && <span className="kw-metric-pill"><strong>{healthClock(sleep.start)} — {healthClock(sleep.end)}</strong><small>主要时段</small></span>}
          {sleep && sleep.sessions.length > 1 && <span className="kw-metric-pill"><strong>{sleep.sessions.length - 1} 段 · {sleepDuration(sleep.minutes - sleep.main_minutes)}</strong><small>小睡</small></span>}
        </div></header>
        <HealthTrend visible={active} days={days} selected={app.date} kind="sleep" onSelect={app.selectDate}/>
      </article>
      <div className="health-detail-grid">
        <article className="health-timing-card health-chart-card kw-card" aria-label="作息时间"><header className="health-section-heading"><h2>作息时间</h2>{span > 7 && <span className="health-range-caption">近 7 天</span>}</header><div className="health-clock-axis"><span>18:00</span><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span></div>
          {timingDays.map(day => {
            const item = day.sleep;
            const left = item ? nightPosition(item.start) : 0;
            const width = item ? Math.min(100 - left, (Date.parse(item.end) - Date.parse(item.start)) / 86400000 * 100) : 0;
            return <button type="button" className="health-timing-row" key={day.date} aria-pressed={day.date === app.date} onClick={() => app.selectDate(day.date)} aria-label={`${fullDate(day.date)}，${item ? `${healthClock(item.start)}至${healthClock(item.end)}` : "未记录"}`}><span>{shortDate(day.date)}</span><span className="health-night-track">{item ? <span className="health-night-interval" style={{ left: `${left}%`, width: `${width}%` }}/>: <span className="health-no-night">未记录</span>}</span><small>{item ? `${healthClock(item.start)}–${healthClock(item.end)}` : "—"}</small></button>;
          })}
        </article>
        <article className="health-steps-chart health-chart-card kw-card" aria-label="每日步数"><header className="health-section-heading"><h2>每日步数</h2><div className="health-stats">
          <span className="kw-metric-pill"><strong>{selected?.steps ? numbers.format(selected.steps.count) : "未记录"}</strong><small>当日</small></span>
          <span className="kw-metric-pill"><strong>{stepAverage === null ? "未记录" : numbers.format(stepAverage)}</strong><small>近 {span} 天日均</small></span>
        </div></header><HealthTrend visible={active} days={days} selected={app.date} kind="steps" onSelect={app.selectDate}/></article>
      </div>
      <details className="health-source-details"><summary>数据来源</summary><div className="health-source-content"><span>{syncMessage || "Apple 健康导出"}</span>{importButton}</div></details>
    </>}
  </section>;
}
