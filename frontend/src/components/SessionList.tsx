import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  saveWorkflowDescription,
  type FileFingerprint,
  type JournalData,
} from "../api";
import type { ScreenSession } from "../lib/sessions";
import { categoryColor } from "../lib/colors";
import { fmtClock, fmtDuration } from "../lib/format";
import { MarkdownLite } from "../lib/markdown";

// Chronological "chapters" of the day: screen sessions split at >15min gaps.
export function SessionList({
  date,
  sessions,
  journal,
  journalFingerprint,
  onSaved,
}: {
  date: string;
  sessions: ScreenSession[];
  journal: JournalData;
  journalFingerprint: FileFingerprint;
  onSaved: () => Promise<void>;
}) {
  const [editingStart, setEditingStart] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savingStart, setSavingStart] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const notesByStart = useMemo(
    () => new Map(journal.workflow_notes.map((note) => [note.start_time, note])),
    [journal.workflow_notes],
  );

  useEffect(() => {
    setEditingStart(null);
    setDraft("");
    setSavingStart(null);
    setSaveError(null);
  }, [date, journal.path]);

  async function save(startTime: string, endTime: string): Promise<void> {
    if (!draft.trim() || savingStart) return;
    setSavingStart(startTime);
    setSaveError(null);
    try {
      await saveWorkflowDescription({
        date,
        start_time: startTime,
        end_time: endTime,
        note: draft,
        expected_fingerprint: journalFingerprint,
      });
      setEditingStart(null);
      setDraft("");
      await onSaved();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        setSaveError(`${reason.message} 页面不会覆盖较新的内容。`);
      } else {
        setSaveError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setSavingStart(null);
    }
  }

  if (sessions.length === 0) {
    return <p className="empty-hint">这一天没有记录到屏幕活动。</p>;
  }
  return (
    <ol className="sessions">
      {sessions.map((s) => {
        const startTime = fmtClock(s.start);
        const endTime = fmtClock(s.end);
        const note = notesByStart.get(startTime);
        const editing = editingStart === startTime;
        const saving = savingStart === startTime;
        return (
        <li key={s.start} className="session">
          <div className="session-time">
            <span>{startTime}</span>
            <span className="session-time-end">{endTime}</span>
          </div>
          <div className="session-body">
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
                  title={`${c.label} ${fmtDuration(c.seconds)}`}
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
            {editing ? (
              <div className="session-note-editor">
                <textarea
                  autoFocus
                  rows={3}
                  maxLength={4000}
                  value={draft}
                  disabled={saving}
                  aria-label={`${startTime} 工作流描述`}
                  placeholder="这段时间真正推进了什么？为什么值得留下？"
                  onChange={(event) => setDraft(event.target.value)}
                />
                {saveError && (
                  <p className="session-note-error" role="alert">
                    {saveError}
                  </p>
                )}
                <div className="session-note-editor-foot">
                  <span>保存后写入当前日记存储</span>
                  <div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setEditingStart(null);
                        setDraft("");
                        setSaveError(null);
                      }}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="session-note-save"
                      disabled={!draft.trim() || saving}
                      onClick={() => void save(startTime, endTime)}
                    >
                      {saving ? "保存中…" : "保存"}
                    </button>
                  </div>
                </div>
              </div>
            ) : note ? (
              <div className="session-note">
                <div className="session-note-row">
                  <MarkdownLite text={note.note} />
                  <button
                    type="button"
                    className="session-note-edit"
                    aria-label={`编辑 ${startTime} 工作流描述`}
                    onClick={() => {
                      setEditingStart(startTime);
                      setDraft(note.note);
                      setSaveError(null);
                    }}
                  >
                    编辑
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="session-note-add"
                onClick={() => {
                  setEditingStart(startTime);
                  setDraft("");
                  setSaveError(null);
                }}
              >
                ＋ 添加描述
              </button>
            )}
          </div>
        </li>
        );
      })}
    </ol>
  );
}
