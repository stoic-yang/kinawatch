import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-words-"));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL("../src/experiments/concepts/words.ts", import.meta.url))], outfile: join(directory, "words.mjs"), bundle: true, platform: "node", format: "esm" });
const { wordScope, wordDay, wordWeek, wordStudyStats, wordYear, answerTime } = await import(pathToFileURL(join(directory, "words.mjs")).href);
const snapshot = {
  fetched_at: "2026-09-08T12:00:00+08:00", words: [
    { id: 10, term: "apple", definition: "苹果", cards: [{ id: 1, deck: "A", state: "review" }, { id: 2, deck: "B", state: "learning" }] },
    { id: 20, term: "pear", definition: "梨", cards: [{ id: 3, deck: "A", state: "new" }] },
  ], reviews: [
    { id: 100, note_id: 10, card_id: 1, deck: "A", date: "2026-05-17", rating: 1, answer_ms: 5000 },
    { id: 101, note_id: 10, card_id: 1, deck: "A", date: "2026-05-17", rating: 1, answer_ms: 3000 },
    { id: 102, note_id: 10, card_id: 2, deck: "B", date: "2026-05-18", rating: 3, answer_ms: 2000 },
  ],
};
test("sibling cards and repeated answers do not inflate new or studied entries", () => {
  const scope = wordScope(snapshot);
  assert.equal(scope.total, 2); assert.equal(scope.learned, 1);
  assert.deepEqual(scope.days.get("2026-05-17"), { date: "2026-05-17", entries: 1, new_entries: 1, answers: 2, answer_ms: 8000 });
  assert.equal(scope.days.get("2026-05-18").new_entries, 0);
});
test("first learning remains stable when review records arrive out of order", () => {
  const scope = wordScope({ ...snapshot, reviews: [...snapshot.reviews].reverse() });
  assert.equal(scope.days.get("2026-05-17").new_entries, 1);
  assert.equal(scope.days.get("2026-05-18").new_entries, 0);
  assert.equal(scope.learned, 1);
  assert.equal(snapshot.reviews[0].id, 100);
});
test("uncached dates remain unknown; absent reviews in the saved period are zero", () => {
  const scope = wordScope(snapshot);
  assert.equal(wordDay(scope.days, "2026-09-09", snapshot), null);
  assert.equal(wordDay(scope.days, "2026-09-08", snapshot).answers, 0);
  assert.equal(wordDay(scope.days, "2026-09-08", null), null);
});
test("weekly trend counts unique entries, includes recorded zeroes, and leaves unread days unknown", () => {
  const saved = { ...snapshot, fetched_at: "2026-05-18T12:00:00+08:00" };
  const week = wordWeek(wordScope(saved).days, "2026-05-20", saved);
  assert.deepEqual(week.map(day => day.date), ["2026-05-14", "2026-05-15", "2026-05-16", "2026-05-17", "2026-05-18", "2026-05-19", "2026-05-20"]);
  assert.deepEqual(week.map(day => day.value), [0, 0, 0, 1, 1, null, null]);
});
test("weekly dates remain consecutive across years, leap days and daylight-saving changes", () => {
  for (const [end, start] of [["2026-01-03", "2025-12-28"], ["2024-03-03", "2024-02-26"], ["2026-03-10", "2026-03-04"]]) {
    const week = wordWeek(new Map(), end, null);
    assert.equal(week[0].date, start);
    assert.equal(week.at(-1).date, end);
    assert.equal(new Set(week.map(day => day.date)).size, 7);
    assert.ok(week.every(day => day.value === null));
  }
});
test("annual heatmap covers each date once in Monday-first weeks", () => {
  for (const [year, length] of [[2024, 366], [2026, 365], [2012, 366], [2100, 365]]) {
    const { cells, months, weekCount } = wordYear(year);
    const dates = cells.filter(Boolean);
    assert.equal(dates.length, length);
    assert.equal(new Set(dates).size, length);
    assert.equal(dates[0], `${year}-01-01`);
    assert.equal(dates.at(-1), `${year}-12-31`);
    assert.equal(cells.length, weekCount * 7);
    assert.equal(months.length, 12);
    cells.forEach((date, index) => {
      if (date) assert.equal(index % 7, (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7);
    });
    months.forEach((month, index) => {
      const start = `${year}-${String(index + 1).padStart(2, "0")}-01`;
      assert.equal(month.column, Math.floor(cells.indexOf(start) / 7) + 1);
    });
  }
  assert.equal(wordYear(2012).weekCount, 54);
  assert.ok(wordYear(2024).cells.includes("2024-02-29"));
  assert.ok(!wordYear(2100).cells.includes("2100-02-29"));
});
test("answer duration preserves seconds and fractional minutes", () => {
  assert.equal(answerTime(0), "0 分钟"); assert.equal(answerTime(30000), "30 秒");
  assert.equal(answerTime(90000), "1.5 分钟");
});

test("cumulative study time and days count repeated answers without duplicating a day", () => {
  const stats = wordStudyStats(wordScope(snapshot).days, "2026-09-08", snapshot.fetched_at);
  assert.deepEqual(stats, { answerMs: 10000, studyDays: 2, longestStreak: 2, currentStreak: 0 });
});

function studyDays(dates) {
  return new Map(dates.map(date => [date, { date, answers: 1, entries: 1, new_entries: 0, answer_ms: 1000 }]));
}

test("current streak survives an unfinished today but ends after a missed day", () => {
  const days = studyDays(["2026-09-07", "2026-09-04", "2026-09-06"]);
  assert.equal(wordStudyStats(days, "2026-09-07", "2026-09-07T12:00:00+08:00").currentStreak, 2);
  assert.equal(wordStudyStats(days, "2026-09-08", "2026-09-08T12:00:00+08:00").currentStreak, 2);
  assert.equal(wordStudyStats(days, "2026-09-09", "2026-09-09T12:00:00+08:00").currentStreak, 0);
});

test("streaks continue through year boundaries, leap days and daylight-saving changes", () => {
  for (const dates of [
    ["2025-12-30", "2025-12-31", "2026-01-01"],
    ["2024-02-28", "2024-02-29", "2024-03-01"],
    ["2026-03-07", "2026-03-08", "2026-03-09"],
  ]) {
    const last = dates.at(-1);
    const stats = wordStudyStats(studyDays(dates), last, `${last}T12:00:00+08:00`);
    assert.equal(stats.longestStreak, 3);
    assert.equal(stats.currentStreak, 3);
  }
});

test("unread or future days cannot create streaks; an old snapshot leaves current streak unknown", () => {
  const days = studyDays(["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09"]);
  const stats = wordStudyStats(days, "2026-09-08", "2026-09-07T12:00:00+08:00");
  assert.deepEqual(stats, { answerMs: 2000, studyDays: 2, longestStreak: 2, currentStreak: null });
  assert.equal(wordStudyStats(days, "2026-09-08", "2026-09-09T12:00:00+08:00").studyDays, 3);
  days.set("2026-09-07", { ...days.get("2026-09-07"), answers: 0, answer_ms: 0 });
  assert.equal(wordStudyStats(days, "2026-09-08", "2026-09-08T12:00:00+08:00").longestStreak, 1);
  assert.deepEqual(wordStudyStats(new Map(), "2026-09-08", "2026-09-08T12:00:00+08:00"),
    { answerMs: 0, studyDays: 0, longestStreak: 0, currentStreak: 0 });
});
