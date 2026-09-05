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

export function fmtClock(iso: string, timezone?: string): string {
  const d = new Date(iso);
  if (timezone) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    return `${values.hour}:${values.minute}`;
  }
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

export function isValidDateString(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  return toDateStr(parseLocalDate(dateStr)) === dateStr;
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

export function currentDayStr(
  mode: "calendar" | "routine",
  routineDayStart = "06:00",
  timezone?: string,
  now = new Date(),
): string {
  let currentDate: string;
  let currentMinutes: number;
  if (timezone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    currentDate = `${values.year}-${values.month}-${values.day}`;
    currentMinutes = Number(values.hour) * 60 + Number(values.minute);
  } else {
    currentDate = toDateStr(now);
    currentMinutes = now.getHours() * 60 + now.getMinutes();
  }
  const [routineHour, routineMinute] = routineDayStart.split(":").map(Number);
  const routineMinutes = routineHour * 60 + routineMinute;
  if (
    mode === "routine" &&
    Number.isFinite(routineMinutes) &&
    currentMinutes < routineMinutes
  ) {
    return shiftDate(currentDate, -1);
  }
  return currentDate;
}
