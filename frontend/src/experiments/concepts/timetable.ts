export interface TimetableSlot { id: string; label: string; start: string; end: string }
export interface Course {
  id: string; name: string; room: string; teacher: string; slot: string;
  weekday: number; weeks: number[]; weeks_label: string;
}
export interface Timetable {
  version: number; term: string; school: string; timezone: string;
  week1_monday: string; weeks: number; slots: TimetableSlot[]; courses: Course[];
  exceptions: { date: string; follows: string | null; label: string }[];
  sources: { title: string; url: string }[];
}
export interface TimetableResponse { status: "ready" | "empty" | "error"; snapshot: Timetable | null; error: string | null }
export interface Lesson { course: Course; slot: TimetableSlot; date: string; teachingDate: string }
const DAY = 86400000;
export const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export function shiftDate(value: string, days: number): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
export function teachingWeek(table: Timetable, value: string): number {
  return Math.floor((Date.parse(`${value}T00:00:00Z`) - Date.parse(`${table.week1_monday}T00:00:00Z`)) / (7 * DAY)) + 1;
}
export function schoolClock(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}
export function lessonsForDay(table: Timetable, value: string): Lesson[] {
  const exception = table.exceptions.find(entry => entry.date === value);
  if (exception && exception.follows === null) return [];
  // A makeup day uses the source day's teaching week, including its odd/even rule.
  // Do not recursively apply the source's holiday exception.
  const teachingDate = exception?.follows ?? value;
  const week = teachingWeek(table, teachingDate);
  const weekday = (new Date(`${teachingDate}T00:00:00Z`).getUTCDay() + 6) % 7 + 1;
  return table.courses.filter(course => course.weekday === weekday && course.weeks.includes(week))
    .map(course => ({ course, slot: table.slots.find(slot => slot.id === course.slot)!, date: value, teachingDate }))
    .sort((a, b) => a.slot.start.localeCompare(b.slot.start) || a.course.id.localeCompare(b.course.id));
}
export function weekDays(table: Timetable, week: number) {
  return Array.from({ length: 7 }, (_, day) => {
    const date = shiftDate(table.week1_monday, (week - 1) * 7 + day);
    return { date, lessons: lessonsForDay(table, date), exception: table.exceptions.find(entry => entry.date === date) };
  });
}
export function nextLesson(table: Timetable, now: Date): Lesson | null {
  const clock = schoolClock(now, table.timezone);
  const dates = new Set<string>();
  for (let offset = 0; offset < table.weeks * 7; offset++) dates.add(shiftDate(table.week1_monday, offset));
  table.exceptions.forEach(entry => { if (entry.follows) dates.add(entry.date); });
  for (const date of [...dates].sort()) {
    if (date < clock.date) continue;
    const lesson = lessonsForDay(table, date).find(item => date > clock.date || item.slot.end > clock.time);
    if (lesson) return lesson;
  }
  return null;
}
export function shortDate(date: string) { return `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`; }
export function lessonState(lesson: Lesson, clock: { date: string; time: string }): string {
  if (lesson.date !== clock.date) return "";
  if (clock.time >= lesson.slot.end) return "已结束";
  if (clock.time >= lesson.slot.start) return "进行中";
  return "待上课";
}
