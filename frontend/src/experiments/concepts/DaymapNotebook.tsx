import { useState } from "react";
import type { JournalData, ReviewField } from "../../api";
import { ReviewWorkspace, type ReviewScope } from "../../components/ReviewWorkspace";
import { JournalEditor } from "./shared";
import type { ConceptProps } from "./types";
import "./daymap-notebook.css";

const SCOPES: { id: ReviewScope; label: string }[] = [
  { id: "day", label: "日记" },
  { id: "permanent", label: "常驻" },
  { id: "week", label: "周复盘" },
  { id: "month", label: "月复盘" },
];

const FIELDS: { id: ReviewField; label: string; hint: string; icon: string }[] = [
  { id: "freeform", label: "自由记录", hint: "随手记下想法与片段", icon: "M5 5h14M5 10h14M5 15h9M5 20h6" },
  { id: "personal_summary", label: "我的总结", hint: "回看今天值得留下的事", icon: "M12 3v4m0 10v4M3 12h4m10 0h4M6 6l3 3m6 6 3 3M6 18l3-3m6-6 3-3" },
  { id: "outputs", label: "今日产出", hint: "记录具体成果与进展", icon: "M4 8h16v13H4zM8 8V4h8v4M4 13h16m-10 0v3h4v-3" },
  { id: "next_action", label: "明天的计划", hint: "给下一步留一个起点", icon: "M4 12h15m-6-6 6 6-6 6" },
];

function fieldText(journal: JournalData | undefined, field: ReviewField): string {
  if (!journal) return "";
  if (field === "freeform") return [journal.body_markdown, journal.freeform_markdown].filter(Boolean).join("\n");
  if (field === "personal_summary") return journal.personal_summary_markdown;
  if (field === "outputs") return journal.outputs.join("\n");
  return journal.next_action_markdown;
}

function excerpt(text: string): string {
  return text.replace(/^\s*[#>*-]+\s*/gm, "").replace(/\s+/g, " ").trim();
}

export function DaymapNotebook({ app, onReturn, visible, focusMode, onFocusChange }: { app: ConceptProps; onReturn: () => void; visible: boolean; focusMode: boolean; onFocusChange: (enabled: boolean) => void }) {
  const [scope, setScope] = useState<ReviewScope>("day");
  const [field, setField] = useState<ReviewField>("freeform");
  const journal = app.day?.journal;
  const weekday = app.weekday.startsWith("星期") ? app.weekday : `星期${app.weekday}`;

  return <div className={`dmn ${focusMode ? "is-focused" : ""}`}>
    <header className="dmn-heading">
      <div className="dmn-heading-title"><span className="dmn-book-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M9 3v18m4-12h3m-3 4h3" /></svg></span><h1>笔记空间</h1><span className="dmn-heading-date">{app.dateLabel}<i />{weekday}</span></div>
      <div className="dmn-heading-actions"><button type="button" className="dmn-focus-button" aria-pressed={focusMode} onClick={() => {if (!focusMode) {setScope("day");setField("freeform");}onFocusChange(!focusMode);}}><span aria-hidden="true">{focusMode ? "↙" : "⤢"}</span>{focusMode ? "退出专注" : "专注书写"}</button><button type="button" className="dmn-return" onClick={onReturn}><span aria-hidden="true">←</span>日程画布</button></div>
    </header>

    <div className="dmn-workspace">
      <div className="dmn-toolbar">
        <nav className="dmn-scope-nav" aria-label="笔记范围">{SCOPES.map(item => <button type="button" key={item.id} aria-pressed={scope === item.id} onClick={() => setScope(item.id)}>{item.label}</button>)}</nav>
        {scope === "day" && journal?.provider === "obsidian" && journal.exists && journal.open_url && <a className="dmn-open-source" href={journal.open_url}>在 Obsidian 打开 <span aria-hidden="true">↗</span></a>}
      </div>

      <div className="dmn-daily" hidden={scope !== "day"}>
        <nav className="dmn-fields" aria-label="日记栏目">
          <span className="dmn-fields-label">这一天的笔记</span>
          {FIELDS.map(item => {
            const text = excerpt(fieldText(journal, item.id));
            return <button type="button" key={item.id} aria-pressed={field === item.id} onClick={() => setField(item.id)}>
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={item.icon} /></svg>
              <span><strong>{item.label}</strong><small>{text || item.hint}</small></span>
              {text && <i className="dmn-content-dot" aria-label="已有内容" />}
            </button>;
          })}
        </nav>
        <div className="dmn-document">
          {FIELDS.map(item => <div key={item.id} className="dmn-field-panel" hidden={field !== item.id} aria-label={item.label}>
            <div className="dmn-document-context"><span>日记</span><span aria-hidden="true">/</span><time dateTime={app.date}>{app.dateLabel}</time></div>
            <JournalEditor app={app} field={item.id} title={item.label} placeholder={item.id === "freeform" ? "从这里写下今天。可以慢慢写，也可以写得很长。" : item.hint} longform={item.id === "freeform"} visible={visible && scope === "day" && field === item.id} />
          </div>)}
        </div>
      </div>

      {/* Keep the existing period editors mounted so switching scope keeps drafts.
          Its daily panel is never exposed; the document editor above owns that view. */}
      <div className="dmn-archive" hidden={scope === "day"}>
        {app.day && <ReviewWorkspace key={app.date} date={app.date} journal={app.day.journal}
          journalFingerprint={app.day.cache.journal_fingerprint} writeEnabled={app.journalWriteEnabled}
          scope={scope} onScopeChange={setScope} onDaySaved={app.onDaySaved} />}
      </div>
    </div>
  </div>;
}
