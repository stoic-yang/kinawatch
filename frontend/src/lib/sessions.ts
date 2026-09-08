import type { DayResponse, ScreenTimelineBlock } from "../api";

export interface CategorySlice {
  category: string;
  label: string;
  seconds: number;
}

export interface AppSlice {
  app: string;
  seconds: number;
  category: string;
}

export interface ScreenSession {
  workflowId?: string;
  start: string;
  end: string;
  seconds: number;
  categories: CategorySlice[];
  topApps: AppSlice[];
}

function toMs(iso: string): number {
  return new Date(iso).getTime();
}

function summarizeCategories(blocks: ScreenTimelineBlock[]): CategorySlice[] {
  const byCat = new Map<string, CategorySlice>();
  for (const b of blocks) {
    const cur = byCat.get(b.category) ?? {
      category: b.category,
      label: b.category_label,
      seconds: 0,
    };
    cur.seconds += b.duration_seconds;
    byCat.set(b.category, cur);
  }
  return [...byCat.values()].sort((a, b) => b.seconds - a.seconds);
}

function summarizeApps(blocks: ScreenTimelineBlock[]): AppSlice[] {
  const byApp = new Map<string, { seconds: number; cats: Map<string, number> }>();
  for (const b of blocks) {
    const app = b.app || "(未知应用)";
    const cur = byApp.get(app) ?? { seconds: 0, cats: new Map() };
    cur.seconds += b.duration_seconds;
    cur.cats.set(b.category, (cur.cats.get(b.category) ?? 0) + b.duration_seconds);
    byApp.set(app, cur);
  }
  return [...byApp.entries()]
    .map(([app, v]) => ({
      app,
      seconds: v.seconds,
      category: [...v.cats.entries()].sort((a, b) => b[1] - a[1])[0][0],
    }))
    .sort((a, b) => b.seconds - a.seconds);
}

function screenBlocks(day: DayResponse): ScreenTimelineBlock[] {
  return day.timeline.filter(
    (b): b is ScreenTimelineBlock => b.kind === "screen",
  );
}

export function buildSessions(day: DayResponse): ScreenSession[] {
  const blocks = workflowBlocks(day);
  return day.workflows.sessions.flatMap(workflow => {
    const visible = blocks.filter(block => toMs(block.start) >= toMs(workflow.start)
      && toMs(block.end) <= toMs(workflow.end));
    return visible.length ? [{ ...summarizeSession(visible, workflow.id),
      start: workflow.start, end: workflow.end }] : [];
  });
}

/** Mac workflow statistics use device time, independent of mobile overlap. */
export function workflowBlocks(day: DayResponse): ScreenTimelineBlock[] {
  return screenBlocks(day)
    .filter(block => (block.source_type ?? "activitywatch-rest") === "activitywatch-rest")
    .map(block => ({ ...block, duration_seconds: block.device_duration_seconds ?? block.duration_seconds }));
}

/** Summarize a view fragment without defining another workflow boundary. */
export function summarizeSession(blocks: ScreenTimelineBlock[], workflowId?: string): ScreenSession {
  return {
    workflowId,
    start: blocks[0].start,
    end: blocks[blocks.length - 1].end,
    seconds: blocks.reduce((sum, block) => sum + block.duration_seconds, 0),
    categories: summarizeCategories(blocks),
    topApps: summarizeApps(blocks).slice(0, 3),
  };
}

export function topAppsForDay(day: DayResponse, limit = 6): AppSlice[] {
  return summarizeApps(screenBlocks(day)).slice(0, limit);
}
