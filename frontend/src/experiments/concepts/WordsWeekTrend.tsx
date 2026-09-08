import { useEffect, useState } from "react";
import { DailyTrend } from "../../components/DailyTrend";
import { wordWeek, type WordDay, type WordsSnapshot } from "./words";

const numbers = new Intl.NumberFormat("zh-CN");
const count = (value: number) => numbers.format(value);
const entries = (value: number) => `${numbers.format(value)} 个词条`;
const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export function WordsWeekTrend({ days, snapshot, selected, active, onSelect }: {
  days: Map<string, WordDay>; snapshot: WordsSnapshot; selected: string; active: boolean; onSelect: (date: string) => void;
}) {
  const [end, setEnd] = useState(selected);
  const week = wordWeek(days, end, snapshot);
  const start = week[0].date;
  useEffect(() => {
    if (selected < start || selected > end) setEnd(selected);
  }, [selected, start, end]);

  return <section className="words-weekly" aria-label="每周学习词条">
    <header><h2>每周学习词条</h2><span><time dateTime={start}>{shortDate(start)}</time> — <time dateTime={end}>{shortDate(end)}</time></span></header>
    <DailyTrend days={week} selected={selected} visible={active} label="学习词条" baseMaximum={10}
      formatValue={entries} formatTick={count} formatMarker={entries} missingLabel="尚未读取" emptyMessage="所选范围尚未读取学习记录"
      onSelect={onSelect}/>
  </section>;
}
