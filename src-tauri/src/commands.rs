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

        // Pull the fields we want to preserve in the audit archive.
        type Row = (
            i64,            // assignment_id
            Option<i64>,    // reader_id
            Option<i64>,    // case_id
            Option<String>, // phase
            Option<String>, // submitted_at
            Option<i64>,    // icdr
            Option<i64>,    // dme
            Option<String>, // notes
            Option<i64>,    // confidence
            Option<i64>,    // difficulty
            Option<String>, // ai_decision
            Option<String>, // adjudication_notes
        );
        let row: Row = results
            .query_row(
                "SELECT a.id, a.reader_id, a.case_id, a.phase, sub.submitted_at,
                        sub.icdr, sub.dme, sub.notes, sub.confidence, sub.difficulty,
                        sub.ai_decision, sub.adjudication_notes
                 FROM submissions sub
                 JOIN assignments a ON a.id = sub.assignment_id
                 WHERE sub.id = ?1",
                params![submission_id],
                |r| {
                    Ok((
                        r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                        r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?,
                        r.get(10)?, r.get(11)?,
                    ))
                },
            )
            .map_err(|_| Error::NotFound(format!("submission {}", submission_id)))?;
        let assignment_id = row.0;

        let tx = results.unchecked_transaction()?;
        // 1. Archive the original grade for audit.
        tx.execute(
            "INSERT INTO revert_log(
                submission_id, assignment_id, reader_id, case_id, phase,
                submitted_at, icdr, dme, notes, confidence, difficulty,
                ai_decision, adjudication_notes, reverted_at, revert_reason)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                submission_id, assignment_id, row.1, row.2, row.3, row.4, row.5,
                row.6, row.7, row.8, row.9, row.10, row.11, now, reason,
            ],
        )?;
        // 2. Unlink the attempt's telemetry from the submission being removed
        //    (FKs are ON; keep the rows, tied to the assignment, for analysis).
        tx.execute(
            "UPDATE events SET submission_id=NULL WHERE submission_id=?1",
            params![submission_id],
        )?;
        tx.execute(
            "UPDATE mouse_track SET submission_id=NULL WHERE submission_id=?1",
            params![submission_id],
        )?;
        // 3. Remove the submission (frees UNIQUE(assignment_id) for a re-grade).
        tx.execute("DELETE FROM submissions WHERE id=?1", params![submission_id])?;
        // 4. Re-open the case so next_case serves it to the reader again.
        tx.execute(
            "UPDATE assignments SET status='pending' WHERE id=?1",
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
    // The DB runs in WAL mode, so recent writes may live only in the `-wal`
    // sidecar. Fold them into the main file first, otherwise the plain file copy
    // below would silently export a stale snapshot (missing the latest cases).
    state.with(|s| -> Result<()> {
        if let Some(db) = s.results_db.as_ref() {
            db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        }
        Ok(())
    })?;
    std::fs::copy(&src, &dest_path)?;
    Ok(dest_path)
}

// ---------- Per-reader statistics ----------

