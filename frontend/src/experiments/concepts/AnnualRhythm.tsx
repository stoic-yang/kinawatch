import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { fetchRange, type DayMode, type RangeDay, type RangeResponse } from "../../api";
import { ViewportTooltip, type ViewportTooltipAnchor } from "../../components/ViewportTooltip";
import { fmtDuration, shiftDate } from "../../lib/format";
import "./annual-rhythm.css";

export type AnnualRhythmProps = {
  currentDate: string;
  selectedDate: string;
  dayMode: DayMode;
  visible: boolean;
  onSelect: (date: string) => void;
};

type CellState = "loading" | "error" | "missing" | "partial" | "empty" | "ready" | "future";
type AnnualRangeMode = "rolling" | "year";
type DayCell = { date: string; state: CellState; seconds: number | null; issues: string[] };
type MonthWindow = { start: string; end: string; dates: string[] };
type AnnualLoad = { key: string; cells: Record<string, DayCell>; pending: number };
type CachedWindow = { cells: DayCell[]; expiresAt: number };
type RequestJob = { owner: symbol; active: () => boolean; run: () => Promise<void> };

// Historical notes/corrections can change too; no month remains stale for the
// lifetime of an open tab. Revisiting within five minutes still reuses reads.
const WINDOW_TTL = 5 * 60 * 1000;
const MAX_CACHED_WINDOWS = 48;
const windowCache = new Map<string, CachedWindow>();
// The limit survives visibility/year changes while uncancellable fetchRange
// calls finish. Old queued jobs are removed; their responses never enter state.
let runningRequests = 0;
let requestQueue: RequestJob[] = [];
function pumpRequests() {
  while (runningRequests < 2 && requestQueue.length) {
    const job = requestQueue.shift()!;
    if (!job.active()) continue;
    runningRequests += 1;
    void job.run().finally(() => {
      runningRequests -= 1;
      pumpRequests();
    });
  }
}

const STATE_LABELS: Record<CellState, string> = {
  loading: "读取中",
  error: "读取失败",
  missing: "数据缺失",
  partial: "数据不完整",
  empty: "无活动记录",
  ready: "活动时间",
  future: "尚未到来",
};
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function validSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

function heatLevel(seconds: number | null): number {
  if (seconds === null || seconds === 0) return 0;
  if (seconds < 2 * 3600) return 1;
  if (seconds < 4 * 3600) return 2;
  if (seconds < 7 * 3600) return 3;
  return 4;
}

function longDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

function activityLabel(cell: DayCell): string {
  if (cell.seconds === null) return STATE_LABELS[cell.state];
  if (cell.state === "partial") return `已记录 ${fmtDuration(cell.seconds)} · 数据不完整`;
  if (cell.state === "empty") return "0秒 · 无活动记录";
  return `活动时间 ${fmtDuration(cell.seconds)}`;
}

function readWindow(window: MonthWindow, result: RangeResponse, mode: DayMode): DayCell[] {
  if (!Array.isArray(result.days) || result.start !== window.start || result.end !== window.end || result.mode !== mode) {
    throw new Error("返回的日期范围与请求不一致。");
  }
  const records = new Map<string, RangeDay>();
  const duplicates = new Set<string>();
  for (const day of result.days) {
    if (!day || typeof day.date !== "string" || day.date < window.start || day.date > window.end) continue;
    if (records.has(day.date)) duplicates.add(day.date);
    else records.set(day.date, day);
  }
  return window.dates.map((date) => {
    const day = records.get(date);
    if (!day) return { date, state: "missing", seconds: null, issues: ["未返回当天数据。"] };
    if (duplicates.has(date)) return { date, state: "partial", seconds: null, issues: ["返回了重复的日期记录。"] };
    const value = day.overview?.combined_nonoverlap_seconds;
    const seconds = validSeconds(value) ? value : null;
    const complete = day.quality?.complete === true && seconds !== null;
    return {
      date,
      state: complete ? seconds === 0 ? "empty" : "ready" : "partial",
      seconds,
      issues: Array.isArray(day.quality?.issues) ? day.quality.issues.filter((issue): issue is string => typeof issue === "string") : [],
    };
  });
}

