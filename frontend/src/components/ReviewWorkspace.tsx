import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  fetchPeriodReview,
  savePeriodReview,
  type FileFingerprint,
  type JournalData,
  type PeriodReviewKind,
  type PeriodReviewResponse,
} from "../api";
import {
  isoWeekNumber,
  isoWeekYear,
  parseLocalDate,
  shiftDate,
  startOfISOWeek,
} from "../lib/format";
import { MarkdownLite } from "../lib/markdown";
import { PermanentNotePanel } from "./PermanentNotePanel";
import { ReviewPanel } from "./ReviewPanel";

export type ReviewScope = "permanent" | "day" | "week" | "month";

const REVIEW_SCOPES: { scope: ReviewScope; label: string }[] = [
  { scope: "permanent", label: "常驻" },
  { scope: "day", label: "日" },
  { scope: "week", label: "周" },
  { scope: "month", label: "月" },
];

const PERIOD_PROMPTS: Record<PeriodReviewKind, string> = {
  week: "本周做成了什么？什么模式值得保留？下周最重要的事是什么？",
  month: "本月发生了什么变化？什么值得继续？下个月把精力放在哪里？",
};

function monthDay(date: string): string {
  const value = parseLocalDate(date);
  return `${value.getMonth() + 1}月${value.getDate()}日`;
}

function dayLabel(date: string): string {
  return monthDay(date);
}

function weekId(date: string): string {
  return `${isoWeekYear(date)}-W${String(isoWeekNumber(date)).padStart(2, "0")}`;
}

function weekLabel(date: string): string {
  const start = startOfISOWeek(date);
  return `第${isoWeekNumber(date)}周 · ${monthDay(start)}–${monthDay(
    shiftDate(start, 6),
  )}`;
}

function monthId(date: string): string {
  return date.slice(0, 7);
}

function monthLabel(date: string): string {
  const value = parseLocalDate(date);
  return `${value.getFullYear()}年${value.getMonth() + 1}月`;
}

function ReviewContext({
  label,
  provider,
  exists,
  openUrl,
}: {
  label: string;
  provider: "local" | "obsidian";
  exists: boolean;
  openUrl: string;
}) {
  return (
    <div className="review-context">
      <span className="review-period-label">{label}</span>
      {provider === "local" && (
        <span className="journal-provider">KinaWatch 本地存储</span>
      )}
      {provider === "obsidian" && exists && openUrl && (
        <a className="obsidian-link" href={openUrl}>
          在 Obsidian 打开 ↗
        </a>
      )}
    </div>
  );
}

