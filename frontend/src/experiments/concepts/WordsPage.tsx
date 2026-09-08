import { useMemo, useState } from "react";
import type { ConceptProps } from "./types";
import { DatePicker } from "../../components/DatePicker";
import { WordsHeatmap } from "./WordsHeatmap";
import { WordsWeekTrend } from "./WordsWeekTrend";
import { useWords, wordScope } from "./words";
import "./words.css";

export function WordsPage({ active, app }: { active: boolean; app: ConceptProps }) {
  const state = useWords(active);
  const snapshot = state.data?.snapshot ?? null;
  const [calendarYear, setCalendarYear] = useState<{ year: number; date: string } | null>(null);
  const scope = useMemo(() => wordScope(snapshot), [snapshot]);
  const year = calendarYear?.date === app.date ? calendarYear.year : Number(app.date.slice(0, 4));
  const stale = state.data?.status === "cached" || Boolean(state.error);
  function selectDate(date: string) { setCalendarYear(null); app.selectDate(date); }
  const refresh = <button type="button" className="words-button" onClick={state.reload} disabled={state.loading}
    title={stale ? "Anki 暂未连接，当前显示上次保存的数据。打开 Anki 后点击更新。" : undefined}>{state.loading ? "正在读取…" : "更新单词数据"}</button>;

  return <section className="words-page kw-page" hidden={!active} aria-label="单词" data-status={state.loading ? "loading" : state.data?.status ?? "unavailable"}>
    <header className="words-heading kw-page-heading">
      <h1 className="kw-page-title">单词</h1>
      <div className="words-heading-actions">{snapshot && <DatePicker date={app.date} maxDate={app.currentDate} active={active} label="单词学习日期" onSelect={selectDate}/>} {refresh}</div>
    </header>
    {state.error && <p className="words-error" role="alert">{state.error}</p>}
    {snapshot ? <>
      <WordsWeekTrend days={scope.days} snapshot={snapshot} learned={scope.learned} selected={app.date} active={active} onSelect={selectDate}/>
      <WordsHeatmap key={year} year={year} selected={app.date} today={app.currentDate} days={scope.days} snapshot={snapshot} active={active}
        onYear={year => setCalendarYear({ year, date: app.date })} onSelect={selectDate}/>
    </> : <div className="words-empty" role="status">
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15"/></svg>
      <h2>{state.loading ? "正在读取学习记录" : "连接你的 Anki"}</h2>
      <p>{state.loading ? "正在整理单词学习数据。" : state.data?.error || "打开电脑端 Anki，安装 AnkiConnect 插件后更新数据。"}</p>
      {!state.loading && <a href="https://ankiweb.net/shared/info/2055492159" target="_blank" rel="noreferrer">AnkiConnect 插件 · 2055492159 ↗</a>}
    </div>}
  </section>;
}
