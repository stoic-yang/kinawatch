import type { ScreenSession } from "./sessions";
import { fmtClock } from "./format";

export interface KinaSummaryEntry {
  workflowId?: string;
  startTime: string;
  endTime: string;
  text: string;
  approximate: boolean;
}

const SUMMARY_LINE_RE = /^\s*>\s*-\s*`(?<range>[^`]+)`[\s　]*(?<text>.+?)\s*$/;
const TIME_RANGE_RE = /^(?<approximate>约)?\s*(?<start>[01]\d|2[0-3]):(?<startMinute>[0-5]\d)\s*[–—-]\s*(?<end>[01]\d|2[0-3]):(?<endMinute>[0-5]\d)$/;

function clockMinutes(clock: string): number {
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
}

function clockInterval(startClock: string, endClock: string): [number, number] {
  const start = clockMinutes(startClock);
  let end = clockMinutes(endClock);
  // A sub-minute session can format to the same HH:MM at both ends. Treat it
  // as a short/zero interval, not as a 24-hour session that captures every
  // generated description. Only a strictly earlier clock crosses midnight.
  if (end < start) end += 24 * 60;
  return [start, end];
}

function overlapMinutes(
  left: [number, number],
  right: [number, number],
): number {
  let best = 0;
  for (const offset of [-24 * 60, 0, 24 * 60]) {
    best = Math.max(
      best,
      Math.min(left[1], right[1] + offset) -
        Math.max(left[0], right[0] + offset),
    );
  }
  return Math.max(0, best);
}

function startDistance(left: number, right: number): number {
  const difference = Math.abs(left - right);
  return Math.min(difference, 24 * 60 - difference);
}

export function parseKinaSummary(markdown: string): KinaSummaryEntry[] {
  const entries: KinaSummaryEntry[] = [];
  for (const line of markdown.split("\n")) {
    const summaryMatch = SUMMARY_LINE_RE.exec(line);
    if (!summaryMatch?.groups) continue;
    const rangeMatch = TIME_RANGE_RE.exec(summaryMatch.groups.range.trim());
    if (!rangeMatch?.groups) continue;
    const identity = /\s*<!-- kina:workflow:([a-f0-9]{16}) -->\s*$/.exec(summaryMatch.groups.text);
    entries.push({
      workflowId: identity?.[1],
      startTime: `${rangeMatch.groups.start}:${rangeMatch.groups.startMinute}`,
      endTime: `${rangeMatch.groups.end}:${rangeMatch.groups.endMinute}`,
      text: summaryMatch.groups.text.replace(/\s*<!-- kina:workflow:[a-f0-9]{16} -->\s*$/, "").trim(),
      approximate: Boolean(rangeMatch.groups.approximate),
    });
  }
  return entries;
}

export function assignKinaSummaryToSessions(
  entries: KinaSummaryEntry[],
  sessions: ScreenSession[],
  timezone: string,
): KinaSummaryEntry[][] {
  const assigned = sessions.map(() => [] as KinaSummaryEntry[]);
  const intervals = sessions.map((session) =>
    clockInterval(
      fmtClock(session.start, timezone),
      fmtClock(session.end, timezone),
    ),
  );

  for (const entry of entries) {
    const entryInterval = clockInterval(entry.startTime, entry.endTime);
    let bestIndex = -1;
    let bestOverlap = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    intervals.forEach((sessionInterval, index) => {
      if (entry.workflowId && sessions[index].workflowId !== entry.workflowId) return;
      const overlap = overlapMinutes(entryInterval, sessionInterval);
      const distance = startDistance(entryInterval[0], sessionInterval[0]);
      // A removed short workflow must not donate its legacy description to
      // the nearest remaining one. Same-start matching retains minute rounding.
      if (!entry.workflowId && overlap === 0 && distance !== 0) return;
      if (
        overlap > bestOverlap ||
        (overlap === bestOverlap && distance < bestDistance)
      ) {
        bestIndex = index;
        bestOverlap = overlap;
        bestDistance = distance;
      }
    });
    if (bestIndex >= 0) assigned[bestIndex].push(entry);
  }

  return assigned;
}
