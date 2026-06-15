#!/usr/bin/env python3
"""Build a FundusGrader project SQLite from the IDRiD-Seg dataset, with vector
contours and (optional) AI predictions for the assisted phase.

Adds two nullable columns to the `cases` table: `ai_icdr` and `ai_dme`.
Populate them via either:
  (a) AI_PREDICTIONS_CSV — a CSV with header `case_id,ai_icdr,ai_dme`
  (b) AI_PREDICTIONS — a hardcoded dict for testing

If neither is provided, both columns are left NULL. The app then shows the
"no AI prediction available" branch of the AI-reveal flow for those cases.

Expected IDRiD layout under IDRID_BASE — see populate_idrid_OLD.py for details.
"""

from __future__ import annotations

import csv
import io
import json
import re
import sqlite3
import sys
from pathlib import Path

import cv2
from PIL import Image

# --- CONFIG --------------------------------------------------------------

IDRID_BASE = Path(
    r"C:\Users\cleme\OneDrive\PostDoc\data\idrid\A. Segmentation\A. Segmentation"
)
PROJECT_DB_PATH = Path("idrid_project.sqlite")

INCLUDE_TRAINING = False
INCLUDE_TESTING = True

SIMPLIFY_EPSILON = 1.5
MIN_CONTOUR_AREA = 4.0

CLASSES: dict[int, tuple[str, str, str, dict]] = {
    1: ("1. Microaneurysms", "MA", "Microaneurysms", {
        "fill": "#ff3b3b", "fill_opacity": 0.30,
        "stroke": "#ff3b3b", "stroke_width": 1.5, "stroke_opacity": 1.0,
        "visible_by_default": True,
    }),
    2: ("2. Haemorrhages", "HE", "Haemorrhages", {
        "fill": "#b042ff", "fill_opacity": 0.25,
        "stroke": "#b042ff", "stroke_width": 1.5, "stroke_opacity": 1.0,
        "visible_by_default": True,
    }),
    3: ("3. Hard Exudates", "EX", "Hard Exudates", {
        "fill": "#ffd23d", "fill_opacity": 0.30,
        "stroke": "#ffd23d", "stroke_width": 1.5, "stroke_opacity": 1.0,
        "visible_by_default": True,
    }),
    4: ("4. Soft Exudates", "SE", "Soft Exudates", {
        "fill": "#3dc6ff", "fill_opacity": 0.30,
        "stroke": "#3dc6ff", "stroke_width": 1.5, "stroke_opacity": 1.0,
        "visible_by_default": True,
    }),
    5: ("5. Optic Disc", "OD", "Optic Disc", {
        "fill": "none",
        "stroke": "#3dff8b", "stroke_width": 2.5, "stroke_opacity": 1.0,
        "stroke_dasharray": "6 4",
        "visible_by_default": True,
    }),
}

CALIBRATION_CASE_IDS: set[int] = {1}
REF_GRADES: dict[int, tuple[int, int]] = {}

# AI predictions per case. Format: { case_id: (ai_icdr, ai_dme) }.
# Cases not in this dict get NULL AI predictions (UI shows "no AI" branch).
# For real studies, load from your model's output CSV via AI_PREDICTIONS_CSV.
AI_PREDICTIONS: dict[int, tuple[int, int]] = {}

# Optional: path to a CSV with header `case_id,ai_icdr,ai_dme`. Overrides
# the dict above with anything it contains (additive — won't clear the dict).
AI_PREDICTIONS_CSV: Path | None = None

MASTER_SEED = 42
OD_ENABLED = False
PREPROCESSING_AVAILABLE = True

# --- IMPL ----------------------------------------------------------------

CASE_ID_RE = re.compile(r"IDRiD_(?P<id>\d+)")

SCHEMA = """
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE cases (
    id             INTEGER PRIMARY KEY,
    has_od         INTEGER NOT NULL,
    is_calibration INTEGER NOT NULL DEFAULT 0,
    ref_icdr       INTEGER NOT NULL,
    ref_dme        INTEGER NOT NULL,
    ai_icdr        INTEGER,
    ai_dme         INTEGER
);
CREATE TABLE images (
    case_id INTEGER NOT NULL,
    view    TEXT NOT NULL CHECK(view IN ('macula','od')),
    png     BLOB NOT NULL,
    width   INTEGER NOT NULL,
    height  INTEGER NOT NULL,
    PRIMARY KEY (case_id, view)
);
CREATE TABLE classes (
    class_id           INTEGER PRIMARY KEY,
    name               TEXT NOT NULL,
    default_style_json TEXT NOT NULL
);
CREATE TABLE masks (
    case_id        INTEGER NOT NULL,
    view           TEXT NOT NULL CHECK(view IN ('macula','od')),
    class_id       INTEGER NOT NULL,
    contours_json  TEXT NOT NULL,
    PRIMARY KEY (case_id, view, class_id)
);
"""


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def load_image_png(path: Path) -> tuple[bytes, int, int]:
    img = Image.open(path).convert("RGB")
    return png_bytes(img), img.width, img.height


def extract_contours_json(mask_path: Path) -> str | None:
    gray = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        return None
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polys: list[list[list[int]]] = []
    for c in contours:
        if len(c) < 3:
            continue
        if cv2.contourArea(c) < MIN_CONTOUR_AREA:
            continue
        s = cv2.approxPolyDP(c, SIMPLIFY_EPSILON, True) if SIMPLIFY_EPSILON > 0 else c
        if len(s) < 3:
            continue
        polys.append([[int(p[0][0]), int(p[0][1])] for p in s])
    return json.dumps(polys, separators=(",", ":")) if polys else None


def parse_case_id(name: str) -> int | None:
    m = CASE_ID_RE.search(name)
    return int(m.group("id")) if m else None


