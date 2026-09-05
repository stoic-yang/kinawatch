import type { DayResponse } from "../../api";
import { fmtClock } from "../../lib/format";
import {
  assignKinaSummaryToSessions,
  parseKinaSummary,
  type KinaSummaryEntry,
} from "../../lib/kinaSummary";
import { buildSessions, type ScreenSession } from "../../lib/sessions";

export interface JournalWorkflowItem {
  title: string;
  /** Complete saved/generated text, suitable for an expanded Markdown view. */
  description: string;
  source: "workflow" | "summary" | "apps";
  apps: string[];
  hasDescription: boolean;
}

function descriptionTitle(description: string): string {
  const firstLine = description.split(/\r\n|\r|\n/).find(line => line.trim())?.trim() ?? "";
  const plain = firstLine
    .replace(/^(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)、]\s+)?/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_match, target: string, label?: string) => label || target)
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/(\*\*|__|~~|`+)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ").trim();
  const sentence = (plain.match(/^.*?[。！？!?]/)?.[0] ?? plain) || firstLine;
  const characters = Array.from(sentence);
  return characters.length > 48 ? `${characters.slice(0, 47).join("")}…` : sentence;
}

/**
 * One item per visible session, in the supplied order. Categories never supply
 * task semantics: only a saved workflow, an existing summary, or actual apps do.
 */
export function buildJournalWorkflow(
  day: DayResponse | null,
  sessions: ScreenSession[],
  timezone: string,
): JournalWorkflowItem[] {
  const notesByStart = new Map(day?.journal.workflow_notes.map(note => [note.start_time, note]) ?? []);
  const summaries: KinaSummaryEntry[][] = sessions.map(() => []);

  if (day) {
    // Match SessionNotes: establish ownership before filtering, then refine only
    // among visible fragments of that original session. Removing an entire
    // session must not transfer its description to another part of the day.
    const originals = buildSessions(day);
    const originalEntries = assignKinaSummaryToSessions(
      parseKinaSummary(day.journal.activity_summary_markdown), originals, timezone,
    );
    originals.forEach((original, originalIndex) => {
      const candidateIndexes = sessions.flatMap((session, index) =>
        Date.parse(session.start) < Date.parse(original.end)
          && Date.parse(session.end) > Date.parse(original.start) ? [index] : [],
      );
      const assigned = assignKinaSummaryToSessions(
        originalEntries[originalIndex], candidateIndexes.map(index => sessions[index]), timezone,
      );
      candidateIndexes.forEach((index, candidateIndex) => summaries[index].push(...assigned[candidateIndex]));
    });
  }

  return sessions.map((session, index) => {
    const apps = [...new Set(session.topApps.map(item => item.app.trim()).filter(Boolean))];
    const manual = notesByStart.get(fmtClock(session.start, timezone));
    // Manual presence suppresses generated prose, as in SessionList. Keep the
    // full original note; trimming is only used to decide whether text exists.
    const description = manual ? manual.note : summaries[index].map(entry => entry.text).join("\n\n");
    const hasDescription = Boolean(description.trim());
    return {
      title: hasDescription ? descriptionTitle(description) : apps.join(" · ") || "屏幕活动",
      description: hasDescription ? description : "",
      source: hasDescription ? manual ? "workflow" : "summary" : "apps",
      apps,
      hasDescription,
    };
  });
}
