import { useEffect, useState } from "react";
import type { RangeDay } from "../api";
import { YearHeatmap } from "./YearHeatmap";
import { categoryColor } from "../lib/colors";
import {
  fmtClock,
  fmtDuration,
  parseLocalDate,
  weekdayShort,
} from "../lib/format";

// Each day's heat column is tinted with that day's dominant category color,
// so the week overview stays colorful and data-driven.
function dayColor(d: RangeDay): string {
  const top = [...d.categories].sort(
    (a, b) => b.duration_seconds - a.duration_seconds,
  )[0];
  return top ? categoryColor(top.category) : "var(--text-3)";
}

function shortDate(date: string): string {
  const d = parseLocalDate(date);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function dottedDate(date: string): string {
  return date.split("-").join(".");
}

const RHYTHM_COLLAPSED_KEY = "kinawatch-rhythm-collapsed";
const LEGACY_RHYTHM_COLLAPSED_KEY = "kina-dashboard-rhythm-collapsed";

function storedRhythmCollapsed(): boolean {
  try {
    return (
      localStorage.getItem(RHYTHM_COLLAPSED_KEY) ??
      localStorage.getItem(LEGACY_RHYTHM_COLLAPSED_KEY)
    ) === "1";
  } catch {
    return false;
  }
}

// A read-only seven-day comparison. Each row of 24 cells follows the same
// 06:00-to-06:00 boundary as the main ribbon; the calendar owns navigation.
export function WeekStrip({
  days,
  yearDays,
  yearLoading,
  yearProgress,
  yearTotal,
  yearError,
  yearRangeStart,
  yearRangeEnd,
  yearDataEnd,
  calendarYear,
  availableYears,
  selected,
  mode,
  weekNumber,
  canMoveNext,
  onModeChange,
  onCalendarYearChange,
  onShiftWeek,
  onSelect,
}: {
  days: RangeDay[];
  yearDays: RangeDay[];
  yearLoading: boolean;
  yearProgress: number;
  yearTotal: number;
  yearError: string | null;
  yearRangeStart: string;
  yearRangeEnd: string;
  yearDataEnd: string;
  calendarYear: number;
  availableYears: number[];
  selected: string;
  mode: "rolling" | "calendar" | "year" | "calendarYear";
  weekNumber: number;
  canMoveNext: boolean;
  onModeChange: (
    mode: "rolling" | "calendar" | "year" | "calendarYear",
  ) => void;
  onCalendarYearChange: (year: number) => void;
  onShiftWeek: (delta: number) => void;
  onSelect: (date: string) => void;
}) {
  const yearSeconds = yearDays.reduce(
    (sum, day) => sum + day.overview.combined_nonoverlap_seconds,
    0,
  );
  const yearActiveDays = yearDays.filter(
    (day) => day.overview.combined_nonoverlap_seconds > 0,
  ).length;
  const annualMode = mode === "year" || mode === "calendarYear";
  const earliestYear = Math.min(...availableYears);
  const latestYear = Math.max(...availableYears);
  // Collapse survives day switches (the day content remounts per date).
  const [collapsed, setCollapsed] = useState(storedRhythmCollapsed);
  useEffect(() => {
    try {
      localStorage.setItem(RHYTHM_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // The preference still applies for this page session.
    }
  }, [collapsed]);

  const chooseMode = onModeChange;

  return (
    <section
      className={`week-context ${collapsed ? "week-context-collapsed" : ""}`}
      aria-label="活动节律"
    >
      <div className="week-context-head">
        <h2 className="rhythm-title">
          <button
            type="button"
            className="fold-btn"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((v) => !v)}
          >
            节律
            <span className="fold-arrow" aria-hidden="true">
              {collapsed ? "▸" : "▾"}
            </span>
          </button>
        </h2>
        {!collapsed && (
          <div className="week-context-controls">
            <div className="week-mode-switch" aria-label="时间范围">
              <button
                type="button"
                className={mode === "rolling" ? "week-mode-active" : ""}
                onClick={() => chooseMode("rolling")}
              >
                近七天
              </button>
              <button
                type="button"
                className={mode === "calendar" ? "week-mode-active" : ""}
                onClick={() => chooseMode("calendar")}
              >
                自然周
              </button>
              <button
                type="button"
                className={mode === "year" ? "week-mode-active" : ""}
                onClick={() => chooseMode("year")}
              >
                近一年
              </button>
              <button
                type="button"
                className={mode === "calendarYear" ? "week-mode-active" : ""}
                aria-label={`查看 ${calendarYear} 年`}
                onClick={() => chooseMode("calendarYear")}
              >
                {calendarYear}年
              </button>
            </div>
            {mode === "calendarYear" && availableYears.length > 1 && (
              <div className="calendar-year-stepper" aria-label="切换年份">
                <button
                  type="button"
                  aria-label="上一年"
                  disabled={calendarYear <= earliestYear}
                  onClick={() => onCalendarYearChange(calendarYear - 1)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  aria-label="下一年"
                  disabled={calendarYear >= latestYear}
                  onClick={() => onCalendarYearChange(calendarYear + 1)}
                >
                  ›
                </button>
              </div>
            )}
            {annualMode && (
              <span
                className="year-range-label"
                aria-label={`日期范围 ${yearRangeStart} 至 ${yearRangeEnd}`}
              >
                {dottedDate(yearRangeStart)}–{dottedDate(yearRangeEnd)}
              </span>
            )}
            {mode === "calendar" && (
              <div className="week-number-picker" aria-label="选择周数">
                <button
                  type="button"
                  aria-label="上一周"
                  onClick={() => onShiftWeek(-1)}
                >
                  ‹
                </button>
                <strong>第 {weekNumber} 周</strong>
                <button
                  type="button"
                  aria-label="下一周"
                  disabled={!canMoveNext}
                  onClick={() => onShiftWeek(1)}
                >
                  ›
                </button>
              </div>
            )}
          </div>
        )}
        {!collapsed && annualMode && (
          <div className="week-context-summary">
            <p>
              {yearLoading
                ? `正在整理${mode === "calendarYear" ? `${calendarYear}年` : "近一年"} · ${yearProgress}/${yearTotal} 天`
                : yearDays.length > 0
                  ? mode === "calendarYear"
                    ? `${calendarYear}年 · 累计 ${fmtDuration(yearSeconds)} · 活跃 ${yearActiveDays} 天`
                    : `累计 ${fmtDuration(yearSeconds)} · 活跃 ${yearActiveDays}/${yearDays.length} 天`
                  : `${mode === "calendarYear" ? `${calendarYear}年` : "近一年"}暂无活动`}
            </p>
          </div>
        )}
      </div>
      {!collapsed &&
        (annualMode ? (
        <YearHeatmap
          days={yearDays}
          rangeStart={yearRangeStart}
          rangeEnd={yearRangeEnd}
          dataEnd={yearDataEnd}
          rangeLabel={mode === "calendarYear" ? `${calendarYear}年` : "近一年"}
          selected={selected}
          loading={yearLoading}
          loaded={yearProgress}
          total={yearTotal}
          error={yearError}
          onSelect={onSelect}
        />
      ) : (
      <ul
        className="weekstrip"
        style={{ "--week-days": Math.max(days.length, 1) } as React.CSSProperties}
      >
        {days.map((d) => {
          const total = d.overview.combined_nonoverlap_seconds;
          const active = d.date === selected;
          const r = d.rhythm;
          const hours =
            r?.hourly_active_seconds ?? Array<number>(24).fill(0);
          const title = r?.first_active
            ? `${d.date} · ${fmtClock(r.first_active)}–${fmtClock(
                r.last_active ?? r.first_active,
              )} · ${fmtDuration(total)}`
            : `${d.date} · 无活动`;
          return (
            <li key={d.date}>
              <button
                type="button"
                className={`weekday ${active ? "weekday-active" : ""}`}
                title={`${title} · 点击查看当天`}
                aria-current={active ? "date" : undefined}
                onClick={() => onSelect(d.date)}
                style={{ "--heat": dayColor(d) } as React.CSSProperties}
              >
              <div className="weekday-head">
                <div>
                  <span className="weekday-label">周{weekdayShort(d.date)}</span>
                  <span className="weekday-date">{shortDate(d.date)}</span>
                </div>
                <strong>{fmtDuration(total)}</strong>
              </div>
              <div className="weekday-heat" aria-hidden="true">
                {hours.map((sec, hour) => {
                  const intensity = Math.min(1, sec / 3600);
                  const pct = sec > 0 ? Math.round(18 + 72 * intensity) : 0;
                  return (
                    <span
                      key={hour}
                      style={
                        pct > 0
                          ? {
                              background: `color-mix(in srgb, var(--heat) ${pct}%, var(--track))`,
                            }
                          : undefined
                      }
                    />
                  );
                })}
              </div>
              <div className="weekday-foot">
                <span>
                  {r?.first_active
                    ? `${fmtClock(r.first_active)}–${fmtClock(
                        r.last_active ?? r.first_active,
                      )}`
                    : "无活动"}
                </span>
              </div>
              </button>
            </li>
          );
        })}
      </ul>
        ))}
    </section>
  );
}