export function AnnualRhythm({ currentDate, selectedDate, dayMode, visible, onSelect }: AnnualRhythmProps) {
  const currentYear = Number(currentDate.slice(0, 4));
  const selectedYear = Number(selectedDate.slice(0, 4));
  const [rangeMode, setRangeMode] = useState<AnnualRangeMode>("rolling");
  const [cursor, setCursor] = useState({ year: Math.min(selectedYear, currentYear), selectedYear });
  // A new selected year is reflected in this render, before effects can run.
  // Day changes within a year leave the user's year navigation intact.
  const year = Math.min(cursor.selectedYear === selectedYear ? cursor.year : selectedYear, currentYear);
  const [retry, setRetry] = useState(0);
  const [load, setLoad] = useState<AnnualLoad | null>(null);
  const [focusedDate, setFocusedDate] = useState(selectedDate);
  const [tooltip, setTooltip] = useState<{ key: string; date: string; anchor: ViewportTooltipAnchor } | null>(null);
  const tooltipId = useId();
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const dismissTooltip = useCallback(() => setTooltip(null), []);
  const rangeStart = rangeMode === "rolling" ? shiftDate(currentDate, -364) : `${String(year).padStart(4, "0")}-01-01`;
  const rangeEnd = rangeMode === "rolling" ? currentDate : `${String(year).padStart(4, "0")}-12-31`;
  const dates = useMemo(() => datesBetween(rangeStart, rangeEnd), [rangeStart, rangeEnd]);
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const requestEnd = lastDate < currentDate ? lastDate : currentDate;
  const requestKey = `${dayMode}:${rangeMode}:${firstDate}:${requestEnd}`;
  const windows = useMemo<MonthWindow[]>(() => {
    const groups = new Map<string, string[]>();
    for (const date of dates) {
      if (date > requestEnd) continue;
      const month = date.slice(0, 7);
      const group = groups.get(month);
      if (group) group.push(date);
      else groups.set(month, [date]);
    }
    return [...groups.values()].map((monthDates) => ({ start: monthDates[0], end: monthDates[monthDates.length - 1], dates: monthDates }));
  }, [dates, requestEnd]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const owner = Symbol(requestKey);
    const initial: AnnualLoad = { key: requestKey, cells: {}, pending: 0 };
    const pending: MonthWindow[] = [];
    for (const window of windows) {
      const key = `${dayMode}:${window.start}:${window.end}`;
      const cached = windowCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        windowCache.delete(key);
        windowCache.set(key, cached);
        for (const cell of cached.cells) initial.cells[cell.date] = cell;
      } else {
        windowCache.delete(key);
        for (const date of window.dates) initial.cells[date] = { date, state: "loading", seconds: null, issues: [] };
        pending.push(window);
      }
    }
    initial.pending = pending.length;
    setLoad(initial);
    // Show the selected/current months first while retaining calendar order.
    for (const window of pending.reverse()) {
      requestQueue.push({
        owner,
        active: () => active,
        run: async () => {
          let cells: DayCell[];
          try {
            const result = await fetchRange(window.start, window.end, dayMode);
            if (!active) return;
            cells = readWindow(window, result, dayMode);
            if (cells.every((cell) => cell.state === "ready" || cell.state === "empty")) {
              const key = `${dayMode}:${window.start}:${window.end}`;
              windowCache.delete(key);
              windowCache.set(key, { cells, expiresAt: Date.now() + WINDOW_TTL });
              while (windowCache.size > MAX_CACHED_WINDOWS) windowCache.delete(windowCache.keys().next().value!);
            }
          } catch (reason) {
            if (!active) return;
            const message = reason instanceof Error ? reason.message : String(reason);
            cells = window.dates.map((date) => ({ date, state: "error", seconds: null, issues: [message] }));
          }
          if (!active) return;
          setLoad((previous) => {
            if (!previous || previous.key !== requestKey) return previous;
            const next = { ...previous.cells };
            for (const cell of cells) next[cell.date] = cell;
            return { key: requestKey, cells: next, pending: Math.max(0, previous.pending - 1) };
          });
        },
      });
    }
    pumpRequests();
    return () => {
      active = false;
      requestQueue = requestQueue.filter((job) => job.owner !== owner);
    };
  }, [currentDate, dayMode, requestKey, retry, visible, windows]);

  const current = load?.key === requestKey ? load : null;
  const cells = useMemo<DayCell[]>(() => dates.map((date) => date > currentDate
    ? { date, state: "future", seconds: null, issues: [] }
    : current?.cells[date] ?? { date, state: "loading", seconds: null, issues: [] }), [current, dates, currentDate]);
  const byDate = useMemo(() => new Map(cells.map((cell) => [cell.date, cell])), [cells]);
  const arrived = cells.filter((cell) => cell.state !== "future");
  const counts = arrived.reduce((value, cell) => ({ ...value, [cell.state]: value[cell.state] + 1 }), {
    loading: 0, error: 0, missing: 0, partial: 0, empty: 0, ready: 0, future: 0,
  });
  const loading = !current || current.pending > 0;
  const complete = !loading && arrived.length > 0 && arrived.every((cell) => cell.state === "ready" || cell.state === "empty");
  const totalSeconds = complete ? arrived.reduce((sum, cell) => sum + cell.seconds!, 0) : null;
  const activeDays = complete ? counts.ready : null;
  const averageSeconds = totalSeconds === null ? null : totalSeconds / arrived.length;
  const status = loading ? "loading" : counts.error > 0 ? "error" : complete ? "ready" : "partial";
  const mondayOffset = (new Date(`${firstDate}T12:00:00Z`).getUTCDay() + 6) % 7;
  const weekCount = Math.ceil((mondayOffset + dates.length) / 7);
  const monthLabels = dates.flatMap((date, index) => {
    const previousMonth = index === 0 ? "" : dates[index - 1].slice(0, 7);
    const month = date.slice(0, 7);
    if (month === previousMonth) return [];
    const monthNumber = Number(date.slice(5, 7));
    const showYear = rangeMode === "rolling" && (index === 0 || monthNumber === 1);
    return [{ key: month, label: showYear ? `${date.slice(0, 4)}·${monthNumber}月` : `${monthNumber}月`, column: Math.floor((mondayOffset + index) / 7) + 1 }];
  });
  const defaultFocus = selectedDate >= firstDate && selectedDate <= requestEnd ? selectedDate : requestEnd;
  const tabStop = focusedDate >= firstDate && focusedDate <= requestEnd ? focusedDate : defaultFocus;
  const activeTooltip = visible && tooltip?.key === requestKey ? tooltip : null;
  const tooltipCell = activeTooltip ? byDate.get(activeTooltip.date) : null;

  useEffect(() => { dismissTooltip(); }, [requestKey, visible, dismissTooltip]);
  useEffect(() => {
    if (!visible) return;
    const container = scrollRef.current;
    const target = cellRefs.current.get(defaultFocus);
    if (!container || !target) return;
    const reveal = () => {
      const targetRect = target.getBoundingClientRect();
      const rect = container.getBoundingClientRect();
      container.scrollLeft += targetRect.left - rect.left - (container.clientWidth - targetRect.width) / 2;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(container);
    return () => observer.disconnect();
  }, [defaultFocus, requestKey, visible]);

  function showTooltip(target: HTMLElement, date: string) {
    const rect = target.getBoundingClientRect();
    setTooltip({ key: requestKey, date, anchor: { x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom } });
  }

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    if (event.key === "Escape") { dismissTooltip(); return; }
    const index = dates.indexOf(date);
    const weekDay = (index + mondayOffset) % 7;
    const moves: Record<string, number> = {
      ArrowLeft: index - 7, ArrowRight: index + 7,
      ArrowUp: index - 1, ArrowDown: index + 1,
      Home: event.ctrlKey || event.metaKey ? 0 : index - weekDay,
      End: event.ctrlKey || event.metaKey ? arrived.length - 1 : index + 6 - weekDay,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = dates[Math.max(0, Math.min(arrived.length - 1, moves[event.key]))];
    cellRefs.current.get(next)?.focus();
  }

  return <section className="kw-annual" hidden={!visible} aria-label="年度活动节律" data-annual="true" data-range={rangeMode} data-year={rangeMode === "year" ? year : undefined} data-start={firstDate} data-end={requestEnd} data-status={status} data-complete={complete} data-request-key={requestKey}>
    <div className="kw-annual-board kw-card">
      <header className="kw-annual-header">
        <div className="kw-annual-heading"><h2>年度活动</h2><p><time dateTime={firstDate}>{longDate(firstDate)}</time><span aria-hidden="true">—</span><time dateTime={requestEnd}>{longDate(requestEnd)}</time></p></div>
        <div className="kw-annual-stats" aria-live="polite">
          <span className="kw-annual-stat kw-metric-pill"><strong data-stat="total" data-seconds={totalSeconds ?? undefined}>{totalSeconds === null ? "—" : `${(totalSeconds / 3600).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}小时`}</strong><small>活动时间</small></span>
          <span className="kw-annual-stat kw-metric-pill"><strong data-stat="active-days" data-count={activeDays ?? undefined}>{activeDays === null ? "—" : `${activeDays}天`}</strong><small>有活动日</small></span>
          <span className="kw-annual-stat kw-metric-pill"><strong className="kw-annual-average" data-stat="average" data-seconds={averageSeconds ?? undefined}>{averageSeconds === null ? "—" : fmtDuration(averageSeconds)}</strong><small>每日平均</small></span>
        </div>
        <div className="kw-annual-controls">
          <div className="kw-annual-range-switch kw-segmented-control" role="group" aria-label="年度统计范围">
            <button type="button" aria-pressed={rangeMode === "rolling"} onClick={() => setRangeMode("rolling")}>近一年</button>
            <button type="button" aria-pressed={rangeMode === "year"} onClick={() => setRangeMode("year")}>自然年</button>
          </div>
          {rangeMode === "year" && <div className="kw-annual-year-controls" role="group" aria-label="自然年年份">
            <button type="button" aria-label="上一年" disabled={year <= 1} onClick={() => setCursor({ year: year - 1, selectedYear })}><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m10 3-5 5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
            <strong>{year}<span>年</span></strong>
            <button type="button" aria-label="下一年" disabled={year >= currentYear} onClick={() => setCursor({ year: year + 1, selectedYear })}><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
          </div>}
        </div>
      </header>
      <div className="kw-annual-scroller" ref={scrollRef}>
        <div className="kw-annual-chart" style={{ "--annual-weeks": weekCount } as CSSProperties}>
          <div className="kw-annual-months" aria-hidden="true">{monthLabels.map((month) => <span key={month.key} style={{ gridColumn: `${month.column} / span 3` }}>{month.label}</span>)}</div>
          <div className="kw-annual-weekdays" aria-hidden="true">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div>
          <div className="kw-annual-grid" role="grid" aria-label={`${longDate(firstDate)}至${longDate(requestEnd)}每日活动时间`} aria-rowcount={7} aria-colcount={weekCount} aria-busy={loading}>
            {WEEKDAYS.map((weekday, row) => <div className="kw-annual-grid-row" role="row" aria-label={`星期${weekday}`} key={weekday}>
              {Array.from({ length: weekCount }, (_, week) => {
                const index = week * 7 + row - mondayOffset;
                const cell = cells[index];
                if (!cell) return <span className="kw-annual-outside" role="gridcell" aria-disabled="true" key={`outside-${week}`} />;
                const label = `${longDate(cell.date)}，星期${weekday}，${activityLabel(cell)}`;
                return <span role="gridcell" className="kw-annual-grid-cell" aria-selected={cell.date === selectedDate} key={cell.date}>
                  <button type="button" className={`kw-annual-cell kw-annual-level-${heatLevel(cell.seconds)}`} data-date={cell.date} data-state={cell.state} data-seconds={cell.seconds ?? undefined} data-today={cell.date === currentDate}
                    aria-label={label} aria-current={cell.date === selectedDate ? "date" : undefined} aria-describedby={activeTooltip?.date === cell.date ? tooltipId : undefined}
                    tabIndex={cell.date === tabStop ? 0 : -1} disabled={cell.state === "future"} title={cell.state === "future" ? label : undefined}
                    ref={(node) => { if (node) cellRefs.current.set(cell.date, node); else cellRefs.current.delete(cell.date); }}
                    onMouseEnter={(event) => showTooltip(event.currentTarget, cell.date)} onMouseLeave={dismissTooltip}
                    onFocus={(event) => { setFocusedDate(cell.date); showTooltip(event.currentTarget, cell.date); }} onBlur={dismissTooltip} onKeyDown={(event) => moveFocus(event, cell.date)}
                    onClick={() => { dismissTooltip(); onSelect(cell.date); }} />
                </span>;
              })}
            </div>)}
          </div>
        </div>
      </div>
      {!loading && !complete && <footer className="kw-annual-footer">
        <div className="kw-annual-coverage" role="status">
          {counts.missing > 0 && <span className="kw-annual-state-key"><i data-state="missing" />缺失 {counts.missing} 天</span>}
          {counts.partial > 0 && <span className="kw-annual-state-key"><i data-state="partial" />不完整 {counts.partial} 天</span>}
          {counts.error > 0 && <span className="kw-annual-state-key"><i data-state="error" />读取失败 {counts.error} 天</span>}
          <button type="button" className="kw-annual-retry" onClick={() => setRetry((value) => value + 1)}>重新读取</button>
        </div>
      </footer>}
    </div>
    {activeTooltip && tooltipCell && <ViewportTooltip id={tooltipId} className="kw-annual-tooltip" anchor={activeTooltip.anchor} side="above" onDismiss={dismissTooltip}>
      <time dateTime={tooltipCell.date}>{longDate(tooltipCell.date)}</time><strong>{activityLabel(tooltipCell)}</strong>{tooltipCell.issues.length > 0 && <span>{tooltipCell.issues.join(" · ")}</span>}
    </ViewportTooltip>}
  </section>;
}
