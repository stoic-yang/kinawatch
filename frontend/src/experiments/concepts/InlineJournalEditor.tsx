import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ApiError, saveReviewField, type FileFingerprint, type ReviewField } from "../../api";
import { LongformTextarea } from "./LongformTextarea";
import type { ConceptProps } from "./types";

type Props = {
  app: ConceptProps;
  field: ReviewField;
  title: string;
  placeholder?: string;
  longform?: boolean;
  visible?: boolean;
  onDraftChange?: (text: string) => void;
  editorId?: string;
};

type Snapshot = { text: string; fingerprint: FileFingerprint | null };
const MAX_LENGTH = 8000;

function readField(app: ConceptProps, field: ReviewField): Snapshot {
  const day = app.day?.date === app.date ? app.day : null;
  const journal = day?.journal;
  const text = !journal ? "" : field === "personal_summary" ? journal.personal_summary_markdown
    : field === "outputs" ? journal.outputs.map(item => `- ${item}`).join("\n")
    : field === "next_action" ? journal.next_action_markdown : journal.freeform_markdown;
  return { text, fingerprint: day ? { ...day.cache.journal_fingerprint } : null };
}

export function InlineJournalEditor(props: Props) {
  return <InlineJournalField key={`${props.app.date}:${props.app.day?.journal.path ?? ""}:${props.field}`} {...props} />;
}

function InlineJournalField({ app, field, title, placeholder, longform = false, visible = true, onDraftChange, editorId }: Props) {
  const source = readField(app, field);
  const [baseline, setBaseline] = useState<Snapshot>(source);
  const baselineRef = useRef(baseline);
  const latestSource = useRef(source);
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const editingFingerprint = useRef<FileFingerprint | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const requestGeneration = useRef(0);
  const notifyDraft = useRef(onDraftChange);
  notifyDraft.current = onDraftChange;
  const uniqueId = useId();
  const id = editorId ?? `journal-inline-${uniqueId}`;
  const errorId = `${id}-error`;
  const countId = `${id}-count`;
  const dirty = draft !== null;
  const text = draft ?? baseline.text;
  const enabled = app.journalWriteEnabled && app.day?.date === app.date && source.fingerprint !== null;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestGeneration.current += 1; };
  }, []);

  // A clean field follows refreshed data; a draft keeps the version the user
  // actually began editing, even when another field saves the same note.
  useLayoutEffect(() => {
    latestSource.current = source;
    if (draftRef.current === null) {
      baselineRef.current = source;
      setBaseline(source);
    }
  }, [source.text, source.fingerprint?.path, source.fingerprint?.mtime_ns, source.fingerprint?.size]);

  const hasDraftObserver = Boolean(onDraftChange);
  useLayoutEffect(() => { notifyDraft.current?.(text); }, [text, hasDraftObserver]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (draftRef.current === null) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);

  function restoreLatest() {
    draftRef.current = null;
    editingFingerprint.current = null;
    baselineRef.current = latestSource.current;
    setBaseline(latestSource.current);
    setDraft(null);
    setError(null);
  }

  function changeText(value: string) {
    if (!enabled || savingRef.current) return;
    if (draftRef.current === null) {
      // Capture synchronously in this input event, before a sibling's save can
      // refresh app.day. Never replace this fingerprint while a draft exists.
      const fingerprint = baselineRef.current.fingerprint;
      editingFingerprint.current = fingerprint ? { ...fingerprint } : null;
      setError(null);
    }
    if (value === baselineRef.current.text) {
      restoreLatest();
      return;
    }
    draftRef.current = value;
    setDraft(value);
  }

  async function save() {
    const markdown = draftRef.current;
    const fingerprint = editingFingerprint.current;
    if (!enabled || savingRef.current || markdown === null || !markdown.trim() || markdown.length > MAX_LENGTH || !fingerprint) return;
    const generation = ++requestGeneration.current;
    const isCurrent = () => mounted.current && generation === requestGeneration.current;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await saveReviewField({ date: app.date, field, markdown, expected_fingerprint: { ...fingerprint } });
      if (!isCurrent()) return;
      // Use the acknowledged value immediately, even if the following read
      // fails. A completed save must not display the previous server value.
      const saved: Snapshot = { text: result.review_field.markdown, fingerprint: { ...result.journal_fingerprint } };
      latestSource.current = saved;
      baselineRef.current = saved;
      draftRef.current = null;
      editingFingerprint.current = null;
      setBaseline(saved);
      setDraft(null);
      try {
        await app.onDaySaved();
      } catch (reason) {
        if (isCurrent()) setError(`内容已保存，但页面刷新失败：${reason instanceof Error ? reason.message : String(reason)}`);
      }
    } catch (reason) {
      if (!isCurrent()) return;
      setError(reason instanceof ApiError && reason.status === 409
        ? `${reason.message} 当前草稿已保留。请先复制草稿，再刷新页面核对最新内容。`
        : reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (isCurrent()) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  return <section className={`journal-inline-field${dirty ? " is-dirty" : ""}${saving ? " is-saving" : ""}${!enabled ? " is-readonly" : ""}${longform ? " is-longform" : ""}`} data-field={field} data-dirty={dirty} aria-busy={saving}>
    <header className="journal-inline-heading"><h3>{title}</h3>{!enabled && <small>{app.day ? "只读" : "正在读取…"}</small>}</header>
    <LongformTextarea
      id={id}
      className="journal-inline-editor"
      aria-label={title}
      aria-describedby={[dirty ? countId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined}
      aria-invalid={Boolean(error)}
      value={text}
      visible={visible}
      placeholder={placeholder}
      rows={longform ? 10 : 3}
      maxLength={MAX_LENGTH}
      readOnly={!enabled || saving}
      onChange={event => changeText(event.target.value)}
    />
    {error && <p className="journal-inline-error" id={errorId} role="alert">{error}</p>}
    {dirty && <footer className="journal-inline-footer">
      <span className="journal-inline-status"><span className="journal-inline-count" id={countId}>{text.length} / {MAX_LENGTH} 字</span><span>{saving ? "正在保存…" : !text.trim() ? "内容不能为空" : "尚未保存"}</span></span>
      <div className="journal-inline-actions">
        <button type="button" className="journal-inline-cancel" disabled={saving} onClick={restoreLatest}>取消</button>
        <button type="button" className="journal-inline-save" disabled={!enabled || saving || !text.trim() || text.length > MAX_LENGTH} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </footer>}
  </section>;
}
