import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { buildMonthCells, monthEnd, monthOf, MONDAY_WEEKDAYS, shiftMonth } from "../lib/calendar";
import { shiftDate, startOfISOWeek } from "../lib/format";
import "./date-picker.css";

const dateLabel = (date: string) => `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;

export function DatePicker({ date, maxDate, onSelect, label = "选择日期", active = true }: {
  date: string; maxDate: string; onSelect: (date: string) => void; label?: string; active?: boolean;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusRequested = useRef(false);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(monthOf(date));
  const [focused, setFocused] = useState(date);
  const cells = buildMonthCells(month, maxDate);
  const monthLabel = `${month.slice(0, 4)}年${Number(month.slice(5))}月`;
  const clampDate = (value: string) => value < "1900-01-01" ? "1900-01-01" : value > maxDate ? maxDate : value;

  useEffect(() => { if (!active) panel.current?.hidePopover(); }, [active]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!trigger.current || !panel.current) return;
      const viewportWidth = document.documentElement.clientWidth;
      const anchor = trigger.current.getBoundingClientRect();
      const bounds = panel.current.getBoundingClientRect();
      const top = anchor.bottom + 8 + bounds.height <= innerHeight - 12 ? anchor.bottom + 8 : anchor.top - bounds.height - 8;
      panel.current.style.top = `${Math.max(12, Math.min(top, innerHeight - bounds.height - 12))}px`;
      panel.current.style.left = `${Math.max(12, Math.min(anchor.right - bounds.width, viewportWidth - bounds.width - 12))}px`;
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open, month]);
  useLayoutEffect(() => {
    if (open && focusRequested.current) {
      panel.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus({ preventScroll: true });
      focusRequested.current = false;
    }
  }, [open, month, focused]);

  function close() { panel.current?.hidePopover(); trigger.current?.focus({ preventScroll: true }); }
  function select(value: string) { onSelect(value); close(); }
  function moveTo(value: string, focus: boolean) {
    const next = clampDate(value);
    focusRequested.current = focus;
    setFocused(next); setMonth(monthOf(next));
  }
  function changeMonth(delta: number, focus = false) {
    const nextMonth = shiftMonth(month, delta);
    const candidate = `${nextMonth}-${focused.slice(8)}`;
    moveTo(candidate > monthEnd(nextMonth) ? monthEnd(nextMonth) : candidate, focus);
  }
  function navigate(event: KeyboardEvent<HTMLButtonElement>, value: string) {
    const shifts: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in shifts) { event.preventDefault(); moveTo(shiftDate(value, shifts[event.key]), true); }
    else if (event.key === "Home" || event.key === "End") {
      event.preventDefault(); moveTo(shiftDate(startOfISOWeek(value), event.key === "End" ? 6 : 0), true);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault(); changeMonth((event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1), true);
    }
  }

  return <div className="kw-date-picker">
    <button ref={trigger} type="button" className="kw-date-trigger" aria-label={`${label}，${dateLabel(date)}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => {
        setMonth(monthOf(date)); setFocused(date); focusRequested.current = true;
        panel.current?.togglePopover(); setOpen(panel.current?.matches(":popover-open") ?? false);
      }}>
      <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="3" y="4" width="14" height="13" rx="2"/><path d="M6 2v4m8-4v4M3 8h14"/></svg>
      <span>{date.replaceAll("-", "/")}</span>
    </button>
    <div ref={panel} id={id} className="kw-date-popover" popover="auto" role="dialog" aria-label={`${label}选择器`}
      onToggle={event => setOpen(event.currentTarget.matches(":popover-open"))}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <header><button type="button" aria-label="日历上个月" disabled={month <= "1900-01"} onClick={() => changeMonth(-1)}>‹</button>
        <strong aria-live="polite">{monthLabel}</strong>
        <button type="button" aria-label="日历下个月" disabled={month >= monthOf(maxDate)} onClick={() => changeMonth(1)}>›</button></header>
      <div role="grid" aria-label={monthLabel} className="kw-date-grid">
        <div role="row" className="kw-date-weekdays">{MONDAY_WEEKDAYS.map(day => <span role="columnheader" key={day}>{day}</span>)}</div>
        {Array.from({ length: cells.length / 7 }, (_, row) => <div role="row" className="kw-date-week" key={row}>
          {cells.slice(row * 7, row * 7 + 7).map(cell => <div role="gridcell" aria-selected={cell.date === date} key={cell.date}>
            <button type="button" className="kw-date-day" data-date={cell.date} data-outside={!cell.inMonth}
              aria-label={dateLabel(cell.date)} aria-current={cell.date === maxDate ? "date" : undefined}
              aria-pressed={cell.date === date} disabled={cell.future || cell.date < "1900-01-01"}
              tabIndex={cell.date === focused ? 0 : -1} onFocus={() => setFocused(cell.date)}
              onKeyDown={event => navigate(event, cell.date)} onClick={() => select(cell.date)}>{cell.day}</button>
          </div>)}
        </div>)}
      </div>
      <footer><button type="button" onClick={() => select(maxDate)}>今天</button><button type="button" onClick={close}>关闭</button></footer>
    </div>
  </div>;
}
