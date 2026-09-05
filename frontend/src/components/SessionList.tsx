import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  saveWorkflowDescription,
  type FileFingerprint,
  type JournalData,
  type WorkflowSaveResponse,
} from "../api";
import type { ScreenSession } from "../lib/sessions";
import { categoryColor } from "../lib/colors";
import { fmtClock, fmtDuration } from "../lib/format";
import {
  assignKinaSummaryToSessions,
  parseKinaSummary,
  type KinaSummaryEntry,
} from "../lib/kinaSummary";
import { MarkdownLite } from "../lib/markdown";
import "./session-description-dialog.css";

function DescriptionDialog({ open, editing, busy, title, context, onClose, children }: {
  open: boolean;
  editing: boolean;
  busy: boolean;
  title: string;
  context: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, [open]);
  useEffect(() => {
    if (open && editing) dialogRef.current?.querySelector("textarea")?.focus();
  }, [open, editing]);
  return <dialog ref={dialogRef} className={`workflow-description-dialog${editing ? " is-editing" : ""}`}
    aria-label={title} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="workflow-description-dialog-heading">
      <div><h3>{title}</h3><p>{context}</p></div>
      <button type="button" className="workflow-description-close" aria-label="关闭工作流描述" disabled={busy} onClick={onClose}>×</button>
    </header>
    <div className="workflow-description-dialog-content">{open && children}</div>
  </dialog>;
}

function KinaDescription({
  entry,
  onEdit,
  disabled,
}: {
  entry: KinaSummaryEntry;
  onEdit?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="session-kina-note">
      <div className="session-kina-note-head">
        <time>
          {entry.approximate ? "约" : ""}
          {entry.startTime}–{entry.endTime}
        </time>
        {onEdit && (
          <button
            type="button"
            className="session-kina-note-edit"
            aria-label={`修改 ${entry.startTime}–${entry.endTime} 工作流总结`}
            onClick={onEdit}
            disabled={disabled}
          >
            修改
          </button>
        )}
      </div>
      <MarkdownLite text={entry.text} />
    </div>
  );
}

