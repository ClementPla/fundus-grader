use crate::error::{Error, Result};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;

/// State of the case currently on screen. Reset on each new case.
#[derive(Default, Debug)]
pub struct ActiveCase {
    pub assignment_id: i64,
    pub case_id: i64,
    pub started_at_ms: i64, // wall clock at first render
    pub current_view: Option<String>,
    pub view_first_shown_ms: HashMap<String, i64>, // view -> first time shown (relative to case start)
    pub view_first_interaction_ms: HashMap<String, i64>,
    pub view_active_ms: HashMap<String, i64>, // accumulated active ms
    pub view_last_resume_ms: HashMap<String, Option<i64>>, // ms since case start when current active interval started, None if paused
    pub first_overlay_toggle_off_ms: Option<i64>,
    pub events: Vec<PendingEvent>,
}

#[derive(Debug, Clone)]
pub struct PendingEvent {
    pub ts_ms_since_case_start: i64,
    pub wall_clock_ms: i64,
    pub view: Option<String>,
    pub event_type: String,
    pub payload_json: String,
}

pub struct AppState {
    inner: Mutex<Inner>,
}

pub struct Inner {
    pub project_path: Option<PathBuf>,
    pub project_db: Option<Connection>,
    pub results_db: Option<Connection>,
    pub reader_id: Option<i64>,
    pub session_id: Option<i64>,
    pub admin_authed: bool,
    pub active_case: Option<ActiveCase>,
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

    pub fn with<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> R {
        let mut g = self.inner.lock();
        f(&mut g)
    }

    pub fn require_project(&self) -> Result<()> {
        self.with(|s| {
            if s.project_db.is_some() && s.results_db.is_some() {
                Ok(())
            } else {
                Err(Error::NoProject)
            }
        })
    }

    pub fn require_reader(&self) -> Result<i64> {
        self.with(|s| s.reader_id.ok_or(Error::NoReader))
    }

    pub fn require_admin(&self) -> Result<()> {
        self.with(|s| if s.admin_authed { Ok(()) } else { Err(Error::Unauthorized) })
    }
}
