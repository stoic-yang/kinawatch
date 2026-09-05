import { Brand, CalendarPanel, DateControls, ThemeSwitcher } from "../shared";
import type { ThemeShellProps } from "../types";
import "./grove.css";

function GroveIcon({ kind }: { kind: "day" | "flow" | "note" | "rhythm" | "calendar" }) {
  const paths = {
    day: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5" /></>,
    flow: <><path d="M6 5v14m0-12h9m-9 5h12m-12 5h8" /><circle cx="6" cy="5" r="1.5" /><circle cx="6" cy="12" r="1.5" /><circle cx="6" cy="19" r="1.5" /></>,
    note: <><path d="M6 3h11a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M8 3v18m3-13h5m-5 4h5" /></>,
    rhythm: <path d="M3 16h3l3-9 4 12 3-14 2 8h3" />,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 10h18m-13 4h2m4 0h2m-8 4h2" /></>,
  };

  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

export function Grove(props: ThemeShellProps) {
  const weekday = props.weekday.startsWith("星期")
    ? props.weekday
    : `星期${props.weekday}`;

  return (
    <div className="theme-page theme-grove" id="top">
      <aside className="grove-rail" aria-label="林间导航">
        <div className="grove-identity">
          <Brand />
          <p><span className="grove-seed" aria-hidden="true" />林间 <span>GROVE</span></p>
        </div>

        <nav className="grove-navigation" aria-label="页面导航">
          <a href="#grove-overview" className="grove-today-link"><GroveIcon kind="day" /><span>我的一天</span><span className="grove-nav-dot" aria-hidden="true" /></a>
          <a href="#theme-workflow"><GroveIcon kind="flow" /><span>工作流</span></a>
          <a href="#theme-notes"><GroveIcon kind="note" /><span>笔记与复盘</span></a>
          <a href="#theme-rhythm"><GroveIcon kind="rhythm" /><span>活动节律</span></a>
          <a href="#grove-calendar" className="grove-mobile-calendar-link"><GroveIcon kind="calendar" /><span>日期与分类</span></a>
        </nav>

        <section className="grove-calendar" id="grove-calendar" aria-label="日期与分类">
          <CalendarPanel>{props.calendar}</CalendarPanel>
        </section>

        <div className="grove-rail-footer">
          <svg viewBox="0 0 28 28" width="24" height="24" fill="none" aria-hidden="true"><path d="M7 22c1-10 5-16 15-16 0 10-6 14-14 14m0 0L19 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span>留意时间，也留意自己。</span>
        </div>
      </aside>

      <div className="grove-workspace">
        <header className="grove-topbar">
          <span className="grove-breadcrumb"><span>林间</span><span aria-hidden="true">/</span>我的一天</span>
          <ThemeSwitcher current="grove" />
        </header>

        <main className="grove-main">
          <div className="grove-heading" id="grove-overview">
            <div>
              <p className="grove-kicker">YOUR DAILY SPACE</p>
              <h1><time dateTime={props.date}>{props.dateLabel}</time><span className="grove-date-dot" aria-hidden="true" /></h1>
              <p className="grove-date-caption">{weekday}<span aria-hidden="true">·</span>{props.year} 年，第 {props.weekNumber} 周</p>
            </div>
            <DateControls date={props.date} currentDate={props.currentDate} onSelect={props.selectDate} />
          </div>

          {props.status}
          {props.warnings}

          <section className="grove-day-summary" aria-label="当天活动概览">
            <div className="grove-summary-primary">
              <p>这一天的时光</p>
              <strong>{props.day ? props.screenTime : "—"}</strong>
              <span>屏幕时间</span>
            </div>
            <dl className="grove-summary-details">
              <div><dt>活动窗口</dt><dd>{props.day ? props.windowLabel : "—"}</dd></div>
              <div><dt>活动片段</dt><dd>{props.day ? props.sessionCount : "—"}<span> 段</span></dd></div>
              <div><dt>主要应用</dt><dd>{props.day ? props.topApp || "暂无记录" : "—"}</dd></div>
            </dl>
            <svg className="grove-leaf-art" width="216" height="194" viewBox="0 0 216 194" fill="none" aria-hidden="true">
              <path d="M61 194C58 94 90 24 184 12c17 93-6 146-94 160M63 184 164 37M80 153c33-5 61-5 99-25M99 124c-1-29-4-42 2-67m17 39 59-31" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </section>

          <section className="grove-timeline grove-surface" id="theme-timeline" aria-label="时间线">
            <div className="grove-section-eyebrow"><span className="grove-section-dot" aria-hidden="true" /><span>一天的轨迹</span></div>
            {props.timeline}
          </section>

          <div className="grove-content-grid">
            <section className="grove-workflow grove-surface" id="theme-workflow" aria-label="工作流">
              <p className="grove-section-eyebrow">01 <span aria-hidden="true">/</span> WORKFLOW</p>
              {props.workflow}
            </section>
            <section className="grove-notebook grove-surface" id="theme-notes" aria-label="笔记与复盘">
              <p className="grove-section-eyebrow">02 <span aria-hidden="true">/</span> NOTEBOOK</p>
              {props.notes}
            </section>
          </div>

          <section className="grove-rhythm grove-surface" id="theme-rhythm" aria-label="活动节律">
            <p className="grove-section-eyebrow">03 <span aria-hidden="true">/</span> DAILY RHYTHM</p>
            {props.rhythm}
          </section>

          <footer className="grove-footer"><span>KinaWatch · 林间</span><a href="#grove-overview">回到这一天 <span aria-hidden="true">↑</span></a></footer>
        </main>
      </div>
      {props.overlay}
    </div>
  );
}
