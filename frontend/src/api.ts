// API types mirror docs/fable-api-types.ts (backend contract).

export type DayMode = "calendar" | "routine";

export interface RuntimeSettings {
  default_mode: DayMode;
  routine_day_start: string;
  timezone: string;
  journal_write_enabled: boolean;
  activity_edit_enabled: boolean;
}

export interface ParseWarning {
  line: string;
  message: string;
}

export interface OverlapWarning {
  offline_index: number;
  start: string;
  end: string;
  overlap_seconds: number;
  message: string;
}

export interface TimeAccounting {
  policy: string;
  raw_device_duration_seconds?: number;
  wall_duration_seconds: number;
  interactive_wall_seconds?: number;
  foreground_media_wall_seconds?: number;
  passive_media_seconds?: number;
  media_activity_enabled?: boolean;
  overlap_adjustment_seconds?: number;
  parallel_wall_seconds?: number;
  background_overlap_removed_seconds?: number;
  observed_device_duration_seconds?: number;
  afk_removed_before_media_seconds?: number;
  afk_removed_seconds: number;
  inactive_window_seconds?: number;
  background_window_removed_seconds: number;
  max_parallel_sources?: number;
}

export interface ActivitySource {
  name: string;
  label: string;
  type: string;
  ok: boolean;
  bucket_id?: string | null;
  event_count?: number;
  duration_seconds?: number;
  error?: string;
  latest_event?: string | null;
  coverage?: string;
  media_activity?: Record<string, unknown>;
}

export interface CategoryAggregate {
  category: string;
  label: string;
  duration_seconds: number;
  event_count: number;
  share: number;
}

export interface ProjectAggregate {
  project: string;
  screen_seconds: number;
  offline_seconds: number;
  duration_seconds: number;
}

export interface ScreenTimelineBlock {
  kind: "screen";
  start: string;
  end: string;
  duration_seconds: number;
  /** Activity credited on this device before cross-device equal sharing. */
  device_duration_seconds?: number;
  category: string;
  category_label: string;
  project: string;
  app: string;
  title: string;
  source: string;
  source_type?: string;
  bundle_id?: string;
  event_refs: ActivityEventRef[];
  manual_edit: boolean;
  manual_edit_conflict: boolean;
}

export interface ActivityEventRef {
  bucket_id: string;
  event_id: string;
}

export interface OfflineActivity {
  kind: "offline";
  start: string;
  end: string;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  category: string;
  project: string;
  note: string;
  crosses_midnight: boolean;
  raw: string;
}

export type TimelineBlock = ScreenTimelineBlock | OfflineActivity;

export interface RhythmDevice {
  device: "mac" | "ipad" | "iphone" | "other" | "offline";
  label: string;
  active_seconds: number;
  observed_seconds: number | null;
}

export interface RangeRhythm {
  first_active: string | null;
  last_active: string | null;
  hourly_active_seconds: number[];
  devices?: RhythmDevice[];
}

export interface WorkflowNote {
  start_time: string;
  end_time: string;
  note: string;
  /** Present only for legacy Obsidian anchors; canonical writes return empty. */
  block_id: string;
  raw: string;
}

export interface FileFingerprint {
  path: string;
  /** Opaque decimal string: nanoseconds are larger than JS safe integers. */
  mtime_ns: string;
  size: number;
}

export interface JournalData {
  exists: boolean;
  provider: "local" | "obsidian";
  path: string;
  absolute_path: string;
  open_url: string;
  obsidian_url: string;
  body_markdown: string;
  personal_summary_markdown: string;
  outputs: string[];
  next_action_markdown: string;
  freeform_markdown: string;
  workflow_notes: WorkflowNote[];
  activity_summary_markdown: string;
  kina_advice: string[];
  projects: string[];
  offline_activities: OfflineActivity[];
  offline_unparsed: string[];
  parse_warnings: ParseWarning[];
}

export interface DayResponse {
  workflows: {
    version: number;
    source: "mac";
    id: string;
    cutoff: string;
    min_active_seconds: number;
    sessions: Array<{ id: string; start: string; end: string; active_seconds: number }>;
  };
  date: string;
  mode: DayMode;
  timezone: string;
  range: {
    start: string;
    end: string;
  };
  generated_at: string;
  cache: {
    hit: boolean;
    journal_fingerprint: FileFingerprint;
  };
  overview: {
    active_seconds: number;
    offline_seconds: number;
    combined_nonoverlap_seconds: number;
    longest_focus_seconds: number;
    meaningful_switches: number;
    classification_coverage: number;
    review_has_content: boolean;
  };
  quality: {
    complete: boolean;
    issues: string[];
    uncategorized_seconds: number;
    overlap_warnings: OverlapWarning[];
    parse_warnings: ParseWarning[];
    time_accounting: TimeAccounting;
    sources: ActivitySource[];
  };
  categories: CategoryAggregate[];
  projects: ProjectAggregate[];
  timeline: TimelineBlock[];
  rhythm?: RangeRhythm;
  journal: JournalData;
}

