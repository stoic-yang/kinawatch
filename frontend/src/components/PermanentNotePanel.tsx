import { useEffect, useState } from "react";
import {
  ApiError,
  fetchPermanentNote,
  savePermanentNote,
  type PermanentNoteResponse,
} from "../api";
import { MarkdownLite } from "../lib/markdown";

const STARTER_MARKDOWN = `# Incoming

## 待处理

- [ ]

## 观察与成因

## 下一步行动

- [ ]

## 等待回看`;

export function PermanentNotePanel({
  active,
  writeEnabled,
}: {
  active: boolean;
  writeEnabled: boolean;
}) {
  const [note, setNote] = useState<PermanentNoteResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || loaded) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchPermanentNote()
      .then((result) => {
        if (cancelled) return;
        setNote(result);
        setLoaded(true);
      })
      .catch((reason) => {
        if (cancelled) return;
        setLoadError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, loadAttempt, loaded]);

  const editable = Boolean(
    note && writeEnabled && note.write_enabled,
  );
  const markdown = note?.markdown ?? "";
  const filled = markdown.trim() !== "";
  const unchanged = draft.trim() === markdown.trim();

  function beginEditing(): void {
    if (!editable) return;
    setDraft(filled ? markdown : STARTER_MARKDOWN);
    setPreviewing(false);
    setSaveError(null);
    setEditing(true);
  }

  function cancelEditing(): void {
    setEditing(false);
    setPreviewing(false);
    setDraft("");
    setSaveError(null);
  }

  async function save(): Promise<void> {
    if (
      !note ||
      !editable ||
      !draft.trim() ||
      unchanged ||
      saving
    ) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await savePermanentNote(
        draft,
        note.journal_fingerprint,
      );
      setNote(result);
      setEditing(false);
      setPreviewing(false);
      setDraft("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        setSaveError(`${reason.message} 页面不会覆盖较新的内容。`);
      } else {
        setSaveError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="review-period-panel" hidden={!active}>
      <div className="review-context">
        <span className="review-period-label">
          {note?.path || "incoming.md"}
        </span>
        {note?.provider === "local" && (
          <span className="journal-provider">KinaWatch 本地存储</span>
        )}
        {note?.provider === "obsidian" &&
          note.exists &&
          note.open_url && (
            <a className="obsidian-link" href={note.open_url}>
              在 Obsidian 打开 ↗
            </a>
          )}
      </div>

      {loading && <p className="review-loading">正在读取常驻笔记…</p>}

      {loadError && (
        <div className="review-load-error" role="alert">
          <span>无法读取常驻笔记：{loadError}</span>
          <button
            type="button"
            className="review-field-action"
            onClick={() => {
              setLoaded(false);
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            重试
          </button>
        </div>
      )}

      {note && !loading && !loadError && (
        <section
          className={`review-section permanent-note-section ${
            filled ? "" : "review-section-empty"
          }`}
        >
          <div className="review-field-heading">
            <h3>常驻笔记</h3>
            {!editing && editable && (
              <button
                type="button"
                className="review-field-action"
                onClick={beginEditing}
              >
                {filled ? "编辑" : "＋ 建立"}
              </button>
            )}
            {!editable && (
              <span className="review-readonly-label">只读</span>
            )}
          </div>

          {editing ? (
            <div className="review-editor permanent-note-editor">
              <nav
                className="permanent-note-mode-switch"
                aria-label="常驻笔记编辑模式"
              >
                <button
                  type="button"
                  className={!previewing ? "is-active" : ""}
                  aria-pressed={!previewing}
                  onClick={() => setPreviewing(false)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className={previewing ? "is-active" : ""}
                  aria-pressed={previewing}
                  onClick={() => setPreviewing(true)}
                >
                  预览
                </button>
              </nav>

              {previewing ? (
                <div
                  className="permanent-note-preview"
                  aria-label="常驻笔记 Markdown 预览"
                >
                  <MarkdownLite text={draft} />
                </div>
              ) : (
                <textarea
                  autoFocus
                  rows={18}
                  maxLength={50000}
                  value={draft}
                  disabled={saving}
                  aria-label="常驻笔记 Markdown"
                  placeholder={STARTER_MARKDOWN}
                  onChange={(event) => setDraft(event.target.value)}
                />
              )}

              {saveError && (
                <p className="review-editor-error" role="alert">
                  {saveError}
                </p>
              )}
              <div className="review-editor-foot permanent-note-editor-foot">
                <span>Markdown · 支持标题、列表、待办、粗体和行内代码</span>
                <div>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={cancelEditing}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="review-editor-save"
                    disabled={!draft.trim() || unchanged || saving}
                    onClick={() => void save()}
                  >
                    {saving ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>
            </div>
          ) : filled ? (
            <div className="permanent-note-content">
              <MarkdownLite text={markdown} />
            </div>
          ) : (
            <>
              <p className="empty-hint">
                这里始终指向同一张笔记，不随日期切换。
              </p>
              <p className="review-prompt">
                先把仍需处理的想法放进来，再逐步补上成因、行动和回看。
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
