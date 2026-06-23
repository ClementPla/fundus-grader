import io
import cv2
from PIL import Image
from pathlib import Path
import json
import numpy as np

SIMPLIFY_EPSILON = 1.5
MIN_CONTOUR_AREA = 4.0

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
    class_id       INTEGER NOT NULL CHECK(typeof(class_id) = 'integer'),
    contours_json  TEXT NOT NULL,
    PRIMARY KEY (case_id, view, class_id)
);
CREATE TABLE anatomy (
    case_id  INTEGER NOT NULL,
    view     TEXT NOT NULL CHECK(view IN ('macula','od')),
    kind     TEXT NOT NULL,           -- 'macula', extensible to 'fovea' etc.
    x        INTEGER NOT NULL,
    y        INTEGER NOT NULL,
    r        INTEGER,                  -- optional radius, nullable
    PRIMARY KEY (case_id, view, kind)
);
"""


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def load_image_png(path: Path) -> tuple[bytes, int, int]:
    img = Image.open(path).convert("RGB")
    return png_bytes(img), img.width, img.height


def extract_contours_json(mask: Path) -> str | None:
    if isinstance(mask, Path):
        gray = cv2.imread(str(mask), cv2.IMREAD_GRAYSCALE)
    else:
        gray = mask.astype(np.uint8)
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


def anatomy_anchor(binary_mask) -> tuple[int, int, int] | None:
    """Centroid + max-radial-extent radius of a binary mask, all in pixels.
    Returns None for empty masks."""
    bm = np.ascontiguousarray(binary_mask).astype(np.uint8)
    if not bm.any():
        return None
    M = cv2.moments(bm)
    if M["m00"] == 0:
        return None
    cx = int(round(M["m10"] / M["m00"]))
    cy = int(round(M["m01"] / M["m00"]))
    ys, xs = np.where(bm > 0)
    r = int(round(float(np.hypot(xs - cx, ys - cy).max())))
    return cx, cy, r
