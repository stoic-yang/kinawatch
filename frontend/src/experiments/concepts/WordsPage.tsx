import { useMemo, useRef, useState } from "react";
import type { ConceptProps } from "./types";
import { DatePicker } from "../../components/DatePicker";
import { answerTime, filterWords, monthCells, ratingLabels, shiftWordMonth, useWords, wordDay, wordScope, wordStateLabels,
  type WordDay, type WordFilter, type WordRow, type WordsSnapshot } from "./words";
import "./words.css";

const numbers = new Intl.NumberFormat("zh-CN");
const filters: { value: WordFilter; label: string }[] = [
  { value: "all", label: "全部" }, { value: "new", label: "未学" },
  { value: "learned", label: "已学" }, { value: "again", label: "重来较多" },
];
const PAGE_SIZE = 8;
const fullDate = (date: string) => `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

function WordCalendar({ month, selected, today, days, snapshot, onMonth, onSelect }: {
  month: string; selected: string; today: string; days: Map<string, WordDay>; snapshot: WordsSnapshot;
  onMonth: (month: string) => void; onSelect: (date: string) => void;
}) {
  return <section className="words-calendar" aria-label="学习日历">
    <header><h2>学习日历</h2><div className="words-month-nav"><button type="button" aria-label="上一个学习月份" onClick={() => onMonth(shiftWordMonth(month, -1))}>‹</button><span>{month.replace("-", " / ")}</span><button type="button" aria-label="下一个学习月份" disabled={month >= today.slice(0, 7)} onClick={() => onMonth(shiftWordMonth(month, 1))}>›</button></div></header>
    <div className="words-calendar-grid"><div className="words-weekdays" aria-hidden="true">{["一", "二", "三", "四", "五", "六", "日"].map(day => <span key={day}>{day}</span>)}</div>
      {monthCells(month).map((date, i) => {
        const value = date ? wordDay(days, date, snapshot) : null;
        const count = value?.answers ?? 0;
        const level = count === 0 ? 0 : count < 10 ? 1 : count < 50 ? 2 : count < 100 ? 3 : 4;
        return date ? <button type="button" key={date} data-level={level} data-today={date === today} disabled={date > today}
          aria-pressed={date === selected} aria-label={`${fullDate(date)}，${value ? `${count} 次作答` : "尚未读取"}`} onClick={() => onSelect(date)}>
          <span>{Number(date.slice(8))}</span><i aria-hidden="true"/></button> : <span className="words-calendar-blank" key={`blank-${i}`}/>;
      })}
    </div><div className="words-calendar-legend" aria-hidden="true"><span>少</span>{[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level}/>)}<span>多</span></div>
  </section>;
}

function WordDetail({ word }: { word: WordRow }) {
  const latest = word.history[0];
  return <>
    <header className="words-detail-heading"><span className="words-state">{wordStateLabels[word.state]}</span><h3 lang="en">{word.term}</h3>{word.phonetic && <p>{word.phonetic}</p>}</header>
    {word.definition && <p className="words-definition">{word.definition}</p>}
    {(word.example || word.translation) && <div className="words-examples"><h4>例句</h4>{word.example && <p lang="en">{word.example}</p>}{word.translation && <p className="words-translation">{word.translation}</p>}</div>}
    <div className="words-detail-history"><h4>学习记录</h4>{word.history.length ? <>
      <p className="words-detail-counts">{numbers.format(word.history.length)} 次作答 · {word.again} 次重来 · 最近学习 {latest.date.replaceAll("-", "/")}</p>
      <ol>{word.history.slice(0, 5).map(review => <li key={review.id}><time dateTime={review.time}>{review.date.slice(5).replace("-", "/")} {review.time.slice(11, 16)}</time><span data-rating={review.rating}>{ratingLabels[review.rating]}</span><small>{answerTime(review.answer_ms)}</small></li>)}</ol>
    </> : <p className="words-muted">这个词条还没有作答记录。</p>}</div>
  </>;
}

export function WordsPage({ active, app }: { active: boolean; app: ConceptProps }) {
  const state = useWords(active);
  const snapshot = state.data?.snapshot ?? null;
  const [deck, setDeck] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WordFilter>("all");
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [calendarMonth, setCalendarMonth] = useState<string | null>(null);
  const detail = useRef<HTMLElement>(null);
  const currentDeck = snapshot?.decks.some(item => item.name === deck) ? deck : "";
  const scope = useMemo(() => wordScope(snapshot, currentDeck), [snapshot, currentDeck]);
  const matches = useMemo(() => filterWords(scope.words, query, filter), [scope.words, query, filter]);
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const page = Math.min(pageIndex, lastPage);
  const visible = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selected = matches.find(word => word.id === selectedId) ?? visible[0];
  const day = wordDay(scope.days, app.date, snapshot);
  const month = calendarMonth ?? app.date.slice(0, 7);
  const stale = state.data?.status === "cached" || Boolean(state.error);
  function selectDate(date: string) { setCalendarMonth(date.slice(0, 7)); app.selectDate(date); }
  function selectWord(word: WordRow) {
    setSelectedId(word.id);
    if (window.matchMedia("(max-width: 900px)").matches) detail.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }
  const refresh = <button type="button" className="words-button" onClick={state.reload} disabled={state.loading}>{state.loading ? "正在读取…" : "更新单词数据"}</button>;
  return <section className="words-page kw-page" hidden={!active} aria-label="单词" data-status={state.loading ? "loading" : state.data?.status ?? "unavailable"}>
    <header className="words-heading kw-page-heading"><div><h1 className="kw-page-title">单词</h1>{snapshot && <span>{numbers.format(scope.words.length)} 个词条</span>}</div><div className="words-heading-actions">
      {snapshot && <DatePicker date={app.date} maxDate={app.currentDate} active={active} label="单词学习日期" onSelect={selectDate}/>} {refresh}
    </div></header>
    {state.error && <p className="words-error" role="alert">{state.error}</p>}
    {snapshot ? <>
      <details className="words-source"><summary>{stale ? "Anki 暂未连接 · 上次读取" : "Anki"} · {snapshot.profile} · {new Date(snapshot.fetched_at).toLocaleString("zh-CN", { timeZone: snapshot.timezone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}{!stale && " 读取"}</summary>
        <p>{state.data?.error || "手机或平板上的学习，需要同步到电脑端 Anki 后更新。"}</p><p>按 {snapshot.timezone} 自然日统计本机记录。一个词条对应一条 Anki 笔记；新学按保存的首次作答计算，耗时为 Anki 记录的作答时间。{snapshot.skipped_notes > 0 && `另有 ${snapshot.skipped_notes} 条笔记未识别出单词字段。`}</p>
      </details>
      <div className="words-overview"><section className="words-study-summary" aria-label="当日单词学习统计"><header><h2>{app.date === app.currentDate ? "今天" : fullDate(app.date)}的学习</h2><span>{day && day.answers === 0 ? "本机暂无作答记录" : ""}</span></header>
        <dl className="words-metrics"><div><dt>新学词条</dt><dd>{day ? numbers.format(day.new_entries) : "—"}</dd></div><div><dt>学习词条</dt><dd>{day ? numbers.format(day.entries) : "—"}</dd></div><div><dt>作答次数</dt><dd>{day ? numbers.format(day.answers) : "—"}</dd></div><div><dt>作答耗时</dt><dd className="words-time-number">{day ? answerTime(day.answer_ms) : "—"}</dd></div></dl>
        <div className="words-progress"><div><span>词库进度</span><span>已学 {numbers.format(scope.learned)} / {numbers.format(scope.words.length)}</span></div><div className="words-progress-track" role="meter" aria-label="已有学习记录的词条" aria-valuemin={0} aria-valuemax={Math.max(1, scope.words.length)} aria-valuenow={scope.learned}><span style={{ width: `${scope.words.length ? scope.learned / scope.words.length * 100 : 0}%` }}/></div></div>
        <div className="words-summary-footer"><span>{scope.days.size ? `${scope.days.size} 个学习日` : "尚无学习记录"}</span>{scope.latest && <button type="button" className="words-text-button" onClick={() => selectDate(scope.latest!)}>最近学习 {scope.latest.replaceAll("-", "/")} <span aria-hidden="true">↗</span></button>}{app.date !== app.currentDate && <button type="button" className="words-text-button" onClick={() => selectDate(app.currentDate)}>回到今天</button>}</div>
      </section><WordCalendar month={month} selected={app.date} today={app.currentDate} days={scope.days} snapshot={snapshot} onMonth={setCalendarMonth} onSelect={selectDate}/></div>
      <section className="words-library" aria-label="单词库"><header className="words-library-heading"><h2>单词库</h2><div className="words-library-tools"><select className="words-select" value={currentDeck} aria-label="选择单词牌组" onChange={event => { setDeck(event.target.value); setPageIndex(0); setSelectedId(null); }}><option value="">全部牌组</option>{snapshot.decks.map(item => <option value={item.name} key={item.id}>{item.name}</option>)}</select><input className="words-search" type="search" aria-label="搜索单词或释义" placeholder="搜索单词或释义" value={query} onChange={event => { setQuery(event.target.value); setPageIndex(0); setSelectedId(null); }}/></div></header>
        <div className="words-filter-row"><div className="kw-segmented-control" aria-label="词条筛选">{filters.map(item => <button type="button" key={item.value} className={filter === item.value ? "is-active" : ""} aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); setPageIndex(0); setSelectedId(null); }}>{item.label}</button>)}</div><span className="words-result-count" role="status">{numbers.format(matches.length)} 个词条</span></div>
        {matches.length ? <div className="words-library-grid"><div className="words-list-panel"><ul className="words-list">{visible.map(word => <li key={word.id}><button type="button" aria-pressed={word.id === selected?.id} onClick={() => selectWord(word)}><span className="words-list-term" lang="en">{word.term}</span><span className="words-list-definition">{word.definition || "暂无释义"}</span><span className="words-list-state">{wordStateLabels[word.state]}</span></button></li>)}</ul><nav className="words-pagination" aria-label="词库分页"><span>第 {page + 1} / {lastPage + 1} 页</span><button type="button" className="words-button" disabled={page === 0} onClick={() => { setPageIndex(page - 1); setSelectedId(null); }}>上一页</button><button type="button" className="words-button" disabled={page === lastPage} onClick={() => { setPageIndex(page + 1); setSelectedId(null); }}>下一页</button></nav></div><article ref={detail} className="words-detail" aria-label="单词详情">{selected && <WordDetail word={selected}/>}</article></div>
          : <p className="words-no-results">{query ? "没有找到匹配的单词或释义。" : scope.words.length ? "当前筛选下没有词条。" : "这个牌组还没有可读取的词条。"}</p>}
      </section>
    </> : <div className="words-empty" role="status"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15"/></svg><h2>{state.loading ? "正在读取你的词库" : "连接你的 Anki 词库"}</h2><p>{state.loading ? "单词与学习记录会一起整理到这里。" : state.data?.error || "打开电脑端 Anki，安装 AnkiConnect 插件后更新数据。"}</p>{!state.loading && <a href="https://ankiweb.net/shared/info/2055492159" target="_blank" rel="noreferrer">AnkiConnect 插件 · 2055492159 ↗</a>}</div>}
  </section>;
}
