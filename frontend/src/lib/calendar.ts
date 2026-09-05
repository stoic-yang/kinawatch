import { toDateStr } from "./format";

export const MONDAY_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

export interface MonthCell {
  date: string;
  day: number;
  inMonth: boolean;
  future: boolean;
}

export function buildMonthCells(
  monthCursor: string,
  today: string,
): MonthCell[] {
  const [year, month] = monthCursor.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month - 1, 1 - lead);
  const cells: MonthCell[] = [];

  for (let index = 0; index < 42; index += 1) {
    const value = new Date(start);
    value.setDate(start.getDate() + index);
    const date = toDateStr(value);
    cells.push({
      date,
      day: value.getDate(),
      inMonth: value.getMonth() === month - 1,
      future: date > today,
    });
  }

  if (!cells.slice(35).some((cell) => cell.inMonth)) {
    return cells.slice(0, 35);
  }
  return cells;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function shiftMonth(monthCursor: string, delta: number): string {
  const [year, month] = monthCursor.split("-").map(Number);
  const value = new Date(year, month - 1 + delta, 1);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

export function monthEnd(monthCursor: string): string {
  const [year, month] = monthCursor.split("-").map(Number);
  return toDateStr(new Date(year, month, 0));
}