export interface RangeDay {
  date: string;
  overview: DayResponse["overview"];
  quality: Pick<
    DayResponse["quality"],
    "complete" | "issues" | "uncategorized_seconds"
  >;
  categories: CategoryAggregate[];
  rhythm?: RangeRhythm;
}

export interface RangeResponse {
  start: string;
  end: string;
  mode: DayMode;
  timezone: string;
  days: RangeDay[];
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const payload = (await res.json()) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error) {
        message = payload.error;
      }
    } catch {
      // Keep the HTTP fallback when the response is not JSON.
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

async function getJSON<T>(url: string): Promise<T> {
  return requestJSON<T>(url);
}

export function fetchRuntimeSettings(): Promise<RuntimeSettings> {
  return getJSON("/api/settings");
}

export function fetchDay(
  date: string,
  mode: DayMode,
  refresh = false,
): Promise<DayResponse> {
  const extra = refresh ? "&refresh=1" : "";
  return getJSON(`/api/day?date=${date}&mode=${mode}${extra}`);
}

export function fetchRange(
  start: string,
  end: string,
  mode: DayMode,
): Promise<RangeResponse> {
  return getJSON(`/api/range?start=${start}&end=${end}&mode=${mode}`);
}

export interface WorkflowSaveRequest {
  date: string;
  start_time: string;
  end_time: string;
  note: string;
  expected_fingerprint: FileFingerprint;
}

export interface WorkflowSaveResponse {
  ok: true;
  date: string;
  created: boolean;
  replaced: boolean;
  workflow_note: Omit<WorkflowNote, "raw">;
  journal_fingerprint: FileFingerprint;
}

export type ReviewField =
  | "personal_summary"
  | "outputs"
  | "next_action"
  | "freeform";

export interface JournalDocumentResponse {
  ok: true;
  date: string;
  markdown: string;
  journal_fingerprint: FileFingerprint;
  path: string;
  provider: "local" | "obsidian";
  write_enabled: boolean;
  exists: boolean;
  has_frontmatter: boolean;
}

export function fetchJournalDocument(date: string): Promise<JournalDocumentResponse> {
  return getJSON(`/api/journal/document?date=${encodeURIComponent(date)}`);
}

export function saveJournalDocument(date: string, markdown: string, expectedFingerprint: FileFingerprint): Promise<JournalDocumentResponse> {
  return requestJSON("/api/journal/document", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({date, markdown, expected_fingerprint: expectedFingerprint}),
  });
}

export interface ReviewSaveRequest {
  date: string;
  field: ReviewField;
  markdown: string;
  expected_fingerprint: FileFingerprint;
}

export interface ReviewSaveResponse {
  ok: true;
  date: string;
  created: boolean;
  replaced: boolean;
  review_field: {
    field: ReviewField;
    markdown: string;
  };
  journal_fingerprint: FileFingerprint;
}

export type PeriodReviewKind = "week" | "month";

export interface PeriodReviewResponse {
  ok: true;
  period_id: string;
  week_id?: string;
  month_id?: string;
  exists: boolean;
  created?: boolean;
  replaced?: boolean;
  path: string;
  provider: "local" | "obsidian";
  open_url: string;
  obsidian_url: string;
  write_enabled: boolean;
  fields: {
    freeform: string;
  };
  journal_fingerprint: FileFingerprint;
  review_field?: {
    field: "freeform";
    markdown: string;
  };
}

export interface PermanentNoteResponse {
  ok: true;
  exists: boolean;
  created?: boolean;
  replaced?: boolean;
  path: string;
  provider: "local" | "obsidian";
  open_url: string;
  obsidian_url: string;
  write_enabled: boolean;
  markdown: string;
  journal_fingerprint: FileFingerprint;
}

export interface ActivityCategoryOption {
  category: string;
  label: string;
  custom: boolean;
}

export interface ActivityEventValues {
  start: string;
  end: string;
  start_local: string;
  end_local: string;
  app: string;
  title: string;
  category: string;
  category_label: string;
}

export interface InspectableActivityEvent {
  bucket_id: string;
  event_id: string;
  source_fingerprint: string;
  editable: boolean;
  ended: boolean;
  original: ActivityEventValues;
  effective: ActivityEventValues;
  automatic_category: {
    category: string;
    category_label: string;
  };
  manual_category: {
    category: string;
    label: string;
  } | null;
  manual_edit: boolean;
  manual_edit_fields: string[];
  manual_edit_conflict: boolean;
}

export interface ActivityInspectorResponse {
  date: string;
  mode: DayMode;
  timezone: string;
  bucket_id: string;
  revision: string;
  write_enabled: boolean;
  categories: ActivityCategoryOption[];
  events: InspectableActivityEvent[];
}

