import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { RangeDay } from "../api";
import { fmtDuration, parseLocalDate, shiftDate } from "../lib/format";
import {
  ViewportTooltip,
  type ViewportTooltipAnchor,
} from "./ViewportTooltip";

function mondayOffset(date: string): number {
  return (parseLocalDate(date).getDay() + 6) % 7;
}

function longDate(date: string): string {
  const value = parseLocalDate(date);
  return `${value.getFullYear()}年${value.getMonth() + 1}月${value.getDate()}日`;
}

function heatLevel(seconds: number): number {
  if (seconds <= 0) return 0;
  if (seconds < 2 * 3600) return 1;
  if (seconds < 4 * 3600) return 2;
  if (seconds < 7 * 3600) return 3;
  return 4;
}

interface HeatmapTooltip {
  date: string;
  dateLabel: string;
  activityLabel: string;
  anchor: ViewportTooltipAnchor;
}

function LoadingHeatmap({
  label,
  loaded,
  total,
}: {
  label: string;
  loaded: number;
  total: number;
}) {
  const progress = total > 0 ? Math.round((loaded / total) * 100) : 0;
  return (
    <div
      className="year-loading"
      role="status"
      aria-label={`正在整理${label}，已完成 ${loaded}/${total} 天，${progress}%`}
    >
      <div className="year-loading-grid" aria-hidden="true">
        {Array.from({ length: 371 }, (_, index) => (
          <span
            key={index}
            style={
              {
                "--loading-delay": `${-1450 + Math.floor(index / 7) * 18 + (index % 7) * 9}ms`,
              } as CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}

export function YearHeatmap({
  days,
  rangeStart,
  rangeEnd,
  dataEnd,
  rangeLabel,
  selected,
  loading,
  loaded,
  total,
  error,
  onSelect,
}: {
  days: RangeDay[];
  rangeStart: string;
  rangeEnd: string;
  dataEnd: string;
  rangeLabel: string;
  selected: string;
  loading: boolean;
  loaded: number;
  total: number;
  error: string | null;
  onSelect: (date: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<HeatmapTooltip | null>(null);
  const dismissTooltip = useCallback(() => setTooltip(null), []);

  function showTooltip(
    target: HTMLElement,
    date: string,
    seconds: number,
  ) {
    const rect = target.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    setTooltip({
      date,
      dateLabel: longDate(date),
      activityLabel: fmtDuration(seconds),
      anchor: { x: center, top: rect.top, bottom: rect.bottom },
    });
  }

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    function centerSelected() {
      const selectedCell =
        container?.querySelector<HTMLElement>('[aria-current="date"]') ??
        (!loading
          ? container?.querySelector<HTMLElement>(".year-grid button:last-of-type")
          : null);
      if (!container || !selectedCell) return;

      const centered =
        selectedCell.offsetLeft -
        container.clientWidth / 2 +
        selectedCell.clientWidth / 2;
      container.scrollLeft = Math.max(0, centered);
    }

    centerSelected();
    const resizeObserver = new ResizeObserver(centerSelected);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [days, selected, loading, rangeStart, rangeEnd]);

  if (loading && days.length === 0) {
    return <LoadingHeatmap label={rangeLabel} loaded={loaded} total={total} />;
  }
  if (error && days.length === 0) {
    return <p className="year-error">年度数据暂时不可用：{error}</p>;
  }
  if (days.length === 0) {
    return <p className="year-error">{rangeLabel}还没有可展示的数据。</p>;
  }

  const byDate = new Map(days.map((day) => [day.date, day]));
  const first = rangeStart;
  const last = rangeEnd;
  const gridStart = shiftDate(first, -mondayOffset(first));
  const gridEnd = shiftDate(last, 6 - mondayOffset(last));
  const cells: string[] = [];
  for (let cursor = gridStart; cursor <= gridEnd; cursor = shiftDate(cursor, 1)) {
    cells.push(cursor);
  }
  const weekCount = Math.ceil(cells.length / 7);
  const monthLabels: { key: string; week: number; label: string }[] = [];
  let previousMonth = "";
  cells.forEach((cellDate, index) => {
    if (cellDate < first || cellDate > last) return;
    const value = parseLocalDate(cellDate);
    const monthKey = `${value.getFullYear()}-${value.getMonth()}`;
    if (monthKey !== previousMonth) {
      monthLabels.push({
        key: monthKey,
        week: Math.floor(index / 7),
        label: `${value.getMonth() + 1}月`,
      });
      previousMonth = monthKey;
    }
  });

  return (
    <div className="year-heatmap" aria-busy={loading}>
      <div className="year-heatmap-scroll" ref={scrollRef}>
        <div
          className="year-chart"
          style={{ "--year-weeks": weekCount } as CSSProperties}
        >
          <div className="year-months" aria-hidden="true">
            {monthLabels.map((month) => (
              <span
                key={month.key}
                style={{ gridColumn: `${month.week + 1} / span 3` }}
              >
                {month.label}
              </span>
            ))}
          </div>
          <div
            className="year-grid"
            role="grid"
            aria-label={`${rangeLabel}活动热力图`}
          >
            {cells.map((cellDate, index) => {
              const day = byDate.get(cellDate);
              if (cellDate < first || cellDate > last) {
                return (
                  <span
                    key={cellDate}
                    className="year-cell year-cell-outside"
                    aria-hidden="true"
                  />
                );
              }
              if (!day) {
                if (cellDate <= dataEnd && loading) {
                  return (
                    <span
                      key={cellDate}
                      className="year-cell year-cell-loading"
                      style={
                        {
                          "--loading-delay": `${-900 + Math.floor(index / 7) * 18 + (index % 7) * 9}ms`,
                        } as CSSProperties
                      }
                      aria-hidden="true"
                    />
                  );
                }
                return (
                  <span
                    key={cellDate}
                    className="year-cell year-cell-future"
                    aria-hidden="true"
                  />
                );
              }
              const seconds = day.overview.combined_nonoverlap_seconds;
              const activityLabel = fmtDuration(seconds);
              const label = `${longDate(cellDate)}，屏幕活跃 ${activityLabel}`;
              return (
                <button
                  key={cellDate}
                  type="button"
                  role="gridcell"
                  className={`year-cell year-level-${heatLevel(seconds)} ${cellDate === selected ? "year-cell-selected" : ""}`}
                  aria-label={label}
                  aria-describedby={tooltip?.date === cellDate ? "year-activity-tooltip" : undefined}
                  aria-current={cellDate === selected ? "date" : undefined}
                  onMouseEnter={(event) => showTooltip(event.currentTarget, cellDate, seconds)}
                  onMouseLeave={dismissTooltip}
                  onFocus={(event) => showTooltip(event.currentTarget, cellDate, seconds)}
                  onBlur={dismissTooltip}
                  onClick={() => {
                    dismissTooltip();
                    onSelect(cellDate);
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
      {tooltip ? (
        <ViewportTooltip
          id="year-activity-tooltip"
          className="year-tooltip"
          anchor={tooltip.anchor}
          side="above"
          onDismiss={dismissTooltip}
        >
          <span className="year-tooltip-date">{tooltip.dateLabel}</span>
          <strong>屏幕活跃 {tooltip.activityLabel}</strong>
        </ViewportTooltip>
      ) : null}
      {error && days.length > 0 ? (
        <p className="year-error year-partial-error" role="alert">
          部分年度数据暂时不可用：{error}
        </p>
      ) : null}
    </div>
  );
}
