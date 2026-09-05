import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchActivityInspector,
  saveActivityEdit,
  undoActivityEdit,
  type ActivityEditResponse,
  type ActivityInspectorResponse,
  type DayMode,
  type InspectableActivityEvent,
  type ScreenTimelineBlock,
} from "../api";

const CUSTOM_CATEGORY = "__custom__";

function eventKey(event: InspectableActivityEvent): string {
  return `${event.bucket_id}\0${event.event_id}`;
}

function localTimeLabel(value: string): string {
  return value.replace("T", " ").slice(0, 16);
}

export function ActivityEditor({
  selection,
  date,
  mode,
  writeEnabled,
  onClose,
  onChanged,
}: {
  selection: ScreenTimelineBlock;
  date: string;
  mode: DayMode;
  writeEnabled: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [inspector, setInspector] =
    useState<ActivityInspectorResponse | null>(null);
  const [selectedKey, setSelectedKey] = useState("");
  const [startLocal, setStartLocal] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [app, setApp] = useState("");
  const [title, setTitle] = useState("");
  const [categoryMode, setCategoryMode] = useState("auto");
  const [customCategory, setCustomCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ActivityEditResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInspector(null);
    setSelectedKey("");
    setSaved(null);
    fetchActivityInspector(date, mode, selection.event_refs ?? [])
      .then((response) => {
        if (cancelled) return;
        setInspector(response);
        const initial =
          response.events.find((event) => event.editable) ??
          response.events[0];
        setSelectedKey(initial ? eventKey(initial) : "");
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date, mode, selection]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, saving]);

  const selectedEvent = useMemo(
    () =>
      inspector?.events.find((event) => eventKey(event) === selectedKey) ??
      null,
    [inspector, selectedKey],
  );

  const loadEventIntoForm = (event: InspectableActivityEvent) => {
    setStartLocal(event.effective.start_local);
    setEndLocal(event.effective.end_local);
    setApp(event.effective.app);
    setTitle(event.effective.title);
    setCategoryMode(event.manual_category?.category ?? "auto");
    setCustomCategory("");
  };

  useEffect(() => {
    if (!selectedEvent) return;
    loadEventIntoForm(selectedEvent);
    setError(null);
    setSaved(null);
    // A saved response updates the selected event object without changing its
    // identity. Only switching the selected raw event should reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  const updateInspectorEvent = (
    response: ActivityEditResponse,
  ) => {
    setInspector((previous) => {
      if (!previous) return previous;
      const updatedKey = eventKey(response.event);
      return {
        ...previous,
        revision: response.revision,
        categories: response.categories,
        events: previous.events.map((event) =>
          eventKey(event) === updatedKey ? response.event : event,
        ),
      };
    });
  };

  const save = async () => {
    if (!inspector || !selectedEvent) return;
    setSaving(true);
    setError(null);
    try {
      const categoryOverride =
        categoryMode === "auto"
          ? null
          : categoryMode === CUSTOM_CATEGORY
            ? { custom_label: customCategory }
            : { category: categoryMode };
      const response = await saveActivityEdit({
        date,
        mode,
        bucket_id: selectedEvent.bucket_id,
        event_id: selectedEvent.event_id,
        expected_source_fingerprint: selectedEvent.source_fingerprint,
        expected_revision: inspector.revision,
        start_local: startLocal,
        end_local: endLocal,
        app,
        title,
        category_override: categoryOverride,
      });
      updateInspectorEvent(response);
      loadEventIntoForm(response.event);
      setSaved(response);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const undo = async () => {
    if (!saved || !selectedEvent) return;
    setSaving(true);
    setError(null);
    try {
      const response = await undoActivityEdit({
        date,
        mode,
        bucket_id: selectedEvent.bucket_id,
        event_id: selectedEvent.event_id,
        change_id: saved.change_id,
        expected_revision: saved.revision,
      });
      updateInspectorEvent(response);
      loadEventIntoForm(response.event);
      setSaved(null);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const canWrite =
    writeEnabled &&
    inspector?.write_enabled &&
    selectedEvent?.editable &&
    !selectedEvent.manual_edit_conflict;
  const canSave =
    canWrite &&
    !saving &&
    Boolean(startLocal && endLocal && app.trim()) &&
    (categoryMode !== CUSTOM_CATEGORY || Boolean(customCategory.trim()));

  return (
    <div
      className="activity-editor-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <aside
        ref={panelRef}
        className="activity-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-editor-title"
        tabIndex={-1}
      >
        <header className="activity-editor-head">
          <div>
            <h2 id="activity-editor-title">修改时间线</h2>
            <p>当前支持修改已有、已结束的事件；新增活动稍后开放。</p>
          </div>
          <button
            type="button"
            className="activity-editor-close"
            aria-label="关闭活动编辑器"
            disabled={saving}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {loading && (
          <p className="activity-editor-status" role="status">
            正在读取原始事件…
          </p>
        )}

        {!loading && inspector && inspector.events.length > 1 && (
          <section className="activity-event-picker">
            <p>这个显示块包含 {inspector.events.length} 条原始事件，请选一条：</p>
            <div>
              {inspector.events.map((event) => (
                <button
                  key={eventKey(event)}
                  type="button"
                  className={
                    selectedKey === eventKey(event) ? "selected" : ""
                  }
                  onClick={() => setSelectedKey(eventKey(event))}
                >
                  <span>
                    {localTimeLabel(event.effective.start_local).slice(11)}–
                    {localTimeLabel(event.effective.end_local).slice(11)}
                  </span>
                  <strong>{event.effective.app || "未知应用"}</strong>
                  <small>{event.effective.title || "无标题"}</small>
                </button>
              ))}
            </div>
          </section>
        )}

        {!loading && inspector && inspector.events.length === 0 && (
          <p className="activity-editor-status">
            原始事件已经变化或不存在，请刷新当天数据后再试。
          </p>
        )}

        {selectedEvent && (
          <form
            className="activity-editor-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {selectedEvent.manual_edit_conflict && (
              <p className="activity-editor-warning">
                原始事件已经变化，旧校正未应用。请先刷新页面再处理。
              </p>
            )}
            {!selectedEvent.editable && (
              <p className="activity-editor-warning">
                这条活动仍在采集或刚刚结束，暂时保持只读。
              </p>
            )}
            {!writeEnabled && (
              <p className="activity-editor-readonly">
                当前配置为只读；开启 activity_edit_enabled 后才能保存。
              </p>
            )}

            <div className="activity-editor-time-grid">
              <label>
                <span>开始时间</span>
                <input
                  type="datetime-local"
                  step="1"
                  value={startLocal}
                  disabled={!canWrite || saving}
                  onChange={(event) => setStartLocal(event.target.value)}
                />
              </label>
              <label>
                <span>结束时间</span>
                <input
                  type="datetime-local"
                  step="1"
                  value={endLocal}
                  disabled={!canWrite || saving}
                  onChange={(event) => setEndLocal(event.target.value)}
                />
              </label>
            </div>

            <label>
              <span>应用</span>
              <input
                type="text"
                value={app}
                maxLength={300}
                disabled={!canWrite || saving}
                onChange={(event) => setApp(event.target.value)}
              />
            </label>

            <label>
              <span>标题 / 内容</span>
              <textarea
                value={title}
                maxLength={1200}
                disabled={!canWrite || saving}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>

            <label>
              <span>分类</span>
              <select
                value={categoryMode}
                disabled={!canWrite || saving}
                onChange={(event) => setCategoryMode(event.target.value)}
              >
                <option value="auto">
                  跟随规则（当前：
                  {selectedEvent.automatic_category.category_label}）
                </option>
                {inspector?.categories.map((category) => (
                  <option
                    key={category.category}
                    value={category.category}
                  >
                    {category.label}
                    {category.custom ? " · 自定义" : ""}
                  </option>
                ))}
                <option value={CUSTOM_CATEGORY}>新建自定义分类…</option>
              </select>
            </label>

            {categoryMode === CUSTOM_CATEGORY && (
              <label>
                <span>自定义分类名称</span>
                <input
                  type="text"
                  value={customCategory}
                  maxLength={80}
                  placeholder="例如：深度工作"
                  disabled={!canWrite || saving}
                  onChange={(event) => setCustomCategory(event.target.value)}
                />
              </label>
            )}

            <p className="activity-editor-source">
              修改只保存在 KinaWatch 校正层，ActivityWatch 原始记录保持不变。
            </p>

            {error && (
              <p className="activity-editor-error" role="alert">
                {error}
              </p>
            )}
            {saved && (
              <p className="activity-editor-saved" role="status">
                已保存。
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void undo()}
                >
                  撤销本次修改
                </button>
              </p>
            )}

            <footer className="activity-editor-actions">
              <button
                type="button"
                disabled={saving}
                onClick={onClose}
              >
                取消
              </button>
              <button
                type="submit"
                className="activity-editor-save"
                disabled={!canSave}
              >
                {saving ? "保存中…" : "保存修改"}
              </button>
            </footer>
          </form>
        )}

        {!loading && error && !selectedEvent && (
          <p className="activity-editor-error" role="alert">
            {error}
          </p>
        )}
      </aside>
    </div>
  );
}
