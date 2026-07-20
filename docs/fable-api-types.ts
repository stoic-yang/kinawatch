export type DayMode = "calendar" | "routine";

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
  days: RangeDay[];
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

export interface WeeklyReviewRequest {
  week_id: string;
}

export interface WeeklyReviewResponse {
  ok: true;
  week_id: string;
  created: boolean;
  path: string;
  provider: "local" | "obsidian";
  open_url: string;
  obsidian_url: string;
}
