import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { fetchRange, type DayMode, type RangeDay } from "../../api";
import { fmtDuration, shiftDate, startOfISOWeek, weekdayShort } from "../../lib/format";
import { ViewportTooltip, type ViewportTooltipAnchor } from "../../components/ViewportTooltip";
import { AnnualRhythm } from "./AnnualRhythm";
import "./rhythm-workspace.css";

type RangeMode = "recent" | "week";
type LoadState =
  | { requestKey: string; status: "loading" }
  | { requestKey: string; status: "ready"; days: RangeDay[] }
  | { requestKey: string; status: "error"; message: string };
type RowState = "loading" | "error" | "missing" | "partial" | "empty" | "ready" | "future";
type Distribution = "available" | "not-provided" | "missing" | "loading" | "error" | "future";
type RhythmRow = {
  date: string;
  state: RowState;
  distribution: Distribution;
  seconds: number | null;
  hours: number[] | null;
  hasNote: boolean;
  issues: string[];
};

export type RhythmWorkspaceProps = {
  variant?: "week" | "overview";
  currentDate: string;
  selectedDate: string;
  dayMode: DayMode;
  dayStartClock: string;
  timezone: string;
  onSelect: (date: string) => void;
  visible: boolean;
};

const HOURS = Array.from({ length: 24 }, (_, index) => index);
const STATE_LABELS: Record<RowState, string> = {
  loading: "读取中",
  error: "读取失败",
  missing: "数据缺失",
  partial: "数据不完整",
  empty: "无活动记录",
  ready: "活动记录",
  future: "尚未到来",
};

function validSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function longDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

function shortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}.${day}`;
}

function clockMinutes(clock: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function hourClock(startMinutes: number, hour: number) {
  const minutes = startMinutes + hour * 60;
  return {
    clock: `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
    nextDay: minutes >= 1440,
  };
}

function heatColor(seconds: number): string {
  const ratio = Math.min(1, seconds / 3600);
  return `color-mix(in srgb, var(--kw-heat-4, #3e6433) ${ratio * 100}%, var(--kw-heat-0, #eff3e9))`;
}

function NoteMark() {
  return <svg className="kw-rhythm-note-mark" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><path d="M4 2.5h6l2 2v9H4zM9.5 2.5v3H12M6 8h4m-4 2h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function distributionLabel(row: RhythmRow): string | null {
  if (row.distribution === "not-provided") return "未提供分布";
  if (row.distribution === "missing") return row.state === "missing" ? "未返回当天数据" : "分布数据缺失";
  if (row.distribution !== "available") return STATE_LABELS[row.state];
  return row.state === "empty" ? "无活动记录" : null;
}