def discover_split(images_dir: Path, gt_dir: Path):
    if not images_dir.exists():
        print(f"!! missing images dir: {images_dir}")
        return
    for img_path in sorted(images_dir.glob("IDRiD_*.jpg")):
        cid = parse_case_id(img_path.name)
        if cid is None:
            continue
        masks: dict[int, Path] = {}
        for class_id, (subfolder, suffix, _name, _style) in CLASSES.items():
            mp = gt_dir / subfolder / f"IDRiD_{cid:02d}_{suffix}.tif"
            if mp.exists():
                masks[class_id] = mp
        yield cid, img_path, masks


def load_ai_predictions() -> dict[int, tuple[int, int]]:
    """Merge AI_PREDICTIONS dict with the optional CSV. CSV wins on conflicts."""
    out: dict[int, tuple[int, int]] = dict(AI_PREDICTIONS)
    if AI_PREDICTIONS_CSV is None:
        return out
    if not AI_PREDICTIONS_CSV.exists():
        print(f"!! AI_PREDICTIONS_CSV not found: {AI_PREDICTIONS_CSV}")
        return out
    with open(AI_PREDICTIONS_CSV, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                cid = int(row["case_id"])
                icdr = int(row["ai_icdr"])
                dme = int(row["ai_dme"])
            except (KeyError, ValueError) as e:
                print(f"   skip bad row {row}: {e}")
                continue
            out[cid] = (icdr, dme)
    print(f"loaded {len(out)} AI predictions ({AI_PREDICTIONS_CSV.name})")
    return out


def main() -> int:
    if not IDRID_BASE.exists():
        print(f"!! IDRID_BASE does not exist: {IDRID_BASE}")
        return 1

    images_train = IDRID_BASE / "1. Original Images" / "a. Training Set"
    images_test  = IDRID_BASE / "1. Original Images" / "b. Testing Set"
    gt_train     = IDRID_BASE / "2. All Segmentation Groundtruths" / "a. Training Set"
    gt_test      = IDRID_BASE / "2. All Segmentation Groundtruths" / "b. Testing Set"

    if PROJECT_DB_PATH.exists():
        print(f"removing existing {PROJECT_DB_PATH}")
        PROJECT_DB_PATH.unlink()
    PROJECT_DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    ai_preds = load_ai_predictions()

    conn = sqlite3.connect(PROJECT_DB_PATH)
    try:
        cur = conn.cursor()
        cur.executescript(SCHEMA)

        cur.execute("INSERT INTO meta(key,value) VALUES(?,?)", ("seed", str(MASTER_SEED)))
        cur.execute("INSERT INTO meta(key,value) VALUES(?,?)",
                    ("od_enabled", "1" if OD_ENABLED else "0"))
        cur.execute("INSERT INTO meta(key,value) VALUES(?,?)",
                    ("preprocessing_available", "1" if PREPROCESSING_AVAILABLE else "0"))

        for class_id, (_sub, _code, name, style) in CLASSES.items():
            cur.execute(
                "INSERT INTO classes(class_id, name, default_style_json) VALUES(?,?,?)",
                (class_id, name, json.dumps(style)),
            )

        splits: list[tuple[str, Path, Path]] = []
        if INCLUDE_TRAINING:
            splits.append(("training", images_train, gt_train))
        if INCLUDE_TESTING:
            splits.append(("testing",  images_test, gt_test))

        n_cases = 0
        n_masks = 0
        n_with_ai = 0
        seen_ids: set[int] = set()

        for i, (split_name, idir, gdir) in enumerate(splits):
            print(f"\n[{split_name}]")
            for cid, img_path, masks in discover_split(idir, gdir):
                if cid in seen_ids:
                    print(f"   warning: duplicate case_id {cid}; skipping {img_path.name}")
                    continue
                seen_ids.add(cid)

                ref_icdr, ref_dme = REF_GRADES.get(cid, (0, 0))
                ai_icdr, ai_dme = ai_preds.get(cid, (None, None))
                ai_icdr = 0
                ai_dme = 0
                is_calib = 1 if cid in CALIBRATION_CASE_IDS else 0
                has_od = 1 if OD_ENABLED else 0

                cur.execute(
                    "INSERT INTO cases(id, has_od, is_calibration, ref_icdr, ref_dme, ai_icdr, ai_dme) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (cid, has_od, is_calib, ref_icdr, ref_dme, ai_icdr, ai_dme),
                )
                img_blob, w, h = load_image_png(img_path)
                cur.execute(
                    "INSERT INTO images(case_id, view, png, width, height) VALUES(?,?,?,?,?)",
                    (cid, "macula", img_blob, w, h),
                )
                names = []
                for class_id, mp in masks.items():
                    cj = extract_contours_json(mp)
                    if cj is None:
                        continue
                    cur.execute(
                        "INSERT INTO masks(case_id, view, class_id, contours_json) VALUES(?,?,?,?)",
                        (cid, "macula", class_id, cj),
                    )
                    names.append(CLASSES[class_id][2])
                    n_masks += 1
                n_cases += 1
                if ai_icdr is not None:
                    n_with_ai += 1
                flag = " [CALIBRATION]" if is_calib else ""
                ai_str = f"  AI: ICDR={ai_icdr}, DME={ai_dme}" if ai_icdr is not None else "  AI: —"
                print(f"  case {cid:>3}: {len(names)} mask(s){flag}{ai_str}")
                if i > 5:
                    break  
        conn.commit()
    finally:
        conn.close()

    size_mb = PROJECT_DB_PATH.stat().st_size / 1e6
    print(f"\nwrote {PROJECT_DB_PATH} ({size_mb:.1f} MB): "
          f"{n_cases} cases ({n_with_ai} with AI), {n_masks} masks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
