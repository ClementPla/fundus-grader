use crate::error::{Error, Result};
use crate::project_db;
use crate::results_db;
use crate::session;
use crate::state::AppState;
use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

// ---------- Open project / readers / sessions (unchanged from prior patches) ----------

#[derive(Serialize)]
pub struct OpenProjectResult {
    project_path: String,
    results_path: String,
    od_enabled: bool,
    preprocessing_available: bool,
    classes: Vec<project_db::ClassInfo>,
    overlay_style: serde_json::Value,
    admin_configured: bool,
}

#[tauri::command]
pub async fn open_project(state: State<'_, AppState>, path: String) -> Result<OpenProjectResult> {
    let project_path = PathBuf::from(&path);
    if !project_path.exists() {
        return Err(Error::NotFound(format!("project file {}", path)));
    }
    let project = project_db::open(&project_path)?;
    let stem = project_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("results")
        .to_string();
    let parent = project_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let results_path = parent.join(format!("{}.results.sqlite", stem));
    let results = results_db::open(&results_path)?;

    let od_enabled = project_db::meta_get(&project, "od_enabled")?
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(true);
    let preprocessing_available = project_db::meta_get(&project, "preprocessing_available")?
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(true);
    let overlay_style: serde_json::Value = project_db::meta_get(&project, "overlay_style")?
        .map(|v| serde_json::from_str(&v).unwrap_or(serde_json::Value::Object(Default::default())))
        .unwrap_or(serde_json::Value::Object(Default::default()));
    let classes = project_db::list_classes(&project)?;
    let admin_configured = results_db::admin_get(&results, "password_hash")?.is_some();

    state.with(|s| {
        s.project_path = Some(project_path.clone());
        s.project_db = Some(project);
        s.results_db = Some(results);
        s.reader_id = None;
        s.session_id = None;
        s.admin_authed = false;
        s.active_case = None;
    });

    Ok(OpenProjectResult {
        project_path: path,
        results_path: results_path.to_string_lossy().to_string(),
        od_enabled,
        preprocessing_available,
        classes,
        overlay_style,
        admin_configured,
    })
}

#[tauri::command]
pub async fn list_readers(state: State<'_, AppState>) -> Result<Vec<results_db::Reader>> {
    state.require_project()?;
    state.with(|s| {
        let results = s.results_db.as_ref().unwrap();
        results_db::list_readers(results)
    })
}

#[tauri::command]
pub async fn register_reader(
    state: State<'_, AppState>,
    name: String,
    surname: String,
) -> Result<results_db::Reader> {
    state.require_project()?;
    let name = name.trim().to_string();
    let surname = surname.trim().to_string();
    if name.is_empty() || surname.is_empty() {
        return Err(Error::Invalid("name and surname required".into()));
    }
    let reader = state.with(|s| {
        let results = s.results_db.as_ref().unwrap();
        results_db::upsert_reader(results, &name, &surname)
    })?;
    state.with(|s| s.reader_id = Some(reader.id));
    Ok(reader)
}

#[tauri::command]
pub async fn login_reader(state: State<'_, AppState>, reader_id: i64) -> Result<()> {
    state.require_project()?;
    state.with(|s| s.reader_id = Some(reader_id));
    Ok(())
}

#[derive(Serialize)]
pub struct SessionStart {
    pub phase: String,
    pub progress: session::Progress,
    pub next_case: Option<session::NextCase>,
    pub od_enabled: bool,
    pub preprocessing_available: bool,
    pub overlay_style: serde_json::Value,
    pub classes: Vec<project_db::ClassInfo>,
}

