use crate::error::{Error, Result};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

pub struct Inner {
    pub project_path: Option<PathBuf>,
    pub project_db: Option<Connection>,
    pub results_db: Option<Connection>,
    pub reader_id: Option<i64>,
    pub session_id: Option<i64>,
    pub admin_authed: bool,
    pub active_case: Option<ActiveCase>,
}

pub struct ActiveCase {
    pub assignment_id: i64,
    pub case_id: i64,
    pub started_at: Instant,

    /// Currently displayed view ("macula" or "od"). Updated on view_switch events.
    pub current_view: String,
    /// Current stage in the grading flow ('grading' | 'ai_reveal' | 'editing_after_ai').
    /// Updated on stage_change events. Defaults to "grading".
    pub current_stage: String,
    /// Timestamp when the active (view, stage) bucket started accumulating.
    /// Reset on view or stage changes, and at finalize.
    pub bucket_start: Instant,

    /// Active-image time, keyed by (view, stage). Flushed on transitions and at submit.
    pub view_active_ms: HashMap<(String, String), i64>,
    /// First time the user interacted with each view (ms since case start).
    pub view_first_interaction_ms: HashMap<String, i64>,
    /// First time any overlay class was toggled off (ms since case start).
    pub first_overlay_toggle_off_ms: Option<i64>,

    pub events: Vec<Event>,
    pub mouse_samples: Vec<MouseSample>,
}

pub struct Event {
    pub ts_ms_since_case_start: i64,
    pub wall_clock_ms: i64,
    /// Stage active at the moment this event was logged. None if the event
    /// pre-dated stage tracking (won't happen for new events).
    pub stage: Option<String>,
    pub view: Option<String>,
    pub event_type: String,
    pub payload_json: String,
}

pub struct MouseSample {
    pub ts_ms_since_case_start: i64,
    pub stage: Option<String>,
    pub view: String,
    pub x: i64,
    pub y: i64,
    pub scale: f64,
}

pub struct AppState {
    inner: Mutex<Inner>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                project_path: None,
                project_db: None,
                results_db: None,
                reader_id: None,
                session_id: None,
                admin_authed: false,
                active_case: None,
            }),
        }
    }

    pub fn with<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut Inner) -> R,
    {
        let mut guard = self.inner.lock();
        f(&mut *guard)
    }

    pub fn require_project(&self) -> Result<()> {
        let guard = self.inner.lock();
        if guard.project_db.is_none() {
            return Err(Error::NoProject);
        }
        Ok(())
    }

    pub fn require_reader(&self) -> Result<i64> {
        let guard = self.inner.lock();
        guard
            .reader_id
            .ok_or_else(|| Error::Invalid("no reader logged in".into()))
    }

    pub fn require_admin(&self) -> Result<()> {
        let guard = self.inner.lock();
        if !guard.admin_authed {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
