import { Brand, CalendarPanel, DateControls, Hours, SectionLinks, ThemeSwitcher } from "../shared";
import type { ThemeShellProps } from "../types";
import "./tide.css";

function HourlyWaterline({ hours }: { hours: number[] }) {
  if (!hours.length) return <div className="tide-empty-wave" />;
  const points = hours.map((seconds, index) => `${(index / Math.max(1, hours.length - 1)) * 240},${68 - Math.min(1, seconds / 3600) * 58}`).join(" ");
  return <svg className="tide-waterline" viewBox="0 0 240 76" preserveAspectRatio="none" role="img" aria-label="所选日每小时屏幕活动分布">
    <defs><linearGradient id="tide-water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".2" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
    <path d="M0 68H240M0 39H240M0 10H240" stroke="currentColor" strokeOpacity=".1" strokeDasharray="2 4" />
    <polygon points={`0,76 ${points} 240,76`} fill="url(#tide-water)" />
    <polyline points={points} stroke="currentColor" strokeWidth="2" fill="none" strokeLinejoin="round" />
  </svg>;
}

export function Tide(props: ThemeShellProps) {
  return <div className="theme-page theme-tide" id="top">
    <div className="tide-nav-wrap"><header className="tide-nav">
      <Brand /><SectionLinks /><ThemeSwitcher current="tide" />
    </header></div>
    <main className="tide-canvas">
      <header className="tide-intro">
        <div className="tide-day-title">
          <p className="tide-eyebrow"><span /> YOUR DAY, IN FLOW</p>
          <h1>{props.dateLabel}<span>{props.weekday}</span></h1>
          <div className="tide-date-line"><span>{props.year} · 第 {props.weekNumber} 周</span><DateControls date={props.date} currentDate={props.currentDate} onSelect={props.selectDate} /></div>
        </div>
        <div className="tide-overview">
          <div className="tide-total"><span className="tide-stat-label">屏幕时间</span><Hours value={props.screenTime} /><span className="tide-window">{props.windowLabel}</span></div>
          <div className="tide-wave"><span className="tide-wave-caption">一天的起伏<small>每小时活动</small></span><HourlyWaterline hours={props.day?.rhythm?.hourly_active_seconds ?? []} /></div>
        </div>
      </header>
      {props.status}
      <div className="tide-body">
        <div className="tide-activity">
          <section className="tide-island tide-timeline" id="theme-timeline"><div className="tide-island-eyebrow"><span>01</span> A DAY IN MOTION</div>{props.timeline}</section>
          <section className="tide-island tide-rhythm" id="theme-rhythm">{props.rhythm}</section>
          <section className="tide-island tide-workflow" id="theme-workflow"><div className="tide-island-eyebrow"><span>02</span> MOMENTS THAT MATTER <small>{props.day ? `${props.sessionCount} 段活动` : ""}</small></div>{props.workflow}</section>
        </div>
        <aside className="tide-companion">
          <section className="tide-island tide-notes" id="theme-notes"><div className="tide-island-eyebrow"><span>03</span> ROOM FOR THOUGHTS</div>{props.notes}</section>
          <section className="tide-calendar"><CalendarPanel>{props.calendar}</CalendarPanel></section>
        </aside>
      </div>
      <div className="tide-warnings">{props.warnings}</div>
      <footer className="tide-footer"><span>KinaWatch</span><span>留一点空间，给每一天。</span><a href="#top">回到顶部 ↑</a></footer>
    </main>
    {props.overlay}
  </div>;
}
