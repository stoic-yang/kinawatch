import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchDay, fetchRange, type DayResponse, type RangeDay } from "./api";
import { DayRibbon } from "./components/DayRibbon";
import { WeekStrip } from "./components/WeekStrip";
import { SessionList } from "./components/SessionList";
import { ReviewPanel } from "./components/ReviewPanel";
import { QualityWarnings } from "./components/QualityWarnings";
import {
  Sidebar,
  monthOf,
  shiftMonth,
  monthEnd,
  SidebarToggleIcon,
  type CategoryOption,
} from "./components/Sidebar";
import { buildSessions, topAppsForDay } from "./lib/sessions";
import {
  currentDayStr,
  fmtClock,
  fmtDuration,
  isoWeekNumber,
  parseLocalDate,
  shiftDate,
  startOfISOWeek,
  weekdayShort,
} from "./lib/format";

const DAY_MODE = "routine" as const;
const HIDDEN_CATS_KEY = "kina-dashboard-hidden-categories";
const SIDEBAR_KEY = "kina-dashboard-sidebar";
const ACTIVITY_FIRST_YEAR = 2026;
type WeekMode = "rolling" | "calendar" | "year" | "calendarYear";

function isAnnualMode(mode: WeekMode): boolean {
  return mode === "year" || mode === "calendarYear";
}

function inclusiveDateCount(start: string, end: string): number {
  if (end < start) return 0;
  const first = parseLocalDate(start);
  const last = parseLocalDate(end);
  const firstUtc = Date.UTC(
    first.getFullYear(),
    first.getMonth(),
    first.getDate(),
  );
  const lastUtc = Date.UTC(last.getFullYear(), last.getMonth(), last.getDate());
  return Math.round((lastUtc - firstUtc) / (24 * 3600 * 1000)) + 1;
}

// The selected day lives in the URL so a browser reload refreshes data while
// staying on the same day instead of snapping back to today.
function dateFromURL(): string | null {
  const value = new URLSearchParams(window.location.search).get("date");
  if (
    value &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value <= currentDayStr(DAY_MODE)
  ) {
    return value;
  }
  return null;
}

function storedHiddenCats(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_CATS_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // Ignore malformed storage.
  }
  return new Set();
}

function storedSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    return true;
  }
}

