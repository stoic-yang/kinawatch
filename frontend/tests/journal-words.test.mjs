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
const { wordScope, wordDay, filterWords, monthCells, shiftWordMonth, answerTime } = await import(pathToFileURL(join(directory, "words.mjs")).href);
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
  const scope = wordScope(snapshot, "");
  assert.equal(scope.words.length, 2); assert.equal(scope.learned, 1);
  assert.deepEqual(scope.days.get("2026-05-17"), { date: "2026-05-17", entries: 1, new_entries: 1, answers: 2, answer_ms: 8000 });
  assert.equal(scope.days.get("2026-05-18").new_entries, 0);
  assert.equal(scope.latest, "2026-05-18");
});
test("deck filtering retains prior learning identity and filters answer history", () => {
  const scope = wordScope(snapshot, "B");
  assert.equal(scope.words.length, 1); assert.equal(scope.words[0].history.length, 1);
  assert.equal(scope.days.get("2026-05-18").new_entries, 0);
  assert.equal(scope.days.has("2026-05-17"), false);
});
test("uncached dates remain unknown; absent reviews in the saved period are zero", () => {
  const scope = wordScope(snapshot, "");
  assert.equal(wordDay(scope.days, "2026-09-09", snapshot), null);
  assert.equal(wordDay(scope.days, "2026-09-08", snapshot).answers, 0);
  assert.equal(wordDay(scope.days, "2026-09-08", null), null);
});
test("search handles Chinese and case; repeated Again filters without mutating source", () => {
  const scope = wordScope(snapshot, "");
  assert.equal(filterWords(scope.words, " APPLE ", "all")[0].id, 10);
  assert.equal(filterWords(scope.words, "梨", "all")[0].id, 20);
  assert.equal(filterWords(scope.words, "", "new")[0].id, 20);
  assert.equal(filterWords(scope.words, "", "again")[0].id, 10);
  assert.equal(filterWords(scope.words, "missing", "all").length, 0);
  assert.equal(snapshot.reviews[0].id, 100);
});
test("calendar handles Monday first, leap years and year transitions", () => {
  assert.equal(monthCells("2024-02").filter(Boolean).length, 29);
  assert.equal(monthCells("2026-06")[0], "2026-06-01");
  assert.equal(shiftWordMonth("2026-01", -1), "2025-12");
  assert.equal(answerTime(0), "0 分钟"); assert.equal(answerTime(30000), "30 秒");
  assert.equal(answerTime(90000), "1.5 分钟");
});
