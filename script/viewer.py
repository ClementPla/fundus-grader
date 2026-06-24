import sqlite3
from PIL import Image
from io import BytesIO
import matplotlib.pyplot as plt
from matplotlib.patches import Circle
import json
import numpy as np

# class_id of the optic disc (see script/consts.py CLASSES).
OPTIC_DISC_CLASS_ID = 5


def _contour_diameter_px(contour) -> float:
    """Horizontal bounding-box width (px) of a stored contour.

    Mirrors the UI's `polygonsBoundingGeom` (utils.ts): the disc diameter is
    the X-extent (maxX - minX) across all polygons of the contour.
    """
    min_x, max_x = np.inf, -np.inf
    for poly in contour:
        if not poly:
            continue
        xs = np.asarray(poly, dtype=float)[:, 0]
        min_x = min(min_x, xs.min())
        max_x = max(max_x, xs.max())
    return float(max_x - min_x) if max_x >= min_x else 0.0


def get_image_from_sql():
    pass


def view_image(
    root_db,
    case_id,
    view,
    show_contours=True,
    figsize=(8, 8),
    draw_etdrs_circle=False,
    etdrs_dd=(1, 2),
    saveas=None,
):
    conn = sqlite3.connect(root_db)
    cur = conn.cursor()

    try:
        cur.execute(
            "SELECT png FROM images WHERE case_id = ? AND view = ?", (case_id, view)
        )
        row = cur.fetchone()
        if row is None:
            print(f"No image found for case_id {case_id} and view {view}.")
            return None
        img_blob = row[0]
        cur.execute(
            "SELECT contours_json, class_id FROM masks WHERE case_id = ? AND view = ?",
            (case_id, view),
        )
        contours = cur.fetchall()  # JSON format
        contours = [
            (json.loads(contour_json), class_id) for contour_json, class_id in contours
        ]

        cur.execute(
            "SELECT x, y, r FROM anatomy WHERE case_id = ? AND view = ? AND kind = 'macula'",
            (case_id, view),
        )
        anatomy_row = cur.fetchone()
        cur.execute("SELECT ai_icdr, ai_dme FROM cases WHERE id = ?", (case_id,))
        case_row = cur.fetchone()

    except sqlite3.Error as e:
        print(f"Database error: {e}")
        return None
    finally:
        cur.close()
        conn.close()

    # Convert the BLOB back to an image
    img = Image.open(BytesIO(img_blob))

    plt.figure(figsize=figsize)
    plt.imshow(img)
    if show_contours:
        # Draw an X on the macula center if available
        if anatomy_row is not None:
            mx, my, mr = anatomy_row
            plt.plot(mx, my, "rx", markersize=10, label="Macula Center")
        # Draw contours on the image
        for contour, class_id in contours:
            if contour:  # Ensure the contour is not empty
                for c in contour:
                    c = np.array(c)
                    plt.plot(c[:, 0], c[:, 1], label=f"Class {class_id}")

    if draw_etdrs_circle:
        # Centre the rings on the macula; scale them by the disc diameter.
        disc = next(
            (ct for ct, cid in contours if cid == OPTIC_DISC_CLASS_ID and ct), None
        )
        if anatomy_row is None:
            print("Cannot draw ETDRS rings: macula not localised.")
        elif disc is None:
            print("Cannot draw ETDRS rings: optic disc not found.")
        else:
            cx, cy, _ = anatomy_row
            dd_px = _contour_diameter_px(disc)
            ax = plt.gca()
            for dd in etdrs_dd:
                ax.add_patch(
                    Circle(
                        (cx, cy),
                        dd * dd_px,
                        fill=False,
                        edgecolor="yellow",
                        linestyle="--",
                        linewidth=1.5,
                    )
                )

    plt.axis("off")
    plt.title(
        f"Case ID: {case_id}, View: {view}, ICDR: {case_row[0]}, DME: {case_row[1]}"
    )

    if saveas:
        plt.savefig(saveas, bbox_inches="tight", pad_inches=0)
    plt.show()
    return img
