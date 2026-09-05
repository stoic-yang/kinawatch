import type { ThemeShellProps } from "../types";
import { Brand, DateControls, Hours, ThemeSwitcher } from "../shared";
import "./studio.css";

const studioSections = [
  { id: "timeline", label: "时间线", number: "01" },
  { id: "rhythm", label: "节律", number: "02" },
  { id: "workflow", label: "工作流", number: "03" },
  { id: "notes", label: "笔记", number: "04" },
];

/** Graphic, asymmetric daily index built from the same live application slots. */
export function Studio(props: ThemeShellProps) {
  const [, month, dateOfMonth] = props.date.split("-");
  const passiveSeconds = props.day?.quality.time_accounting.passive_media_seconds ?? 0;

  return (
    <div className="theme-page theme-studio" id="top">
      <header className="studio-topbar">
        <Brand />
        <span className="studio-topbar-label">日常观察室 <span aria-hidden="true">↗</span></span>
        <ThemeSwitcher current="studio" />
      </header>

      <main className="studio-main" id="studio-main">
        <section className="studio-cover" aria-label="所选日期与活动概览">
          <div className="studio-date-block">
            <div className="studio-cover-eyebrow"><span>构造 / STUDIO</span><span>W{String(props.weekNumber).padStart(2, "0")}</span></div>
            <h1><time dateTime={props.date} aria-label={`${props.year}年${props.dateLabel}`}><span>{month}</span><b aria-hidden="true">.</b><span>{dateOfMonth}</span></time></h1>
            <div className="studio-cover-footer">
              <p>{props.year} 年 · {props.weekday}<small>把一天，清楚展开。</small></p>
              <DateControls date={props.date} currentDate={props.currentDate} onSelect={props.selectDate} />
            </div>
          </div>
          <div className="studio-stat-block">
            <div className="studio-stat-label"><span>屏幕时间</span><span className="studio-stat-symbol" aria-hidden="true">↗</span></div>
            <p className="studio-screen-value"><Hours value={props.screenTime} /></p>
            <div className="studio-stat-grid">
              <div><span>活动窗口</span><strong>{props.windowLabel}</strong></div>
              <div><span>活动会话</span><strong>{props.day ? props.sessionCount : "—"}<small> 段</small></strong></div>
            </div>
            {passiveSeconds > 0 ? <p className="studio-passive-time">其中，被动观看 {props.passiveTime}</p> : null}
          </div>
        </section>

        {props.status}

        <nav className="studio-index-nav" aria-label="页面章节">
          {studioSections.map((section) => (
            <a href={`#theme-${section.id}`} key={section.id}>
              <span className="studio-nav-number">{section.number}</span><span>{section.label}</span><span className="studio-nav-arrow" aria-hidden="true">↘</span>
            </a>
          ))}
        </nav>

        <div className="studio-body-grid">
          <div className="studio-primary">
            <section className="studio-content-section studio-timeline" id="theme-timeline" aria-label="时间线">
              <div className="studio-section-index"><span>01 / TIMELINE</span><span>一天的时间切片</span></div>
              {props.timeline}
            </section>
            <section className="studio-content-section studio-rhythm" id="theme-rhythm" aria-label="活动节律">
              <div className="studio-section-index"><span>02 / RHYTHM</span><span>放大一点，看见规律</span></div>
              {props.rhythm}
            </section>
            <section className="studio-content-section studio-workflow" id="theme-workflow" aria-label="工作流">
              <div className="studio-section-index"><span>03 / WORKFLOW</span><span>发生了什么，留下了什么</span></div>
              {props.workflow}
            </section>
          </div>

          <aside className="studio-secondary" aria-label="日历与笔记">
            <details className="studio-calendar">
              <summary><span><b>日期与分类</b><small>CALENDAR & FILTERS</small></span><span className="studio-calendar-toggle" aria-hidden="true">+</span></summary>
              <div className="studio-calendar-content">{props.calendar}</div>
            </details>
            <section className="studio-content-section studio-notes" id="theme-notes" aria-label="笔记">
              <div className="studio-section-index"><span>04 / NOTES</span><span>写下，才不会忘记</span></div>
              {props.notes}
            </section>
          </aside>
        </div>

        {props.warnings}

        <footer className="studio-footer"><span>一天一页，一点一点。</span><span className="studio-footer-edition">KINAWATCH — STUDIO</span><a href="#studio-main">回到页首 <span aria-hidden="true">↑</span></a></footer>
      </main>
      {props.overlay}
    </div>
  );
}
