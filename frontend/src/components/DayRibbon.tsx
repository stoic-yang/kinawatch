import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ActivityEventRef,
  ScreenTimelineBlock,
  TimelineBlock,
} from "../api";
import { categoryColor } from "../lib/colors";
import { fmtClock, fmtDuration } from "../lib/format";
import { ViewportTooltip } from "./ViewportTooltip";

const W = 1000;
const LANE_Y = 6;
const LANE_H = 40;
const H = 52;
const HOUR_MS = 3600 * 1000;
const MIN_VIEW_MS = 30 * 60 * 1000;
const MIN_DISPLAY_COLUMN_PX = 1.5;

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
  moved: boolean;
}

interface TouchPoint {
  x: number;
  y: number;
}

interface TouchGeometry {
  centerX: number;
  centerY: number;
  distance: number;
  count: number;
}

interface TouchGesture extends TouchGeometry {
  view: ViewWindow;
}

function touchGeometry(points: Map<number, TouchPoint>): TouchGeometry | null {
  const [first, second] = [...points.values()];
  if (!first) return null;
  return {
    centerX: second ? (first.x + second.x) / 2 : first.x,
    centerY: second ? (first.y + second.y) / 2 : first.y,
    distance: second ? Math.hypot(first.x - second.x, first.y - second.y) : 0,
    count: second ? 2 : 1,
  };
}

interface RibbonBucketScore {
  key: string;
  block: ScreenTimelineBlock;
  activeMs: number;
  firstOffset: number;
  lastOffset: number;
  representativeOverlapMs: number;
  eventRefs: ActivityEventRef[];
  manualEdit: boolean;
  manualEditConflict: boolean;
}

interface RibbonRenderSegment {
  key: string;
  x: number;
  width: number;
  block: ScreenTimelineBlock;
  lane?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function tickStep(span: number): number {
  if (span <= HOUR_MS) return 15 * 60 * 1000;
  if (span <= 3 * HOUR_MS) return 30 * 60 * 1000;
  if (span <= 6 * HOUR_MS) return HOUR_MS;
  if (span <= 12 * HOUR_MS) return 2 * HOUR_MS;
  return 3 * HOUR_MS;
}

function blockIdentity(block: ScreenTimelineBlock): string {
  return JSON.stringify([
    block.category,
    block.app,
    block.title,
    block.project,
    block.source,
  ]);
}

function mergeEventRefs(
  current: ActivityEventRef[],
  incoming: ActivityEventRef[],
): ActivityEventRef[] {
  const result = [...current];
  const known = new Set(
    result.map((item) => `${item.bucket_id}\0${item.event_id}`),
  );
  for (const item of incoming) {
    const key = `${item.bucket_id}\0${item.event_id}`;
    if (!known.has(key)) {
      known.add(key);
      result.push(item);
    }
  }
  return result;
}

function buildRenderSegments(
  blocks: ScreenTimelineBlock[],
  axisStartMs: number,
  view: ViewWindow,
  displayWidth: number,
): RibbonRenderSegment[] {
  const columnCount = Math.max(
    1,
    Math.min(W, Math.floor(displayWidth / MIN_DISPLAY_COLUMN_PX)),
  );
  const columnSpan = view.span / columnCount;
  const viewEnd = view.start + view.span;
  const buckets = Array.from(
    { length: columnCount },
    () => new Map<string, RibbonBucketScore>(),
  );

  for (const block of blocks) {
    const blockStart = new Date(block.start).getTime() - axisStartMs;
    const blockEnd = new Date(block.end).getTime() - axisStartMs;
    const clippedStart = Math.max(blockStart, view.start);
    const clippedEnd = Math.min(blockEnd, viewEnd);
    if (clippedEnd <= clippedStart) continue;

    const key = blockIdentity(block);
    const firstColumn = clamp(
      Math.floor((clippedStart - view.start) / columnSpan),
      0,
      columnCount - 1,
    );
    const lastColumn = clamp(
      Math.ceil((clippedEnd - view.start) / columnSpan) - 1,
      0,
      columnCount - 1,
    );

    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const bucketStart = view.start + column * columnSpan;
      const bucketEnd = bucketStart + columnSpan;
      const overlapStart = Math.max(clippedStart, bucketStart);
      const overlapEnd = Math.min(clippedEnd, bucketEnd);
      const overlapMs = overlapEnd - overlapStart;
      if (overlapMs <= 0) continue;

      const existing = buckets[column].get(key);
      if (existing) {
        existing.activeMs += overlapMs;
        existing.firstOffset = Math.min(existing.firstOffset, overlapStart);
        existing.lastOffset = Math.max(existing.lastOffset, overlapEnd);
        if (overlapMs > existing.representativeOverlapMs) {
          existing.block = block;
          existing.representativeOverlapMs = overlapMs;
        }
        existing.eventRefs = mergeEventRefs(
          existing.eventRefs,
          block.event_refs ?? [],
        );
        existing.manualEdit ||= Boolean(block.manual_edit);
        existing.manualEditConflict ||= Boolean(block.manual_edit_conflict);
      } else {
        buckets[column].set(key, {
          key,
          block,
          activeMs: overlapMs,
          firstOffset: overlapStart,
          lastOffset: overlapEnd,
          representativeOverlapMs: overlapMs,
          eventRefs: [...(block.event_refs ?? [])],
          manualEdit: Boolean(block.manual_edit),
          manualEditConflict: Boolean(block.manual_edit_conflict),
        });
      }
    }
  }

