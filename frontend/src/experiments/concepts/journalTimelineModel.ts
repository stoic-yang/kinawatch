import type { DayResponse, ScreenTimelineBlock } from "../../api";
import { buildJournalActivity } from "./journalActivity";

export type JournalTimelineBar = { block: ScreenTimelineBlock; from: number; to: number };
export type JournalTimelineView = { start: number; span: number };
const MINUTE = 60000;
const MIN_SPAN = 5 * MINUTE;

export function clampJournalTimelineView(view: JournalTimelineView, total: number): JournalTimelineView {
  if (total <= 0) return { start: 0, span: 0 };
  const span = Math.min(total, Math.max(Math.min(MIN_SPAN, total), view.span));
  return { start: Math.max(0, Math.min(total - span, view.start)), span };
}

export function zoomJournalTimeline(view: JournalTimelineView, total: number, factor: number, anchor: number): JournalTimelineView {
  const point = Math.max(0, Math.min(1, anchor));
  const { span } = clampJournalTimelineView({ ...view, span: view.span * factor }, total);
  return clampJournalTimelineView({ start: view.start + (view.span - span) * point, span }, total);
}

export function journalTimelineInView(bars: JournalTimelineBar[], total: number, view: JournalTimelineView) {
  if (view.span <= 0) return [];
  return bars.flatMap((bar, index) => {
    const from = Math.max(0, (bar.from * total - view.start) / view.span);
    const to = Math.min(1, (bar.to * total - view.start) / view.span);
    return to > from ? [{ ...bar, from, to, index }] : [];
  });
}

export function journalTimelineTicks(view: JournalTimelineView, height: number): number[] {
  if (view.span <= 0) return [];
  const minimum = view.span / Math.max(2, Math.floor(height / 56));
  const step = ([1, 2, 5, 10, 15, 30, 60, 120, 180, 360].find(minutes => minutes * MINUTE >= minimum) ?? 360) * MINUTE;
  const end = view.start + view.span, ticks = [];
  for (let offset = Math.ceil(view.start / step) * step; offset <= end; offset += step) {
    const y = (offset - view.start) / view.span * height;
    if (y >= 30 && height - y >= 30) ticks.push(offset);
  }
  return [view.start, ...ticks, end];
}

/** Pick by time, including subpixel events that SVG cannot reliably hit-test. */
export function journalTimelineBarAt(bars: JournalTimelineBar[], position: number, tolerance: number): number {
  let nearest = -1, distance = tolerance;
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    if (position >= bar.from && position < bar.to) return index;
    const gap = Math.min(Math.abs(position - bar.from), Math.abs(position - bar.to));
    if (gap < distance) { nearest = index; distance = gap; }
  }
  return nearest;
}

/** Actual screen intervals share one continuous time scale, including idle gaps. */
export function buildJournalTimeline(day: DayResponse | null) {
  const start = day ? Date.parse(day.range.start) : 0;
  const end = day ? Date.parse(day.range.end) : 0;
  const span = end - start;
  const groups = buildJournalActivity(day);
  const bars = (day?.timeline ?? []).flatMap(block => {
    if (block.kind !== "screen" || span <= 0) return [];
    const from = Math.max(start, Date.parse(block.start)), to = Math.min(end, Date.parse(block.end));
    if (to <= from || !Number.isFinite(from) || !Number.isFinite(to)) return [];
    return [{ block: block as ScreenTimelineBlock, from: (from - start) / span, to: (to - start) / span }];
  });
  return { start, end, span, bars, groups };
}
