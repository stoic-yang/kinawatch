import { useMemo, useState } from "react";
import type { ConceptProps } from "./types";
import { DatePicker } from "../../components/DatePicker";
import { WordsHeatmap } from "./WordsHeatmap";
import { answerTime, useWords, wordDay, wordScope } from "./words";
import "./words.css";

const numbers = new Intl.NumberFormat("zh-CN");
const fullDate = (date: string) => `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

export function WordsPage({ active, app }: { active: boolean; app: ConceptProps }) {
  const state = useWords(active);
  const snapshot = state.data?.snapshot ?? null;
  const [calendarYear, setCalendarYear] = useState<{ year: number; date: string } | null>(null);
  const scope = useMemo(() => wordScope(snapshot), [snapshot]);
  const day = wordDay(scope.days, app.date, snapshot);
  const year = calendarYear?.date === app.date ? calendarYear.year : Number(app.date.slice(0, 4));
  const stale = state.data?.status === "cached" || Boolean(state.error);
  function selectDate(date: string) { setCalendarYear(null); app.selectDate(date); }
  const refresh = <button type="button" className="words-button" onClick={state.reload} disabled={state.loading}
    title={stale ? "Anki 暂未连接，当前显示上次保存的数据。打开 Anki 后点击更新。" : undefined}>{state.loading ? "正在读取…" : "更新单词数据"}</button>;

  return <section className="words-page kw-page" hidden={!active} aria-label="单词" data-status={state.loading ? "loading" : state.data?.status ?? "unavailable"}>
    <header className="words-heading kw-page-heading">
      <div><h1 className="kw-page-title">单词</h1>{snapshot && <span>{numbers.format(scope.total)} 个词条</span>}</div>
      <div className="words-heading-actions">{snapshot && <DatePicker date={app.date} maxDate={app.currentDate} active={active} label="单词学习日期" onSelect={selectDate}/>} {refresh}</div>
    </header>
    {state.error && <p className="words-error" role="alert">{state.error}</p>}
    {snapshot ? <>
      <section className="words-study-summary" aria-label="当日单词学习统计">
        <header><h2>{app.date === app.currentDate ? "今天" : fullDate(app.date)}的学习</h2><span>{day && day.answers === 0 ? "本机暂无作答记录" : ""}</span></header>
        <dl className="words-metrics">
          <div><dt>新学词条</dt><dd>{day ? numbers.format(day.new_entries) : "—"}</dd></div>
          <div><dt>学习词条</dt><dd>{day ? numbers.format(day.entries) : "—"}</dd></div>
          <div><dt>作答次数</dt><dd>{day ? numbers.format(day.answers) : "—"}</dd></div>
          <div><dt>作答耗时</dt><dd className="words-time-number">{day ? answerTime(day.answer_ms) : "—"}</dd></div>
        </dl>
        <div className="words-progress">
          <div><span>词库进度</span><span>已学 {numbers.format(scope.learned)} / {numbers.format(scope.total)}</span></div>
          <div className="words-progress-track" role="meter" aria-label="已有学习记录的词条" aria-valuemin={0} aria-valuemax={Math.max(1, scope.total)} aria-valuenow={scope.learned}>
            <span style={{ width: `${scope.total ? scope.learned / scope.total * 100 : 0}%` }}/>
          </div>
        </div>
      </section>
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
