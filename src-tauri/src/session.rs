use crate::error::{Error, Result};
use crate::state::{ActiveCase, PendingEvent};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub done: i64,
    pub total: i64,
    pub phase: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct NextCase {
    pub assignment_id: i64,
    pub case_id: i64,
    pub is_calibration: bool,
    pub has_od: bool,
}

pub fn current_phase(results: &Connection) -> Result<String> {
    crate::results_db::admin_get(results, "phase")?
        .ok_or_else(|| Error::Internal("phase not set in admin_config".into()))
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

/// Find the next case the reader should see in the current phase. Re-queues any
/// interrupted (in_progress) case by flipping its status back to pending.
pub fn next_case(
    results: &Connection,
    project: &Connection,
    reader_id: i64,
    phase: &str,
) -> Result<Option<NextCase>> {
    // Reset any orphaned in_progress for this reader/phase.
    results.execute(
        "UPDATE assignments SET status='pending'
         WHERE reader_id=?1 AND phase=?2 AND status='in_progress'",
        params![reader_id, phase],
    )?;

    let row = results
        .query_row::<(i64, i64), _, _>(
            "SELECT id, case_id FROM assignments
             WHERE reader_id=?1 AND phase=?2 AND status IN ('pending','reverted')
             ORDER BY order_index ASC LIMIT 1",
            params![reader_id, phase],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let Some((assignment_id, case_id)) = row else {
        return Ok(None);
    };

    let case = crate::project_db::get_case(project, case_id)?;
    Ok(Some(NextCase {
        assignment_id,
        case_id,
        is_calibration: case.is_calibration,
        has_od: case.has_od,
    }))
}

pub fn mark_in_progress(results: &Connection, assignment_id: i64) -> Result<()> {
    results.execute(
        "UPDATE assignments SET status='in_progress' WHERE id=?1",
        params![assignment_id],
    )?;
    Ok(())
}

/// Initialize a fresh ActiveCase for a new case render.
pub fn new_active_case(assignment_id: i64, case_id: i64) -> ActiveCase {
    let now = chrono::Utc::now().timestamp_millis();
    ActiveCase {
        assignment_id,
        case_id,
        started_at_ms: now,
        current_view: None,
        view_first_shown_ms: HashMap::new(),
        view_first_interaction_ms: HashMap::new(),
        view_active_ms: HashMap::new(),
        view_last_resume_ms: HashMap::new(),
        first_overlay_toggle_off_ms: None,
        events: Vec::new(),
    }
}

/// Add an event to the active case buffer.
pub fn push_event(
    case: &mut ActiveCase,
    view: Option<String>,
    event_type: &str,
    payload: serde_json::Value,
) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let rel = now - case.started_at_ms;

    // Track derived fields.
    if event_type == "view_shown" {
        if let Some(v) = &view {
            case.view_first_shown_ms.entry(v.clone()).or_insert(rel);
            // Resume timing for this view, pause others.
            // Two-pass to avoid simultaneous borrow of two fields.
            let pause_keys: Vec<String> = case
                .view_last_resume_ms
                .iter()
                .filter_map(|(k, last)| {
                    if k != v && last.is_some() {
                        Some(k.clone())
                    } else {
                        None
                    }
                })
                .collect();
            for k in pause_keys {
                let start_opt = case
                    .view_last_resume_ms
                    .get(&k)
                    .copied()
                    .unwrap_or(None);
                if let Some(start) = start_opt {
                    let elapsed = rel - start;
                    if elapsed > 0 {
                        *case.view_active_ms.entry(k.clone()).or_insert(0) += elapsed;
                    }
                    case.view_last_resume_ms.insert(k, None);
                }
            }
            case.view_last_resume_ms.insert(v.clone(), Some(rel));
            case.current_view = Some(v.clone());
        }
    }

    if event_type == "interaction" {
        if let Some(v) = &view {
            case.view_first_interaction_ms.entry(v.clone()).or_insert(rel);
        }
    }

    if event_type == "overlay_toggle" {
        // payload: { class_id, visible }
        if case.first_overlay_toggle_off_ms.is_none() {
            if let Some(visible) = payload.get("visible").and_then(|v| v.as_bool()) {
                if !visible {
                    case.first_overlay_toggle_off_ms = Some(rel);
                }
            }
        }
    }

    if event_type == "idle_start" {
        if let Some(v) = &view {
            let start_opt = case
                .view_last_resume_ms
                .get(v)
                .copied()
                .unwrap_or(None);
            if let Some(start) = start_opt {
                let elapsed = rel - start;
                if elapsed > 0 {
                    *case.view_active_ms.entry(v.clone()).or_insert(0) += elapsed;
                }
                case.view_last_resume_ms.insert(v.clone(), None);
            }
        }
    }

    if event_type == "idle_end" {
        if let Some(v) = &view {
            case.view_last_resume_ms.insert(v.clone(), Some(rel));
        }
    }

    let payload_str = serde_json::to_string(&payload)?;
    case.events.push(PendingEvent {
        ts_ms_since_case_start: rel,
        wall_clock_ms: now,
        view,
        event_type: event_type.to_string(),
        payload_json: payload_str,
    });
    Ok(())
}

/// Finalize remaining active time intervals at submission time.
pub fn finalize_timings(case: &mut ActiveCase) {
    let now = chrono::Utc::now().timestamp_millis();
    let rel = now - case.started_at_ms;
    let keys: Vec<String> = case.view_last_resume_ms.keys().cloned().collect();
    for v in keys {
        if let Some(start) = case.view_last_resume_ms.get(&v).copied().unwrap_or(None) {
            let elapsed = rel - start;
            if elapsed > 0 {
                *case.view_active_ms.entry(v.clone()).or_insert(0) += elapsed;
            }
            case.view_last_resume_ms.insert(v, None);
        }
    }
}
