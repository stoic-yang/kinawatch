export type DayMode = "calendar" | "routine";

export interface RuntimeSettings {
  default_mode: DayMode;
  routine_day_start: string;
  timezone: string;
  journal_write_enabled: boolean;
  activity_edit_enabled: boolean;
}

export interface FileFingerprint {
  path: string;
  /** Opaque decimal string: nanoseconds are larger than JS safe integers. */
  mtime_ns: string;
  size: number;
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
  overlap_adjustment_seconds?: number;
  parallel_wall_seconds?: number;
  background_overlap_removed_seconds?: number;
  observed_device_duration_seconds?: number;
  interactive_wall_seconds?: number;
  foreground_media_wall_seconds?: number;
  passive_media_seconds?: number;
  media_activity_enabled?: boolean;
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
  observed_event_count?: number;
  observed_duration_seconds?: number;
  attributed_duration_seconds?: number;
  error?: string;
  afk_filter?: Record<string, unknown>;
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
  category: string;
  category_label: string;
  project: string;
  app: string;
  title: string;
  source: string;
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

export interface RangeRhythm {
  first_active: string | null;
  last_active: string | null;
  hourly_active_seconds: number[];
}

export interface UncategorizedAppAggregate {
  app: string;
  duration_seconds: number;
}

export interface PeriodAppAggregate {
  app: string;
  duration_seconds: number;
  /** The category with the greatest accumulated duration for this app. */
  category: string;
}

export interface WorkflowNote {
  start_time: string;
  end_time: string;
  note: string;
  /** Present only for legacy Obsidian anchors; canonical writes return empty. */
  block_id: string;
  raw: string;
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
  /** Returned only when /api/range includes `timeline`. Screen blocks only. */
  timeline?: ScreenTimelineBlock[];
}

export interface RangeResponse {
  start: string;
  end: string;
  mode: DayMode;
  timezone: string;
  days: RangeDay[];
  top_apps?: PeriodAppAggregate[];
  uncategorized_apps?: UncategorizedAppAggregate[];
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

export type PeriodReviewKind = "week" | "month";
export type PeriodReviewField = "freeform";

export interface PeriodReviewSaveRequest {
  period_id: string;
  field: PeriodReviewField;
  markdown: string;
  expected_fingerprint: FileFingerprint;
}

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
  fields: Record<PeriodReviewField, string>;
  journal_fingerprint: FileFingerprint;
  review_field?: {
    field: PeriodReviewField;
    markdown: string;
  };
}

export type WeeklyReviewField = PeriodReviewField;
export interface WeeklyReviewSaveRequest
  extends Omit<PeriodReviewSaveRequest, "period_id"> {
  week_id: string;
}
export interface WeeklyReviewResponse extends PeriodReviewResponse {
  week_id: string;
}
export interface MonthlyReviewResponse extends PeriodReviewResponse {
  month_id: string;
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