function PeriodReviewPanel({
  active,
  kind,
  periodId,
  label,
  writeEnabled,
}: {
  active: boolean;
  kind: PeriodReviewKind;
  periodId: string;
  label: string;
  writeEnabled: boolean;
}) {
  const [review, setReview] = useState<PeriodReviewResponse | null>(null);
  const [loadedPeriodId, setLoadedPeriodId] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => {
    requestGeneration.current += 1;
    setReview(null);
    setLoadedPeriodId("");
    setLoadError(null);
    setEditing(false);
    setDraft("");
    setSaving(false);
    setSaveError(null);
  }, [kind, periodId]);

  useEffect(() => {
    if (!active || loadedPeriodId === periodId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchPeriodReview(kind, periodId)
      .then((result) => {
        if (cancelled) return;
        setReview(result);
        setLoadedPeriodId(periodId);
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
  }, [active, kind, loadAttempt, loadedPeriodId, periodId]);

  async function save(): Promise<void> {
    if (!review || !writeEnabled || !review.write_enabled || !draft.trim() || saving) {
      return;
    }
    const generation = requestGeneration.current;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await savePeriodReview(
        kind,
        periodId,
        draft,
        review.journal_fingerprint,
      );
      if (generation !== requestGeneration.current) return;
      setReview(result);
      setEditing(false);
      setDraft("");
    } catch (reason) {
      if (generation !== requestGeneration.current) return;
      if (reason instanceof ApiError && reason.status === 409) {
        setSaveError(`${reason.message} 页面不会覆盖较新的内容。`);
      } else {
        setSaveError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (generation === requestGeneration.current) setSaving(false);
    }
  }

  const periodName = kind === "week" ? "周复盘" : "月复盘";
  const value = review?.fields.freeform ?? "";
  const filled = value.trim() !== "";
  const editable = Boolean(
    review && writeEnabled && review.write_enabled,
  );

  return (
    <div className="review-period-panel" hidden={!active}>
      {review ? (
        <ReviewContext
          label={label}
          provider={review.provider}
          exists={review.exists}
          openUrl={review.open_url}
        />
      ) : (
        <div className="review-context">
          <span className="review-period-label">{label}</span>
        </div>
      )}

      {loading && <p className="review-loading">正在读取{periodName}…</p>}

      {loadError && (
        <div className="review-load-error" role="alert">
          <span>无法读取{periodName}：{loadError}</span>
          <button
            type="button"
            className="review-field-action"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            重试
          </button>
        </div>
      )}

      {review && !loading && !loadError && (
        <section
          className={`review-section review-period-section ${
            filled ? "" : "review-section-empty"
          }`}
        >
          <div className="review-field-heading">
            <h3>自由记录</h3>
            {!editing && editable && (
              <button
                type="button"
                className="review-field-action"
                aria-label={`${filled ? "编辑" : "添加"}${periodName}`}
                onClick={() => {
                  setDraft(value);
                  setSaveError(null);
                  setEditing(true);
                }}
              >
                {filled ? "编辑" : "＋ 添加"}
              </button>
            )}
            {!editable && <span className="review-readonly-label">只读</span>}
          </div>

          {editing ? (
            <div className="review-editor review-period-editor">
              <textarea
                autoFocus
                rows={12}
                maxLength={8000}
                value={draft}
                disabled={saving}
                aria-label={`${periodName}自由记录`}
                placeholder={PERIOD_PROMPTS[kind]}
                onChange={(event) => setDraft(event.target.value)}
              />
              {saveError && (
                <p className="review-editor-error" role="alert">
                  {saveError}
                </p>
              )}
              <div className="review-editor-foot">
                <span>
                  保存后只写入本{kind === "week" ? "周" : "月"}笔记的「自由记录」；
                  小标题请使用 ###
                </span>
                <div>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setEditing(false);
                      setDraft("");
                      setSaveError(null);
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="review-editor-save"
                    disabled={!draft.trim() || saving}
                    onClick={() => void save()}
                  >
                    {saving ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>
            </div>
          ) : filled ? (
            <MarkdownLite text={value} />
          ) : (
            <>
              <p className="empty-hint">还没有{periodName}。</p>
              <p className="review-prompt">{PERIOD_PROMPTS[kind]}</p>
            </>
          )}
        </section>
      )}
    </div>
  );
}

export function ReviewWorkspace({
  date,
  journal,
  journalFingerprint,
  writeEnabled,
  scope,
  onScopeChange,
  onDaySaved,
}: {
  date: string;
  journal: JournalData;
  journalFingerprint: FileFingerprint;
  writeEnabled: boolean;
  scope: ReviewScope;
  onScopeChange: (scope: ReviewScope) => void;
  onDaySaved: () => Promise<void>;
}) {
  const week = useMemo(
    () => ({ id: weekId(date), label: weekLabel(date) }),
    [date],
  );
  const month = useMemo(
    () => ({ id: monthId(date), label: monthLabel(date) }),
    [date],
  );

  return (
    <>
      <h2 className="section-title section-title-row review-title">
        <span>笔记</span>
        <nav className="review-scope-switch" aria-label="笔记范围">
          {REVIEW_SCOPES.map((item) => (
            <button
              key={item.scope}
              type="button"
              className={scope === item.scope ? "review-scope-active" : ""}
              aria-pressed={scope === item.scope}
              onClick={() => onScopeChange(item.scope)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </h2>

      <PermanentNotePanel
        active={scope === "permanent"}
        writeEnabled={writeEnabled}
      />

      <div hidden={scope !== "day"}>
        <ReviewContext
          label={dayLabel(date)}
          provider={journal.provider}
          exists={journal.exists}
          openUrl={journal.open_url}
        />
        <ReviewPanel
          date={date}
          journal={journal}
          journalFingerprint={journalFingerprint}
          writeEnabled={writeEnabled}
          onSaved={onDaySaved}
        />
      </div>

      <PeriodReviewPanel
        active={scope === "week"}
        kind="week"
        periodId={week.id}
        label={week.label}
        writeEnabled={writeEnabled}
      />
      <PeriodReviewPanel
        active={scope === "month"}
        kind="month"
        periodId={month.id}
        label={month.label}
        writeEnabled={writeEnabled}
      />
    </>
  );
}
