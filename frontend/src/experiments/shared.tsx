import { useEffect, useRef, type ReactNode } from "react";
import { isValidDateString, shiftDate } from "../lib/format";
import { THEMES, type ThemeId } from "./types";

export function Brand({ wordmark = "KinaWatch" }: { wordmark?: string }) {
  return <a className="theme-brand" href="#top" aria-label={`${wordmark}，回到顶部`}>
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M6 8v16M13 4v24M20 10v12M27 7v18" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
    </svg><span>{wordmark}</span>
  </a>;
}

export function DateControls({ date, currentDate, onSelect }: {
  date: string; currentDate: string; onSelect: (date: string) => void;
}) {
  return <nav className="theme-date-controls" aria-label="日期导航">
    <button className="theme-today" onClick={() => onSelect(currentDate)} disabled={date === currentDate}>今天</button>
    <button className="theme-date-arrow" aria-label="上一天" disabled={date <= "2026-01-01"} onClick={() => onSelect(shiftDate(date, -1))}>‹</button>
    <label className="theme-date-picker">
      <span className="theme-sr-only">选择日期</span>
      <input type="date" aria-label="选择日期" value={date} min="2026-01-01"
        onChange={(event) => {
          const next = event.target.value;
          if (isValidDateString(next) && next >= "2026-01-01") onSelect(next);
        }} />
    </label>
    <button className="theme-date-arrow" aria-label="下一天" onClick={() => onSelect(shiftDate(date, 1))}>›</button>
  </nav>;
}

export function ThemeSwitcher({ current }: { current: ThemeId }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const selected = THEMES.find((theme) => theme.id === current)!;
  useEffect(() => {
    function close(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    }
    function escape(event: KeyboardEvent) { if (event.key === "Escape" && ref.current) ref.current.open = false; }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  const params = new URLSearchParams(window.location.search);
  const dateQuery = params.has("date") ? `?date=${encodeURIComponent(params.get("date")!)}` : "";
  return <details className="theme-switcher" ref={ref}>
    <summary aria-label="切换设计主题"><span className={`theme-swatch swatch-${current}`} />{selected.english}<span className="theme-switch-chevron" aria-hidden="true">⌄</span></summary>
    <div className="theme-switch-menu">
      <span className="theme-switch-caption">选择另一种视角</span>
      {THEMES.map((theme, index) => <a key={theme.id}
        href={theme.id === current ? undefined : `http://127.0.0.1:${theme.port}/${dateQuery}`}
        target={theme.id === current ? undefined : "_blank"} rel="noopener noreferrer"
        aria-current={theme.id === current ? "page" : undefined}
        aria-label={theme.id === current ? `${theme.name}，当前主题` : `${theme.name} ${theme.english}，在新标签页打开`}>
        <span className={`theme-swatch swatch-${theme.id}`} /><span>{theme.name}<small>{theme.english}</small></span><span className="theme-switch-number">0{index + 1}</span>
      </a>)}
    </div>
  </details>;
}

export function CalendarPanel({ children }: { children: ReactNode }) {
  return <details className="theme-calendar-panel" open>
    <summary><span>日历与分类</span><span className="theme-calendar-chevron" aria-hidden="true">⌄</span></summary>
    <div className="theme-calendar-content">{children}</div>
  </details>;
}

export function SectionLinks({ items = [
  { href: "#theme-timeline", label: "时间线" },
  { href: "#theme-rhythm", label: "节律" },
  { href: "#theme-workflow", label: "工作流" },
  { href: "#theme-notes", label: "笔记" },
] }: { items?: { href: string; label: string }[] }) {
  return <nav className="theme-section-links" aria-label="页面内容">{items.map((item) => <a key={item.href} href={item.href}>{item.label}</a>)}</nav>;
}

export function Hours({ value }: { value: string }) {
  return <span className="theme-hours">{value.split(/(\d+)/).map((part, index) => /\d/.test(part) ? <strong key={index}>{part}</strong> : <span key={index}>{part}</span>)}</span>;
}
