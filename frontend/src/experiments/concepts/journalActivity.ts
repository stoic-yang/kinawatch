import type { DayResponse, ScreenTimelineBlock } from "../../api";
import { summarizeSession, type ScreenSession } from "../../lib/sessions";

const HALF_HOUR_MS = 30 * 60 * 1000;
const BREAK_MS = 5 * 60 * 1000;
const APP_PAUSE_MS = 60 * 1000;
const APP_CHANGE_SECONDS = 60;

/** Compact activity chapters for the writing rail; source events stay intact. */
export function buildJournalActivity(day: DayResponse | null): ScreenSession[] {
  if (!day) return [];
  const origin = Date.parse(day.range.start);
  const runs: { slot: number; app: string; blocks: ScreenTimelineBlock[]; seconds: number; end: number }[] = [];
  for (const block of day.timeline) {
    if (block.kind !== "screen" || block.duration_seconds <= 0) continue;
    const start = Date.parse(block.start), end = Date.parse(block.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    let from = start, assignedSeconds = 0;
    while (from < end) {
      const slot = Math.floor((from - origin) / HALF_HOUR_MS);
      const to = Math.min(end, origin + (slot + 1) * HALF_HOUR_MS);
      const seconds = to === end ? block.duration_seconds - assignedSeconds : block.duration_seconds * (to - from) / (end - start);
      const piece = { ...block, start: new Date(from).toISOString(), end: new Date(to).toISOString(), duration_seconds: seconds };
      const previous = runs.at(-1);
      if (previous && previous.slot === slot && previous.app === block.app && from - previous.end <= APP_PAUSE_MS) {
        previous.blocks.push(piece);
        previous.seconds += seconds;
        previous.end = to;
      } else runs.push({ slot, app: block.app, blocks: [piece], seconds, end: to });
      assignedSeconds += seconds;
      from = to;
    }
  }

  const sessions: ScreenSession[] = [];
  let blocks: ScreenTimelineBlock[] = [], currentSlot = -1, currentEnd = 0, currentSeconds = 0;
  const apps = new Map<string, number>();
  const flush = () => {
    if (blocks.length) {
      const owner = day.workflows.sessions.find(workflow =>
        Date.parse(blocks[0].start) >= Date.parse(workflow.start)
        && Date.parse(blocks[blocks.length - 1].end) <= Date.parse(workflow.end));
      sessions.push(summarizeSession(blocks, owner?.id));
    }
    blocks = [];
    apps.clear();
    currentSeconds = 0;
  };
  for (const run of runs) {
    const mainApp = [...apps.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const appChanged = run.app !== mainApp && run.seconds >= APP_CHANGE_SECONDS && currentSeconds >= APP_CHANGE_SECONDS;
    if (blocks.length && (run.slot !== currentSlot || Date.parse(run.blocks[0].start) - currentEnd >= BREAK_MS || appChanged)) flush();
    blocks.push(...run.blocks);
    apps.set(run.app, (apps.get(run.app) ?? 0) + run.seconds);
    currentSeconds += run.seconds;
    currentSlot = run.slot;
    currentEnd = run.end;
  }
  flush();
  return sessions;
}