export interface ActivityEditRequest {
  date: string;
  mode: DayMode;
  bucket_id: string;
  event_id: string;
  expected_source_fingerprint: string;
  expected_revision: string;
  start_local: string;
  end_local: string;
  app: string;
  title: string;
  category_override:
    | { category: string }
    | { custom_label: string }
    | null;
}

export interface ActivityEditResponse {
  ok: true;
  date: string;
  change_id: string;
  revision: string;
  event: InspectableActivityEvent;
  categories: ActivityCategoryOption[];
}

export interface ActivityUndoRequest {
  date: string;
  mode: DayMode;
  bucket_id: string;
  event_id: string;
  change_id: string;
  expected_revision: string;
}

export function saveWorkflowDescription(
  payload: WorkflowSaveRequest,
): Promise<WorkflowSaveResponse> {
  return requestJSON("/api/journal/workflow", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function saveReviewField(
  payload: ReviewSaveRequest,
): Promise<ReviewSaveResponse> {
  return requestJSON("/api/journal/review", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function fetchPermanentNote(): Promise<PermanentNoteResponse> {
  return getJSON("/api/journal/permanent");
}

export interface BeliefsResponse extends PermanentNoteResponse {
  has_frontmatter: boolean;
  changed?: boolean;
}

export function fetchBeliefs(): Promise<BeliefsResponse> {
  return getJSON("/api/journal/beliefs");
}

export interface BeliefRecord {
  id: string;
  markdown: string;
  fingerprint: string;
  path: string;
  legacy: boolean;
  created_at: number;
  updated_at: number;
  liked_days: string[];
  liked_today: boolean;
  like_count: number;
}
export interface BeliefLibraryResponse {
  ok: boolean;
  namespace: string;
  write_enabled: boolean;
  timezone: string;
  today: string;
  revision: string;
  records: BeliefRecord[];
  order: string[];
}
export function fetchBeliefLibrary(): Promise<BeliefLibraryResponse> { return getJSON("/api/beliefs"); }
export function saveBeliefDocument(payload: {namespace: string; id: string; markdown: string; expected_fingerprint: string | null}): Promise<BeliefLibraryResponse> {
  return requestJSON("/api/beliefs/document", { method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload) });
}
export function saveBeliefState(payload: {namespace: string; expected_revision: string} & ({action: "order"; order: string[]} | {action: "like"; id: string; value: boolean; day: string})): Promise<BeliefLibraryResponse> {
  return requestJSON("/api/beliefs/state", { method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload) });
}

export function saveBeliefs(markdown: string, fingerprint: FileFingerprint): Promise<BeliefsResponse> {
  return requestJSON("/api/journal/beliefs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, expected_fingerprint: fingerprint }),
  });
}

export function savePermanentNote(
  markdown: string,
  expectedFingerprint: FileFingerprint,
): Promise<PermanentNoteResponse> {
  return requestJSON("/api/journal/permanent", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      markdown,
      expected_fingerprint: expectedFingerprint,
    }),
  });
}

export function fetchPeriodReview(
  kind: PeriodReviewKind,
  periodId: string,
): Promise<PeriodReviewResponse> {
  const endpoint = kind === "week" ? "weekly" : "monthly";
  const parameter = kind === "week" ? "week_id" : "month_id";
  return getJSON(
    `/api/journal/${endpoint}?${parameter}=${encodeURIComponent(periodId)}`,
  );
}

export function savePeriodReview(
  kind: PeriodReviewKind,
  periodId: string,
  markdown: string,
  expectedFingerprint: FileFingerprint,
): Promise<PeriodReviewResponse> {
  const endpoint = kind === "week" ? "weekly" : "monthly";
  const periodKey = kind === "week" ? "week_id" : "month_id";
  return requestJSON(`/api/journal/${endpoint}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      [periodKey]: periodId,
      field: "freeform",
      markdown,
      expected_fingerprint: expectedFingerprint,
    }),
  });
}

export function fetchActivityInspector(
  date: string,
  mode: DayMode,
  references: ActivityEventRef[],
): Promise<ActivityInspectorResponse> {
  const first = references[0];
  if (!first) {
    return Promise.reject(new Error("该时间块没有可定位的原始事件。"));
  }
  const parameters = new URLSearchParams({
    date,
    mode,
    bucket_id: first.bucket_id,
  });
  for (const reference of references) {
    if (reference.bucket_id === first.bucket_id) {
      parameters.append("event_id", reference.event_id);
    }
  }
  return getJSON(`/api/activity/inspect?${parameters.toString()}`);
}

export function saveActivityEdit(
  payload: ActivityEditRequest,
): Promise<ActivityEditResponse> {
  return requestJSON("/api/activity/edit", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function undoActivityEdit(
  payload: ActivityUndoRequest,
): Promise<ActivityEditResponse> {
  return requestJSON("/api/activity/undo", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
