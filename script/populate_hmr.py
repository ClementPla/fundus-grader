from __future__ import annotations
import pandas as pd
import cv2
import json
import sqlite3
import sys
from pathlib import Path
from utils import SCHEMA, load_image_png, extract_contours_json
from hmr.predictions import predict_lesions, predict_od_mac, predict_DR, predict_DME
import numpy as np
from consts import CLASSES
from hmr.load import DATAFRAME
from hmr.load import select_balanced_eye_set
from tqdm.auto import tqdm

from script.utils import anatomy_anchor

ROOT_INPUT = Path("/home/clement/Documents/data/IVisionHMR/output/selected_FoV/")
PROJECT_DB_PATH = Path("HMR_project.sqlite")
if PROJECT_DB_PATH.exists():
    # Remove existing DB to start fresh.
    PROJECT_DB_PATH.unlink()

CALIBRATION_CASE_IDS: set[int] = {0}
REF_GRADES: dict[int, tuple[int, int]] = {}

MASTER_SEED = 42
OD_ENABLED = True
PREPROCESSING_AVAILABLE = True
NAME_TO_CLASS_ID = {name: cid for cid, (_sub, code, name, _style) in CLASSES.items()}


subset = select_balanced_eye_set(DATAFRAME, n=200, task="dr", seed=0)

subset = subset.merge(
    DATAFRAME[["id_patient", "session", "ICDR_DME_OD", "ICDR_DME_OS"]],
    on=["id_patient", "session"],
    how="left",
)


def insert_mask(cursor, cid, view, key, mask):
    if isinstance(key, str):
        class_id = NAME_TO_CLASS_ID.get(key)
        if class_id is None:
            print(f"   warning: unknown lesion code {key!r}, skipping")
            return
    else:
        class_id = int(key)
    cj = extract_contours_json(
        mask.astype(np.uint8) if hasattr(mask, "astype") else mask
    )
    if cj is None:
        return
    cursor.execute(
        "INSERT INTO masks(case_id, view, class_id, contours_json) VALUES(?,?,?,?)",
        (cid, view, class_id, cj),
    )


def upload_case(index, case, cursor):
    image_filepath_macula = ROOT_INPUT / str(case.session) / case.eye / "macula.jpeg"
    image_filepath_od = ROOT_INPUT / str(case.session) / case.eye / "OD.jpeg"

    img_mac = cv2.imread(str(image_filepath_macula), cv2.IMREAD_COLOR_RGB)
    img_od = cv2.imread(str(image_filepath_od), cv2.IMREAD_COLOR_RGB)
    lesions_od = predict_lesions(img_od, target_size=1536)
    lesions_mac = predict_lesions(img_mac, target_size=1536)

    od_mac = predict_od_mac(img_mac, target_size=1024)
    dr_grade_mac = predict_DR(img_mac)
    dr_grade_od = predict_DR(img_od)
    dr_grade = max(dr_grade_mac, dr_grade_od)
    dr_grade = round(dr_grade)
    dme_grade = predict_DME(lesions_mac, od_mac)
    # Remove the M and convert to int for storage
    dme_grade = int(dme_grade[1:])
    cid = index
    has_od = 1
    is_calib = 1 if cid in CALIBRATION_CASE_IDS else 0

    ref_icdr = case.grade
    ref_dme = case.ICDR_DME_OD if case.eye == "OD" else case.ICDR_DME_OS
    if pd.isna(ref_dme):
        ref_dme = 6
    if pd.isna(ref_icdr):
        ref_icdr = 6
    ai_icdr = dr_grade
    ai_dme = dme_grade
    if ai_icdr == 0 and ai_dme > 0:
        ai_icdr = 1
    print(
        f"Uploading case {cid}: ICDR {ref_icdr} -> {ai_icdr}, DME {ref_dme} -> {ai_dme}"
    )
    cursor.execute(
        "INSERT INTO cases(id, has_od, is_calibration, ref_icdr, ref_dme, ai_icdr, ai_dme) "
        "VALUES(?,?,?,?,?,?,?)",
        (cid, has_od, is_calib, ref_icdr, ref_dme, ai_icdr, ai_dme),
    )
    img_blob, w, h = load_image_png(image_filepath_macula)
    cursor.execute(
        "INSERT INTO images(case_id, view, png, width, height) VALUES(?,?,?,?,?)",
        (cid, "macula", img_blob, w, h),
    )
    img_blob, w, h = load_image_png(image_filepath_od)
    cursor.execute(
        "INSERT INTO images(case_id, view, png, width, height) VALUES(?,?,?,?,?)",
        (cid, "od", img_blob, w, h),
    )
    for key, mp in lesions_od.items():
        insert_mask(cursor, cid, "od", key, mp)
    for key, mp in lesions_mac.items():
        insert_mask(cursor, cid, "macula", key, mp)
    cj_mac = extract_contours_json(od_mac["mask"] == 1)
    if cj_mac is not None:
        cursor.execute(
            "INSERT INTO masks(case_id, view, class_id, contours_json) VALUES(?,?,?,?)",
            (cid, "macula", 5, cj_mac),
        )

    macula_binary = od_mac["mask"] == 2  # or od_mac["macula_mask"], etc.

    anchor = anatomy_anchor(macula_binary)
    if anchor is not None:
        mx, my, mr = anchor
        cursor.execute(
            "INSERT INTO anatomy(case_id, view, kind, x, y, r) VALUES (?,?,?,?,?,?)",
            (cid, "macula", "macula", int(mx), int(my), int(mr)),
        )


def main():
    conn = sqlite3.connect(PROJECT_DB_PATH)
    try:
        cur = conn.cursor()
        cur.executescript(SCHEMA)

        cur.execute(
            "INSERT INTO meta(key,value) VALUES(?,?)", ("seed", str(MASTER_SEED))
        )
        cur.execute(
            "INSERT INTO meta(key,value) VALUES(?,?)",
            ("od_enabled", "1" if OD_ENABLED else "0"),
        )
        cur.execute(
            "INSERT INTO meta(key,value) VALUES(?,?)",
            ("preprocessing_available", "1" if PREPROCESSING_AVAILABLE else "0"),
        )

        for class_id, (_sub, _code, name, style) in CLASSES.items():
            cur.execute(
                "INSERT INTO classes(class_id, name, default_style_json) VALUES(?,?,?)",
                (class_id, name, json.dumps(style)),
            )
        n_cases = 0
        for i, (_, row) in enumerate(tqdm(subset.iterrows(), desc="Uploading cases")):
            upload_case(i, row, cur)
            n_cases += 1
            if n_cases % 10 == 0:
                print(f"   uploaded {n_cases} cases...")
        conn.commit()
    finally:
        conn.close()

    size_mb = PROJECT_DB_PATH.stat().st_size / 1e6
    print(f"\nwrote {PROJECT_DB_PATH} ({size_mb:.1f} MB): ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
