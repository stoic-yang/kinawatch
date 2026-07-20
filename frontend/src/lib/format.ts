export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}秒`;
  const totalMin = Math.round(s / 60);
  if (totalMin < 60) return `${totalMin}分`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}小时` : `${h}小时${String(m).padStart(2, "0")}分`;
}

export function fmtHours(seconds: number): string {
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function fmtClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function fmtDateTitle(dateStr: string): string {
  const d = parseLocalDate(dateStr);
  return `${d.getMonth() + 1}月${d.getDate()}日 · 星期${WEEKDAYS[d.getDay()]}`;
}

export function weekdayShort(dateStr: string): string {
  return WEEKDAYS[parseLocalDate(dateStr).getDay()];
}

export function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function shiftDate(dateStr: string, days: number): string {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

export function startOfISOWeek(dateStr: string): string {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDateStr(d);
}

export function isoWeekNumber(dateStr: string): number {
  const d = parseLocalDate(dateStr);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  firstThursday.setDate(
    firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7),
  );
  return (
    1 +
    Math.round(
      (d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000),
    )
  );
}

export function isoWeekYear(dateStr: string): number {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  return d.getFullYear();
}

export const ROUTINE_DAY_START_HOUR = 6;

export function currentDayStr(
  mode: "calendar" | "routine",
  now = new Date(),
): string {
  const current = new Date(now);
  if (mode === "routine" && current.getHours() < ROUTINE_DAY_START_HOUR) {
    current.setDate(current.getDate() - 1);
  }
  return toDateStr(current);
}