#[tauri::command]
pub async fn start_session(state: State<'_, AppState>) -> Result<SessionStart> {
    state.require_project()?;
    let reader_id = state.require_reader()?;
    state.with(|s| -> Result<SessionStart> {
        let results = s.results_db.as_ref().unwrap();
        let project = s.project_db.as_ref().unwrap();
        let phase = session::current_phase(results)?;
        let seed_str = project_db::meta_get(project, "seed")?
            .ok_or_else(|| Error::Invalid("project meta missing seed".into()))?;
        let seed: u64 = seed_str
            .parse()
            .map_err(|_| Error::Invalid(format!("seed not numeric: {}", seed_str)))?;
        crate::assignment_gen::ensure_assignments(results, project, reader_id, &phase, seed)?;
        let progress = session::progress(results, reader_id, &phase)?;
        let next = session::next_case(results, project, reader_id, &phase)?;
        let od_enabled = project_db::meta_get(project, "od_enabled")?
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(true);
        let preprocessing_available = project_db::meta_get(project, "preprocessing_available")?
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(true);
        let overlay_style: serde_json::Value = project_db::meta_get(project, "overlay_style")?
            .map(|v| {
                serde_json::from_str(&v).unwrap_or(serde_json::Value::Object(Default::default()))
            })
            .unwrap_or(serde_json::Value::Object(Default::default()));
        let classes = project_db::list_classes(project)?;
        Ok(SessionStart {
            phase,
            progress,
            next_case: next,
            od_enabled,
            preprocessing_available,
            overlay_style,
            classes,
        })
    })
}

// ---------- Case loading ----------

#[derive(Serialize)]
pub struct CaseView {
    pub view: String,
    pub raw_uri: String,
    pub preprocessed_uri: Option<String>,
    pub width: i64,
    pub height: i64,
    pub masks: Vec<MaskOverlay>,
    pub anatomy: Vec<project_db::AnatomyAnchor>,
}

#[derive(Serialize)]
pub struct MaskOverlay {
    pub class_id: i64,
    pub contours_json: String,
}

#[derive(Serialize)]
pub struct CasePayload {
    pub assignment_id: i64,
    pub case_id: i64,
    pub has_od: bool,
    pub is_calibration: bool,
    pub phase: String,
    pub views: Vec<CaseView>,
    pub ai_icdr: Option<i64>,
    pub ai_dme: Option<i64>,
}

