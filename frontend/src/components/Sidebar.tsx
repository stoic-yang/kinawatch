import { useMemo } from "react";
import { categoryColor } from "../lib/colors";
import { fmtDuration, toDateStr } from "../lib/format";

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

const DOW = ["一", "二", "三", "四", "五", "六", "日"];
const PRIMARY_CATEGORY_LIMIT = 6;

interface CalendarCell {
  date: string;
  day: number;
  inMonth: boolean;
  future: boolean;
}

function buildMonthCells(monthCursor: string, today: string): CalendarCell[] {
  const [y, m] = monthCursor.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  // Monday-first grid.
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(y, m - 1, 1 - lead);
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const dateStr = toDateStr(d);
    cells.push({
      date: dateStr,
      day: d.getDate(),
      inMonth: d.getMonth() === m - 1,
      future: dateStr > today,
    });
  }
  // Drop a fully out-of-month trailing week.
  const lastRowStart = cells[35];
  if (lastRowStart && !cells.slice(35).some((c) => c.inMonth)) {
    return cells.slice(0, 35);
  }
  return cells;
}

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
}) {
  const cells = useMemo(
    () => buildMonthCells(monthCursor, today),
    [monthCursor, today],
  );
  const primaryCategories = categories.slice(0, PRIMARY_CATEGORY_LIMIT);

  return (
    <aside className="sidebar">
      <div className="cal-head">
        <button className="nav-btn cal-nav" aria-label="上个月" onClick={() => onMonthChange(-1)}>
          <span className="cal-chevron cal-chevron-prev" aria-hidden="true" />
        </button>
        <button className="nav-btn cal-nav" aria-label="下个月" onClick={() => onMonthChange(1)}>
          <span className="cal-chevron cal-chevron-next" aria-hidden="true" />
        </button>
        <button
          className="nav-btn cal-nav sidebar-toggle-btn collapse-btn"
          aria-label="收起侧边栏"
          title="收起侧边栏"
          onClick={onCollapse}
        >
          <SidebarToggleIcon />
        </button>
      </div>

      <div className="cal-grid">
        {DOW.map((d) => (
          <span key={d} className="cal-dow">
            {d}
          </span>
        ))}
        {cells.map((c) => {
          const selected = c.date === date;
          const isToday = c.date === today;
          const hasRecord = monthRecords[c.date] ?? false;
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
              aria-label={hasRecord ? `${c.date}，有记录` : c.date}
              aria-current={selected ? "date" : undefined}
              title={hasRecord ? `${c.date} · 有记录` : c.date}
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

      {categories.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-label">
            <span>主要分类</span>
            {hidden.size > 0 && (
              <button className="show-all-btn" onClick={onShowAll}>
                全部显示
              </button>
            )}
          </div>
          {primaryCategories.map((c) => {
            const off = hidden.has(c.category);
            const color = categoryColor(c.category);
            return (
              <button
                key={c.category}
                className={`filter-row ${off ? "filter-row-hidden" : ""}`}
                onClick={() => onToggleCategory(c.category)}
                title={off ? "点击显示" : "点击隐藏"}
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
          })}
        </div>
      )}

      {apps.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-label">
            <span>主要应用</span>
          </div>
          {apps.map((app) => (
            <div className="sidebar-app-row" key={app.app}>
              <i style={{ background: categoryColor(app.category) }} />
              <span className="filter-name">{app.app}</span>
              <span className="filter-dur">{fmtDuration(app.seconds)}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

export function monthOf(dateStr: string): string {
  return dateStr.slice(0, 7);
}

export function shiftMonth(monthCursor: string, delta: number): string {
  const [y, m] = monthCursor.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function monthEnd(monthCursor: string): string {
  const [y, m] = monthCursor.split("-").map(Number);
  return toDateStr(new Date(y, m, 0));
}
