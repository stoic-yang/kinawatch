import { useCallback, useEffect, useId, useState } from "react";
import { ViewportTooltip, type ViewportTooltipAnchor } from "../../components/ViewportTooltip";
import { sleepDuration, type HealthDay } from "./personalHealth";
import { healthTrend } from "./health-trend";

const numbers = new Intl.NumberFormat("zh-CN");
const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const fullDate = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

export function HealthTrend({ days, selected, kind, visible, onSelect }: {
  days: HealthDay[]; selected: string; kind: "sleep" | "steps"; visible: boolean; onSelect: (date: string) => void;
}) {
  const values = days.map(day => kind === "sleep" ? day.sleep?.minutes ?? null : day.steps?.count ?? null);
  const { maximum, points, paths } = healthTrend(values, kind === "sleep" ? 600 : 5000);
  const rangeKey = `${days[0]?.date}:${days.length}`;
  const [inspection, setInspection] = useState<{ rangeKey: string; index: number; anchor: ViewportTooltipAnchor } | null>(null);
  const tooltipId = useId();
  const dismiss = useCallback(() => setInspection(null), []);
  useEffect(() => { dismiss(); }, [dismiss, rangeKey, visible]);
  const tooltip = visible && inspection?.rangeKey === rangeKey ? inspection : null;
  const label = kind === "sleep" ? "睡眠时长" : "步数";
  const describe = (value: number | null) => kind === "sleep" ? sleepDuration(value) : value === null ? "未记录" : `${numbers.format(value)} 步`;
  function inspect(index: number, element: HTMLButtonElement) {
    const bounds = element.querySelector(".health-trend-mark")!.getBoundingClientRect();
    setInspection({ rangeKey, index, anchor: { x: bounds.x + bounds.width / 2, top: bounds.top, bottom: bounds.bottom } });
  }
  return <div className={`health-trend health-trend-${kind}`} data-density={days.length > 7 ? "month" : "week"} onMouseLeave={dismiss}>
    <div className="health-trend-axis" aria-hidden="true">{[1, .5, 0].map(ratio => <span key={ratio} style={{ top: `${(1 - ratio) * 100}%` }}>{kind === "sleep" ? `${maximum * ratio / 60}小时` : numbers.format(maximum * ratio)}</span>)}</div>
    <div className="health-trend-canvas">
      <svg className="health-trend-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {[0, 50, 100].map(y => <line className="health-trend-gridline" key={y} x1="0" x2="100" y1={y} y2={y}/>)}
        {paths.map((path, index) => <path className="health-trend-line" key={index} d={path}/>)}
      </svg>
      {values.every(value => value === null) && <span className="health-trend-empty">所选范围暂无{label}记录</span>}
      {days.map((day, index) => {
        const value = values[index];
        const top = `${points[index].y ?? 100}%`;
        return <button type="button" key={day.date} className="health-trend-day" aria-pressed={selected === day.date}
          aria-label={`${fullDate(day.date)}，${label}，${describe(value)}`} aria-describedby={tooltip?.index === index ? tooltipId : undefined}
          aria-keyshortcuts="ArrowLeft ArrowRight Home End" style={{ left: `${index / days.length * 100}%`, width: `${100 / days.length}%` }}
          onClick={() => onSelect(day.date)} onMouseEnter={event => inspect(index, event.currentTarget)} onFocus={event => inspect(index, event.currentTarget)} onBlur={dismiss}
          onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); dismiss(); return; }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? days.length - 1 : Math.max(0, Math.min(days.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(".health-trend-day")[next]?.focus({ preventScroll: true });
          }}>
          <span className={`health-trend-mark${value === null ? " is-missing" : ""}`} style={{ top }} aria-hidden="true"/>
          {selected === day.date && days.length <= 7 && value !== null && <span className="health-trend-value" style={{ top }} aria-hidden="true">{kind === "sleep" ? sleepDuration(value) : numbers.format(value)}</span>}
          <span className="health-trend-date" aria-hidden="true">{days.length <= 7 || index % 5 === 0 || index === days.length - 1 ? shortDate(day.date) : ""}</span>
        </button>;
      })}
    </div>
    {tooltip && <ViewportTooltip id={tooltipId} className="health-trend-tooltip" anchor={tooltip.anchor} side="above" onDismiss={dismiss}>
      <span>{fullDate(days[tooltip.index].date)} · {label}</span><strong>{describe(values[tooltip.index])}</strong>
    </ViewportTooltip>}
  </div>;
}
