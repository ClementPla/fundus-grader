export interface ClassInfo {
  class_id: number;
  name: string;
  default_style: ClassStyle;
}

export interface ClassStyle {
  fill?: string;
  fill_opacity?: number;
  stroke?: string;
  stroke_width?: number;
  stroke_opacity?: number;
  stroke_dasharray?: string;
  animate?: "march" | "pulse";
  visible_by_default?: boolean;
}

export interface Reader {
  id: number;
  name: string;
  surname: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface Progress {
  done: number;
  total: number;
  phase: string;
}

export interface NextCase {
  assignment_id: number;
  case_id: number;
  is_calibration: boolean;
  has_od: boolean;
}

export interface SessionStart {
  phase: "no_ai" | "ai";
  progress: Progress;
  next_case: NextCase | null;
  od_enabled: boolean;
  preprocessing_available: boolean;
  overlay_style: Record<string, ClassStyle>;
  classes: ClassInfo[];
}

export interface MaskOverlay {
  class_id: number;
  contours_json: string;
}

export interface AnatomyAnchor {
  kind: string;
  x: number;
  y: number;
  r: number | null;
}

export interface CaseView {
  view: "macula" | "od";
  raw_uri: string;
  preprocessed_uri: string | null;
  width: number;
  height: number;
  masks: MaskOverlay[];
  anatomy: AnatomyAnchor[];
}

export interface CasePayload {
  assignment_id: number;
  case_id: number;
  has_od: boolean;
  is_calibration: boolean;
  phase: "no_ai" | "ai";
  views: CaseView[];
  ai_icdr: number | null;
  ai_dme: number | null;
}

export interface OpenProjectResult {
  project_path: string;
  results_path: string;
  od_enabled: boolean;
  preprocessing_available: boolean;
  classes: ClassInfo[];
  overlay_style: Record<string, ClassStyle>;
  admin_configured: boolean;
}

export type AiDecision = "kept" | "changed" | "no_prediction";

/** Reader's progress through a single case. Mirrors the session-component
 *  state machine; the backend uses these exact strings. */
export type Stage = "grading" | "ai_reveal" | "editing_after_ai";

export interface SubmitPayload {
  icdr: number;
  dme: number;
  notes: string | null;
  confidence: number;
  difficulty: number;
  pre_ai_icdr: number | null;
  pre_ai_dme: number | null;
  ai_icdr_shown: number | null;
  ai_dme_shown: number | null;
  ai_decision: AiDecision | null;
  /** Comment written during the AI-reveal (adjudication) phase. Stored
   *  separately from `notes` so it never overwrites the original grading notes. */
  adjudication_notes: string | null;
}

/** One mouse sample as sent to the backend. Coordinates are in image-space
 *  pixels (post-inverse-transform). `stage` is stamped at capture time on
 *  the frontend, because samples can spend up to ~1.5s in the flush buffer
 *  and the stage may transition in that window. */
export interface MouseSample {
  ts_ms_since_case_start: number;
  stage: Stage | null;
  view: "macula" | "od";
  x: number;
  y: number;
  scale: number;
}

export interface AdminStatus {
  authed: boolean;
  phase: "no_ai" | "ai";
  idle_threshold_ms: number;
}

/** One assignment row for a reader, with its submission (if any), reference
 *  grades, and interaction aggregates. Returned by `admin_reader_stats`; all
 *  summary statistics are computed on the frontend from these. */
export interface CaseRecord {
  assignment_id: number;
  case_id: number;
  phase: "no_ai" | "ai";
  status: string;
  is_calibration: boolean;
  ref_icdr: number | null;
  ref_dme: number | null;
  case_ai_icdr: number | null;
  case_ai_dme: number | null;
  submitted_at: string | null;
  icdr: number | null;
  dme: number | null;
  confidence: number | null;
  difficulty: number | null;
  pre_ai_icdr: number | null;
  pre_ai_dme: number | null;
  ai_icdr_shown: number | null;
  ai_dme_shown: number | null;
  ai_decision: AiDecision | null;
  has_notes: boolean;
  has_adjudication_notes: boolean;
  active_ms_macula: number | null;
  active_ms_od: number | null;
  active_ms_macula_pre_ai: number | null;
  active_ms_macula_post_ai: number | null;
  active_ms_od_pre_ai: number | null;
  active_ms_od_post_ai: number | null;
  first_interaction_ms_macula: number | null;
  first_interaction_ms_od: number | null;
  first_overlay_toggle_off_ms: number | null;
  n_macula_corrections: number;
  macula_correction_dist_px: number | null;
  n_zoom: number;
  n_pan: number;
  n_overlay_toggle: number;
  n_preprocess_toggle: number;
  n_view_switch: number;
  n_idle: number;
  n_mouse_samples: number;
}

export interface ReaderStats {
  reader: {
    id: number;
    name: string;
    surname: string;
    first_seen_at: string;
    last_seen_at: string;
  };
  cases: CaseRecord[];
  revert_count: number;
}

export interface SubmissionRow {
  id: number;
  assignment_id: number;
  case_id: number;
  reader_name: string;
  reader_surname: string;
  phase: string;
  submitted_at: string;
  icdr: number;
  dme: number;
  ai_decision: AiDecision | null;
  reverted: boolean;
}
