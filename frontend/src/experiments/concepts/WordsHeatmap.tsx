import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ViewportTooltip, type ViewportTooltipAnchor } from "../../components/ViewportTooltip";
import { wordDay, wordYear, type WordDay, type WordsSnapshot } from "./words";
import "./annual-rhythm.css";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const fullDate = (date: string) => `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
const heatLevel = (answers: number) => answers === 0 ? 0 : answers < 10 ? 1 : answers < 50 ? 2 : answers < 100 ? 3 : 4;

export function WordsHeatmap({ year, selected, today, days, snapshot, active, onYear, onSelect }: {
  year: number; selected: string; today: string; days: Map<string, WordDay>; snapshot: WordsSnapshot; active: boolean;
  onYear: (year: number) => void; onSelect: (date: string) => void;
}) {
  const { cells, months, weekCount } = useMemo(() => wordYear(year), [year]);
  const arrived = cells.filter((date): date is string => date !== null && date <= today);
  const defaultFocus = arrived.includes(selected) ? selected : arrived[arrived.length - 1];
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ date: string; anchor: ViewportTooltipAnchor } | null>(null);
  const tooltipId = useId();
  const dismissTooltip = useCallback(() => setTooltip(null), []);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabStop = focusedDate && arrived.includes(focusedDate) ? focusedDate : defaultFocus;

  useEffect(() => { dismissTooltip(); }, [active, snapshot, dismissTooltip]);

  useEffect(() => {
    if (!active) return;
    const container = scrollRef.current;
    const target = cellRefs.current.get(defaultFocus);
    if (!container || !target) return;
    const reveal = () => {
      const bounds = target.getBoundingClientRect();
      const viewport = container.getBoundingClientRect();
      if (bounds.left < viewport.left || bounds.right > viewport.right) {
        container.scrollLeft += bounds.left - viewport.left - (container.clientWidth - bounds.width) / 2;
      }
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(container);
    return () => observer.disconnect();
  }, [active, defaultFocus]);

  function showTooltip(target: HTMLElement, date: string) {
    if (date > today) return;
    const rect = target.getBoundingClientRect();
    setTooltip({ date, anchor: { x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom } });
  }

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    if (event.key === "Escape") { dismissTooltip(); return; }
    const index = cells.indexOf(date);
    const row = index % 7;
    const moves: Record<string, number> = {
      ArrowLeft: index - 7, ArrowRight: index + 7, ArrowUp: index - 1, ArrowDown: index + 1,
      Home: event.ctrlKey || event.metaKey ? cells.indexOf(arrived[0]) : index - row,
      End: event.ctrlKey || event.metaKey ? cells.indexOf(arrived[arrived.length - 1]) : index + 6 - row,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = cells[Math.max(cells.indexOf(arrived[0]), Math.min(cells.indexOf(arrived[arrived.length - 1]), moves[event.key]))];
    if (next) cellRefs.current.get(next)?.focus();
  }

  const tooltipDay = tooltip ? wordDay(days, tooltip.date, snapshot) : null;
  return <section className="words-annual kw-annual" aria-label="年度学习热力图" data-year={year}>
    <header className="words-annual-heading">
      <h2>学习日历</h2>
      <div className="words-year-nav" role="group" aria-label="学习年份">
        <button type="button" aria-label="上一个学习年份" disabled={year <= 1} onClick={() => onYear(year - 1)}>‹</button>
        <span>{year} 年</span>
        <button type="button" aria-label="下一个学习年份" disabled={year >= Number(today.slice(0, 4))} onClick={() => onYear(year + 1)}>›</button>
      </div>
    </header>
    <div className="kw-annual-scroller" ref={scrollRef}>
      <div className="kw-annual-chart" style={{ "--annual-weeks": weekCount } as CSSProperties}>
        <div className="kw-annual-months" aria-hidden="true">{months.map(month => <span key={month.label} style={{ gridColumn: `${month.column} / span 3` }}>{month.label}</span>)}</div>
        <div className="kw-annual-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
        <div className="kw-annual-grid" role="grid" aria-label={`${year} 年每日作答次数`} aria-rowcount={7} aria-colcount={weekCount}>
          {weekdays.map((weekday, row) => <div className="kw-annual-grid-row" role="row" aria-label={`星期${weekday}`} key={weekday}>
            {Array.from({ length: weekCount }, (_, week) => {
              const date = cells[week * 7 + row];
              if (!date) return <span className="kw-annual-outside" role="gridcell" aria-disabled="true" key={`outside-${week}`}/>;
              const day = wordDay(days, date, snapshot);
              const future = date > today;
              const label = `${fullDate(date)}，${future ? "尚未到来" : day ? `${day.answers} 次作答` : "尚未读取"}`;
              return <span role="gridcell" className="kw-annual-grid-cell" aria-selected={date === selected} key={date}>
                <button type="button" className={`kw-annual-cell kw-annual-level-${heatLevel(day?.answers ?? 0)}`} data-date={date} data-state={future ? "future" : day ? "ready" : "missing"} data-answers={day?.answers} data-today={date === today}
                  aria-label={label} aria-current={date === selected ? "date" : undefined} aria-describedby={active && tooltip?.date === date ? tooltipId : undefined}
                  tabIndex={date === tabStop ? 0 : -1} disabled={future} title={future ? label : undefined}
                  ref={node => { if (node) cellRefs.current.set(date, node); else cellRefs.current.delete(date); }}
                  onMouseEnter={event => showTooltip(event.currentTarget, date)} onMouseLeave={dismissTooltip}
                  onFocus={event => { setFocusedDate(date); showTooltip(event.currentTarget, date); }} onBlur={dismissTooltip} onKeyDown={event => moveFocus(event, date)}
                  onClick={() => { dismissTooltip(); onSelect(date); }}/>
              </span>;
            })}
          </div>)}
        </div>
      </div>
    </div>
    <div className="words-heat-legend" aria-hidden="true"><span>少</span>{[0, 1, 2, 3, 4].map(level => <i key={level} className={`kw-annual-level-${level}`}/>)}<span>多</span></div>
    {active && tooltip && <ViewportTooltip id={tooltipId} className="kw-annual-tooltip" anchor={tooltip.anchor} side="above" onDismiss={dismissTooltip}>
      <time dateTime={tooltip.date}>{fullDate(tooltip.date)}</time><strong>{tooltipDay ? `${tooltipDay.answers} 次作答 · ${tooltipDay.entries} 个词条` : "尚未读取"}</strong>
    </ViewportTooltip>}
  </section>;
}
