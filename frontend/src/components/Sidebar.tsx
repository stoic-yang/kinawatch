import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  buildMonthCells,
  MONDAY_WEEKDAYS,
  monthOf,
} from "../lib/calendar";
import { categoryColor } from "../lib/colors";
import { fmtDuration } from "../lib/format";

export interface CategoryOption {
  category: string;
  label: string;
  seconds: number;
}

export interface AppOption {
  app: string;
  seconds: number;
  category: string;
}

export function SidebarToggleIcon() {
  return <span className="sidebar-toggle-icon" aria-hidden="true" />;
}

const PRIMARY_CATEGORY_LIMIT = 6;

export function Sidebar({
  date,
  today,
  monthCursor,
  monthRecords,
  categories,
  apps,
  hidden,
  onSelectDate,
  onMonthChange,
  onToggleCategory,
  onShowAll,
  onCollapse,
  independentSections = false,
  afterCalendar,
}: {
  date: string;
  today: string;
  monthCursor: string;
  monthRecords: Record<string, boolean>;
  categories: CategoryOption[];
  apps: AppOption[];
  hidden: Set<string>;
  onSelectDate: (d: string) => void;
  onMonthChange: (delta: number) => void;
  onToggleCategory: (c: string) => void;
  onShowAll: () => void;
  onCollapse: () => void;
  independentSections?: boolean;
  afterCalendar?: ReactNode;
}) {
  const sectionId = useId();
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 820px)").matches);
  const [sectionChoices, setSectionChoices] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!independentSections) return;
    const media = window.matchMedia("(max-width: 820px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [independentSections]);
  const cells = useMemo(
    () => buildMonthCells(monthCursor, today),
    [monthCursor, today],
  );
  const primaryCategories = categories.slice(0, PRIMARY_CATEGORY_LIMIT);
  const [calendarYear, calendarMonth] = monthCursor.split("-").map(Number);

  // Keep each explicit choice through page/date changes and responsive layout
  // changes. Only untouched sections follow the compact default.
  function section(name: string, label: string, content: ReactNode, action?: ReactNode) {
    const open = sectionChoices[name] ?? !compact;
    const bodyId = `${sectionId}-${name}`;
    return (
      <section className="sidebar-disclosure" data-sidebar-section={name}>
        <button
          type="button"
          className="sidebar-section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setSectionChoices(previous => ({ ...previous, [name]: !open }))}
        >
          <span>{label}</span>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
            <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div id={bodyId} className="sidebar-section-content" hidden={!open}>
          {action && <div className="sidebar-section-actions">{action}</div>}
          {content}
        </div>
      </section>
    );
  }

  const calendar = (
    <>
      <div className="cal-head">
        <div className="cal-title" aria-live="polite">
          <strong>{calendarMonth}月</strong>
          <span>{calendarYear}</span>
        </div>
        <button
          className="nav-btn cal-nav"
          aria-label="上个月"
          onClick={() => onMonthChange(-1)}
        >
          <span className="cal-chevron cal-chevron-prev" aria-hidden="true" />
        </button>
        <button
          className="nav-btn cal-nav"
          aria-label="下个月"
          disabled={monthCursor >= monthOf(today)}
          onClick={() => onMonthChange(1)}
        >
          <span className="cal-chevron cal-chevron-next" aria-hidden="true" />
        </button>
        <button
          className="nav-btn cal-nav sidebar-toggle-btn collapse-btn"
          aria-label="收起侧边栏"
          onClick={onCollapse}
        >
          <SidebarToggleIcon />
        </button>
      </div>

      <div className="cal-grid">
        {MONDAY_WEEKDAYS.map((d) => (
          <span key={d} className="cal-dow">
            {d}
          </span>
        ))}
        {cells.map((c) => {
          const selected = c.date === date;
          const isToday = c.date === today;
          const hasRecord = monthRecords[c.date] ?? false;
          const dateLabel = [
            c.date,
            selected ? "当前日期" : "",
            hasRecord ? "有记录" : "",
          ]
            .filter(Boolean)
            .join("，");
          return (
            <button
              key={c.date}
              className={[
                "cal-day",
                c.inMonth ? "" : "cal-day-out",
                c.future ? "cal-day-future" : "",
                selected ? "cal-day-selected" : "",
                isToday ? "cal-day-today" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-label={dateLabel}
              aria-current={selected ? "date" : undefined}
              disabled={c.future}
              onClick={() => onSelectDate(c.date)}
            >
              <span>{c.day}</span>
              <span
                className={`cal-dot ${hasRecord ? "cal-dot-recorded" : ""}`}
                aria-hidden
              />
            </button>
          );
        })}
      </div>
    </>
  );
  const categoryRows = primaryCategories.map((c) => {
    const off = hidden.has(c.category);
    const color = categoryColor(c.category);
    return (
      <button
        key={c.category}
        className={`filter-row ${off ? "filter-row-hidden" : ""}`}
        aria-pressed={!off}
        onClick={() => onToggleCategory(c.category)}
      >
        <i
          style={
            off
              ? { boxShadow: `inset 0 0 0 1.5px ${color}` }
              : { background: color }
          }
        />
        <span className="filter-name">{c.label}</span>
        <span className="filter-dur">
          {c.seconds > 0 ? fmtDuration(c.seconds) : ""}
        </span>
      </button>
    );
  });
  const appRows = apps.map((app) => (
    <div className="sidebar-app-row" key={app.app}>
      <i style={{ background: categoryColor(app.category) }} />
      <span className="filter-name">{app.app}</span>
      <span className="filter-dur">{fmtDuration(app.seconds)}</span>
    </div>
  ));
  const showAll = hidden.size > 0 && (
    <button type="button" className="show-all-btn" onClick={onShowAll}>全部显示</button>
  );

  return (
    <aside id="activity-sidebar" className={`sidebar${independentSections ? " sidebar-independent" : ""}`} aria-label="日期与活动导航">
      {independentSections ? section("calendar", "日历", calendar) : calendar}
      {afterCalendar}
      {categories.length > 0 && (independentSections
        ? section("categories", "主要分类", categoryRows, showAll)
        : <div className="sidebar-section">
            <div className="sidebar-label"><span>主要分类</span>{showAll}</div>
            {categoryRows}
          </div>
      )}
      {apps.length > 0 && (independentSections
        ? section("apps", "主要应用", appRows)
        : <div className="sidebar-section">
            <div className="sidebar-label"><span>主要应用</span></div>
            {appRows}
          </div>
      )}
    </aside>
  );
}
