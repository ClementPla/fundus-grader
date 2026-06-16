# Fundus Grader

Desktop tool for the AI-assisted-vs-unassisted fundus reading study. Tauri 2 + Angular 19, Rust backend with SQLite.

## What it does

- Reader logs in (name + surname).
- Reads cases in a per-reader, stratified random order; macula then optionally OD per case.
- Records ICDR + DME grade, free-text notes, confidence (1–5), perceived difficulty (1–3), and (AI phase only) an "AI influence" flag.
- Logs every interaction (zoom, pan, view switch, overlay toggle, preprocessing toggle, idle start/end, grade changes) with timestamps relative to case start.
- Supports session resume across days. Mid-case interruptions re-queue the case.
- Administrator pane: phase switch (no_ai ↔ ai), revert submissions, export the results SQLite.

The admin pane is password-protected (Argon2id) per project.

## Build

Requires Rust toolchain + Node 18+ + Tauri 2 system dependencies.

```bash
npm install
npm run dev      # development with hot reload
npm run build    # production binary
```

## Files

The app needs a **project SQLite** (read-only input). It creates a **results SQLite** as a sidecar next to the project file (`<project_stem>.results.sqlite`).

You will be prompted to pick the project file on first launch; the path is remembered.

### Project SQLite schema (input — you produce this)

```sql
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Required keys:
--   seed                       integer string, master RNG seed for assignment generator
-- Optional keys (defaults shown):
--   od_enabled                 '1' (set to '0' to grade macula only)
--   preprocessing_available    '1'
--   overlay_style              JSON: { "<class_id>": { fill, stroke, opacity, edge_only, pulsate, visible_by_default } }

CREATE TABLE cases (
    id              INTEGER PRIMARY KEY,
    has_od          INTEGER NOT NULL,   -- 0/1
    is_calibration  INTEGER NOT NULL DEFAULT 0,
    ref_icdr        INTEGER NOT NULL,
    ref_dme         INTEGER NOT NULL
);

CREATE TABLE images (
    case_id  INTEGER NOT NULL,
    view     TEXT NOT NULL CHECK(view IN ('macula','od')),
    png      BLOB NOT NULL,
    PRIMARY KEY (case_id, view)
);

CREATE TABLE classes (
    class_id            INTEGER PRIMARY KEY,
    name                TEXT NOT NULL,
    default_style_json  TEXT NOT NULL  -- JSON: { fill, stroke, opacity, edge_only, pulsate, visible_by_default }
);

CREATE TABLE masks (
    case_id   INTEGER NOT NULL,
    view      TEXT NOT NULL,
    class_id  INTEGER NOT NULL,
    png       BLOB NOT NULL,
    PRIMARY KEY (case_id, view, class_id)
);
```

Masks are single-channel (or grayscale) PNGs with the same dimensions as the corresponding image. Any nonzero pixel is interpreted as "mask present" via the alpha channel after the browser decodes it (transparent PNGs work directly; if you produce grayscale, ensure transparent for background).

Images and masks are streamed to the frontend over a custom URI scheme (`fundus://image/<case>/<view>/<raw|preprocessed>`, `fundus://mask/<case>/<view>/<class_id>`). The frontend never receives base64.

### Overlay style JSON

Per class, used by both the renderer and exported with each submission's event log:

```json
{
  "fill": "#ff6b3d",
  "stroke": "#ff6b3d",
  "opacity": 0.5,
  "edge_only": false,
  "pulsate": false,
  "visible_by_default": true
}
```

`edge_only` extracts a 1-pixel boundary of each mask (binary erosion via canvas composite). Useful when you want to highlight structures without obscuring them.

### Results SQLite (created automatically)

`readers`, `assignments`, `submissions`, `events`, `admin_config`. See `src-tauri/src/results_db.rs` for the canonical schema. The interesting bits:

- `assignments` is generated once per (reader, phase) when that reader first opens a session. The order is stratified by `(ref_icdr, ref_dme)`, round-robin interleaved across strata, with calibration cases prepended.
- `submissions` carries the timing summaries (active time per view, first-interaction time per view, first overlay-toggle-off time).
- `events` is the full interaction trail. Every event has `ts_ms_since_case_start` and `wall_clock_ms`. The latter lets you reconstruct fatigue covariates across sessions.

## Active time and idle handling

Active time per view is computed in the Rust backend from events. The rules:

- A view is "active" from `view_shown` until either: another view becomes active, an `idle_start` fires, or the case is submitted.
- An `idle_start` fires after `idle_threshold_ms` (default 15 s) of no user interaction, or immediately when the window/tab goes hidden.
- An `idle_end` fires on the next interaction.
- Active intervals are summed per view and stored on the submission.