// Chronological "chapters" of the day: screen sessions split at >15min gaps.
export function SessionList({
  date,
  sessions,
  journal,
  journalFingerprint,
  timezone,
  writeEnabled,
  descriptionLayout = "below",
  onSaved,
}: {
  date: string;
  sessions: ScreenSession[];
  journal: JournalData;
  journalFingerprint: FileFingerprint;
  timezone: string;
  writeEnabled: boolean;
  descriptionLayout?: "below" | "aside";
  onSaved: (saved: WorkflowSaveResponse, editedFingerprint: FileFingerprint) => Promise<void>;
}) {
  const [editingStart, setEditingStart] = useState<string | null>(null);
  const [viewingStart, setViewingStart] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savingStart, setSavingStart] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editingFingerprint = useRef<FileFingerprint | null>(null);
  const editingOriginal = useRef("");
  const saveInFlight = useRef(false);
  const generation = useRef(0);
  const notesByStart = useMemo(
    () => new Map(journal.workflow_notes.map((note) => [note.start_time, note])),
    [journal.workflow_notes],
  );
  const kinaSummaryEntries = useMemo(
    () => parseKinaSummary(journal.activity_summary_markdown),
    [journal.activity_summary_markdown],
  );
  const kinaSummariesBySession = useMemo(
    () => assignKinaSummaryToSessions(kinaSummaryEntries, sessions, timezone),
    [kinaSummaryEntries, sessions, timezone],
  );

  useEffect(() => {
    setEditingStart(null);
    setViewingStart(null);
    setDraft("");
    setSavingStart(null);
    setSaveError(null);
    editingFingerprint.current = null;
    editingOriginal.current = "";
    saveInFlight.current = false;
    return () => { generation.current += 1; };
  }, [date, journal.path, writeEnabled]);

  function beginEditing(startTime: string, text: string) {
    if (!writeEnabled || saveInFlight.current) return;
    editingFingerprint.current = {...journalFingerprint};
    editingOriginal.current = text;
    setViewingStart(null);
    setEditingStart(startTime);
    setDraft(text);
    setSaveError(null);
  }

  function closeDescription() {
    if (saveInFlight.current) return;
    setViewingStart(null);
    setEditingStart(null);
    setDraft("");
    setSaveError(null);
    editingFingerprint.current = null;
    editingOriginal.current = "";
  }

  async function save(startTime: string, endTime: string): Promise<void> {
    const fingerprint = editingFingerprint.current;
    if (!writeEnabled || (!draft.trim() && !editingOriginal.current.trim()) || saveInFlight.current || !fingerprint) return;
    const startedGeneration = generation.current;
    saveInFlight.current = true;
    setSavingStart(startTime);
    setSaveError(null);
    try {
      const saved = await saveWorkflowDescription({
        date,
        start_time: startTime,
        end_time: endTime,
        note: draft,
        expected_fingerprint: fingerprint,
      });
      if (generation.current !== startedGeneration) return;
      // App applies the save response immediately and owns refresh failures.
      // Do not keep the editor locked while ActivityWatch is being reloaded.
      void onSaved(saved, fingerprint).catch(() => {});
      setEditingStart(null);
      setDraft("");
      editingFingerprint.current = null;
      editingOriginal.current = "";
    } catch (reason) {
      if (generation.current !== startedGeneration) return;
      if (reason instanceof ApiError && reason.status === 409) {
        setSaveError(`${reason.message} 页面不会覆盖较新的内容。`);
      } else {
        setSaveError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (generation.current === startedGeneration) {
        saveInFlight.current = false;
        setSavingStart(null);
      }
    }
  }

  if (sessions.length === 0) {
    if (kinaSummaryEntries.length === 0) {
      return <p className="empty-hint">这一天没有记录到屏幕活动。</p>;
    }
    return (
      <div className="session-kina-summary-only">
        {kinaSummaryEntries.map((entry, index) => (
          <KinaDescription
            key={`${entry.startTime}-${entry.endTime}-${index}`}
            entry={entry}
          />
        ))}
      </div>
    );
  }
  return (
    <>
      {!writeEnabled && (
        <p className="write-disabled-hint">当前配置为只读，工作流描述不会显示编辑入口。</p>
      )}
      <ol className="sessions">
      {sessions.map((s, sessionIndex) => {
        const startTime = fmtClock(s.start, timezone);
        const endTime = fmtClock(s.end, timezone);
        const note = notesByStart.get(startTime);
        const hasDescription = Boolean(note?.note.trim());
        const assignedKinaDescriptions =
          kinaSummariesBySession[sessionIndex] ?? [];
        const kinaDescriptions = note ? [] : assignedKinaDescriptions;
        const editing = editingStart === startTime;
        const saving = savingStart === startTime;
        const activity = (
          <>
            <div className="session-head">
              <span className="session-dur">{fmtDuration(s.seconds)}</span>
              <span className="session-apps">
                {s.topApps.map((a) => a.app).join(" · ")}
              </span>
            </div>
            <div className="session-mix" aria-hidden>
              {s.categories.map((c) => (
                <span
                  key={c.category}
                  style={{
                    width: `${(c.seconds / s.seconds) * 100}%`,
                    background: categoryColor(c.category),
                  }}
                />
              ))}
            </div>
            <div className="session-cats">
              {s.categories.slice(0, 3).map((c) => (
                <span key={c.category} className="cat-chip">
                  <i style={{ background: categoryColor(c.category) }} />
                  {c.label} {fmtDuration(c.seconds)}
                </span>
              ))}
            </div>
          </>
        );
        const description = (
          <>
            {!editing && kinaDescriptions.length > 0 && (
              <div className="session-kina-notes">
                {kinaDescriptions.map((entry, index) => (
                  <KinaDescription
                    key={`${entry.startTime}-${entry.endTime}-${index}`}
                    entry={entry}
                    disabled={Boolean(savingStart)}
                    onEdit={
                      writeEnabled
                        ? () => beginEditing(startTime, entry.text)
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
            {editing ? (
              <div className="session-note-editor">
                <textarea
                  autoFocus
                  rows={3}
                  maxLength={4000}
                  value={draft}
                  disabled={saving}
                  aria-label={`${startTime} 工作流描述`}
                  placeholder="写下这段时间的事情…"
                  onChange={(event) => setDraft(event.target.value)}
                />
                {saveError && (
                  <p className="session-note-error" role="alert">
                    {saveError}
                  </p>
                )}
                <div className="session-note-editor-foot">
                  <div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={closeDescription}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="session-note-save"
                      disabled={(!draft.trim() && !editingOriginal.current.trim()) || saving}
                      onClick={() => void save(startTime, endTime)}
                    >
                      {saving ? "保存中…" : "保存"}
                    </button>
                  </div>
                </div>
              </div>
            ) : note && hasDescription ? (
              <div className="session-note">
                <div className="session-note-row">
                  <MarkdownLite text={note.note} />
                  {writeEnabled && (
                    <button
                      type="button"
                      className="session-note-edit"
                      aria-label={`编辑 ${startTime} 工作流描述`}
                      disabled={Boolean(savingStart)}
                      onClick={() => beginEditing(startTime, note.note)}
                    >
                      编辑
                    </button>
                  )}
                </div>
              </div>
            ) : writeEnabled && kinaDescriptions.length === 0 ? (
              <button
                type="button"
                className="session-note-add"
                disabled={Boolean(savingStart)}
                onClick={() => beginEditing(startTime, "")}
              >
                ＋ 添加描述
              </button>
            ) : null}
          </>
        );
        const descriptionAside = descriptionLayout === "aside" &&
          (writeEnabled || Boolean(note) || kinaDescriptions.length > 0);
        return (
        <li key={s.start} className={`session${descriptionAside ? " session-description-aside" : ""}`}>
          <div className="session-time">
            <span>{startTime}</span>
            <span className="session-time-end">{endTime}</span>
          </div>
          <div className="session-body">
            {descriptionAside ? (
              <>
                <div className="session-activity">{activity}</div>
                <div className="session-description">
                  {hasDescription || kinaDescriptions.length > 0 ? <div className="session-description-summary">
                    <div className="session-description-copy"><MarkdownLite text={note?.note ?? kinaDescriptions.map(entry => entry.text).join("\n")} /></div>
                    <div className="session-description-actions">
                      <button type="button" className="session-note-open" aria-label={`展开 ${startTime} 工作流描述`} onClick={() => setViewingStart(startTime)}>展开</button>
                      {note && writeEnabled && <button type="button" className="session-note-edit" aria-label={`编辑 ${startTime} 工作流描述`}
                        disabled={Boolean(savingStart)} onClick={() => beginEditing(startTime, note.note)}>编辑</button>}
                    </div>
                  </div> : writeEnabled ? <button type="button" className="session-note-add" disabled={Boolean(savingStart)}
                    onClick={() => beginEditing(startTime, "")}>＋ 添加描述</button> : null}
                </div>
              </>
            ) : <>{activity}{description}</>}
          </div>
          {descriptionAside && <DescriptionDialog open={editing || viewingStart === startTime} editing={editing} busy={saving}
            title={`${startTime} — ${endTime} 工作流描述`}
            context={`${fmtDuration(s.seconds)} · ${s.topApps.map(app => app.app).join(" · ")}`}
            onClose={closeDescription}>{description}</DescriptionDialog>}
        </li>
        );
      })}
      </ol>
    </>
  );
}