  const winners = buckets.map((bucket) => {
    let winner: RibbonBucketScore | null = null;
    for (const candidate of bucket.values()) {
      if (
        !winner ||
        candidate.activeMs > winner.activeMs ||
        (candidate.activeMs === winner.activeMs &&
          candidate.representativeOverlapMs >
            winner.representativeOverlapMs) ||
        (candidate.activeMs === winner.activeMs &&
          candidate.representativeOverlapMs ===
            winner.representativeOverlapMs &&
          candidate.key < winner.key)
      ) {
        winner = candidate;
      }
    }
    return winner;
  });

  const segments: RibbonRenderSegment[] = [];
  let current:
    | (RibbonBucketScore & {
        startColumn: number;
        endColumn: number;
      })
    | null = null;

  const commitCurrent = () => {
    if (!current) return;
    const firstTime = axisStartMs + current.firstOffset;
    const lastTime = axisStartMs + current.lastOffset;
    const activeMs = Math.min(
      current.activeMs,
      current.lastOffset - current.firstOffset,
    );
    segments.push({
      key: `${current.key}-${current.startColumn}`,
      x: (current.startColumn / columnCount) * W,
      width: ((current.endColumn - current.startColumn) / columnCount) * W,
      block: {
        ...current.block,
        start: new Date(firstTime).toISOString(),
        end: new Date(lastTime).toISOString(),
        duration_seconds: activeMs / 1000,
        event_refs: current.eventRefs,
        manual_edit: current.manualEdit,
        manual_edit_conflict: current.manualEditConflict,
      },
    });
  };

  winners.forEach((winner, column) => {
    if (winner && current?.key === winner.key) {
      current.endColumn = column + 1;
      current.activeMs += winner.activeMs;
      current.firstOffset = Math.min(
        current.firstOffset,
        winner.firstOffset,
      );
      current.lastOffset = Math.max(current.lastOffset, winner.lastOffset);
      if (
        winner.representativeOverlapMs > current.representativeOverlapMs
      ) {
        current.block = winner.block;
        current.representativeOverlapMs = winner.representativeOverlapMs;
      }
      current.eventRefs = mergeEventRefs(
        current.eventRefs,
        winner.eventRefs,
      );
      current.manualEdit ||= winner.manualEdit;
      current.manualEditConflict ||= winner.manualEditConflict;
      return;
    }

    commitCurrent();
    current = winner
      ? {
          ...winner,
          startColumn: column,
          endColumn: column + 1,
        }
      : null;
  });
  commitCurrent();

  return segments;
}