#[derive(Serialize)]
pub struct ReaderInfo {
    pub id: i64,
    pub name: String,
    pub surname: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

/// One row per assignment for the selected reader, joined with its submission
/// (if any), the reference grades from the project, and event/mouse aggregates.
/// All heavy stats are computed on the frontend from these rows so the admin can
/// re-slice them instantly with filters.
#[derive(Serialize, Default)]
pub struct CaseRecord {
    pub assignment_id: i64,
    pub case_id: i64,
    pub phase: String,
    pub status: String,
    pub is_calibration: bool,
    pub ref_icdr: Option<i64>,
    pub ref_dme: Option<i64>,
    pub case_ai_icdr: Option<i64>,
    pub case_ai_dme: Option<i64>,
    pub submitted_at: Option<String>,
    pub icdr: Option<i64>,
    pub dme: Option<i64>,
    pub confidence: Option<i64>,
    pub difficulty: Option<i64>,
    pub pre_ai_icdr: Option<i64>,
    pub pre_ai_dme: Option<i64>,
    pub ai_icdr_shown: Option<i64>,
    pub ai_dme_shown: Option<i64>,
    pub ai_decision: Option<String>,
    pub has_notes: bool,
    pub has_adjudication_notes: bool,
    pub active_ms_macula: Option<i64>,
    pub active_ms_od: Option<i64>,
    pub active_ms_macula_pre_ai: Option<i64>,
    pub active_ms_macula_post_ai: Option<i64>,
    pub active_ms_od_pre_ai: Option<i64>,
    pub active_ms_od_post_ai: Option<i64>,
    pub first_interaction_ms_macula: Option<i64>,
    pub first_interaction_ms_od: Option<i64>,
    pub first_overlay_toggle_off_ms: Option<i64>,
    pub n_macula_corrections: i64,
    pub macula_correction_dist_px: Option<f64>,
    pub n_zoom: i64,
    pub n_pan: i64,
    pub n_overlay_toggle: i64,
    pub n_preprocess_toggle: i64,
    pub n_view_switch: i64,
    pub n_idle: i64,
    pub n_mouse_samples: i64,
}

#[derive(Serialize)]
pub struct ReaderStats {
    pub reader: ReaderInfo,
    pub cases: Vec<CaseRecord>,
    pub revert_count: i64,
}

#[tauri::command]
pub async fn admin_reader_stats(state: State<'_, AppState>, reader_id: i64) -> Result<ReaderStats> {
    state.require_admin()?;
    state.require_project()?;
    state.with(|s| -> Result<ReaderStats> {
        let results = s.results_db.as_ref().unwrap();
        let project = s.project_db.as_ref().unwrap();

        // Reader.
        let reader = results
            .query_row(
                "SELECT id, name, surname, first_seen_at, last_seen_at FROM readers WHERE id=?1",
                params![reader_id],
                |r| {
                    Ok(ReaderInfo {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        surname: r.get(2)?,
                        first_seen_at: r.get(3)?,
                        last_seen_at: r.get(4)?,
                    })
                },
            )
            .map_err(|_| Error::NotFound(format!("reader {}", reader_id)))?;

        // Reference grades + calibration + AI, keyed by case id.
        let case_refs = project_db::list_cases(project)?;
        let ref_map: std::collections::HashMap<i64, project_db::CaseRef> =
            case_refs.into_iter().map(|c| (c.id, c)).collect();

        // Base records: assignments LEFT JOIN submissions.
        let mut stmt = results.prepare(
            "SELECT a.id, a.case_id, a.phase, a.status,
                    sub.submitted_at, sub.icdr, sub.dme, sub.confidence, sub.difficulty,
                    sub.pre_ai_icdr, sub.pre_ai_dme, sub.ai_icdr_shown, sub.ai_dme_shown,
                    sub.ai_decision, sub.notes, sub.adjudication_notes,
                    sub.active_time_ms_macula, sub.active_time_ms_od,
                    sub.active_time_ms_macula_pre_ai, sub.active_time_ms_macula_post_ai,
                    sub.active_time_ms_od_pre_ai, sub.active_time_ms_od_post_ai,
                    sub.first_interaction_ms_macula, sub.first_interaction_ms_od,
                    sub.first_overlay_toggle_off_ms
             FROM assignments a
             LEFT JOIN submissions sub ON sub.assignment_id = a.id
             WHERE a.reader_id = ?1
             ORDER BY (sub.submitted_at IS NULL), sub.submitted_at, a.order_index",
        )?;
        let mut cases: Vec<CaseRecord> = Vec::new();
        let rows = stmt.query_map(params![reader_id], |r| {
            let case_id: i64 = r.get(1)?;
            let cref = ref_map.get(&case_id);
            let notes: Option<String> = r.get(14)?;
            let adj: Option<String> = r.get(15)?;
            Ok(CaseRecord {
                assignment_id: r.get(0)?,
                case_id,
                phase: r.get(2)?,
                status: r.get(3)?,
                is_calibration: cref.map(|c| c.is_calibration).unwrap_or(false),
                ref_icdr: cref.map(|c| c.ref_icdr),
                ref_dme: cref.map(|c| c.ref_dme),
                case_ai_icdr: cref.and_then(|c| c.ai_icdr),
                case_ai_dme: cref.and_then(|c| c.ai_dme),
                submitted_at: r.get(4)?,
                icdr: r.get(5)?,
                dme: r.get(6)?,
                confidence: r.get(7)?,
                difficulty: r.get(8)?,
                pre_ai_icdr: r.get(9)?,
                pre_ai_dme: r.get(10)?,
                ai_icdr_shown: r.get(11)?,
                ai_dme_shown: r.get(12)?,
                ai_decision: r.get(13)?,
                has_notes: notes.map(|n| !n.trim().is_empty()).unwrap_or(false),
                has_adjudication_notes: adj.map(|n| !n.trim().is_empty()).unwrap_or(false),
                active_ms_macula: r.get(16)?,
                active_ms_od: r.get(17)?,
                active_ms_macula_pre_ai: r.get(18)?,
                active_ms_macula_post_ai: r.get(19)?,
                active_ms_od_pre_ai: r.get(20)?,
                active_ms_od_post_ai: r.get(21)?,
                first_interaction_ms_macula: r.get(22)?,
                first_interaction_ms_od: r.get(23)?,
                first_overlay_toggle_off_ms: r.get(24)?,
                ..Default::default()
            })
        })?;
        for row in rows {
            cases.push(row?);
        }

        // Index records by assignment for cheap merging of aggregates.
        let mut idx: std::collections::HashMap<i64, usize> = std::collections::HashMap::new();
        for (i, c) in cases.iter().enumerate() {
            idx.insert(c.assignment_id, i);
        }

        // Event counts per (assignment, event_type).
        let mut estmt = results.prepare(
            "SELECT e.assignment_id, e.event_type, COUNT(*)
             FROM events e
             WHERE e.assignment_id IN (SELECT id FROM assignments WHERE reader_id = ?1)
             GROUP BY e.assignment_id, e.event_type",
        )?;
        let erows = estmt.query_map(params![reader_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        })?;
        for row in erows {
            let (aid, etype, n) = row?;
            if let Some(&i) = idx.get(&aid) {
                let c = &mut cases[i];
                match etype.as_str() {
                    "zoom" => c.n_zoom += n,
                    "pan" => c.n_pan += n,
                    "overlay_toggle" | "overlay_tab_toggle" => c.n_overlay_toggle += n,
                    "preprocess_toggle" => c.n_preprocess_toggle += n,
                    "view_switch" => c.n_view_switch += n,
                    "idle_start" => c.n_idle += n,
                    "macula_corrected" => c.n_macula_corrections += n,
                    _ => {}
                }
            }
        }

        // Macula-correction distances (mean per assignment).
        let mut cstmt = results.prepare(
            "SELECT assignment_id, payload_json FROM events
             WHERE event_type = 'macula_corrected'
               AND assignment_id IN (SELECT id FROM assignments WHERE reader_id = ?1)",
        )?;
        let crows = cstmt.query_map(params![reader_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))
        })?;
        let mut dist_acc: std::collections::HashMap<i64, (f64, i64)> =
            std::collections::HashMap::new();
        for row in crows {
            let (aid, payload) = row?;
            if let Some(p) = payload {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&p) {
                    let fx = v.pointer("/from/x").and_then(|x| x.as_f64());
                    let fy = v.pointer("/from/y").and_then(|x| x.as_f64());
                    let tx = v.pointer("/to/x").and_then(|x| x.as_f64());
                    let ty = v.pointer("/to/y").and_then(|x| x.as_f64());
                    if let (Some(fx), Some(fy), Some(tx), Some(ty)) = (fx, fy, tx, ty) {
                        let d = ((tx - fx).powi(2) + (ty - fy).powi(2)).sqrt();
                        let e = dist_acc.entry(aid).or_insert((0.0, 0));
                        e.0 += d;
                        e.1 += 1;
                    }
                }
            }
        }
        for (aid, (sum, n)) in dist_acc {
            if let Some(&i) = idx.get(&aid) {
                if n > 0 {
                    cases[i].macula_correction_dist_px = Some(sum / n as f64);
                }
            }
        }

        // Mouse-sample counts per assignment.
        let mut mstmt = results.prepare(
            "SELECT assignment_id, COUNT(*) FROM mouse_track
             WHERE assignment_id IN (SELECT id FROM assignments WHERE reader_id = ?1)
             GROUP BY assignment_id",
        )?;
        let mrows = mstmt.query_map(params![reader_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in mrows {
            let (aid, n) = row?;
            if let Some(&i) = idx.get(&aid) {
                cases[i].n_mouse_samples = n;
            }
        }

        let revert_count: i64 = results
            .query_row(
                "SELECT COUNT(*) FROM revert_log WHERE reader_id = ?1",
                params![reader_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        Ok(ReaderStats {
            reader,
            cases,
            revert_count,
        })
    })
}
