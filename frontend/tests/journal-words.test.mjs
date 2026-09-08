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
const { wordScope, wordDay, wordYear, answerTime } = await import(pathToFileURL(join(directory, "words.mjs")).href);
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