export function DayRibbon({
  rangeStart,
  rangeEnd,
  timezone,
  timeline,
  onSelectBlock,
  showControls = false,
  touchZoom = false,
  isVisible = true,
}: {
  rangeStart: string;
  rangeEnd: string;
  timezone: string;
  timeline: TimelineBlock[];
  onSelectBlock?: (block: ScreenTimelineBlock) => void;
  showControls?: boolean;
  touchZoom?: boolean;
  isVisible?: boolean;
}) {
  const start = new Date(rangeStart).getTime();
  const axisSpan = Math.max(
    MIN_VIEW_MS,
    new Date(rangeEnd).getTime() - start,
  );
  const [hover, setHover] = useState<Hover | null>(null);
  const [view, setView] = useState<ViewWindow>({
    start: 0,
    span: axisSpan,
  });
  const [dragging, setDragging] = useState(false);
  const [ribbonWidth, setRibbonWidth] = useState(W);
  const viewRef = useRef(view);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const touchPointsRef = useRef(new Map<number, TouchPoint>());
  const touchGestureRef = useRef<TouchGesture | null>(null);
  const suppressTouchClickRef = useRef(false);
  const ribbonRef = useRef<SVGSVGElement | null>(null);
  const dismissHover = useCallback(() => setHover(null), []);

  useLayoutEffect(() => { viewRef.current = view; }, [view]);

  useEffect(() => {
    dragRef.current = null;
    setDragging(false);
    const element = ribbonRef.current;
    const points = touchPointsRef.current;
    return () => {
      const captured = [...points.keys()];
      if (captured.length) suppressTouchClickRef.current = true;
      points.clear();
      touchGestureRef.current = null;
      captured.forEach(pointerId => {
        if (element?.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      });
    };
  }, [touchZoom, isVisible, rangeStart, rangeEnd]);

  useEffect(() => {
    setView({ start: 0, span: axisSpan });
    setHover(null);
  }, [axisSpan, rangeEnd, rangeStart]);

  useLayoutEffect(() => {
    const element = ribbonRef.current;
    if (!element || !isVisible) return;

    const updateWidth = (width: number) => {
      const nextWidth = Math.max(1, Math.round(width));
      setRibbonWidth((previous) =>
        previous === nextWidth ? previous : nextWidth,
      );
    };
    updateWidth(element.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) updateWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) setHover(null);
  }, [isVisible]);

  const blocks = useMemo(
    () =>
      timeline.filter((b): b is ScreenTimelineBlock => b.kind === "screen"),
    [timeline],
  );

  const activityFocus = useMemo(() => {
    if (blocks.length === 0) {
      const now = Date.now() - start;
      return now >= 0 && now <= axisSpan ? now : axisSpan / 2;
    }
    const first = Math.min(
      ...blocks.map((block) => new Date(block.start).getTime() - start),
    );
    const last = Math.max(
      ...blocks.map((block) => new Date(block.end).getTime() - start),
    );
    return clamp((first + last) / 2, 0, axisSpan);
  }, [axisSpan, blocks, start]);

  const visibleBlocks = useMemo(() => {
    const end = view.start + view.span;
    return blocks.filter((block) => {
      const blockStart = new Date(block.start).getTime() - start;
      const blockEnd = new Date(block.end).getTime() - start;
      return blockEnd > view.start && blockStart < end;
    });
  }, [blocks, start, view]);

  const laneNames = useMemo(() => {
    const names = [...new Set(blocks.map(block => block.source_type === "apple-screentime" ? block.source : "Mac"))];
    return names.length ? names : ["Mac"];
  }, [blocks]);
  const multiLane = laneNames.length > 1;
  const graphHeight = multiLane ? laneNames.length * 64 : H;
  const laneY = (index: number) => multiLane ? index * 64 + 24 : LANE_Y;
  const laneHeight = multiLane ? 32 : LANE_H;
  const renderSegments = useMemo(
    () => laneNames.flatMap((name, lane) => buildRenderSegments(visibleBlocks.filter(block =>
      (block.source_type === "apple-screentime" ? block.source : "Mac") === name), start, view, ribbonWidth)
      .map(segment => ({ ...segment, key: `${lane}-${segment.key}`, lane }))),
    [ribbonWidth, start, view, visibleBlocks, laneNames],
  );

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
      const clock = fmtClock(
        new Date(start + offset).toISOString(),
        timezone,
      );
      const text = step < HOUR_MS ? clock : clock.slice(0, 2);
      result.push({
        offset,
        xPos: ((offset - view.start) / view.span) * W,
        text,
      });
    }
    return result;
  }, [start, timezone, view]);

  const resetView = () => setView({ start: 0, span: axisSpan });

  const viewClock = (offset: number) => {
    const time = new Date(start + offset);
    const dayOptions = { timeZone: timezone };
    const nextDay = time.toLocaleDateString("en-CA", dayOptions) !== new Date(start).toLocaleDateString("en-CA", dayOptions);
    return `${nextDay ? "次日 " : ""}${fmtClock(time.toISOString(), timezone)}`;
  };

  const panBy = (direction: number) => {
    setView((previous) => ({
      ...previous,
      start: clamp(
        previous.start + previous.span * direction * 0.5,
        0,
        axisSpan - previous.span,
      ),
    }));
  };

  const zoomBy = (factor: number, anchor = 0.5) => {
    setView((previous) => {
      const nextSpan = clamp(
        previous.span * factor,
        MIN_VIEW_MS,
        axisSpan,
      );
      const anchorTime = previous.start + previous.span * anchor;
      const nextStart = clamp(
        anchorTime - nextSpan * anchor,
        0,
        axisSpan - nextSpan,
      );
      return { start: nextStart, span: nextSpan };
    });
  };

  const zoomIn = () => {
    setView((previous) => {
      const nextSpan = clamp(
        previous.span * 0.625,
        MIN_VIEW_MS,
        axisSpan,
      );
      return {
        start: clamp(
          activityFocus - nextSpan / 2,
          0,
          axisSpan - nextSpan,
        ),
        span: nextSpan,
      };
    });
  };

  useEffect(() => {
    const element = ribbonRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      const rect = element.getBoundingClientRect();

      // Preserve ordinary page scrolling over the timeline. Zoom is an
      // intentional modified gesture (and trackpad pinch reports ctrlKey),
      // while a horizontal gesture pans only after the view is zoomed in.
      if (!event.metaKey && !event.ctrlKey) {
        const horizontal =
          Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey;
        if (!horizontal || view.span >= axisSpan) return;

        event.preventDefault();
        const delta = event.shiftKey ? event.deltaY : event.deltaX;
        setView((previous) => ({
          ...previous,
          start: clamp(
            previous.start + (delta / rect.width) * previous.span,
            0,
            axisSpan - previous.span,
          ),
        }));
        return;
      }

      event.preventDefault();
      setView((previous) => {
        const anchor = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const delta = clamp(event.deltaY, -180, 180);
        const nextSpan = clamp(
          previous.span * Math.exp(delta * 0.0028),
          MIN_VIEW_MS,
          axisSpan,
        );
        const anchorTime = previous.start + previous.span * anchor;
        return {
          start: clamp(
            anchorTime - nextSpan * anchor,
            0,
            axisSpan - nextSpan,
          ),
          span: nextSpan,
        };
      });
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [axisSpan, view.span]);

  const rebaseTouchGesture = () => {
    const geometry = touchGeometry(touchPointsRef.current);
    touchGestureRef.current = geometry ? { ...geometry, view: { ...viewRef.current } } : null;
  };

  const captureTouches = (element: SVGSVGElement) => {
    touchPointsRef.current.forEach((_point, pointerId) => {
      if (!element.hasPointerCapture(pointerId)) element.setPointerCapture(pointerId);
    });
  };

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    if (touchZoom && event.pointerType === "touch") {
      if (touchPointsRef.current.size === 0) {
        suppressTouchClickRef.current = false;
        viewRef.current = view;
      }
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPointsRef.current.size > 1) {
        suppressTouchClickRef.current = true;
        event.preventDefault();
        captureTouches(event.currentTarget);
      }
      rebaseTouchGesture();
      setDragging(true);
      setHover(null);
      return;
    }
    if (touchPointsRef.current.size > 0) return;
    suppressTouchClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      viewStart: view.start,
      viewSpan: view.span,
      moved: false,
    };
    setDragging(true);
    setHover(null);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const geometry = touchGeometry(touchPointsRef.current);
      const gesture = touchGestureRef.current;
      if (!geometry || !gesture) return;
      if (geometry.count !== gesture.count || (gesture.count === 2 && gesture.distance < 4)) {
        rebaseTouchGesture();
        return;
      }
      if (!suppressTouchClickRef.current
        && Math.hypot(geometry.centerX - gesture.centerX, geometry.centerY - gesture.centerY) <= 4) return;

      suppressTouchClickRef.current = true;
      event.preventDefault();
      captureTouches(event.currentTarget);
      const rect = event.currentTarget.getBoundingClientRect();
      if (!rect.width) return;
      const span = clamp(
        gesture.view.span * (geometry.count === 2 ? gesture.distance / Math.max(geometry.distance, 1) : 1),
        MIN_VIEW_MS,
        axisSpan,
      );
      // Preserve the time under the initial midpoint while allowing that
      // midpoint to move, so a pinch can zoom and pan in one gesture.
      const anchorTime = gesture.view.start
        + ((gesture.centerX - rect.left) / rect.width) * gesture.view.span;
      const next = {
        start: clamp(anchorTime - ((geometry.centerX - rect.left) / rect.width) * span, 0, axisSpan - span),
        span,
      };
      viewRef.current = next;
      setView(next);
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.startX) > 4) {
      if (!drag.moved && !event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      drag.moved = true;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const delta = ((event.clientX - drag.startX) / rect.width) * drag.viewSpan;
    setView((previous) => ({
      ...previous,
      start: clamp(
        drag.viewStart - delta,
        0,
        axisSpan - previous.span,
      ),
    }));
  };

  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if (touchPointsRef.current.has(event.pointerId)) {
      if (event.type !== "pointerup") suppressTouchClickRef.current = true;
      touchPointsRef.current.delete(event.pointerId);
      // Rebase after every addition/removal: two fingers can become one (or
      // three become two) without jumping back to the old gesture's view.
      rebaseTouchGesture();
      setDragging(touchPointsRef.current.size > 0);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      // Keep suppression until a fresh pointerdown; delayed touch click events
      // must not open an inspector after the gesture has already ended.
      return;
    }
    if (dragRef.current?.pointerId === event.pointerId) {
      const moved = dragRef.current.moved;
      dragRef.current = null;
      setDragging(false);
      if (moved) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };

  return (
    <div className="ribbon-wrap">
      {showControls && <div className="ribbon-controls">
        <div className="ribbon-view-range" aria-label="当前时间范围">
          <span>{viewClock(view.start)} — {viewClock(view.start + view.span)}</span>
          <small>{fmtDuration(view.span / 1000)}</small>
        </div>
        <div className="ribbon-view-actions" role="group" aria-label="时间线视图控制">
          <button type="button" aria-label="时间线向前平移" title="向前平移半个视窗" disabled={view.start <= 0} onClick={() => panBy(-1)}>←</button>
          <button type="button" aria-label="时间线向后平移" title="向后平移半个视窗" disabled={view.start + view.span >= axisSpan} onClick={() => panBy(1)}>→</button>
          <span className="ribbon-control-divider" aria-hidden="true"/>
          <button type="button" aria-label="缩小时间线" title="缩小（−）" disabled={view.span >= axisSpan} onClick={() => zoomBy(1.6)}>−</button>
          <button type="button" aria-label="放大时间线" title="放大（+）" disabled={view.span <= MIN_VIEW_MS} onClick={zoomIn}>+</button>
          <button type="button" className="ribbon-reset" aria-label="时间线恢复全天" title="恢复全天（0）" disabled={view.span >= axisSpan} onClick={resetView}>全天</button>
        </div>
      </div>}
      <div className="ribbon-device-surface" style={{ position: "relative" }}>
      {multiLane && <div className="ribbon-device-labels" aria-hidden="true">{laneNames.map((name, index) => <span key={name} style={{ position: "absolute", top: index * 60, fontSize: 11, pointerEvents: "none" }}>{name}</span>)}</div>}
      <svg
        ref={ribbonRef}
        viewBox={`0 0 ${W} ${graphHeight}`}
        style={multiLane ? { height: laneNames.length * 60 } : undefined}
        className={`ribbon ${dragging ? "ribbon-dragging" : ""}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`当日活动时间轴，当前范围 ${viewClock(view.start)} 至 ${viewClock(view.start + view.span)}；点击活动块查看详情；按住 Command 或 Control 滚动可缩放，${touchZoom ? "双指缩放，" : ""}拖动或左右键平移，加减键缩放，0 或双击恢复全天`}
        data-view-start={view.start}
        data-view-span={view.span}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={(event) => {
          // Capturing a touch on the SVG can release implicit capture on a
          // child rect; that bubbled event does not end the SVG's gesture.
          if (event.target === event.currentTarget) endDrag(event);
        }}
        onDoubleClick={resetView}
        onKeyDown={(event) => {
          switch (event.key) {
            case "+": case "=": event.preventDefault(); zoomIn(); break;
            case "-": event.preventDefault(); zoomBy(1.6); break;
            case "0": event.preventDefault(); resetView(); break;
            case "ArrowLeft": event.preventDefault(); panBy(-1); break;
            case "ArrowRight": event.preventDefault(); panBy(1); break;
          }
        }}
        onMouseLeave={dismissHover}
      >
        {laneNames.map((name, index) => <rect key={name} x={0} y={laneY(index)} width={W}
          height={laneHeight} className="ribbon-lane" rx={5}/>)}
        {ticks
          .filter((tick) => tick.xPos > 0.5 && tick.xPos < W - 0.5)
          .map((tick) => (
            <line
              key={tick.offset}
              x1={tick.xPos}
              x2={tick.xPos}
              y1={LANE_Y}
              y2={graphHeight - 6}
              className="ribbon-grid"
            />
          ))}

        {renderSegments.map((segment) => {
          const block = segment.block;
          return (
            <rect
              key={segment.key}
              x={segment.x}
              y={laneY(segment.lane)}
              width={segment.width}
              height={laneHeight}
              fill={categoryColor(block.category)}
              className={`ribbon-block ${
                block.manual_edit ? "ribbon-block-edited" : ""
              } ${
                block.manual_edit_conflict
                  ? "ribbon-block-edit-conflict"
                  : ""
              }`}
              role="button"
              tabIndex={0}
              aria-label={`${fmtClock(block.start, timezone)} 到 ${fmtClock(
                block.end,
                timezone,
              )}，${block.app || "未知应用"}，${block.category_label}，${block.source_type === "apple-screentime" ? block.source : "Mac"}，查看详情`}
              onClick={() => {
                if (suppressClickRef.current || suppressTouchClickRef.current) return;
                onSelectBlock?.(block);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectBlock?.(block);
                }
              }}
              onMouseMove={(event) => {
                if (!dragRef.current && touchPointsRef.current.size === 0) {
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
            y2={graphHeight - 2}
            className="ribbon-now"
          />
        )}

      </svg>
      </div>
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
      {hover && isVisible && (
        <RibbonTooltip
          hover={hover}
          timezone={timezone}
          onDismiss={dismissHover}
        />
      )}
    </div>
  );
}

function RibbonTooltip({
  hover,
  timezone,
  onDismiss,
}: {
  hover: Hover;
  timezone: string;
  onDismiss: () => void;
}) {
  const block = hover.block;
  return (
    <ViewportTooltip
      className="tooltip"
      anchor={{ x: hover.clientX, top: hover.clientY, bottom: hover.clientY }}
      side="below"
      align="after"
      onDismiss={onDismiss}
    >
      <div className="tooltip-time">
        {fmtClock(block.start, timezone)}–{fmtClock(block.end, timezone)} ·{" "}
        {fmtDuration(block.duration_seconds)}
      </div>
      <div className="tooltip-title">{block.app || "(未知应用)"}</div>
      {block.source_type === "apple-screentime" && <div className="tooltip-sub">{block.source} · 屏幕时间</div>}
      {block.title && <div className="tooltip-sub">{block.title}</div>}
      <div className="tooltip-cat">
        <i style={{ background: categoryColor(block.category) }} />
        {block.category_label}
        {block.project && ` · ${block.project}`}
      </div>
      {block.manual_edit && (
        <div className="tooltip-edit-state">已手动校正</div>
      )}
      {block.manual_edit_conflict && (
        <div className="tooltip-edit-state tooltip-edit-conflict">
          原始事件已变化，校正未应用
        </div>
      )}
    </ViewportTooltip>
  );
}
