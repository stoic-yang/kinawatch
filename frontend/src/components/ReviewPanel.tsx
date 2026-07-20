import { useEffect, useState } from "react";
import {
  ApiError,
  saveReviewField,
  type FileFingerprint,
  type JournalData,
  type ReviewField,
} from "../api";
import { MarkdownLite } from "../lib/markdown";

const FIELD_PLACEHOLDERS: Record<ReviewField, string> = {
  personal_summary: "用一两句话回顾这一天真正推进了什么。",
  outputs: "每行写一项今天留下的可验证产出。",
  next_action:
    "把明天想推进的事情、顺序和判断写完整。可以分段，也可以使用 Markdown 列表。",
};

function reviewValue(journal: JournalData, field: ReviewField): string {
  if (field === "personal_summary") return journal.personal_summary_markdown;
  if (field === "outputs") {
    return journal.outputs.map((output) => `- ${output}`).join("\n");
  }
  return journal.next_action_markdown;
}

function Section({
  field,
  title,
  value,
  hint,
  editing,
  draft,
  saving,
  error,
  onEdit,
  onDraft,
  onCancel,
  onSave,
  children,
}: {
  field: ReviewField;
  title: string;
  value: string;
  hint: string;
  editing: boolean;
  draft: string;
  saving: boolean;
  error: string | null;
  onEdit: () => void;
  onDraft: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
  children?: React.ReactNode;
}) {
  const filled = value.trim() !== "";
  return (
    <section className={`review-section ${filled ? "" : "review-section-empty"}`}>
      <div className="review-field-heading">
        <h3>{title}</h3>
        {!editing && (
          <button
            type="button"
            className="review-field-action"
            aria-label={`${filled ? "编辑" : "添加"}${title}`}
            onClick={onEdit}
          >
            {filled ? "编辑" : "＋ 添加"}
          </button>
        )}
      </div>
      {editing ? (
        <div className="review-editor">
          <textarea
            autoFocus
            rows={field === "next_action" ? 8 : field === "outputs" ? 5 : 4}
            maxLength={8000}
            value={draft}
            disabled={saving}
            aria-label={title}
            placeholder={FIELD_PLACEHOLDERS[field]}
            onChange={(event) => onDraft(event.target.value)}
          />
          {error && (
            <p className="review-editor-error" role="alert">
              {error}
            </p>
          )}
          <div className="review-editor-foot">
            <span>保存后写入当前日记存储的「复盘」总块</span>
            <div>
              <button type="button" disabled={saving} onClick={onCancel}>
                取消
              </button>
              <button
                type="button"
                className="review-editor-save"
                disabled={!draft.trim() || saving}
                onClick={onSave}
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      ) : filled ? (
        children
      ) : (
        <p className="empty-hint">{hint}</p>
      )}
    </section>
  );
}

export function ReviewPanel({
  date,
  journal,
  journalFingerprint,
  onSaved,
}: {
  date: string;
  journal: JournalData;
  journalFingerprint: FileFingerprint;
  onSaved: () => Promise<void>;
}) {
  const [showActivitySummary, setShowActivitySummary] = useState(false);
  const [editingField, setEditingField] = useState<ReviewField | null>(null);
  const [draft, setDraft] = useState("");
  const [savingField, setSavingField] = useState<ReviewField | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setEditingField(null);
    setDraft("");
    setSavingField(null);
    setSaveError(null);
  }, [date, journal.path]);

  function edit(field: ReviewField): void {
    setEditingField(field);
    setDraft(reviewValue(journal, field));
    setSaveError(null);
  }

  function cancel(): void {
    setEditingField(null);
    setDraft("");
    setSaveError(null);
  }

  async function save(field: ReviewField): Promise<void> {
    if (!draft.trim() || savingField) return;
    setSavingField(field);
    setSaveError(null);
    try {
      await saveReviewField({
        date,
        field,
        markdown: draft,
        expected_fingerprint: journalFingerprint,
      });
      setEditingField(null);
      setDraft("");
      await onSaved();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        setSaveError(`${reason.message} 页面不会覆盖较新的内容。`);
      } else {
        setSaveError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setSavingField(null);
    }
  }

  const personalSummary = reviewValue(journal, "personal_summary");
  const outputs = reviewValue(journal, "outputs");
  const nextAction = reviewValue(journal, "next_action");

  return (
    <div className="review">
      {!journal.exists && (
        <div className="review-empty-state">
          <p className="review-empty-title">今天还没有留下复盘</p>
          <p className="review-empty-copy">
            可以直接从下面任意一项开始，首次保存时会创建当天记录。
          </p>
        </div>
      )}

      <Section
        field="personal_summary"
        title="我的总结"
        value={personalSummary}
        hint="还没写总结 — 用一两句话回顾这一天。"
        editing={editingField === "personal_summary"}
        draft={draft}
        saving={savingField === "personal_summary"}
        error={editingField === "personal_summary" ? saveError : null}
        onEdit={() => edit("personal_summary")}
        onDraft={setDraft}
        onCancel={cancel}
        onSave={() => void save("personal_summary")}
      >
        <MarkdownLite text={journal.personal_summary_markdown} />
      </Section>

      <Section
        field="outputs"
        title="今日产出"
        value={outputs}
        hint="还没记录产出。"
        editing={editingField === "outputs"}
        draft={draft}
        saving={savingField === "outputs"}
        error={editingField === "outputs" ? saveError : null}
        onEdit={() => edit("outputs")}
        onDraft={setDraft}
        onCancel={cancel}
        onSave={() => void save("outputs")}
      >
        <ul className="output-list">
          {journal.outputs.map((output, index) => (
            <li key={index}>
              <MarkdownLite text={output} />
            </li>
          ))}
        </ul>
      </Section>

      <Section
        field="next_action"
        title="明天的计划"
        value={nextAction}
        hint="还没写明天的计划。"
        editing={editingField === "next_action"}
        draft={draft}
        saving={savingField === "next_action"}
        error={editingField === "next_action" ? saveError : null}
        onEdit={() => edit("next_action")}
        onDraft={setDraft}
        onCancel={cancel}
        onSave={() => void save("next_action")}
      >
        <MarkdownLite text={journal.next_action_markdown} />
      </Section>

      {journal.body_markdown.trim() !== "" && (
        <section className="review-section">
          <h3>自由记录</h3>
          <MarkdownLite text={journal.body_markdown} />
        </section>
      )}

      {journal.activity_summary_markdown.trim() !== "" && (
        <section className="review-section">
          <h3>
            <button
              className="fold-btn"
              onClick={() => setShowActivitySummary((value) => !value)}
            >
              一天活动小总结（Kina 生成）
              <span className="fold-arrow">
                {showActivitySummary ? "▾" : "▸"}
              </span>
            </button>
          </h3>
          {showActivitySummary && (
            <MarkdownLite text={journal.activity_summary_markdown} />
          )}
        </section>
      )}
    </div>
  );
}
