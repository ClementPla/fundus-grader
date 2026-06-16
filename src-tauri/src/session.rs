use crate::error::Result;
use crate::project_db;
use crate::state::{ActiveCase, Event, MouseSample};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Serialize, Debug, Clone)]
pub struct Progress {
    pub done: i64,
    pub total: i64,
    pub phase: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct NextCase {
    pub assignment_id: i64,
    pub case_id: i64,
    pub is_calibration: bool,
    pub has_od: bool,
}

#[derive(Deserialize, Debug)]
pub struct MouseSampleIn {
    pub ts_ms_since_case_start: i64,
    pub stage: Option<String>,
    pub view: String,
    pub x: i64,
    pub y: i64,
    pub scale: f64,
}

pub fn current_phase(results: &Connection) -> Result<String> {
    let phase: Option<String> = results
        .query_row(
            "SELECT value FROM admin_config WHERE key='phase'",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(phase.unwrap_or_else(|| "no_ai".to_string()))
}

pub fn progress(results: &Connection, reader_id: i64, phase: &str) -> Result<Progress> {
    let total: i64 = results.query_row(
        "SELECT COUNT(*) FROM assignments WHERE reader_id=?1 AND phase=?2",
        params![reader_id, phase],
        |r| r.get(0),
    )?;
    let done: i64 = results.query_row(
        "SELECT COUNT(*) FROM assignments WHERE reader_id=?1 AND phase=?2 AND status='submitted'",
        params![reader_id, phase],
        |r| r.get(0),
    )?;
    Ok(Progress {
        done,
        total,
        phase: phase.to_string(),
    })
}

pub fn next_case(
    results: &Connection,
    project: &Connection,
    reader_id: i64,
    phase: &str,
) -> Result<Option<NextCase>> {
    let row: Option<(i64, i64)> = results
        .query_row(
            "SELECT id, case_id FROM assignments
             WHERE reader_id=?1 AND phase=?2 AND status IN ('pending','in_progress')
             ORDER BY order_index ASC LIMIT 1",
            params![reader_id, phase],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    if let Some((aid, case_id)) = row {
        let case = project_db::get_case(project, case_id)?;
        Ok(Some(NextCase {
            assignment_id: aid,
            case_id,
            is_calibration: case.is_calibration,
            has_od: case.has_od,
        }))
    } else {
        Ok(None)
    }
}

pub fn mark_in_progress(results: &Connection, assignment_id: i64) -> Result<()> {
    results.execute(
        "UPDATE assignments SET status='in_progress' WHERE id=?1 AND status='pending'",
        params![assignment_id],
    )?;
    Ok(())
}

pub fn new_active_case(assignment_id: i64, case_id: i64) -> ActiveCase {
    let now = Instant::now();
    ActiveCase {
        assignment_id,
        case_id,
        started_at: now,
        current_view: "macula".to_string(),
        current_stage: "grading".to_string(),
        bucket_start: now,
        view_active_ms: HashMap::new(),
        view_first_interaction_ms: HashMap::new(),
        first_overlay_toggle_off_ms: None,
        events: Vec::new(),
        mouse_samples: Vec::new(),
    }
}

/// Flush time elapsed since `bucket_start` into the current (view, stage) bucket
/// and restart the timer. Call before every view or stage transition, and at submit.
fn flush_bucket(case: &mut ActiveCase) {
    let now = Instant::now();
    let elapsed = now.duration_since(case.bucket_start).as_millis() as i64;
    if elapsed > 0 {
        let key = (case.current_view.clone(), case.current_stage.clone());
        *case.view_active_ms.entry(key).or_insert(0) += elapsed;
    }
    case.bucket_start = now;
}

fn wall_clock_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Process an incoming event. Three things happen here, in order:
///   1. If it's a view_switch or stage_change, flush the active bucket first
///      (so the elapsed time gets attributed to the OLD view/stage), then
///      update current_view/current_stage. The event itself then gets stamped
///      with the NEW stage — the transition moment marks the new bucket's start.
///   2. Track first-interaction timestamps and first-overlay-off, unchanged.
///   3. Append to events with the current stage stamped on it.
pub fn push_event(
    case: &mut ActiveCase,
    view: Option<String>,
    event_type: &str,
    payload: Value,
) -> Result<()> {
    let now = Instant::now();
    let ts = now.duration_since(case.started_at).as_millis() as i64;

    if event_type == "view_switch" {
        if let Some(to) = payload.get("to").and_then(|v| v.as_str()) {
            flush_bucket(case);
            case.current_view = to.to_string();
        }
    } else if event_type == "stage_change" {
        if let Some(to) = payload.get("to").and_then(|v| v.as_str()) {
            flush_bucket(case);
            case.current_stage = to.to_string();
        }
    }

    // First-interaction tracking — these event types count as "user did something."
    if matches!(
        event_type,
        "interaction" | "zoom" | "pan" | "overlay_toggle" | "overlay_tab_toggle"
    ) {
        let v = view.clone().unwrap_or_else(|| case.current_view.clone());
        case.view_first_interaction_ms.entry(v).or_insert(ts);
    }

    if event_type == "overlay_toggle" {
        if let Some(visible) = payload.get("visible").and_then(|v| v.as_bool()) {
            if !visible && case.first_overlay_toggle_off_ms.is_none() {
                case.first_overlay_toggle_off_ms = Some(ts);
            }
        }
    }

    let payload_json = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    case.events.push(Event {
        ts_ms_since_case_start: ts,
        wall_clock_ms: wall_clock_ms(),
        stage: Some(case.current_stage.clone()),
        view,
        event_type: event_type.to_string(),
        payload_json,
    });
    Ok(())
}

/// Append a batch of mouse samples to the active case's buffer. Samples are
/// already stage-tagged on the frontend (because samples can spend up to ~1.5s
/// in the flush buffer and the stage may change in that window).
pub fn push_mouse_samples(case: &mut ActiveCase, samples: Vec<MouseSampleIn>) {
    case.mouse_samples.reserve(samples.len());
    for s in samples {
        case.mouse_samples.push(MouseSample {
            ts_ms_since_case_start: s.ts_ms_since_case_start,
            stage: s.stage,
            view: s.view,
            x: s.x,
            y: s.y,
            scale: s.scale,
        });
    }
}

/// Flush the final active bucket at submit time.
pub fn finalize_timings(case: &mut ActiveCase) {
    flush_bucket(case);
}

/// Get accumulated active ms for a specific (view, stage) bucket.
pub fn get_active_ms(case: &ActiveCase, view: &str, stage: &str) -> i64 {
    case.view_active_ms
        .get(&(view.to_string(), stage.to_string()))
        .copied()
        .unwrap_or(0)
}

/// Sum across the "post-AI" stages for a view. Post-AI = ai_reveal + editing_after_ai.
pub fn get_post_ai_active_ms(case: &ActiveCase, view: &str) -> i64 {
    get_active_ms(case, view, "ai_reveal") + get_active_ms(case, view, "editing_after_ai")
}
