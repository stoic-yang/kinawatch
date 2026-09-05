import { Brand, CalendarPanel, DateControls, ThemeSwitcher } from "../shared";
import type { ThemeShellProps } from "../types";
import "./paper.css";

const PAPER_CONTENTS = [
  { href: "#theme-notes", number: "01", label: "笔记" },
  { href: "#theme-timeline", number: "02", label: "时间线" },
  { href: "#theme-workflow", number: "03", label: "工作流" },
  { href: "#theme-rhythm", number: "04", label: "节律" },
];

export function Paper(props: ThemeShellProps) {
  const weekday = props.weekday.startsWith("星期")
    ? props.weekday
    : `星期${props.weekday}`;

  return (
    <div className="theme-page theme-paper" id="top">
      <div className="paper-sheet">
        <div className="paper-edition">
          <span>个人时间手记 <span aria-hidden="true">/</span> A DAILY JOURNAL</span>
          <span>{props.year} · 第 {props.weekNumber} 周</span>
        </div>

        <header className="paper-masthead">
          <div className="paper-brand-lockup">
            <Brand />
            <span className="paper-theme-name">纸间</span>
          </div>
          <ThemeSwitcher current="paper" />
        </header>

        <div className="paper-day-heading">
          <div className="paper-date-block">
            <p className="paper-eyebrow">THE DAILY EDITION</p>
            <h1><time dateTime={props.date}>{props.dateLabel}</time></h1>
            <p className="paper-date-caption">
              <span>{weekday}</span>
              <span className="paper-small-separator" aria-hidden="true" />
              <span>{props.date === props.currentDate ? "今天的一页" : "这一天的一页"}</span>
            </p>
          </div>
          <div className="paper-day-metric">
            <span className="paper-metric-label">屏幕时间</span>
            <strong className="paper-metric-value">{props.day ? props.screenTime : "—"}</strong>
            <div className="paper-window-caption">
              <span>活动窗口</span>
              <span>{props.day ? props.windowLabel : "—"}</span>
            </div>
          </div>
        </div>

        <div className="paper-reading-bar">
          <nav className="paper-contents" aria-label="本页目录">
            {PAPER_CONTENTS.map((item) => (
              <a key={item.href} href={item.href}>
                <span>{item.number}</span>{item.label}
              </a>
            ))}
          </nav>
          <DateControls
            date={props.date}
            currentDate={props.currentDate}
            onSelect={props.selectDate}
          />
        </div>

        {props.status}
        {props.warnings}

        <main className="paper-main">
          <div className="paper-spread">
            <section className="paper-notebook" id="theme-notes" aria-label="笔记与复盘">
              <div className="paper-section-index">
                <span>01</span><span>笔记与复盘</span><span>NOTEBOOK</span>
              </div>
              {props.notes}
            </section>

            <div className="paper-evidence">
              <section className="paper-timeline" id="theme-timeline" aria-label="时间线">
                <div className="paper-section-index">
                  <span>02</span><span>时间的刻度</span><span>ACTIVITY</span>
                </div>
                {props.timeline}
              </section>

              <section className="paper-workflow" id="theme-workflow" aria-label="工作流">
                <div className="paper-section-index">
                  <span>03</span>
                  <span>一天的片段</span>
                  <span>{props.day ? `${props.sessionCount} 段` : "WORKFLOW"}</span>
                </div>
                {props.workflow}
              </section>
            </div>
          </div>

          <div className="paper-appendix">
            <section className="paper-calendar" aria-label="日期与分类索引">
              <CalendarPanel>{props.calendar}</CalendarPanel>
            </section>
            <section className="paper-rhythm" id="theme-rhythm" aria-label="活动节律">
              <div className="paper-section-index">
                <span>04</span><span>把日子连起来</span><span>RHYTHM</span>
              </div>
              {props.rhythm}
            </section>
          </div>
        </main>

        <footer className="paper-footer">
          <span>KinaWatch <span aria-hidden="true">/</span> 纸间</span>
          <time dateTime={props.date}>{props.date.replaceAll("-", ".")}</time>
          <a href="#theme-notes">回到笔记 <span aria-hidden="true">↑</span></a>
        </footer>
      </div>
      {props.overlay}
    </div>
  );
}
