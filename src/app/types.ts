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
  animate?: 'march' | 'pulse';
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
  phase: 'no_ai' | 'ai';
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

export interface CaseView {
  view: 'macula' | 'od';
  raw_uri: string;
  preprocessed_uri: string | null;
  width: number;
  height: number;
  masks: MaskOverlay[];
}

export interface CasePayload {
  assignment_id: number;
  case_id: number;
  has_od: boolean;
  is_calibration: boolean;
  phase: 'no_ai' | 'ai';
  views: CaseView[];
  /** AI predictions surfaced only in the `ai` phase. Null when no prediction exists. */
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

export type AiDecision = 'kept' | 'changed' | 'no_prediction';

export interface SubmitPayload {
  // Final grade (post-AI-revision if any).
  icdr: number;
  dme: number;
  notes: string | null;
  confidence: number;
  difficulty: number;

  // Grade committed before seeing the AI. Null in no_ai phase or no-prediction cases.
  pre_ai_icdr: number | null;
  pre_ai_dme: number | null;

  // AI prediction that was displayed. Null when nothing was shown.
  ai_icdr_shown: number | null;
  ai_dme_shown: number | null;

  /** One of 'kept' | 'changed' | 'no_prediction', or null in no_ai phase. */
  ai_decision: AiDecision | null;
}

export interface AdminStatus {
  authed: boolean;
  phase: 'no_ai' | 'ai';
  idle_threshold_ms: number;
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
