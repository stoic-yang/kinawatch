import type { DayResponse, ScreenTimelineBlock } from "../api";

// A "session" is a stretch of screen activity with no gap longer than
// SESSION_GAP_SECONDS. This is a presentation-level grouping computed on the
// client; the backend timeline stays authoritative.
const SESSION_GAP_SECONDS = 15 * 60;

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
  const sessions: ScreenSession[] = [];
  let current: ScreenTimelineBlock[] = [];

  const flush = () => {
    if (current.length === 0) return;
    sessions.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      seconds: current.reduce((s, b) => s + b.duration_seconds, 0),
      categories: summarizeCategories(current),
      topApps: summarizeApps(current).slice(0, 3),
    });
    current = [];
  };

  for (const block of screenBlocks(day)) {
    const last = current[current.length - 1];
    if (last && toMs(block.start) - toMs(last.end) > SESSION_GAP_SECONDS * 1000) {
      flush();
    }
    current.push(block);
  }
  flush();
  return sessions;
}

export function topAppsForDay(day: DayResponse, limit = 6): AppSlice[] {
  return summarizeApps(screenBlocks(day)).slice(0, limit);
}
