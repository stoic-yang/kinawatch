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
export interface WordRow extends Word { state: WordState; history: WordReview[]; again: number }
export interface WordDay { date: string; entries: number; new_entries: number; answers: number; answer_ms: number }
export type WordFilter = "all" | "new" | "learned" | "again";
export const wordStateLabels: Record<WordState, string> = { new: "未学", learning: "学习中", review: "复习中", suspended: "已暂停", buried: "已搁置" };
export const ratingLabels = ["", "重来", "困难", "良好", "简单"];

export function wordScope(snapshot: WordsSnapshot | null, deck: string) {
  const first = new Map<number, number>();
  const byNote = new Map<number, WordReview[]>();
  const days = new Map<string, WordDay>();
  const entries = new Map<string, Set<number>>();
  for (const review of snapshot?.reviews ?? []) {
    const existing = first.get(review.note_id);
    if (existing === undefined || review.id < existing) first.set(review.note_id, review.id);
  }
  let latest: string | null = null;
  for (const review of snapshot?.reviews ?? []) {
    if (deck && review.deck !== deck) continue;
    if (!byNote.has(review.note_id)) byNote.set(review.note_id, []);
    byNote.get(review.note_id)!.push(review);
    if (!days.has(review.date)) {
      days.set(review.date, { date: review.date, entries: 0, new_entries: 0, answers: 0, answer_ms: 0 });
      entries.set(review.date, new Set());
    }
    const day = days.get(review.date)!;
    entries.get(review.date)!.add(review.note_id);
    day.entries = entries.get(review.date)!.size;
    day.answers += 1; day.answer_ms += review.answer_ms;
    if (first.get(review.note_id) === review.id) day.new_entries += 1;
    if (!latest || review.date > latest) latest = review.date;
  }
  const words: WordRow[] = [];
  for (const word of snapshot?.words ?? []) {
    const cards = word.cards.filter(card => !deck || card.deck === deck);
    if (!cards.length) continue;
    const history = (byNote.get(word.id) ?? []).sort((a, b) => b.id - a.id);
    const states = new Set(cards.map(card => card.state));
    const state = (["learning", "review", "new", "buried", "suspended"] as const).find(value => states.has(value))!;
    words.push({ ...word, state, history, again: history.filter(review => review.rating === 1).length });
  }
  return { words, days, latest, learned: words.filter(word => word.history.length > 0).length };
}

export function filterWords(words: WordRow[], query: string, filter: WordFilter): WordRow[] {
  const term = query.trim().toLocaleLowerCase();
  const result = words.filter(word => (!term || `${word.term}\n${word.definition}`.toLocaleLowerCase().includes(term))
    && (filter === "all" || filter === "new" && word.state === "new" || filter === "learned" && word.history.length > 0 || filter === "again" && word.again >= 2));
  return filter === "again" ? result.sort((a, b) => b.again - a.again || b.history.length - a.history.length) : result;
}

export function wordDay(days: Map<string, WordDay>, date: string, snapshot: WordsSnapshot | null): WordDay | null {
  if (!snapshot || date > snapshot.fetched_at.slice(0, 10)) return null;
  return days.get(date) ?? { date, entries: 0, new_entries: 0, answers: 0, answer_ms: 0 };
}

export function monthCells(month: string): (string | null)[] {
  const first = new Date(`${month}-01T12:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return Array.from({ length: Math.ceil((offset + length) / 7) * 7 }, (_, i) =>
    i < offset || i >= offset + length ? null : `${month}-${String(i - offset + 1).padStart(2, "0")}`);
}
export function shiftWordMonth(month: string, offset: number): string {
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
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
