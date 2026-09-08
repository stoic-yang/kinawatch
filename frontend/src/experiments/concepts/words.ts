import { useEffect, useRef, useState } from "react";

export type WordState = "new" | "learning" | "review" | "suspended" | "buried";
export interface Word {
  id: number; term: string; phonetic: string; definition: string; example: string; translation: string;
  cards: { id: number; deck: string; state: WordState }[];
}
export interface WordReview {
  id: number; card_id: number; note_id: number; deck: string; date: string; time: string;
  rating: number; kind: number; answer_ms: number; interval: number;
}
export interface WordsSnapshot {
  version: number; profile: string; timezone: string; fetched_at: string;
  decks: { id: number; name: string }[]; words: Word[]; reviews: WordReview[]; skipped_notes: number;
}
export interface WordsResponse {
  available: boolean; status: "ready" | "cached" | "unavailable"; error: string | null; snapshot: WordsSnapshot | null;
}
export interface WordDay { date: string; entries: number; new_entries: number; answers: number; answer_ms: number }
export function wordScope(snapshot: WordsSnapshot | null) {
  const first = new Map<number, number>();
  const days = new Map<string, WordDay>();
  const entries = new Map<string, Set<number>>();
  for (const review of snapshot?.reviews ?? []) {
    const existing = first.get(review.note_id);
    if (existing === undefined || review.id < existing) first.set(review.note_id, review.id);
  }
  for (const review of snapshot?.reviews ?? []) {
    if (!days.has(review.date)) {
      days.set(review.date, { date: review.date, entries: 0, new_entries: 0, answers: 0, answer_ms: 0 });
      entries.set(review.date, new Set());
    }
    const day = days.get(review.date)!;
    entries.get(review.date)!.add(review.note_id);
    day.entries = entries.get(review.date)!.size;
    day.answers += 1;
    day.answer_ms += review.answer_ms;
    if (first.get(review.note_id) === review.id) day.new_entries += 1;
  }
  const words = snapshot?.words ?? [];
  return { total: words.length, days, learned: words.filter(word => first.has(word.id)).length };
}

export function wordDay(days: Map<string, WordDay>, date: string, snapshot: WordsSnapshot | null): WordDay | null {
  if (!snapshot || date > snapshot.fetched_at.slice(0, 10)) return null;
  return days.get(date) ?? { date, entries: 0, new_entries: 0, answers: 0, answer_ms: 0 };
}

export function wordYear(year: number) {
  const date = new Date(`${String(year).padStart(4, "0")}-01-01T12:00:00Z`);
  const cells: (string | null)[] = Array((date.getUTCDay() + 6) % 7).fill(null);
  const months: { label: string; column: number }[] = [];
  while (date.getUTCFullYear() === year) {
    if (date.getUTCDate() === 1) months.push({ label: `${date.getUTCMonth() + 1}月`, column: Math.floor(cells.length / 7) + 1 });
    cells.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  while (cells.length % 7) cells.push(null);
  return { cells, months, weekCount: cells.length / 7 };
}

export function answerTime(ms: number): string {
  if (!ms) return "0 分钟";
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`;
  return `${(ms / 60000).toFixed(1).replace(/\.0$/, "")} 分钟`;
}

export function useWords(active: boolean) {
  const [data, setData] = useState<WordsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const force = useRef(false);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    const url = `/api/words${force.current ? "?refresh=1" : ""}`;
    force.current = false;
    fetch(url, { signal: controller.signal, cache: "no-store" }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "单词数据暂时无法读取。");
      return result as WordsResponse;
    }).then(result => { if (!controller.signal.aborted) { setData(result); setError(null); } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "单词数据暂时无法读取。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, attempt]);
  return { data, error, loading, reload: () => { force.current = true; setAttempt(value => value + 1); } };
}
