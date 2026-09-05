import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { DayResponse } from "../../api";
import { ViewportTooltip } from "../../components/ViewportTooltip";
import { categoryColor } from "../../lib/colors";
import { fmtClock, fmtDuration } from "../../lib/format";
import { buildJournalWorkflow } from "./journalWorkflow";
import { buildJournalTimeline, clampJournalTimelineView, journalTimelineBarAt, journalTimelineInView, journalTimelineTicks, zoomJournalTimeline, type JournalTimelineView } from "./journalTimelineModel";
import "./journal-timeline.css";

type Hover = { start: string; end: string; seconds: number; app: string; title: string; category: string; description?: string; x: number; y: number };
type Drag = { pointerId: number; y: number; view: JournalTimelineView };

export function JournalTimeline({ day, displayDay, timezone, visible }: { day: DayResponse | null; displayDay: DayResponse | null; timezone: string; visible: boolean }) {
  const surface = useRef<HTMLDivElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [height, setHeight] = useState(536);
  const [hover, setHover] = useState<Hover | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const tooltipId = useId();
  const model = useMemo(() => buildJournalTimeline(displayDay), [displayDay]);
  const [viewState, setView] = useState<JournalTimelineView>({ start: 0, span: model.span });
  const view = viewState.span > 0 ? clampJournalTimelineView(viewState, model.span) : { start: 0, span: model.span };
  const viewRef = useRef(view);
  viewRef.current = view;
  const bars = useMemo(() => journalTimelineInView(model.bars, model.span, view), [model.bars, model.span, view.start, view.span]);
  const ticks = journalTimelineTicks(view, height);
  const zoomed = view.span < model.span;
  const selection = activeIndex === null ? undefined : bars.find(bar => bar.index === activeIndex);
  const workflow = useMemo(() => buildJournalWorkflow(day, model.groups, timezone), [day, model.groups, timezone]);
  const dismiss = useCallback(() => { setHover(null); setActiveIndex(null); }, []);
  const endDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    setDragging(false);
    if (current && surface.current?.hasPointerCapture(current.pointerId)) surface.current.releasePointerCapture(current.pointerId);
  }, []);

  useEffect(() => { dismiss(); endDrag(); }, [dismiss, endDrag, displayDay, visible]);
  useEffect(() => { setView({ start: 0, span: model.span }); }, [model.start, model.span]);
  useLayoutEffect(() => {
    if (!plot.current) return;
    const observer = new ResizeObserver(entries => {
      const next = entries[0].contentRect.height;
      if (next > 0) setHeight(next);
    });
    observer.observe(plot.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = surface.current;
    if (!element || !visible || model.span <= 0) return;
    const wheel = (event: WheelEvent) => {
      const bounds = plot.current!.getBoundingClientRect();
      if (bounds.height <= 0) return;
      event.preventDefault();
      endDrag();
      dismiss();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
      const pan = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const delta = (pan && !event.shiftKey ? event.deltaX : event.deltaY) * unit;
      setView(previous => {
        const current = previous.span > 0 ? previous : { start: 0, span: model.span };
        return pan
          ? clampJournalTimelineView({ ...current, start: current.start + delta / bounds.height * current.span }, model.span)
          : zoomJournalTimeline(current, model.span, Math.exp(Math.max(-240, Math.min(240, delta)) * 0.003), (event.clientY - bounds.top) / bounds.height);
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [visible, model.span, dismiss, endDrag]);

  const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const nextDay = (instant: number) => date.format(new Date(instant)) !== date.format(new Date(model.start));
  const rangeLabel = (start: string, end: string) => {
    const clock = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", ...(Date.parse(end) - Date.parse(start) < 60000 ? { second: "2-digit" as const } : {}), hourCycle: "h23" });
    return `${nextDay(Date.parse(start)) ? "次日 " : ""}${clock.format(new Date(start))} — ${date.format(new Date(start)) !== date.format(new Date(end)) ? "次日 " : ""}${clock.format(new Date(end))}`;
  };
  function reset() { endDrag(); dismiss(); setView({ start: 0, span: model.span }); }
  function showActivity(index: number, x: number, y: number) {
    const { block } = model.bars[index];
    const group = model.groups.findIndex(group => Date.parse(block.start) >= Date.parse(group.start) && Date.parse(block.start) < Date.parse(group.end));
    setActiveIndex(index);
    setHover({ start: block.start, end: block.end, seconds: block.duration_seconds, app: block.app || "屏幕活动", title: block.title?.trim() ?? "", category: block.category, description: workflow[group]?.description, x, y });
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const bounds = plot.current!.getBoundingClientRect();
    if (drag.current) {
      if (event.pointerId !== drag.current.pointerId) return;
      const delta = event.clientY - drag.current.y;
      if (Math.abs(delta) < 3 && !dragging) return;
      setDragging(true);
      dismiss();
      setView(clampJournalTimelineView({ ...drag.current.view, start: drag.current.view.start - delta / bounds.height * drag.current.view.span }, model.span));
    } else {
      const track = plot.current!.querySelector(".journal-vertical-track")!.getBoundingClientRect();
      if (event.clientX < track.left - 8 || event.clientX > track.right + 8) { dismiss(); return; }
      const index = journalTimelineBarAt(bars, (event.clientY - bounds.top) / bounds.height, 2 / bounds.height);
      if (index < 0) dismiss();
      else showActivity(bars[index].index, event.clientX, event.clientY);
    }
  }
  function focusActivity(index: number) {
    const bar = model.bars[index], bounds = plot.current!.getBoundingClientRect();
    const track = plot.current!.querySelector(".journal-vertical-track")!.getBoundingClientRect();
    const from = bar.from * model.span, to = bar.to * model.span;
    let next = view;
    if (to <= view.start || from >= view.start + view.span) {
      next = clampJournalTimelineView({ ...view, start: (from + to - view.span) / 2 }, model.span);
      setView(next);
    }
    const midpoint = (Math.max(from, next.start) + Math.min(to, next.start + next.span)) / 2;
    showActivity(index, track.right, bounds.top + (midpoint - next.start) / next.span * bounds.height);
  }

  return <section className="journal-mini-timeline" aria-label="当天活动时间线">
    <header>
      <h2>工作流</h2>
      <span className="journal-mini-total" aria-label="全天屏幕时间">{displayDay ? fmtDuration(model.groups.reduce((total, group) => total + group.seconds, 0)) : "—"}<span className="journal-mini-total-caption">屏幕时间</span></span>
    </header>
    <div ref={surface} className={`journal-vertical-timeline${zoomed ? " is-zoomed" : ""}${dragging ? " is-dragging" : ""}`} role="group" tabIndex={model.bars.length ? 0 : undefined}
      aria-label="当天竖向时间线；滚轮缩放，拖动或 Shift 加滚轮平移，双击或 0 恢复全天，上下方向键逐条查看活动，加减键缩放" aria-describedby={hover ? tooltipId : undefined}
      data-view-start={view.start} data-view-span={view.span}
      onBlur={() => { dismiss(); endDrag(); }} onPointerLeave={() => { if (!drag.current) dismiss(); }}
      onDoubleClick={reset} onPointerMove={pointerMove}
      onPointerDown={event => {
        if (event.button !== 0 || event.pointerType === "touch" || !zoomed) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        drag.current = { pointerId: event.pointerId, y: event.clientY, view: viewRef.current };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={endDrag} onPointerCancel={endDrag}
      onLostPointerCapture={event => { if (event.target === event.currentTarget) endDrag(); }}
      onKeyDown={event => {
        if (event.key === "Escape") { dismiss(); endDrag(); return; }
        if (event.key === "0") { event.preventDefault(); reset(); return; }
        if (["+", "=", "-", "PageUp", "PageDown"].includes(event.key)) {
          event.preventDefault(); dismiss(); endDrag();
          setView(previous => {
            const current = previous.span > 0 ? previous : { start: 0, span: model.span };
            return event.key === "PageUp" || event.key === "PageDown"
              ? clampJournalTimelineView({ ...current, start: current.start + current.span * (event.key === "PageUp" ? -0.8 : 0.8) }, model.span)
              : zoomJournalTimeline(current, model.span, event.key === "-" ? 1.6 : 0.625, 0.5);
          });
          return;
        }
        if (!model.bars.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = event.key === "Home" ? 0 : event.key === "End" ? model.bars.length - 1 : Math.max(0, Math.min(model.bars.length - 1, (activeIndex ?? (event.key === "ArrowDown" ? (bars[0]?.index ?? 0) - 1 : (bars.at(-1)?.index ?? model.bars.length - 1) + 1)) + (event.key === "ArrowDown" ? 1 : -1)));
        focusActivity(index);
      }}>
      <div className="journal-vertical-plot" ref={plot}>
        {zoomed && <button className="journal-timeline-reset" type="button" aria-label="恢复全天时间线" title="恢复全天（双击或 0）" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={reset}>↺</button>}
        {ticks.map((offset, index) => <div className={`journal-vertical-tick${index === ticks.length - 1 ? " is-end" : ""}`} key={offset} style={{ top: `${(offset - view.start) / view.span * 100}%` }} aria-hidden="true">
          <time>{fmtClock(new Date(model.start + offset).toISOString(), timezone)}{nextDay(model.start + offset) && <small>次日</small>}</time><i />
        </div>)}
        <svg className="journal-vertical-track" viewBox="0 0 20 1000" preserveAspectRatio="none" aria-hidden="true">
          {bars.map(({ block, from, to, index }) => <rect key={`${block.start}-${index}`} x="0" y={from * 1000} width="20" height={(to - from) * 1000} fill={categoryColor(block.category)} />)}
        </svg>
        {selection && <div className="journal-vertical-selection" aria-hidden="true" style={{ top: `${selection.from * 100}%`, height: `${(selection.to - selection.from) * 100}%` }} />}
        {displayDay && !model.bars.length && <p className="journal-vertical-empty">暂无屏幕活动</p>}
      </div>
    </div>
    {visible && hover && <ViewportTooltip id={tooltipId} className="tooltip journal-vertical-tooltip" anchor={{ x: hover.x, top: hover.y, bottom: hover.y }} side="below" align="after" onDismiss={dismiss}>
      <div className="tooltip-time">{rangeLabel(hover.start, hover.end)} · {fmtDuration(hover.seconds)}</div>
      <div className="journal-tooltip-app"><i style={{ background: categoryColor(hover.category) }} />{hover.app}</div>
      {hover.title && <div className="tooltip-title">{hover.title}</div>}
      {hover.description && <p className="tooltip-sub">{hover.description}</p>}
    </ViewportTooltip>}
  </section>;
}
