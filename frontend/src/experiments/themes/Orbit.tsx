import { useEffect, useState, type ReactNode } from "react";
import type { ThemeShellProps } from "../types";
import { Brand, DateControls, Hours, ThemeSwitcher } from "../shared";
import "./orbit.css";

const orbitSections = [
  { id: "timeline", label: "时间线", icon: "timeline" },
  { id: "rhythm", label: "节律", icon: "rhythm" },
  { id: "workflow", label: "工作流", icon: "workflow" },
  { id: "notes", label: "笔记", icon: "notes" },
] as const;

function OrbitSymbol() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="4" fill="currentColor" />
      <ellipse cx="16" cy="16" rx="13" ry="6.5" transform="rotate(-38 16 16)" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="26" cy="8" r="2" fill="currentColor" />
    </svg>
  );
}

function RailIcon({ name }: { name: (typeof orbitSections)[number]["icon"] }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === "timeline" ? (
        <><rect x="3.5" y="5" width="17" height="14" rx="3" /><path d="M7 9v6m4-4v4m4-7v7m3-5v5" /></>
      ) : name === "rhythm" ? (
        <><path d="M3 12h4l3-7 4 14 3-7h4" /></>
      ) : name === "workflow" ? (
        <><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><path d="M6 8v8m5-10h9m-9 6h6m-6 6h9" /></>
      ) : (
        <><path d="M6 3.5h9l4 4V20H6z" /><path d="M14 3.5V8h5M9 12h7m-7 4h5" /></>
      )}
    </svg>
  );
}

function OrbitCalendar({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(() => window.matchMedia("(min-width: 981px)").matches);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 981px)");
    const update = () => setExpanded(desktop.matches);
    desktop.addEventListener("change", update);
    return () => desktop.removeEventListener("change", update);
  }, []);
  return (
    <details className="theme-calendar-panel" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary><span>日历与分类</span><span className="theme-calendar-chevron" aria-hidden="true">⌄</span></summary>
      <div className="theme-calendar-content">{children}</div>
    </details>
  );
}

/** A compact, dark activity workspace; the slots retain all application state. */
export function Orbit(props: ThemeShellProps) {
  const passiveSeconds = props.day?.quality.time_accounting.passive_media_seconds ?? 0;

  return (
    <div className="theme-page theme-orbit" id="top">
      <nav className="orbit-rail" aria-label="页面章节">
        <a className="orbit-symbol" href="#orbit-main" aria-label="Orbit，回到每日概览">
          <OrbitSymbol />
        </a>
        <div className="orbit-rail-links">
          {orbitSections.map((section) => (
            <a key={section.id} href={`#theme-${section.id}`}>
              <RailIcon name={section.icon} />
              <span>{section.label}</span>
            </a>
          ))}
        </div>
        <span className="orbit-rail-caption" aria-hidden="true">ORBIT</span>
      </nav>

      <aside className="orbit-sidebar" aria-label="日历、分类与应用">
        <div className="orbit-sidebar-brand">
          <Brand />
          <span className="orbit-edition">轨道</span>
        </div>
        <div className="orbit-sidebar-intro">
          <span className="orbit-workspace-icon" aria-hidden="true"><OrbitSymbol /></span>
          <div><strong>我的活动空间</strong><span>让日常，有迹可循</span></div>
        </div>
        <div className="orbit-sidebar-eyebrow"><span>日历与筛选</span><span>{props.year}</span></div>
        <OrbitCalendar>{props.calendar}</OrbitCalendar>
        <div className="orbit-sidebar-footer">
          <span className="orbit-local-mark" aria-hidden="true" />
          本地记录 · 一天一页
        </div>
      </aside>

      <div className="orbit-workspace">
        <header className="orbit-topbar">
          <div className="orbit-breadcrumb"><span>活动空间</span><span aria-hidden="true">/</span><strong>每日概览</strong></div>
          <ThemeSwitcher current="orbit" />
        </header>

        <main className="orbit-main" id="orbit-main">
          <section className="orbit-day-head" aria-labelledby="orbit-date-title">
            <div>
              <div className="orbit-eyebrow"><span>DAILY ACTIVITY</span><span>W{String(props.weekNumber).padStart(2, "0")}</span></div>
              <h1 id="orbit-date-title"><time dateTime={props.date}>{props.dateLabel}</time></h1>
              <p>{props.year} 年 <span>·</span> {props.weekday} <span>·</span> 回看一天的流动</p>
            </div>
            <DateControls date={props.date} currentDate={props.currentDate} onSelect={props.selectDate} />
          </section>

          {props.status}

          <div className="orbit-stats" aria-label="当日活动概览">
            <div className="orbit-stat orbit-stat-primary">
              <span>屏幕时间</span>
              <strong><Hours value={props.screenTime} /></strong>
              <small>{passiveSeconds > 0 ? `含被动观看 ${props.passiveTime}` : "当日屏幕活动"}</small>
            </div>
            <div className="orbit-stat">
              <span>活动窗口</span>
              <strong className="orbit-window-value">{props.windowLabel}</strong>
              <small>首段至末段活动</small>
            </div>
            <div className="orbit-stat">
              <span>工作流</span>
              <strong>{props.day ? props.sessionCount : "—"}<em>段</em></strong>
              <small>按活动间隔划分</small>
            </div>
          </div>

          <section className="orbit-panel orbit-timeline" id="theme-timeline" aria-label="时间线">
            <div className="orbit-panel-kicker"><span>01 / DAY STREAM</span><span>按时间展开</span></div>
            {props.timeline}
          </section>

          <section className="orbit-panel orbit-rhythm" id="theme-rhythm" aria-label="活动节律">
            {props.rhythm}
          </section>

          <div className="orbit-lower-grid">
            <section className="orbit-panel orbit-workflow" id="theme-workflow" aria-label="工作流">
              <div className="orbit-panel-kicker"><span>02 / ACTIVITY LOG</span><span>当天的活动片段</span></div>
              {props.workflow}
            </section>
            <section className="orbit-panel orbit-notes" id="theme-notes" aria-label="笔记">
              <div className="orbit-panel-kicker"><span>03 / YOUR NOTES</span><span>思考留在这里</span></div>
              {props.notes}
            </section>
          </div>

          {props.warnings}

          <footer className="orbit-page-footer"><span>KINAWATCH / ORBIT</span><a href="#orbit-main">回到页首 <span aria-hidden="true">↑</span></a></footer>
        </main>
      </div>
      {props.overlay}
    </div>
  );
}
