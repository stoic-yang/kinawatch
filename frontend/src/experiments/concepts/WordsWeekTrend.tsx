import { useEffect, useState } from "react";
import { DailyTrend } from "../../components/DailyTrend";
import { answerTime, wordDay, wordWeek, type WordDay, type WordsSnapshot } from "./words";

const numbers = new Intl.NumberFormat("zh-CN");
const count = (value: number) => numbers.format(value);
const entries = (value: number) => `${numbers.format(value)} 个词条`;
const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export function WordsWeekTrend({ days, snapshot, learned, selected, active, onSelect }: {
  days: Map<string, WordDay>; snapshot: WordsSnapshot; learned: number; selected: string; active: boolean; onSelect: (date: string) => void;
}) {
  const [end, setEnd] = useState(selected);
  const week = wordWeek(days, end, snapshot);
  const day = wordDay(days, selected, snapshot);
  const start = week[0].date;
  useEffect(() => {
    if (selected < start || selected > end) setEnd(selected);
  }, [selected, start, end]);

  return <section className="words-weekly" aria-label="每周学习词条">
    <header>
      <h2>每周学习词条</h2>
      <div className="words-study-totals" role="group" aria-label={`${selected} 当日单词学习统计`}>
        <span className="kw-metric-pill"><b>{day ? count(day.new_entries) : "—"}</b><small>当日新学</small></span>
        <span className="kw-metric-pill"><b>{day ? count(day.entries) : "—"}</b><small>当日学习</small></span>
        <span className="kw-metric-pill"><b>{day ? count(day.answers) : "—"}</b><small>作答次数</small></span>
        <span className="kw-metric-pill"><b>{day ? answerTime(day.answer_ms).replace(" ", "") : "—"}</b><small>作答耗时</small></span>
        <span className="kw-metric-pill" title="当前词库中已有学习记录的词条数 / 总词条数"><b>{count(learned)} / {count(snapshot.words.length)}</b><small>词库已学</small></span>
      </div>
      <span className="words-week-range"><time dateTime={start}>{shortDate(start)}</time> — <time dateTime={end}>{shortDate(end)}</time></span>
    </header>
    <DailyTrend days={week} selected={selected} visible={active} label="学习词条" baseMaximum={10}
      formatValue={entries} formatTick={count} formatMarker={entries} missingLabel="尚未读取" emptyMessage="所选范围尚未读取学习记录"
      onSelect={onSelect}/>
  </section>;
}