#[tauri::command]
pub async fn start_case(state: State<'_, AppState>, assignment_id: i64) -> Result<CasePayload> {
    state.require_project()?;
    let _reader_id = state.require_reader()?;
    state.with(|s| -> Result<CasePayload> {
        let results = s.results_db.as_ref().unwrap();
        let project = s.project_db.as_ref().unwrap();

        let row: (i64, i64, String, String) = results
            .query_row(
                "SELECT id, case_id, phase, status FROM assignments WHERE id = ?1",
                params![assignment_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|_| Error::NotFound(format!("assignment {}", assignment_id)))?;
        let (aid, case_id, phase, status) = row;
        if status == "submitted" {
            return Err(Error::Invalid("assignment already submitted".into()));
        }
        let case = project_db::get_case(project, case_id)?;
        let od_enabled = project_db::meta_get(project, "od_enabled")?
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(true);
        let preprocessing_available = project_db::meta_get(project, "preprocessing_available")?
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(true);

        let mut views_vec: Vec<&str> = vec!["macula"];
        if case.has_od && od_enabled {
            views_vec.push("od");
        }

        let mut payload_views = Vec::new();
        for v in &views_vec {
            let raw_uri = format!("fundus://image/{}/{}/raw", case_id, v);
            let preprocessed_uri = if preprocessing_available {
                Some(format!("fundus://image/{}/{}/preprocessed", case_id, v))
            } else {
                None
            };
            let dims = project_db::get_image_dims(project, case_id, v)?;
            let anatomy = project_db::list_anatomy(project, case_id, v)?;
            let masks = if phase == "ai" {
                project_db::list_mask_contours(project, case_id, v)?
                    .into_iter()
                    .map(|m| MaskOverlay {
                        class_id: m.class_id,
                        contours_json: m.contours_json,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            payload_views.push(CaseView {
                view: v.to_string(),
                raw_uri,
                preprocessed_uri,
                width: dims.width,
                height: dims.height,
                masks,
                anatomy,
            });
        }

        session::mark_in_progress(results, aid)?;
        s.active_case = Some(session::new_active_case(aid, case_id));

        let (ai_icdr, ai_dme) = if phase == "ai" {
            (case.ai_icdr, case.ai_dme)
        } else {
            (None, None)
        };

        Ok(CasePayload {
            assignment_id: aid,
            case_id,
            has_od: case.has_od && od_enabled,
            is_calibration: case.is_calibration,
            phase,
            views: payload_views,
            ai_icdr,
            ai_dme,
        })
    })
}

// ---------- Event and mouse-sample ingestion ----------

#[derive(Deserialize)]
pub struct EventIn {
    pub event_type: String,
    pub view: Option<String>,
    pub payload: serde_json::Value,
}

#[tauri::command]
pub async fn log_event(state: State<'_, AppState>, ev: EventIn) -> Result<()> {
    state.with(|s| -> Result<()> {
        let case = s
            .active_case
            .as_mut()
            .ok_or_else(|| Error::Invalid("no active case".into()))?;
        session::push_event(case, ev.view, &ev.event_type, ev.payload)?;
        Ok(())
    })
}

#[tauri::command]
pub async fn push_mouse_samples(
    state: State<'_, AppState>,
    samples: Vec<session::MouseSampleIn>,
) -> Result<()> {
    if samples.is_empty() {
        return Ok(());
    }
    state.with(|s| -> Result<()> {
        let case = s
            .active_case
            .as_mut()
            .ok_or_else(|| Error::Invalid("no active case".into()))?;
        session::push_mouse_samples(case, samples);
        Ok(())
    })
}

// ---------- Submit ----------

#[derive(Deserialize, Debug)]
pub struct SubmitPayload {
    pub icdr: i64,
    pub dme: i64,
    pub notes: Option<String>,
    pub confidence: i64,
    pub difficulty: i64,
    pub pre_ai_icdr: Option<i64>,
    pub pre_ai_dme: Option<i64>,
    pub ai_icdr_shown: Option<i64>,
    pub ai_dme_shown: Option<i64>,
    pub ai_decision: Option<String>,
    /// Free-text comment written during the AI-reveal (adjudication) phase.
    /// Stored separately from `notes` so it never overwrites the reader's
    /// original grading notes.
    pub adjudication_notes: Option<String>,
}

const ALLOWED_ICDR: &[i64] = &[0, 1, 2, 3, 4, 6];
const ALLOWED_DME: &[i64] = &[0, 1, 2, 6];

#[tauri::command]
pub async fn submit_case(state: State<'_, AppState>, submission: SubmitPayload) -> Result<()> {
    if !ALLOWED_ICDR.contains(&submission.icdr) {
        return Err(Error::Invalid(format!(
            "icdr {} not in {{R0..R4, R6}}",
            submission.icdr
        )));
    }
    if !ALLOWED_DME.contains(&submission.dme) {
        return Err(Error::Invalid(format!(
            "dme {} not in {{M0..M2, M6}}",
            submission.dme
        )));
    }
    if !(1..=5).contains(&submission.confidence) {
        return Err(Error::Invalid("confidence 1..5".into()));
    }
    if !(1..=3).contains(&submission.difficulty) {
        return Err(Error::Invalid("difficulty 1..3".into()));
    }
    if let Some(d) = submission.ai_decision.as_deref() {
        if !matches!(d, "kept" | "changed" | "no_prediction") {
            return Err(Error::Invalid(format!("bad ai_decision {}", d)));
        }
    }

    state.with(|s| -> Result<()> {
        let results = s.results_db.as_ref().unwrap();
        let mut case = s
            .active_case
            .take()
            .ok_or_else(|| Error::Invalid("no active case".into()))?;
        session::finalize_timings(&mut case);

        let now = chrono::Utc::now().to_rfc3339();
        let is_ai_phase = submission.ai_decision.is_some();

        // Per-(view, stage) timings.
        let macula_pre = session::get_active_ms(&case, "macula", "grading");
        let od_pre = session::get_active_ms(&case, "od", "grading");
        let macula_post = session::get_post_ai_active_ms(&case, "macula");
        let od_post = session::get_post_ai_active_ms(&case, "od");

        // Totals (sum of all stages for this view) — keep populated for back-compat.
        let macula_total = macula_pre + macula_post;
        let od_total = od_pre + od_post;

        // post_ai columns: NULL in no_ai phase (the concept doesn't apply).
        let (macula_post_col, od_post_col): (Option<i64>, Option<i64>) = if is_ai_phase {
            (Some(macula_post), Some(od_post))
        } else {
            (None, None)
        };

        let first_macula = case.view_first_interaction_ms.get("macula").copied();
        let first_od = case.view_first_interaction_ms.get("od").copied();

        let tx = results.unchecked_transaction()?;

        tx.execute(
            "INSERT INTO submissions(
                assignment_id, submitted_at, icdr, dme, notes, confidence, difficulty,
                pre_ai_icdr, pre_ai_dme, ai_icdr_shown, ai_dme_shown, ai_decision,
                active_time_ms_macula, active_time_ms_od,
                active_time_ms_macula_pre_ai, active_time_ms_macula_post_ai,
                active_time_ms_od_pre_ai,     active_time_ms_od_post_ai,
                first_interaction_ms_macula, first_interaction_ms_od,
                first_overlay_toggle_off_ms, adjudication_notes
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
            params![
                case.assignment_id,
                now,
                submission.icdr,
                submission.dme,
                submission.notes,
                submission.confidence,
                submission.difficulty,
                submission.pre_ai_icdr,
                submission.pre_ai_dme,
                submission.ai_icdr_shown,
                submission.ai_dme_shown,
                submission.ai_decision,
                macula_total,
                od_total,
                macula_pre,
                macula_post_col,
                od_pre,
                od_post_col,
                first_macula,
                first_od,
                case.first_overlay_toggle_off_ms,
                submission.adjudication_notes,
            ],
        )?;
        let submission_id: i64 = tx.last_insert_rowid();

        // Flush event buffer.
        {
            let mut stmt = tx.prepare(
                "INSERT INTO events(
                    assignment_id, submission_id, ts_ms_since_case_start, wall_clock_ms,
                    stage, view, event_type, payload_json
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            )?;
            for ev in &case.events {
                stmt.execute(params![
                    case.assignment_id,
                    submission_id,
                    ev.ts_ms_since_case_start,
                    ev.wall_clock_ms,
                    ev.stage,
                    ev.view,
                    ev.event_type,
                    ev.payload_json,
                ])?;
            }
        }

        // Flush mouse sample buffer.
        if !case.mouse_samples.is_empty() {
            let mut stmt = tx.prepare(
                "INSERT INTO mouse_track(
                    assignment_id, submission_id, ts_ms_since_case_start,
                    stage, view, x, y, scale
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            )?;
            for sample in &case.mouse_samples {
                stmt.execute(params![
                    case.assignment_id,
                    submission_id,
                    sample.ts_ms_since_case_start,
                    sample.stage,
                    sample.view,
                    sample.x,
                    sample.y,
                    sample.scale,
                ])?;
            }
        }

        tx.execute(
            "UPDATE assignments SET status='submitted' WHERE id=?1",
            params![case.assignment_id],
        )?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub async fn skip_case(state: State<'_, AppState>) -> Result<()> {
    state.with(|s| -> Result<()> {
        if let Some(case) = s.active_case.take() {
            let results = s.results_db.as_ref().unwrap();
            // Re-queue at the end: keep it pending but push its order_index past
            // every other assignment for the same reader+phase, otherwise
            // next_case (ORDER BY order_index ASC) would just hand back the same
            // case we skipped.
            results.execute(
                "UPDATE assignments
                 SET status='pending',
                     order_index = (
                         SELECT COALESCE(MAX(a2.order_index), 0) + 1
                         FROM assignments a2
                         WHERE a2.reader_id = assignments.reader_id
                           AND a2.phase = assignments.phase
                     )
                 WHERE id=?1",
                params![case.assignment_id],
            )?;
        }
        Ok(())
    })
}

// ---------- Preprocessing ----------

#[tauri::command]
pub async fn preprocess_case_image(
    state: State<'_, AppState>,
    case_id: i64,
    view: String,
) -> std::result::Result<tauri::ipc::Response, String> {
    let raw = state.with(|s| -> std::result::Result<Vec<u8>, String> {
        let project = s
            .project_db
            .as_ref()
            .ok_or_else(|| "no project open".to_string())?;
        crate::project_db::get_image(project, case_id, &view).map_err(|e| e.to_string())
    })?;

    let bytes =
        tauri::async_runtime::spawn_blocking(move || -> std::result::Result<Vec<u8>, String> {
            let img = image::load_from_memory(&raw).map_err(|e| format!("decode: {}", e))?;
            let mut rgb = img.to_rgb8();
            crate::preprocessing::stretch_histogram(&mut rgb, 0.02);
            let mut out = Vec::with_capacity(raw.len());
            {
                let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
                enc.encode_image(&rgb)
                    .map_err(|e| format!("encode: {}", e))?;
            }
            Ok(out)
        })
        .await
        .map_err(|e| format!("thread panic: {}", e))??;

    Ok(tauri::ipc::Response::new(bytes))
}

// ---------- Admin (unchanged) ----------

#[tauri::command]
pub async fn admin_set_password(state: State<'_, AppState>, new_password: String) -> Result<()> {
    if new_password.len() < 6 {
        return Err(Error::Invalid("password too short".into()));
    }
    state.require_project()?;
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(new_password.as_bytes(), &salt)
        .map_err(|e| Error::Internal(e.to_string()))?
        .to_string();
    state.with(|s| -> Result<()> {
        let results = s.results_db.as_ref().unwrap();
        let existing = results_db::admin_get(results, "password_hash")?;
        if existing.is_some() && !s.admin_authed {
            return Err(Error::Unauthorized);
        }
        results_db::admin_set(results, "password_hash", &hash)?;
        s.admin_authed = true;
        Ok(())
    })
}

#[tauri::command]
pub async fn admin_login(state: State<'_, AppState>, password: String) -> Result<()> {
    state.require_project()?;
    state.with(|s| -> Result<()> {
        let results = s.results_db.as_ref().unwrap();
        let stored = results_db::admin_get(results, "password_hash")?
            .ok_or_else(|| Error::Invalid("no admin password set".into()))?;
        let parsed = PasswordHash::new(&stored).map_err(|e| Error::Internal(e.to_string()))?;
        let ok = Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok();
        if !ok {
            return Err(Error::Unauthorized);
        }
        s.admin_authed = true;
        Ok(())
    })
}

#[tauri::command]
pub async fn admin_logout(state: State<'_, AppState>) -> Result<()> {
    state.with(|s| s.admin_authed = false);
    Ok(())
}

#[derive(Serialize)]
pub struct AdminStatus {
    pub authed: bool,
    pub phase: String,
    pub idle_threshold_ms: i64,
}

#[tauri::command]
pub async fn admin_status(state: State<'_, AppState>) -> Result<AdminStatus> {
    state.require_project()?;
    state.with(|s| -> Result<AdminStatus> {
        let results = s.results_db.as_ref().unwrap();
        let phase = results_db::admin_get(results, "phase")?.unwrap_or_else(|| "no_ai".to_string());
        let idle: i64 = results_db::admin_get(results, "idle_threshold_ms")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(15000);
        Ok(AdminStatus {
            authed: s.admin_authed,
            phase,
            idle_threshold_ms: idle,
        })
    })
}

#[tauri::command]
pub async fn admin_set_phase(state: State<'_, AppState>, phase: String) -> Result<()> {
    state.require_admin()?;
    if phase != "no_ai" && phase != "ai" {
        return Err(Error::Invalid("phase must be no_ai or ai".into()));
    }
    state.with(|s| -> Result<()> {
        let results = s.results_db.as_ref().unwrap();
        results_db::admin_set(results, "phase", &phase)
    })
}

#[derive(Serialize)]
pub struct SubmissionRow {
    pub id: i64,
    pub assignment_id: i64,
    pub case_id: i64,
    pub reader_name: String,
    pub reader_surname: String,
    pub phase: String,
    pub submitted_at: String,
    pub icdr: i64,
    pub dme: i64,
    pub ai_decision: Option<String>,
    pub reverted: bool,
}

#[tauri::command]
pub async fn admin_list_submissions(state: State<'_, AppState>) -> Result<Vec<SubmissionRow>> {
    state.require_admin()?;
    state.with(|s| -> Result<Vec<SubmissionRow>> {
        let results = s.results_db.as_ref().unwrap();
        let mut stmt = results.prepare(
            "SELECT sub.id, a.id, a.case_id, r.name, r.surname, a.phase,
                    sub.submitted_at, sub.icdr, sub.dme, sub.ai_decision,
                    CASE WHEN a.status='reverted' THEN 1 ELSE 0 END
             FROM submissions sub
             JOIN assignments a ON a.id = sub.assignment_id
             JOIN readers r ON r.id = a.reader_id
             ORDER BY sub.submitted_at DESC LIMIT 500",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SubmissionRow {
                id: r.get(0)?,
                assignment_id: r.get(1)?,
                case_id: r.get(2)?,
                reader_name: r.get(3)?,
                reader_surname: r.get(4)?,
                phase: r.get(5)?,
                submitted_at: r.get(6)?,
                icdr: r.get(7)?,
                dme: r.get(8)?,
                ai_decision: r.get(9)?,
                reverted: r.get::<_, i64>(10)? != 0,
            })
        })?;
        let mut v = Vec::new();
        for row in rows {
            v.push(row?);
        }
        Ok(v)
    })
}

#[tauri::command]
pub async fn admin_revert_submission(
    state: State<'_, AppState>,
    submission_id: i64,
    reason: String,
) -> Result<()> {
    state.require_admin()?;
    if reason.trim().is_empty() {
        return Err(Error::Invalid("reason required".into()));
    }
    state.with(|s| -> Result<()> {
        let results = s.results_db.as_ref().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let assignment_id: i64 = results
            .query_row(
                "SELECT assignment_id FROM submissions WHERE id=?1",
                params![submission_id],
                |r| r.get(0),
            )
            .map_err(|_| Error::NotFound(format!("submission {}", submission_id)))?;
        let tx = results.unchecked_transaction()?;
        tx.execute(
            "UPDATE submissions SET reverted_at=?1, revert_reason=?2 WHERE id=?3",
            params![now, reason, submission_id],
        )?;
        tx.execute(
            "UPDATE assignments SET status='reverted' WHERE id=?1",
            params![assignment_id],
        )?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub async fn admin_export_results(state: State<'_, AppState>, dest_path: String) -> Result<String> {
    state.require_admin()?;
    state.require_project()?;
    let src = state.with(|s| -> Result<PathBuf> {
        let path = s.project_path.as_ref().ok_or(Error::NoProject)?;
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("results");
        let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
        Ok(parent.join(format!("{}.results.sqlite", stem)))
    })?;
    std::fs::copy(&src, &dest_path)?;
    Ok(dest_path)
}
