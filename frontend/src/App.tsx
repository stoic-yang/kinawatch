import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThemeShellProps } from "./experiments/types";
import {
  fetchDay,
  fetchRange,
  fetchRuntimeSettings,
  type DayResponse,
  type FileFingerprint,
  type RangeDay,
  type RuntimeSettings,
  type ScreenTimelineBlock,
  type WorkflowSaveResponse,
} from "./api";
import { ActivityEditor } from "./components/ActivityEditor";
import { DayRibbon } from "./components/DayRibbon";
import { WeekStrip, type RhythmMode } from "./components/WeekStrip";
import { SessionList } from "./components/SessionList";
import {
  ReviewWorkspace,
  type ReviewScope,
} from "./components/ReviewWorkspace";
import { QualityWarnings } from "./components/QualityWarnings";
import {
  Sidebar,
  SidebarToggleIcon,
  type CategoryOption,
} from "./components/Sidebar";
import { monthEnd, monthOf, shiftMonth } from "./lib/calendar";
import { buildSessions, topAppsForDay } from "./lib/sessions";
import {
  currentDayStr,
  fmtClock,
  fmtDuration,
  isValidDateString,
  isoWeekNumber,
  parseLocalDate,
  shiftDate,
  startOfISOWeek,
  weekdayShort,
} from "./lib/format";

const HIDDEN_CATS_KEY = "kinawatch-hidden-categories";
const SIDEBAR_KEY = "kinawatch-sidebar";
const LEGACY_HIDDEN_CATS_KEY = "kina-dashboard-hidden-categories";
const LEGACY_SIDEBAR_KEY = "kina-dashboard-sidebar";
const ACTIVITY_FIRST_YEAR = 2026;
const ANNUAL_CHUNK_DAYS = 14;