export function RhythmWorkspace({ variant = "week", currentDate, selectedDate, dayMode, dayStartClock, timezone, onSelect, visible }: RhythmWorkspaceProps) {
  const [rangeMode, setRangeMode] = useState<RangeMode>("recent");
  const [retry, setRetry] = useState(0);
  const [loadState, setLoadState] = useState<LoadState | null>(null);
  const rangeStart = rangeMode === "recent" ? shiftDate(currentDate, -6) : startOfISOWeek(currentDate);
  const rangeEnd = rangeMode === "recent" ? currentDate : shiftDate(rangeStart, 6);
  const requestEnd = rangeEnd < currentDate ? rangeEnd : currentDate;
  const requestKey = [rangeMode, rangeStart, rangeEnd, requestEnd, dayMode, dayStartClock, timezone].join("|");
  // Changing the selection never changes this request or its seven-day frame.
  const dates = useMemo(() => HOURS.slice(0, 7).map((index) => shiftDate(rangeStart, index)), [rangeStart]);
  const startMinutes = clockMinutes(dayStartClock);
  const hours = useMemo(() => HOURS.map(index => ({
    index,
    from: hourClock(startMinutes, index),
    to: hourClock(startMinutes, index + 1),
    startsNextDay: index > 0 && hourClock(startMinutes, index).nextDay && !hourClock(startMinutes, index - 1).nextDay,
  })), [startMinutes]);
  const [tooltip, setTooltip] = useState<{ key: string; date: string; hour: number; anchor: ViewportTooltipAnchor } | null>(null);
  const tooltipId = useId();
  const pendingInspection = useRef<number | null>(null);
  const hideTooltip = useCallback(() => setTooltip(null), []);
  const dismissTooltip = useCallback(() => {
    if (pendingInspection.current !== null) cancelAnimationFrame(pendingInspection.current);
    pendingInspection.current = null;
    setTooltip(null);
  }, []);
  useEffect(() => { dismissTooltip(); return dismissTooltip; }, [dismissTooltip, requestKey, visible]);
  function inspectHour(date: string, hour: number, element: Element) {
    if (pendingInspection.current !== null) cancelAnimationFrame(pendingInspection.current);
    pendingInspection.current = null;
    const bounds = element.getBoundingClientRect();
    setTooltip({ key: requestKey, date, hour, anchor: { x: bounds.x + bounds.width / 2, top: bounds.top, bottom: bounds.bottom } });
  }

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setLoadState({ requestKey, status: "loading" });
    fetchRange(rangeStart, requestEnd, dayMode)
      .then((result) => {
        if (!active) return;
        if (!Array.isArray(result.days)) throw new Error("返回结果没有日期记录，请重试。");
        setLoadState({ requestKey, status: "ready", days: result.days });
      })
      .catch((reason: unknown) => {
        if (active) setLoadState({ requestKey, status: "error", message: reason instanceof Error ? reason.message : String(reason) });
      });
    return () => { active = false; };
  }, [visible, requestKey, rangeStart, requestEnd, dayMode, retry]);

  // Gate data during render as well as in the effect: the new range title must
  // never share a frame with the previous request's values.
  const current = loadState?.requestKey === requestKey ? loadState : null;
  const rows = useMemo<RhythmRow[]>(() => {
    const records = new Map(current?.status === "ready" ? current.days.map((day) => [day.date, day]) : []);
    return dates.map((date) => {
      const base = { date, seconds: null, hours: null, hasNote: false, issues: [] };
      if (date > currentDate) return { ...base, state: "future", distribution: "future" };
      if (!current || current.status === "loading") return { ...base, state: "loading", distribution: "loading" };
      if (current.status === "error") return { ...base, state: "error", distribution: "error" };
      const day = records.get(date);
      if (!day) return { ...base, state: "missing", distribution: "missing" };
      const total = day.overview?.combined_nonoverlap_seconds;
      const seconds = validSeconds(total) ? total : null;
      const suppliedHours = day.rhythm?.hourly_active_seconds;
      const hours = Array.isArray(suppliedHours) && suppliedHours.length === 24 && suppliedHours.every(validSeconds) ? suppliedHours : null;
      const complete = day.quality?.complete === true && seconds !== null;
      return {
        date,
        state: complete ? seconds === 0 ? "empty" : "ready" : "partial",
        distribution: hours ? "available" : day.rhythm ? "missing" : "not-provided",
        seconds,
        hours,
        hasNote: day.overview?.review_has_content === true,
        issues: Array.isArray(day.quality?.issues) ? day.quality.issues : [],
      };
    });
  }, [current, dates, currentDate]);

  const arrivedRows = rows.filter((row) => row.state !== "future");
  const complete = current?.status === "ready" && arrivedRows.every((row) => row.state === "ready" || row.state === "empty");
  const totalSeconds = complete ? arrivedRows.reduce((sum, row) => sum + row.seconds!, 0) : null;
  const activeDays = complete ? arrivedRows.filter((row) => row.seconds! > 0).length : null;
  const peakSeconds = rows.reduce((peak, row) => row.seconds === null ? peak : Math.max(peak, row.seconds), 0);
  const missingDays = rows.filter((row) => row.state === "missing").length;
  const partialDays = rows.filter((row) => row.state === "partial").length;
  const loading = !current || current.status === "loading";

  const activeTooltip = visible && tooltip?.key === requestKey ? tooltip : null;
  const tooltipRow = activeTooltip ? rows.find(row => row.date === activeTooltip.date) : null;
  const tooltipHour = activeTooltip ? hours[activeTooltip.hour] : null;
  const tooltipSeconds = tooltipRow?.hours?.[activeTooltip?.hour ?? 0];

  const heading = <header className={`kw-rhythm-card-header${variant === "overview" ? " kw-page-heading" : ""}`}>
    <div className="kw-rhythm-heading"><h1 className={variant === "overview" ? "kw-page-title" : undefined}>{variant === "overview" ? "节律" : "七日节律"}</h1><p className="kw-rhythm-range-title"><time dateTime={rangeStart}>{longDate(rangeStart)}</time><span aria-hidden="true">—</span><time dateTime={rangeEnd}>{longDate(rangeEnd)}</time></p></div>
    <div className="kw-rhythm-header-actions">
      <div className="kw-rhythm-stats" aria-live="polite">
        <span className="kw-rhythm-stat kw-metric-pill"><strong className="kw-rhythm-total-value" data-complete={complete} data-seconds={totalSeconds ?? undefined}>{totalSeconds === null ? "—" : fmtDuration(totalSeconds)}</strong><small>活动时间</small></span>
        <span className="kw-rhythm-stat kw-metric-pill"><strong className="kw-rhythm-active-days-value" data-complete={complete} data-count={activeDays ?? undefined}>{activeDays === null ? "—" : `${activeDays}天`}</strong><small>有活动日</small></span>
      </div>
      <div className="kw-rhythm-range-switch kw-segmented-control" role="group" aria-label="节律日期范围">
        <button type="button" aria-pressed={rangeMode === "recent"} onClick={() => setRangeMode("recent")}>近 7 天</button>
        <button type="button" aria-pressed={rangeMode === "week"} onClick={() => setRangeMode("week")}>本周</button>
      </div>
    </div>
  </header>;

  return <section className="kw-rhythm" hidden={!visible} aria-label={variant === "overview" ? "活动节律" : "七日活动节律"} data-variant={variant} data-range={rangeMode} data-request-key={requestKey} data-status={current?.status ?? "loading"}>
    {variant === "overview" && heading}
    <div className="kw-rhythm-board kw-card">
      {variant !== "overview" && heading}
      {current?.status === "error" && <div className="kw-rhythm-notice is-error" role="alert"><span>暂时无法读取节律。{current.message}</span><button type="button" onClick={() => setRetry((value) => value + 1)}>重试</button></div>}
      {current?.status === "ready" && (missingDays > 0 || partialDays > 0) && <p className="kw-rhythm-notice" role="status">{[missingDays ? `${missingDays} 天未返回数据` : "", partialDays ? `${partialDays} 天数据不完整` : ""].filter(Boolean).join("，")}；暂不展示完整合计。</p>}
      {variant !== "overview" && <p className="kw-rhythm-scroll-hint">左右滑动查看完整 24 小时 <span aria-hidden="true">↔</span></p>}
      <div className="kw-rhythm-scroller" tabIndex={0} aria-label="七天小时活动矩阵，每列一小时，可左右滚动" aria-busy={loading} onMouseLeave={dismissTooltip}>
        <div className="kw-rhythm-matrix">
          <div className="kw-rhythm-axis-row" aria-hidden="true"><span className="kw-rhythm-axis-date">日期</span><span className="kw-rhythm-axis-total">活动时间</span><div className="kw-rhythm-hour-axis">{hours.map(hour =>
            <span className="kw-rhythm-axis-tick" key={hour.index} data-hour={hour.index} data-next-day={hour.startsNextDay || undefined} data-highlighted={activeTooltip?.hour === hour.index || undefined}>
              <time data-clock={hour.from.clock}>{hour.from.clock.endsWith(":00") ? hour.from.clock.slice(0, 2) : hour.from.clock}</time>{hour.startsNextDay && <small>次日</small>}
            </span>
          )}</div></div>
          {rows.map((row) => {
            const selected = row.date === selectedDate;
            const today = row.date === currentDate;
            const label = distributionLabel(row);
            const ratio = row.seconds === null || peakSeconds === 0 ? null : Math.min(100, (row.seconds / peakSeconds) * 100);
            const note = `${longDate(row.date)}，星期${weekdayShort(row.date)}${today ? "，今天" : ""}${selected ? "，当前选中" : ""}，${STATE_LABELS[row.state]}${row.seconds === null ? "" : `，${row.state === "partial" ? "已记录" : ""}活动时间${fmtDuration(row.seconds)}`}${row.hasNote ? "，有笔记" : ""}${row.distribution === "not-provided" ? "，未提供小时分布" : ""}`;
            return <button type="button" className="kw-rhythm-row" key={row.date} data-date={row.date} data-state={row.state} data-distribution={row.distribution} data-today={today} data-selected={selected} aria-pressed={selected} aria-label={note} disabled={row.state === "future"} onClick={() => onSelect(row.date)}
              aria-describedby={activeTooltip?.date === row.date ? tooltipId : undefined} aria-keyshortcuts="ArrowLeft ArrowRight Home End"
              onFocus={event => { const cell = event.currentTarget.querySelector('[data-hour="0"]'); if (cell) inspectHour(row.date, 0, cell); }}
              onBlur={dismissTooltip} onMouseLeave={dismissTooltip}
              onKeyDown={event => {
                if (event.key === "Escape") { event.preventDefault(); dismissTooltip(); return; }
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const currentHour = activeTooltip?.date === row.date ? activeTooltip.hour : 0;
                const next = event.key === "Home" ? 0 : event.key === "End" ? 23 : Math.max(0, Math.min(23, currentHour + (event.key === "ArrowRight" ? 1 : -1)));
                const cell = event.currentTarget.querySelector(`[data-hour="${next}"]`);
                if (cell) { cell.scrollIntoView({ block: "nearest", inline: "nearest" }); if (pendingInspection.current !== null) cancelAnimationFrame(pendingInspection.current); pendingInspection.current = requestAnimationFrame(() => inspectHour(row.date, next, cell)); }
              }}>
              <span className="kw-rhythm-date-cell"><span className="kw-rhythm-date-line"><time dateTime={row.date}>{shortDate(row.date)}</time>{row.hasNote && <NoteMark />}</span><span className="kw-rhythm-day-meta"><span className={today ? "kw-rhythm-today" : undefined}>{today ? "今天" : `周${weekdayShort(row.date)}`}</span>{row.state === "partial" ? <em>不完整</em> : selected ? <b>已选</b> : null}</span></span>
              <span className="kw-rhythm-total-cell"><strong data-seconds={row.seconds ?? undefined}>{row.seconds === null ? "—" : fmtDuration(row.seconds)}</strong>{ratio === null ? <small>{STATE_LABELS[row.state]}</small> : row.state === "partial" ? <small className="kw-rhythm-partial-total">仅已记录</small> : <span className="kw-rhythm-day-bar" aria-hidden="true"><i style={{ width: `${ratio}%` }} /></span>}</span>
              <span className={`kw-rhythm-hours ${row.hours ? "" : "is-unavailable"}`}>
                <span className="kw-rhythm-cells" aria-hidden="true">{hours.map(hour => {
                  const seconds = row.hours?.[hour.index];
                  return <span className="kw-rhythm-cell" key={hour.index} data-hour={hour.index} data-distribution={row.distribution} data-seconds={seconds}
                    data-next-day={hour.startsNextDay || undefined} data-highlighted={activeTooltip?.hour === hour.index || undefined}
                    data-inspected={activeTooltip?.date === row.date && activeTooltip.hour === hour.index || undefined}
                    onMouseEnter={event => inspectHour(row.date, hour.index, event.currentTarget)}>
                    <span className="kw-rhythm-cell-fill" style={seconds === undefined ? undefined : { background: heatColor(seconds) }} />
                  </span>;
                })}</span>
                {label && <span className="kw-rhythm-distribution-label">{label}</span>}
              </span>
            </button>;
          })}
        </div>
      </div>
    </div>
    {activeTooltip && tooltipRow && tooltipHour && <ViewportTooltip id={tooltipId} className="kw-rhythm-tooltip" anchor={activeTooltip.anchor} side="above" onDismiss={hideTooltip}>
      <time dateTime={tooltipRow.date}>{longDate(tooltipRow.date)}</time>
      <strong>{tooltipHour.from.nextDay ? "次日 " : ""}{tooltipHour.from.clock}–{tooltipHour.to.nextDay && !tooltipHour.from.nextDay ? "次日 " : ""}{tooltipHour.to.clock}</strong>
      <span>{tooltipSeconds === undefined ? distributionLabel(tooltipRow) : `活动时间 ${fmtDuration(tooltipSeconds)}`}</span>
      {tooltipRow.issues.length > 0 && <small>{tooltipRow.issues.join(" · ")}</small>}
    </ViewportTooltip>}
    {variant === "overview" && <AnnualRhythm currentDate={currentDate} selectedDate={selectedDate} dayMode={dayMode} visible={visible} onSelect={onSelect} />}
  </section>;
}
