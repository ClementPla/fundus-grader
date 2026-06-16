use crate::error::Result;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;

        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS readers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            surname TEXT NOT NULL,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            UNIQUE(name, surname)
        );

        CREATE TABLE IF NOT EXISTS assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reader_id INTEGER NOT NULL REFERENCES readers(id),
            case_id INTEGER NOT NULL,
            phase TEXT NOT NULL CHECK(phase IN ('no_ai','ai')),
            order_index INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','in_progress','submitted','reverted')),
            UNIQUE(reader_id, case_id, phase)
        );

        CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assignment_id INTEGER NOT NULL UNIQUE REFERENCES assignments(id),
            submitted_at TEXT NOT NULL,
            icdr INTEGER NOT NULL,
            dme INTEGER NOT NULL,
            notes TEXT,
            confidence INTEGER NOT NULL,
            difficulty INTEGER NOT NULL,
            ai_influenced TEXT,                          -- legacy
            pre_ai_icdr INTEGER,
            pre_ai_dme INTEGER,
            ai_icdr_shown INTEGER,
            ai_dme_shown INTEGER,
            ai_decision TEXT,
            active_time_ms_macula INTEGER,
            active_time_ms_od INTEGER,
            active_time_ms_macula_pre_ai  INTEGER,
            active_time_ms_macula_post_ai INTEGER,
            active_time_ms_od_pre_ai      INTEGER,
            active_time_ms_od_post_ai     INTEGER,
            first_interaction_ms_macula INTEGER,
            first_interaction_ms_od INTEGER,
            first_overlay_toggle_off_ms INTEGER,
            reverted_at TEXT,
            revert_reason TEXT
        );

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assignment_id INTEGER NOT NULL REFERENCES assignments(id),
            submission_id INTEGER REFERENCES submissions(id),
            ts_ms_since_case_start INTEGER NOT NULL,
            wall_clock_ms INTEGER NOT NULL,
            stage TEXT,
            view TEXT,
            event_type TEXT NOT NULL,
            payload_json TEXT
        );

        CREATE TABLE IF NOT EXISTS mouse_track (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assignment_id INTEGER NOT NULL REFERENCES assignments(id),
            submission_id INTEGER REFERENCES submissions(id),
            ts_ms_since_case_start INTEGER NOT NULL,
            stage TEXT,
            view TEXT NOT NULL,
            x INTEGER NOT NULL,
            y INTEGER NOT NULL,
            scale REAL
        );

        CREATE TABLE IF NOT EXISTS admin_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_assignments_reader_phase
            ON assignments(reader_id, phase, order_index);
        CREATE INDEX IF NOT EXISTS idx_events_assignment
            ON events(assignment_id);
        CREATE INDEX IF NOT EXISTS idx_mouse_track_assignment
            ON mouse_track(assignment_id);
        "#,
    )?;

    // -- Idempotent column-add migrations for older DBs --

    // submissions: AI-reveal columns (added in earlier patch).
    if !column_exists(&conn, "submissions", "ai_decision")? {
        conn.execute_batch(
            r#"
            ALTER TABLE submissions ADD COLUMN pre_ai_icdr   INTEGER;
            ALTER TABLE submissions ADD COLUMN pre_ai_dme    INTEGER;
            ALTER TABLE submissions ADD COLUMN ai_icdr_shown INTEGER;
            ALTER TABLE submissions ADD COLUMN ai_dme_shown  INTEGER;
            ALTER TABLE submissions ADD COLUMN ai_decision   TEXT;
            "#,
        )?;
    }

    // submissions: per-(view, stage) active timings.
    if !column_exists(&conn, "submissions", "active_time_ms_macula_pre_ai")? {
        conn.execute_batch(
            r#"
            ALTER TABLE submissions ADD COLUMN active_time_ms_macula_pre_ai  INTEGER;
            ALTER TABLE submissions ADD COLUMN active_time_ms_macula_post_ai INTEGER;
            ALTER TABLE submissions ADD COLUMN active_time_ms_od_pre_ai      INTEGER;
            ALTER TABLE submissions ADD COLUMN active_time_ms_od_post_ai     INTEGER;
            "#,
        )?;
    }

    // events: stage column.
    if !column_exists(&conn, "events", "stage")? {
        conn.execute("ALTER TABLE events ADD COLUMN stage TEXT", [])?;
    }

    // Seed defaults for fresh DBs.
    let phase: Option<String> = conn
        .query_row(
            "SELECT value FROM admin_config WHERE key='phase'",
            [],
            |r| r.get(0),
        )
        .ok();
    if phase.is_none() {
        conn.execute(
            "INSERT INTO admin_config(key,value) VALUES('phase','no_ai')",
            [],
        )?;
    }
    let idle: Option<String> = conn
        .query_row(
            "SELECT value FROM admin_config WHERE key='idle_threshold_ms'",
            [],
            |r| r.get(0),
        )
        .ok();
    if idle.is_none() {
        conn.execute(
            "INSERT INTO admin_config(key,value) VALUES('idle_threshold_ms','15000')",
            [],
        )?;
    }

    Ok(conn)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name=?2",
        params![table, column],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub fn admin_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM admin_config WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn admin_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO admin_config(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct Reader {
    pub id: i64,
    pub name: String,
    pub surname: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

pub fn upsert_reader(conn: &Connection, name: &str, surname: &str) -> Result<Reader> {
    let now = chrono::Utc::now().to_rfc3339();
    let _ = conn.execute(
        "INSERT INTO readers(name,surname,first_seen_at,last_seen_at)
         VALUES(?1,?2,?3,?3) ON CONFLICT(name,surname) DO UPDATE SET last_seen_at=excluded.last_seen_at",
        params![name, surname, now],
    )?;
    let mut stmt = conn.prepare(
        "SELECT id,name,surname,first_seen_at,last_seen_at FROM readers WHERE name=?1 AND surname=?2",
    )?;
    let r = stmt.query_row(params![name, surname], |r| {
        Ok(Reader {
            id: r.get(0)?,
            name: r.get(1)?,
            surname: r.get(2)?,
            first_seen_at: r.get(3)?,
            last_seen_at: r.get(4)?,
        })
    })?;
    Ok(r)
}

pub fn list_readers(conn: &Connection) -> Result<Vec<Reader>> {
    let mut stmt = conn.prepare(
        "SELECT id,name,surname,first_seen_at,last_seen_at FROM readers ORDER BY surname, name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Reader {
            id: r.get(0)?,
            name: r.get(1)?,
            surname: r.get(2)?,
            first_seen_at: r.get(3)?,
            last_seen_at: r.get(4)?,
        })
    })?;
    let mut v = Vec::new();
    for row in rows {
        v.push(row?);
    }
    Ok(v)
}
