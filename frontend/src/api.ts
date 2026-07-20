// API types mirror docs/fable-api-types.ts (backend contract).

export type DayMode = "calendar" | "routine";

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

export interface ActivitySource {
  name: string;
  label: string;
  type: string;
  ok: boolean;
  bucket_id?: string | null;
  event_count?: number;
  duration_seconds?: number;
  error?: string;
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
  category: string;
  category_label: string;
  project: string;
  app: string;
  title: string;
  source: string;
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

export interface RangeRhythm {
  first_active: string | null;
  last_active: string | null;
  hourly_active_seconds: number[];
}

export interface UncategorizedAppAggregate {
  app: string;
  duration_seconds: number;
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
  path: string;
  absolute_path: string;
  obsidian_url: string;
  body_markdown: string;
  personal_summary_markdown: string;
  outputs: string[];
  next_action_markdown: string;
  workflow_notes: WorkflowNote[];
  activity_summary_markdown: string;
  kina_advice: string[];
  completion_task_exists: boolean;
  completion_task_checked: boolean;
  projects: string[];
  offline_activities: OfflineActivity[];
  offline_unparsed: string[];
  parse_warnings: ParseWarning[];
}

export interface DayResponse {
  date: string;
  mode: DayMode;
  timezone: string;
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
    review_completed: boolean;
  };
  quality: {
    complete: boolean;
    issues: string[];
    uncategorized_seconds: number;
    overlap_warnings: OverlapWarning[];
    parse_warnings: ParseWarning[];
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
  days: RangeDay[];
  uncategorized_apps?: UncategorizedAppAggregate[];
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
  includeUncategorizedApps = false,
): Promise<RangeResponse> {
  const include = includeUncategorizedApps
    ? "&include=uncategorized_apps"
    : "";
  return getJSON(
    `/api/range?start=${start}&end=${end}&mode=${mode}${include}`,
  );
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

export type ReviewField = "personal_summary" | "outputs" | "next_action";

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

export interface WeeklyReviewResponse {
  ok: true;
  week_id: string;
  created: boolean;
  path: string;
  obsidian_url: string;
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

export function ensureWeeklyReview(
  weekId: string,
): Promise<WeeklyReviewResponse> {
  return requestJSON("/api/journal/weekly", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ week_id: weekId }),
  });
}