function isAnnualMode(mode: RhythmMode): boolean {
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

function rangeDayFromResponse(day: DayResponse): RangeDay {
  return {
    date: day.date,
    overview: day.overview,
    quality: {
      complete: day.quality.complete,
      issues: day.quality.issues,
      uncategorized_seconds: day.quality.uncategorized_seconds,
    },
    categories: day.categories,
    rhythm: day.rhythm,
  };
}

// The selected day lives in the URL so a browser reload refreshes data while
// staying on the same day instead of snapping back to today.
function dateFromURL(): string | null {
  const value = new URLSearchParams(window.location.search).get("date");
  if (
    value &&
    isValidDateString(value)
  ) {
    return value;
  }
  return null;
}

function storedHiddenCats(): Set<string> {
  try {
    const raw =
      localStorage.getItem(HIDDEN_CATS_KEY) ??
      localStorage.getItem(LEGACY_HIDDEN_CATS_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // Ignore malformed storage.
  }
  return new Set();
}

function storedSidebarOpen(): boolean {
  try {
    const value =
      localStorage.getItem(SIDEBAR_KEY) ??
      localStorage.getItem(LEGACY_SIDEBAR_KEY);
    return value !== "closed";
  } catch {
    return true;
  }
}

export default function App({ renderShell }: {
  renderShell?: (props: ThemeShellProps) => ReactNode;
} = {}) {
  const provisionalDate = currentDayStr("calendar");
  const [runtime, setRuntime] = useState<RuntimeSettings | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [date, setDate] = useState(
    () => dateFromURL() ?? provisionalDate,
  );
  const [day, setDay] = useState<DayResponse | null>(null);
  const [week, setWeek] = useState<RangeDay[]>([]);
  const [year, setYear] = useState<RangeDay[]>([]);
  const [yearLoading, setYearLoading] = useState(false);
  const [yearProgress, setYearProgress] = useState(0);
  const [yearError, setYearError] = useState<string | null>(null);
  const [yearRevision, setYearRevision] = useState(0);
  const [weekMode, setWeekMode] = useState<RhythmMode>("rolling");
  const [calendarYear, setCalendarYear] = useState(() =>
    parseLocalDate(provisionalDate).getFullYear(),
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [monthCursor, setMonthCursor] = useState(() => monthOf(date));
  const [monthRecords, setMonthRecords] = useState<Record<string, boolean>>({});
  const [monthRevision, setMonthRevision] = useState(0);
  const [hiddenCats, setHiddenCats] = useState<Set<string>>(storedHiddenCats);
  const [sidebarOpen, setSidebarOpen] = useState(storedSidebarOpen);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [reviewScope, setReviewScope] = useState<ReviewScope>("day");
  const [activitySelection, setActivitySelection] =
    useState<ScreenTimelineBlock | null>(null);
  // On first mount, re-read today's data from the sources so a page reload
  // acts as the "refresh" action; later navigation uses the normal cache.
  const initialRefresh = useRef(true);
  const loadGeneration = useRef(0);
  const selectedDateRef = useRef(date);
  const monthLoadGeneration = useRef(0);
  const monthCache = useRef(new Map<string, Record<string, boolean>>());
  const yearCache = useRef(new Map<string, RangeDay[]>());
  const dayMode = runtime?.default_mode ?? "calendar";
  const currentDate = runtime
    ? currentDayStr(
        runtime.default_mode,
        runtime.routine_day_start,
        runtime.timezone,
      )
    : provisionalDate;
  const selectDate = useCallback((nextDate: string) => {
    if (nextDate === selectedDateRef.current) return;
    loadGeneration.current += 1;
    selectedDateRef.current = nextDate;
    setActivitySelection(null);
    setDay(null);
    setDate(nextDate);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchRuntimeSettings()
      .then((settings) => {
        if (cancelled) return;
        const today = currentDayStr(
          settings.default_mode,
          settings.routine_day_start,
          settings.timezone,
        );
        const nextDate = dateFromURL() ?? today;
        loadGeneration.current += 1;
        selectedDateRef.current = nextDate;
        setDay(null);
        setDate(nextDate);
        setMonthCursor(monthOf(nextDate));
        setCalendarYear(parseLocalDate(today).getFullYear());
        setRuntime(settings);
        setBootstrapError(null);
      })
      .catch((reason) => {
        if (!cancelled) {
          setBootstrapError(
            reason instanceof Error ? reason.message : String(reason),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
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
    const activityDate = date < currentDate ? date : currentDate;
    if (weekMode === "rolling") {
      return { start: shiftDate(activityDate, -6), end: activityDate };
    }
    const start = startOfISOWeek(activityDate);
    const sunday = shiftDate(start, 6);
    return { start, end: sunday < currentDate ? sunday : currentDate };
  }, [currentDate, date, weekMode]);

  const load = useCallback(async () => {
    if (!runtime) return;
    const targetDate = date;
    const generation = ++loadGeneration.current;
    const refresh = initialRefresh.current && targetDate === currentDate;
    const annualMode = isAnnualMode(weekMode);
    initialRefresh.current = false;
    setDay(null);
    setLoading(true);
    setError(null);
    try {
      const [d, r] = await Promise.all([
        fetchDay(targetDate, dayMode, refresh),
        annualMode
          ? Promise.resolve(null)
          : fetchRange(weekRange.start, weekRange.end, dayMode),
      ]);
      if (
        generation !== loadGeneration.current ||
        selectedDateRef.current !== targetDate
      ) {
        return;
      }
      setDay(d);
      if (r) setWeek(r.days);
    } catch (e) {
      if (
        generation === loadGeneration.current &&
        selectedDateRef.current === targetDate
      ) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (
        generation === loadGeneration.current &&
        selectedDateRef.current === targetDate
      ) {
        setLoading(false);
      }
    }
  }, [currentDate, date, dayMode, runtime, weekMode, weekRange]);

  const refreshSelectedDay = useCallback(async (
    savedWorkflow?: WorkflowSaveResponse,
    editedFingerprint?: FileFingerprint,
  ) => {
    if (!runtime) return;
    const targetDate = selectedDateRef.current;
    const generation = ++loadGeneration.current;
    setError(null);
    if (savedWorkflow?.date === targetDate && editedFingerprint) {
      // Publish the acknowledged text and version before the slower day reload.
      // A later edit must never start from the pre-save note or fingerprint.
      setDay(previous => {
        if (!previous || previous.date !== savedWorkflow.date) return previous;
        const current = previous.cache.journal_fingerprint;
        if (current.path !== editedFingerprint.path ||
            current.mtime_ns !== editedFingerprint.mtime_ns ||
            current.size !== editedFingerprint.size) return previous;
        const notes = previous.journal.workflow_notes.filter(
          note => note.start_time !== savedWorkflow.workflow_note.start_time,
        );
        return {
          ...previous,
          cache: {...previous.cache, journal_fingerprint: savedWorkflow.journal_fingerprint},
          journal: {
            ...previous.journal,
            exists: true,
            workflow_notes: [...notes, {...savedWorkflow.workflow_note, raw: ""}],
          },
        };
      });
    }
    try {
      const refreshed = await fetchDay(targetDate, dayMode, true);
      if (
        generation !== loadGeneration.current ||
        selectedDateRef.current !== targetDate
      ) {
        return;
      }
      setDay(refreshed);
      const targetMonth = monthOf(targetDate);
      monthLoadGeneration.current += 1;
      const cachedMonth = monthCache.current.get(targetMonth);
      if (cachedMonth) {
        monthCache.current.set(targetMonth, {
          ...cachedMonth,
          [targetDate]: refreshed.overview.review_has_content,
        });
      }
      setMonthRecords((previous) =>
        monthCursor === targetMonth
          ? {
              ...previous,
              [targetDate]: refreshed.overview.review_has_content,
            }
          : previous,
      );
      setMonthRevision((revision) => revision + 1);
      yearCache.current.clear();
      setYear((previous) =>
        previous.map((item) =>
          item.date === targetDate ? rangeDayFromResponse(refreshed) : item,
        ),
      );
      if (isAnnualMode(weekMode)) {
        setYearRevision((revision) => revision + 1);
      }
      // The refreshed day cache feeds the range endpoint, so the visible
      // rhythm strip stays in sync after a save.
      if (!isAnnualMode(weekMode)) {
        const refreshedRange = await fetchRange(
          weekRange.start,
          weekRange.end,
          dayMode,
        );
        if (
          generation !== loadGeneration.current ||
          selectedDateRef.current !== targetDate
        ) {
          return;
        }
        setWeek(refreshedRange.days);
      }
    } catch (reason) {
      if (
        generation === loadGeneration.current &&
        selectedDateRef.current === targetDate
      ) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }, [dayMode, monthCursor, runtime, weekMode, weekRange]);

  useEffect(() => {
    void load();
  }, [load]);

  // Annual views are deliberately lazy: nothing loads until the user enters
  // a year view, and ordinary single-day pages never scan a year. Cold loads
  // reuse the existing range endpoint with a small bounded worker pool (3 in
  // flight). Fourteen-day slices keep visible progress moving while the
  // backend batches each slice into one read per ActivityWatch bucket.
  useEffect(() => {
    if (!runtime || !isAnnualMode(weekMode)) return;
    const cacheKey = `${dayMode}:${annualRange.start}:${annualRange.end}`;
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
      const candidateEnd = shiftDate(cursor, ANNUAL_CHUNK_DAYS - 1);
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
            dayMode,
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
  }, [
    annualRange.end,
    annualRange.start,
    dayMode,
    runtime,
    weekMode,
    yearRevision,
  ]);

  useEffect(() => {
    if (!runtime) return;
    const url = new URL(window.location.href);
    if (date === currentDate) {
      url.searchParams.delete("date");
    } else {
      url.searchParams.set("date", date);
    }
    url.searchParams.delete("view");
    window.history.replaceState(null, "", url);
  }, [currentDate, date, runtime]);

  // Follow the selected day's month in the calendar.
  useEffect(() => {
    setMonthCursor(monthOf(date));
  }, [date]);

  // Activity dots for the visible calendar month.
  useEffect(() => {
    if (!runtime || !monthCursor) return;
    const generation = ++monthLoadGeneration.current;
    const cached = monthCache.current.get(monthCursor);
    if (cached) {
      setMonthRecords(cached);
      return;
    }
    const today = currentDate;
    const start = `${monthCursor}-01`;
    if (start > today) {
      setMonthRecords({});
      return;
    }
    const end = monthEnd(monthCursor) < today ? monthEnd(monthCursor) : today;
    let cancelled = false;
    fetchRange(start, end, dayMode)
      .then((r) => {
        if (cancelled || generation !== monthLoadGeneration.current) return;
        const map: Record<string, boolean> = {};
        for (const d of r.days) {
          map[d.date] = d.overview.review_has_content;
        }
        monthCache.current.set(monthCursor, map);
        setMonthRecords(map);
      })
      .catch(() => {
        if (!cancelled && generation === monthLoadGeneration.current) {
          setMonthRecords({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentDate, dayMode, monthCursor, monthRevision, runtime]);

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

  useEffect(() => {
    const narrowViewport = window.matchMedia("(max-width: 900px)");
    const closeOnDesktop = () => {
      if (!narrowViewport.matches) setMobileSidebarOpen(false);
    };
    narrowViewport.addEventListener("change", closeOnDesktop);
    return () => narrowViewport.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileSidebarOpen]);

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
  const passiveMediaSeconds =
    day?.quality.time_accounting.passive_media_seconds ?? 0;

  const selectedDate = parseLocalDate(date);
  const canMoveToNextWeek =
    startOfISOWeek(date) < startOfISOWeek(currentDate);
  const canMoveHeaderPrevious = date > `${ACTIVITY_FIRST_YEAR}-01-01`;
  const moveHeaderDate = (delta: -1 | 1) =>
    selectDate(shiftDate(date, delta));

  if (!runtime) {
    return (
      <div className="loading" role={bootstrapError ? "alert" : "status"}>
        {bootstrapError
          ? `无法读取运行设置：${bootstrapError}`
          : "正在读取运行设置…"}
      </div>
    );
  }

  // The five design studies share this app's real data, date state, filters,
  // and guarded editors. The regular entry point retains its existing layout.
  if (renderShell) {
    return renderShell({
      date,
      currentDate,
      dateLabel: `${selectedDate.getMonth() + 1}月${selectedDate.getDate()}日`,
      weekday: `星期${weekdayShort(date)}`,
      year: selectedDate.getFullYear(),
      weekNumber: isoWeekNumber(date),
      day,
      displayDay: filteredDay,
      sessions,
      timezone: runtime.timezone,
      onInspect: setActivitySelection,
      dayMode,
      dayStartClock: dayMode === "routine" ? runtime.routine_day_start : "00:00",
      journalWriteEnabled: runtime.journal_write_enabled,
      onDaySaved: refreshSelectedDay,
      days: week,
      screenTime: day ? fmtDuration(day.overview.active_seconds) : "—",
      passiveTime: fmtDuration(passiveMediaSeconds),
      windowLabel: bounds ? `${fmtClock(bounds.first, runtime.timezone)} — ${fmtClock(bounds.last, runtime.timezone)}` : "暂无活动",
      sessionCount: sessions.length,
      topApp: topApps[0]?.app ?? "暂无记录",
      selectDate,
      calendar: <Sidebar
        date={date} today={currentDate} monthCursor={monthCursor}
        monthRecords={monthRecords} categories={categoryOptions} apps={topApps}
        hidden={hiddenCats} onSelectDate={selectDate}
        onMonthChange={(delta) => setMonthCursor((month) => shiftMonth(month, delta))}
        onToggleCategory={(category) => setHiddenCats((previous) => {
          const next = new Set(previous);
          if (next.has(category)) next.delete(category); else next.add(category);
          return next;
        })}
        onShowAll={() => setHiddenCats(new Set())} onCollapse={() => {}}
      />,
      timeline: day && filteredDay ? <section className="overview" key={date}>
        <div className="rhythm-heading"><h2 className="rhythm-title">时间线</h2>
          <span className="theme-section-caption">{bounds ? `${fmtClock(bounds.first, runtime.timezone)} — ${fmtClock(bounds.last, runtime.timezone)}` : "暂无活动"}</span>
        </div>
        <DayRibbon rangeStart={day.range.start} rangeEnd={day.range.end}
          timezone={runtime.timezone} timeline={filteredDay.timeline} onSelectBlock={setActivitySelection} />
      </section> : null,
      rhythm: day ? <WeekStrip
        days={week} yearDays={year} yearLoading={yearLoading} yearProgress={yearProgress}
        yearTotal={annualTotal} yearError={yearError}
        yearRangeStart={annualRange.displayStart} yearRangeEnd={annualRange.displayEnd}
        yearDataEnd={annualRange.end} calendarYear={calendarYear} availableYears={availableYears}
        selected={date} timezone={runtime.timezone} mode={weekMode} weekNumber={isoWeekNumber(date)}
        canMoveNext={canMoveToNextWeek} onModeChange={setWeekMode}
        onCalendarYearChange={(next) => { setCalendarYear(next); setWeekMode("calendarYear"); }}
        onShiftWeek={(delta) => {
          const candidate = shiftDate(date, delta * 7);
          selectDate(candidate > currentDate ? currentDate : candidate);
        }} onSelect={selectDate}
      /> : null,
      workflow: day ? <div className="theme-workflow-content" key={date}><h2 className="section-title">工作流</h2>
        <SessionList date={date} sessions={sessions} journal={day.journal}
          journalFingerprint={day.cache.journal_fingerprint} timezone={runtime.timezone}
          writeEnabled={runtime.journal_write_enabled} onSaved={refreshSelectedDay} />
      </div> : null,
      notes: day ? <ReviewWorkspace key={date} date={date} journal={day.journal}
        journalFingerprint={day.cache.journal_fingerprint} writeEnabled={runtime.journal_write_enabled}
        scope={reviewScope} onScopeChange={setReviewScope} onDaySaved={refreshSelectedDay} /> : null,
      warnings: day ? <QualityWarnings day={day} /> : null,
      status: error ? <div className="error-card" role="alert">暂时无法加载这一天。<button onClick={() => void load()}>重新加载</button></div>
        : loading && !day ? <div className="loading" role="status">正在读取这一天…</div> : null,
      overlay: activitySelection ? <ActivityEditor selection={activitySelection} date={date} mode={dayMode}
        writeEnabled={runtime.activity_edit_enabled} onClose={() => setActivitySelection(null)}
        onChanged={refreshSelectedDay} /> : null,
    });
  }

  return (
    <div
      className={`layout ${sidebarOpen ? "" : "layout-collapsed"} ${
        mobileSidebarOpen ? "mobile-sidebar-open" : ""
      }`}
    >
      {mobileSidebarOpen && (
        <button
          type="button"
          className="mobile-sidebar-scrim"
          aria-label="关闭侧边栏"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      {(sidebarOpen || mobileSidebarOpen) && (
        <Sidebar
          date={date}
          today={currentDate}
          monthCursor={monthCursor}
          monthRecords={monthRecords}
          categories={categoryOptions}
          apps={topApps}
          hidden={hiddenCats}
          onSelectDate={(nextDate) => {
            selectDate(nextDate);
            setMobileSidebarOpen(false);
          }}
          onMonthChange={(delta) =>
            setMonthCursor((month) => shiftMonth(month, delta))
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
          onCollapse={() => {
            if (window.matchMedia("(max-width: 900px)").matches) {
              setMobileSidebarOpen(false);
            } else {
              setSidebarOpen(false);
            }
          }}
        />
      )}

      {!sidebarOpen && (
        <aside className="sidebar-rail" aria-label="侧边栏控制">
          <button
            className="nav-btn sidebar-toggle-btn rail-toggle"
            aria-label="展开侧边栏"
            onClick={() => setSidebarOpen(true)}
          >
            <SidebarToggleIcon />
          </button>
        </aside>
      )}

      <div className="page">
        <header className="header">
          <div className="header-title-group">
            <button
              type="button"
              className="nav-btn sidebar-toggle-btn mobile-sidebar-toggle"
              aria-label="打开侧边栏"
              aria-controls="activity-sidebar"
              aria-expanded={mobileSidebarOpen}
              onClick={() => setMobileSidebarOpen(true)}
            >
              <SidebarToggleIcon />
            </button>
            <h1 className="date-title">
              <span>
                {selectedDate.getMonth() + 1}月{selectedDate.getDate()}日
              </span>
              <small>
                {selectedDate.getFullYear()}年 · 第{isoWeekNumber(date)}周 · 星期
                {weekdayShort(date)}
              </small>
            </h1>
          </div>
          <nav className="header-date-nav" aria-label="切换日期">
            <button
              type="button"
              aria-label="上一天"
              disabled={!canMoveHeaderPrevious}
              onClick={() => moveHeaderDate(-1)}
            >
              <span
                className="cal-chevron cal-chevron-prev"
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              aria-label="下一天"
              onClick={() => moveHeaderDate(1)}
            >
              <span
                className="cal-chevron cal-chevron-next"
                aria-hidden="true"
              />
            </button>
          </nav>
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
                        {fmtClock(bounds.first, runtime.timezone)} –{" "}
                        {fmtClock(bounds.last, runtime.timezone)}
                      </b>
                      活动窗口
                    </span>
                  )}
                  <span>
                    <b>{fmtDuration(day.overview.active_seconds)}</b>
                    屏幕时间
                  </span>
                  {passiveMediaSeconds > 0 && (
                    <span>
                      <b>{fmtDuration(passiveMediaSeconds)}</b>
                      被动观看
                    </span>
                  )}
                </div>
              </div>
              <DayRibbon
                rangeStart={day.range.start}
                rangeEnd={day.range.end}
                timezone={runtime.timezone}
                timeline={filteredDay.timeline}
                onSelectBlock={setActivitySelection}
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
              timezone={runtime.timezone}
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
                selectDate(candidate > currentDate ? currentDate : candidate);
              }}
              onSelect={selectDate}
            />

            <main className="columns">
              <section className="col">
                <h2 className="section-title">工作流</h2>
                <SessionList
                  date={date}
                  sessions={sessions}
                  journal={day.journal}
                  journalFingerprint={day.cache.journal_fingerprint}
                  timezone={runtime.timezone}
                  writeEnabled={runtime.journal_write_enabled}
                  onSaved={refreshSelectedDay}
                />
              </section>
              <section className="col">
                <ReviewWorkspace
                  date={date}
                  journal={day.journal}
                  journalFingerprint={day.cache.journal_fingerprint}
                  writeEnabled={runtime.journal_write_enabled}
                  scope={reviewScope}
                  onScopeChange={setReviewScope}
                  onDaySaved={refreshSelectedDay}
                />
              </section>
            </main>

            <QualityWarnings day={day} />
          </div>
        )}

        {loading && !day && <div className="loading">加载中…</div>}
      </div>
      {activitySelection && (
        <ActivityEditor
          selection={activitySelection}
          date={date}
          mode={dayMode}
          writeEnabled={runtime.activity_edit_enabled}
          onClose={() => setActivitySelection(null)}
          onChanged={refreshSelectedDay}
        />
      )}
    </div>
  );
}
