import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-timetable-"));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL("../src/experiments/concepts/timetable.ts", import.meta.url))], outfile: join(directory, "timetable.mjs"), bundle: true, platform: "node", format: "esm" });
const { teachingWeek, lessonsForDay, weekDays, nextLesson, schoolClock, lessonState } = await import(pathToFileURL(join(directory, "timetable.mjs")).href);
const course = (id, weekday, weeks, room = "Room A") => ({ id, name: id, weekday, weeks, room, teacher: "Teacher", weeks_label: "Example", slot: "am" });
const table = {
  week1_monday: "2026-09-14", weeks: 16, timezone: "Asia/Shanghai",
  slots: [{ id: "am", start: "08:00", end: "09:40", label: "1–2节" }],
  courses: [course("odd", 3, [1, 3, 5]), course("even", 3, [2, 4, 6]),
    course("early", 1, [1, 2, 3, 4]), course("late", 1, [5, 6, 7, 8], "Room B"),
    course("second-half", 1, [9, 10, 11, 12, 13, 14, 15, 16])],
  exceptions: [{ date: "2026-10-07", follows: null, label: "Holiday" },
    { date: "2026-10-10", follows: "2026-10-07", label: "Makeup" }],
};
test("teaching weeks roll over on Monday, across calendar years, with unclamped term boundaries", () => {
  assert.equal(teachingWeek(table, "2026-09-13"), 0);
  assert.equal(teachingWeek(table, "2026-09-14"), 1);
  assert.equal(teachingWeek(table, "2026-09-20"), 1);
  assert.equal(teachingWeek(table, "2026-09-21"), 2);
  assert.equal(teachingWeek(table, "2027-01-03"), 16);
  assert.equal(teachingWeek(table, "2027-01-04"), 17);
  assert.equal(weekDays(table, 16).at(-1).date, "2027-01-03");
});
test("odd and even weeks, room changes and second-half courses are selected exactly", () => {
  assert.equal(lessonsForDay(table, "2026-09-16")[0].course.id, "odd");
  assert.equal(lessonsForDay(table, "2026-09-23")[0].course.id, "even");
  assert.equal(lessonsForDay(table, "2026-10-05")[0].course.room, "Room A");
  assert.equal(lessonsForDay(table, "2026-10-12")[0].course.room, "Room B");
  assert.equal(lessonsForDay(table, "2026-11-09")[0].course.id, "second-half");
});
test("holiday removes classes; makeup uses source teaching week without following its cancellation", () => {
  assert.deepEqual(lessonsForDay(table, "2026-10-07"), []);
  const makeup = lessonsForDay(table, "2026-10-10");
  assert.equal(makeup.length, 1);
  assert.equal(makeup[0].course.id, "even");
  assert.equal(makeup[0].teachingDate, "2026-10-07");
  assert.equal(makeup[0].date, "2026-10-10");
  assert.equal(weekDays(table, 4)[5].lessons[0].course.id, "even");
});
test("next course spans preterm, weekends and holidays and stops at term end", () => {
  assert.equal(nextLesson(table, new Date("2026-09-13T23:00:00+08:00")).date, "2026-09-14");
  assert.equal(nextLesson(table, new Date("2026-10-06T23:00:00+08:00")).date, "2026-10-10");
  assert.equal(nextLesson(table, new Date("2027-01-04T08:00:00+08:00")), null);
  assert.deepEqual(lessonsForDay(table, "2026-09-13"), []);
});
test("current course includes its start and excludes its end using campus civil time", () => {
  const start = new Date("2026-09-14T00:00:00Z");
  assert.deepEqual(schoolClock(start, table.timezone), { date: "2026-09-14", time: "08:00" });
  const lesson = nextLesson(table, start);
  assert.equal(lessonState(lesson, schoolClock(start, table.timezone)), "进行中");
  assert.equal(lessonState(lesson, { date: "2026-09-14", time: "07:59" }), "待上课");
  assert.equal(lessonState(lesson, { date: "2026-09-14", time: "09:40" }), "已结束");
  assert.equal(nextLesson(table, new Date("2026-09-14T09:40:00+08:00")).date, "2026-09-16");
});
test("overlapping courses are preserved so the page can disclose the conflict", () => {
  const overlap = { ...table, courses: [course("a", 1, [1]), course("b", 1, [1])] };
  assert.equal(lessonsForDay(overlap, "2026-09-14").length, 2);
});
