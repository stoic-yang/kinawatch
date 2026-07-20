import { useEffect, useMemo, useRef, useState } from "react";
import type { DayMode, ScreenTimelineBlock, TimelineBlock } from "../api";
import { categoryColor } from "../lib/colors";
import { fmtClock, fmtDuration, parseLocalDate } from "../lib/format";

const W = 1000;
const LANE_Y = 6;
const LANE_H = 40;
const H = 52;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_VIEW_MS = 30 * 60 * 1000;

interface Hover {
  block: ScreenTimelineBlock;
  clientX: number;
  clientY: number;
}

interface ViewWindow {
  start: number;
  span: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  viewStart: number;
  viewSpan: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function axisStart(date: string, mode: DayMode): number {
  const d = parseLocalDate(date);
  if (mode === "routine") d.setHours(6);
  return d.getTime();
}

function tickStep(span: number): number {
  if (span <= HOUR_MS) return 15 * 60 * 1000;
  if (span <= 3 * HOUR_MS) return 30 * 60 * 1000;
  if (span <= 6 * HOUR_MS) return HOUR_MS;
  if (span <= 12 * HOUR_MS) return 2 * HOUR_MS;
  return 3 * HOUR_MS;
}

export function DayRibbon({
  date,
  mode,
  timeline,
}: {
  date: string;
  mode: DayMode;
  timeline: TimelineBlock[];
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [view, setView] = useState<ViewWindow>({ start: 0, span: DAY_MS });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const ribbonRef = useRef<SVGSVGElement | null>(null);
  const start = axisStart(date, mode);

  useEffect(() => {
    setView({ start: 0, span: DAY_MS });
    setHover(null);
  }, [date, mode]);

  const blocks = useMemo(
    () =>
      timeline.filter((b): b is ScreenTimelineBlock => b.kind === "screen"),
    [timeline],
  );

  const activityFocus = useMemo(() => {
    if (blocks.length === 0) {
      const now = Date.now() - start;
      return now >= 0 && now <= DAY_MS ? now : DAY_MS / 2;
    }
    const first = Math.min(
      ...blocks.map((block) => new Date(block.start).getTime() - start),
    );
    const last = Math.max(
      ...blocks.map((block) => new Date(block.end).getTime() - start),
    );
    return clamp((first + last) / 2, 0, DAY_MS);
  }, [blocks, start]);

  const visibleBlocks = useMemo(() => {
    const end = view.start + view.span;
    return blocks.filter((block) => {
      const blockStart = new Date(block.start).getTime() - start;
      const blockEnd = new Date(block.end).getTime() - start;
      return blockEnd > view.start && blockStart < end;
    });
  }, [blocks, start, view]);

  const x = (iso: string) => {
    const offset = new Date(iso).getTime() - start;
    return clamp(((offset - view.start) / view.span) * W, 0, W);
  };

  const nowX = useMemo(() => {
    const offset = Date.now() - start;
    if (offset < view.start || offset > view.start + view.span) return null;
    return ((offset - view.start) / view.span) * W;
  }, [start, view]);

  const ticks = useMemo(() => {
    const step = tickStep(view.span);
    const end = view.start + view.span;
    const result: { offset: number; xPos: number; text: string }[] = [];
    const first = Math.ceil(view.start / step) * step;
    for (let offset = first; offset <= end + 1; offset += step) {
      const dateAtTick = new Date(start + offset);
      const hour = String(dateAtTick.getHours()).padStart(2, "0");
      const minute = String(dateAtTick.getMinutes()).padStart(2, "0");
      const text = step < HOUR_MS ? `${hour}:${minute}` : hour;
      result.push({
        offset,
        xPos: ((offset - view.start) / view.span) * W,
        text,
      });
    }
    return result;
  }, [start, view]);

  const resetView = () => setView({ start: 0, span: DAY_MS });

  const zoomBy = (factor: number, anchor = 0.5) => {
    setView((previous) => {
      const nextSpan = clamp(
        previous.span * factor,
        MIN_VIEW_MS,
        DAY_MS,
      );
      const anchorTime = previous.start + previous.span * anchor;
      const nextStart = clamp(
        anchorTime - nextSpan * anchor,
        0,
        DAY_MS - nextSpan,
      );
      return { start: nextStart, span: nextSpan };
    });
  };

  const zoomIn = () => {
    setView((previous) => {
      const nextSpan = clamp(
        previous.span * 0.625,
        MIN_VIEW_MS,
        DAY_MS,
      );
      return {
        start: clamp(
          activityFocus - nextSpan / 2,
          0,
          DAY_MS - nextSpan,
        ),
        span: nextSpan,
      };
    });
  };

  useEffect(() => {
    const element = ribbonRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      setView((previous) => {
        if (
          Math.abs(event.deltaX) > Math.abs(event.deltaY) &&
          previous.span < DAY_MS
        ) {
          return {
            ...previous,
            start: clamp(
              previous.start + (event.deltaX / rect.width) * previous.span,
              0,
              DAY_MS - previous.span,
            ),
          };
        }
        const anchor = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const delta = clamp(event.deltaY, -180, 180);
        const nextSpan = clamp(
          previous.span * Math.exp(delta * 0.0028),
          MIN_VIEW_MS,
          DAY_MS,
        );
        const anchorTime = previous.start + previous.span * anchor;
        return {
          start: clamp(
            anchorTime - nextSpan * anchor,
            0,
            DAY_MS - nextSpan,
          ),
          span: nextSpan,
        };
      });
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      viewStart: view.start,
      viewSpan: view.span,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    setHover(null);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const delta = ((event.clientX - drag.startX) / rect.width) * drag.viewSpan;
    setView((previous) => ({
      ...previous,
      start: clamp(
        drag.viewStart - delta,
        0,
        DAY_MS - previous.span,
      ),
    }));
  };

  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };

  return (
    <div className="ribbon-wrap">
      <svg
        ref={ribbonRef}
        viewBox={`0 0 ${W} ${H}`}
        className={`ribbon ${dragging ? "ribbon-dragging" : ""}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="当日活动时间轴，可滚轮缩放、拖动平移，双击恢复全天"
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetView}
        onKeyDown={(event) => {
          if (event.key === "+" || event.key === "=") zoomIn();
          if (event.key === "-") zoomBy(1.6);
          if (event.key === "0") resetView();
        }}
        onMouseLeave={() => setHover(null)}
      >
        <rect
          x={0}
          y={LANE_Y}
          width={W}
          height={LANE_H}
          className="ribbon-lane"
          rx={5}
        />
        {ticks
          .filter((tick) => tick.xPos > 0.5 && tick.xPos < W - 0.5)
          .map((tick) => (
            <line
              key={tick.offset}
              x1={tick.xPos}
              x2={tick.xPos}
              y1={LANE_Y}
              y2={LANE_Y + LANE_H}
              className="ribbon-grid"
            />
          ))}

        {visibleBlocks.map((block) => {
          const x1 = x(block.start);
          const x2 = x(block.end);
          const width = Math.max(x2 - x1, 0.6);
          return (
            <rect
              key={`${block.start}-${block.end}-${block.app}`}
              x={x1}
              y={LANE_Y}
              width={width}
              height={LANE_H}
              fill={categoryColor(block.category)}
              className="ribbon-block"
              onMouseMove={(event) => {
                if (!dragRef.current) {
                  setHover({
                    block,
                    clientX: event.clientX,
                    clientY: event.clientY,
                  });
                }
              }}
            />
          );
        })}

        {nowX !== null && (
          <line
            x1={nowX}
            x2={nowX}
            y1={LANE_Y - 4}
            y2={LANE_Y + LANE_H + 4}
            className="ribbon-now"
          />
        )}

      </svg>
      {/* Keep glyphs outside the non-uniformly scaled SVG coordinate space. */}
      <div className="ribbon-axis" aria-hidden="true">
        {ticks.map((tick) => {
          const edgeClass =
            tick.xPos < 1
              ? " ribbon-hour-start"
              : tick.xPos > W - 1
                ? " ribbon-hour-end"
                : "";
          return (
            <span
              key={`t${tick.offset}`}
              className={`ribbon-hour${edgeClass}`}
              style={{ left: `${clamp((tick.xPos / W) * 100, 0, 100)}%` }}
            >
              {tick.text}
            </span>
          );
        })}
      </div>
      {hover && <RibbonTooltip hover={hover} />}
    </div>
  );
}

function RibbonTooltip({ hover }: { hover: Hover }) {
  const block = hover.block;
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(hover.clientX + 14, window.innerWidth - 320),
    top: hover.clientY + 16,
  };
  return (
    <div className="tooltip" style={style}>
      <div className="tooltip-time">
        {fmtClock(block.start)}–{fmtClock(block.end)} ·{" "}
        {fmtDuration(block.duration_seconds)}
      </div>
      <div className="tooltip-title">{block.app || "(未知应用)"}</div>
      {block.title && <div className="tooltip-sub">{block.title}</div>}
      <div className="tooltip-cat">
        <i style={{ background: categoryColor(block.category) }} />
        {block.category_label}
        {block.project && ` · ${block.project}`}
      </div>
    </div>
  );
}