export default function App() {
  const [date, setDate] = useState(
    () => dateFromURL() ?? currentDayStr(DAY_MODE),
  );
  const [day, setDay] = useState<DayResponse | null>(null);
  const [week, setWeek] = useState<RangeDay[]>([]);
  const [year, setYear] = useState<RangeDay[]>([]);
  const [yearLoading, setYearLoading] = useState(false);
  const [yearProgress, setYearProgress] = useState(0);
  const [yearError, setYearError] = useState<string | null>(null);
  const [weekMode, setWeekMode] = useState<WeekMode>("rolling");
  const [calendarYear, setCalendarYear] = useState(() =>
    parseLocalDate(currentDayStr(DAY_MODE)).getFullYear(),
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [monthCursor, setMonthCursor] = useState(() => monthOf(date));
  const [monthReviews, setMonthReviews] = useState<Record<string, boolean>>({});
  const [hiddenCats, setHiddenCats] = useState<Set<string>>(storedHiddenCats);
  const [sidebarOpen, setSidebarOpen] = useState(storedSidebarOpen);
  // On first mount, re-read today's data from the sources so a page reload
  // acts as the "refresh" action; later navigation uses the normal cache.
  const initialRefresh = useRef(true);
  const monthCache = useRef(new Map<string, Record<string, boolean>>());
  const yearCache = useRef(new Map<string, RangeDay[]>());
  const currentDate = currentDayStr(DAY_MODE);
  const currentYear = parseLocalDate(currentDate).getFullYear();
  const availableYears = useMemo(
    () =>
      Array.from(
        { length: Math.max(1, currentYear - ACTIVITY_FIRST_YEAR + 1) },
        (_, index) => currentYear - index,
      ),
    [currentYear],
  );
  const annualRange = useMemo(() => {
    if (weekMode === "calendarYear") {
      const displayStart = `${calendarYear}-01-01`;
      const displayEnd = `${calendarYear}-12-31`;
      return {
        start: displayStart,
        end: displayEnd < currentDate ? displayEnd : currentDate,
        displayStart,
        displayEnd,
      };
    }
    const start = shiftDate(currentDate, -364);
    return {
      start,
      end: currentDate,
      displayStart: start,
      displayEnd: currentDate,
    };
  }, [calendarYear, currentDate, weekMode]);
  const annualTotal = inclusiveDateCount(annualRange.start, annualRange.end);
  const weekRange = useMemo(() => {
    if (weekMode === "rolling") {
      return { start: shiftDate(date, -6), end: date };
    }
    const start = startOfISOWeek(date);
    const sunday = shiftDate(start, 6);
    return { start, end: sunday < currentDate ? sunday : currentDate };
  }, [currentDate, date, weekMode]);

  const load = useCallback(async () => {
    const refresh = initialRefresh.current && date === currentDate;
    initialRefresh.current = false;
    setLoading(true);
    setError(null);
    try {
      const [d, r] = await Promise.all([
        fetchDay(date, DAY_MODE, refresh),
        isAnnualMode(weekMode)
          ? Promise.resolve(null)
          : fetchRange(weekRange.start, weekRange.end, DAY_MODE),
      ]);
      setDay(d);
      if (r) setWeek(r.days);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [currentDate, date, weekMode, weekRange]);

  const refreshSelectedDay = useCallback(async () => {
    setError(null);
    try {
      setDay(await fetchDay(date, DAY_MODE, true));
      // The refreshed day cache feeds the range endpoint, so the visible
      // rhythm strip stays in sync after a save.
      if (!isAnnualMode(weekMode)) {
        setWeek(
          (await fetchRange(weekRange.start, weekRange.end, DAY_MODE)).days,
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [date, weekMode, weekRange]);

  useEffect(() => {
    void load();
  }, [load]);

  // Annual views are deliberately lazy: nothing loads until the user enters
  // a year view, and ordinary single-day pages never scan a year. Cold loads
  // reuse the existing 31-day range endpoint with a small bounded worker
  // pool (3 in flight) — the backend serves requests on threads, so this
  // reduces cold-load wall time without an unbounded burst.
  useEffect(() => {
    if (!isAnnualMode(weekMode)) return;
    const cacheKey = `${annualRange.start}:${annualRange.end}`;
    const cached = yearCache.current.get(cacheKey);
    if (cached) {
      setYear(cached);
      setYearProgress(cached.length);
      setYearLoading(false);
      setYearError(null);
      return;
    }

    const chunks: { start: string; end: string }[] = [];
    for (let cursor = annualRange.start; cursor <= annualRange.end; ) {
      const candidateEnd = shiftDate(cursor, 30);
      const chunkEnd =
        candidateEnd < annualRange.end ? candidateEnd : annualRange.end;
      chunks.push({ start: cursor, end: chunkEnd });
      cursor = shiftDate(chunkEnd, 1);
    }

    let cancelled = false;
    async function loadYear() {
      setYearLoading(true);
      setYearProgress(0);
      setYearError(null);
      // Do not keep the previous range on screen while a different annual
      // range is loading. Completed chunks are published below so the chart
      // can progressively replace its loading cells with real data.
      setYear([]);
      const results: RangeDay[][] = new Array(chunks.length);
      // Fetch the most recent slices first. They contain the selected/current
      // area in the common case, so the useful side of the heatmap appears
      // before older empty history while the remaining workers catch up.
      const pendingChunkIndexes = chunks.map((_, index) => index).reverse();
      let nextPendingChunk = 0;
      let loadedDays = 0;
      let failed = false;
      async function worker() {
        while (!cancelled && !failed) {
          const index = pendingChunkIndexes[nextPendingChunk++];
          if (index === undefined) return;
          const response = await fetchRange(
            chunks[index].start,
            chunks[index].end,
            DAY_MODE,
          );
          if (cancelled || failed) return;
          results[index] = response.days;
          loadedDays += response.days.length;
          setYearProgress(loadedDays);
          setYear(results.flat());
        }
      }
      try {
        await Promise.all(
          Array.from({ length: Math.min(3, chunks.length) }, () => worker()),
        );
        if (cancelled) return;
        const collected = results.flat();
        yearCache.current.set(cacheKey, collected);
        setYear(collected);
      } catch (reason) {
        if (!cancelled) {
          failed = true;
          setYearError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (!cancelled) setYearLoading(false);
      }
    }
    void loadYear();
    return () => {
      cancelled = true;
    };
  }, [annualRange.end, annualRange.start, weekMode]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (date === currentDayStr(DAY_MODE)) {
      url.searchParams.delete("date");
    } else {
      url.searchParams.set("date", date);
    }
    window.history.replaceState(null, "", url);
  }, [date]);

  // Follow the selected day's month in the calendar.
  useEffect(() => {
    setMonthCursor(monthOf(date));
  }, [date]);

  // Activity dots for the visible calendar month.
  useEffect(() => {
    const cached = monthCache.current.get(monthCursor);
    if (cached) {
      setMonthReviews(cached);
      return;
    }
    const today = currentDayStr(DAY_MODE);
    const start = `${monthCursor}-01`;
    if (start > today) {
      setMonthReviews({});
      return;
    }
    const end = monthEnd(monthCursor) < today ? monthEnd(monthCursor) : today;
    let cancelled = false;
    fetchRange(start, end, DAY_MODE)
      .then((r) => {
        if (cancelled) return;
        const map: Record<string, boolean> = {};
        for (const d of r.days) {
          map[d.date] = d.overview.review_completed;
        }
        monthCache.current.set(monthCursor, map);
        setMonthReviews(map);
      })
      .catch(() => {
        if (!cancelled) setMonthReviews({});
      });
    return () => {
      cancelled = true;
    };
  }, [monthCursor]);

  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_CATS_KEY, JSON.stringify([...hiddenCats]));
    } catch {
      // Selection still applies for this page session.
    }
  }, [hiddenCats]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "open" : "closed");
    } catch {
      // Ignore.
    }
  }, [sidebarOpen]);

  // Categories hidden in the sidebar are filtered out of every visual
  // breakdown; backend overview numbers stay untouched.
  const filteredDay = useMemo(() => {
    if (!day) return null;
    if (hiddenCats.size === 0) return day;
    return {
      ...day,
      timeline: day.timeline.filter(
        (b) => b.kind !== "screen" || !hiddenCats.has(b.category),
      ),
      categories: day.categories.filter((c) => !hiddenCats.has(c.category)),
      quality: {
        ...day.quality,
        uncategorized_seconds: hiddenCats.has("uncategorized")
          ? 0
          : day.quality.uncategorized_seconds,
      },
    };
  }, [day, hiddenCats]);

  const sessions = useMemo(
    () => (filteredDay ? buildSessions(filteredDay) : []),
    [filteredDay],
  );
  const topApps = useMemo(
    () => (filteredDay ? topAppsForDay(filteredDay) : []),
    [filteredDay],
  );

  const categoryOptions = useMemo<CategoryOption[]>(() => {
    if (!day) return [];
    const options = day.categories.map((c) => ({
      category: c.category,
      label: c.label,
      seconds: c.duration_seconds,
    }));
    if (day.quality.uncategorized_seconds > 0) {
      options.push({
        category: "uncategorized",
        label: "未分类",
        seconds: day.quality.uncategorized_seconds,
      });
    }
    options.sort((a, b) => b.seconds - a.seconds);
    // Keep hidden categories visible in the list even when today lacks them,
    // so they can be un-hidden.
    const known = new Set(options.map((o) => o.category));
    for (const c of hiddenCats) {
      if (!known.has(c)) {
        const fromWeek = week
          .flatMap((d) => d.categories)
          .find((x) => x.category === c);
        options.push({
          category: c,
          label: fromWeek?.label ?? (c === "uncategorized" ? "未分类" : c),
          seconds: 0,
        });
      }
    }
    return options;
  }, [day, week, hiddenCats]);

  const bounds = useMemo(() => {
    if (!day) return null;
    const first = day.rhythm?.first_active ?? day.timeline[0]?.start ?? null;
    const last =
      day.rhythm?.last_active ??
      day.timeline[day.timeline.length - 1]?.end ??
      null;
    return first && last ? { first, last } : null;
  }, [day]);

  const selectedDate = parseLocalDate(date);
  const canMoveToNextWeek =
    startOfISOWeek(date) < startOfISOWeek(currentDate);

  return (
    <div className={`layout ${sidebarOpen ? "" : "layout-collapsed"}`}>
      {sidebarOpen && (
        <Sidebar
          date={date}
          today={currentDate}
          monthCursor={monthCursor}
          monthReviews={monthReviews}
          categories={categoryOptions}
          apps={topApps}
          hidden={hiddenCats}
          onSelectDate={setDate}
          onMonthChange={(delta) =>
            setMonthCursor((m) => {
              const next = shiftMonth(m, delta);
              return next > monthOf(currentDate) ? m : next;
            })
          }
          onToggleCategory={(c) =>
            setHiddenCats((prev) => {
              const next = new Set(prev);
              if (next.has(c)) next.delete(c);
              else next.add(c);
              return next;
            })
          }
          onShowAll={() => setHiddenCats(new Set())}
          onCollapse={() => setSidebarOpen(false)}
        />
      )}

      {!sidebarOpen && (
        <aside className="sidebar-rail" aria-label="侧边栏控制">
          <button
            className="nav-btn sidebar-toggle-btn rail-toggle"
            aria-label="展开侧边栏"
            title="展开侧边栏"
            onClick={() => setSidebarOpen(true)}
          >
            <SidebarToggleIcon />
          </button>
        </aside>
      )}

      <div className="page">
        <header className="header">
          <h1 className="date-title">
            <span>
              {selectedDate.getMonth() + 1}月{selectedDate.getDate()}日
            </span>
            <small>
              {selectedDate.getFullYear()}年 · 第{isoWeekNumber(date)}周 · 星期
              {weekdayShort(date)}
            </small>
          </h1>
        </header>

        {error && (
          <div className="error-card">
            无法加载数据：{error}。请确认后端已运行（python3 -m backend.server）。
          </div>
        )}

        {day && filteredDay && (
          <div className="day-content" key={date}>
            <section className="overview">
              <div className="rhythm-heading">
                <h2 className="rhythm-title">时间线</h2>
                <div className="rhythm-summary">
                  {bounds && (
                    <span>
                      <b>
                        {fmtClock(bounds.first)} – {fmtClock(bounds.last)}
                      </b>
                      活动窗口
                    </span>
                  )}
                  <span>
                    <b>{fmtDuration(day.overview.active_seconds)}</b>
                    屏幕活跃
                  </span>
                </div>
              </div>
              <DayRibbon
                date={date}
                mode={DAY_MODE}
                timeline={filteredDay.timeline}
              />
            </section>

            <WeekStrip
              days={week}
              yearDays={year}
              yearLoading={yearLoading}
              yearProgress={yearProgress}
              yearTotal={annualTotal}
              yearError={yearError}
              yearRangeStart={annualRange.displayStart}
              yearRangeEnd={annualRange.displayEnd}
              yearDataEnd={annualRange.end}
              calendarYear={calendarYear}
              availableYears={availableYears}
              selected={date}
              mode={weekMode}
              weekNumber={isoWeekNumber(date)}
              canMoveNext={canMoveToNextWeek}
              onModeChange={setWeekMode}
              onCalendarYearChange={(nextYear) => {
                setCalendarYear(nextYear);
                setWeekMode("calendarYear");
              }}
              onShiftWeek={(delta) => {
                const candidate = shiftDate(date, delta * 7);
                setDate(candidate > currentDate ? currentDate : candidate);
              }}
              onSelect={setDate}
            />

            <main className="columns">
              <section className="col">
                <h2 className="section-title">工作流</h2>
                <SessionList
                  date={date}
                  sessions={sessions}
                  journal={day.journal}
                  journalFingerprint={day.cache.journal_fingerprint}
                  onSaved={refreshSelectedDay}
                />
              </section>
              <section className="col">
                <h2 className="section-title section-title-row">
                  <span>复盘</span>
                  {day.journal.exists && (
                    <a
                      className="obsidian-link"
                      href={day.journal.obsidian_url}
                    >
                      在 Obsidian 打开 ↗
                    </a>
                  )}
                </h2>
                <ReviewPanel
                  date={date}
                  journal={day.journal}
                  journalFingerprint={day.cache.journal_fingerprint}
                  onSaved={refreshSelectedDay}
                />
              </section>
            </main>

            <QualityWarnings day={day} />
          </div>
        )}

        {loading && !day && <div className="loading">加载中…</div>}
      </div>
    </div>
  );
}
