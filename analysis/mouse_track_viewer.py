"""Render the mouse trajectory captured during one grading assignment.

Reads two SQLite files:
  - results.sqlite  → mouse_track samples + submission/assignment metadata
  - project.sqlite  → the fundus image bytes for the case

Stage-colored scatter on top of the image. Marker size encodes zoom level
(larger = more zoomed in, log₂ scaled). Thin trail lines connect consecutive
samples within the same stage segment (gaps at stage transitions are kept
visible — those represent decision pauses, not movement).
"""

from __future__ import annotations

import io
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Union

import matplotlib.pyplot as plt
from matplotlib.figure import Figure
from matplotlib.lines import Line2D
import numpy as np
from PIL import Image

PathLike = Union[str, Path]

STAGE_COLORS = {
    "grading": "#3b82f6",
    "ai_reveal": "#f59e0b",
    "editing_after_ai": "#ef4444",
    None: "#6b7280",
}

STAGE_LABELS = {
    "grading": "Pre-AI (initial grading)",
    "ai_reveal": "AI reveal (deciding)",
    "editing_after_ai": "Editing after AI",
    None: "Unknown stage",
}

STAGE_ORDER = ["grading", "ai_reveal", "editing_after_ai"]

# Cap log₂(zoom) at 4 → 16× — beyond that, the marker is already huge.
_LOG_ZOOM_CAP = 4.0


@dataclass
class _AssignmentMeta:
    case_id: int
    phase: str
    reader_name: str
    reader_surname: str
    icdr: Optional[int]
    dme: Optional[int]
    ai_decision: Optional[str]
    pre_ai_icdr: Optional[int]
    pre_ai_dme: Optional[int]
    ai_icdr_shown: Optional[int]
    ai_dme_shown: Optional[int]


def _fetch_meta(
    conn: sqlite3.Connection, assignment_id: int
) -> Optional[_AssignmentMeta]:
    row = conn.execute(
        """
        SELECT a.case_id, a.phase, r.name, r.surname,
               s.icdr, s.dme, s.ai_decision,
               s.pre_ai_icdr, s.pre_ai_dme, s.ai_icdr_shown, s.ai_dme_shown
        FROM assignments a
        JOIN readers r       ON r.id = a.reader_id
        LEFT JOIN submissions s ON s.assignment_id = a.id
        WHERE a.id = ?
        """,
        (assignment_id,),
    ).fetchone()
    if row is None:
        return None
    return _AssignmentMeta(*row)


def _fetch_image(conn: sqlite3.Connection, case_id: int, view: str):
    row = conn.execute(
        "SELECT png, width, height FROM images WHERE case_id=? AND view=?",
        (case_id, view),
    ).fetchone()
    if row is None:
        return None
    png_bytes, width, height = row
    arr = np.asarray(Image.open(io.BytesIO(png_bytes)).convert("RGB"))
    return arr, int(width), int(height)


def _fetch_samples(conn: sqlite3.Connection, assignment_id: int):
    return conn.execute(
        """
        SELECT ts_ms_since_case_start, stage, view, x, y, scale
        FROM mouse_track
        WHERE assignment_id = ?
        ORDER BY ts_ms_since_case_start ASC
        """,
        (assignment_id,),
    ).fetchall()


def _format_grade(icdr: Optional[int], dme: Optional[int]) -> str:
    if icdr is None or dme is None:
        return "—"
    return f"R{icdr}/M{dme}"


def _compute_marker_sizes(scales, base_size: float):
    """Map per-sample zoom to scatter areas. Per-view normalized: the
    smallest scale in the input gets `base_size`; each doubling of zoom
    adds 1 to the log₂ exponent. Final area is `base_size * (1 + log₂)²`
    so that visible *diameter* (∝ √area) scales linearly with log-zoom —
    the perceptually intuitive mapping. Capped at 16× to keep markers sane."""
    arr = np.asarray([s if s is not None else 1.0 for s in scales], dtype=float)
    arr = np.maximum(arr, 1e-6)
    smin = float(arr.min())
    if smin <= 0:
        return np.full_like(arr, base_size)
    log_zoom = np.log2(arr / smin)
    log_zoom = np.clip(log_zoom, 0.0, _LOG_ZOOM_CAP)
    return base_size * (1.0 + log_zoom) ** 2


def visualize_mouse_track(
    results_db_path: PathLike,
    project_db_path: PathLike,
    assignment_id: int,
    output_path: Optional[PathLike] = None,
    show: bool = False,
    point_size: float = 6.0,
    trail_alpha: float = 0.35,
    point_alpha: float = 0.75,
    scale_encoding: str = "size",
) -> Figure:
    """Build a stage-colored mouse trajectory figure for one assignment.

    Parameters
    ----------
    point_size :
        Base marker area (points²) for fit-view samples. Zoomed-in samples
        grow from this baseline.
    scale_encoding :
        ``'size'`` (default) — marker area scales with log₂(zoom relative
        to the minimum scale seen in each view).
        ``'none'`` — uniform markers (ignore the scale field).

    Returns the Figure. Saves to ``output_path`` (150 dpi) if given; calls
    ``plt.show()`` if ``show=True``. Raises ValueError if the assignment
    doesn't exist or has no samples.
    """
    if scale_encoding not in ("size", "none"):
        raise ValueError(
            f"scale_encoding must be 'size' or 'none', got {scale_encoding!r}"
        )

    results_uri = f"file:{Path(results_db_path).resolve()}?mode=ro"
    project_uri = f"file:{Path(project_db_path).resolve()}?mode=ro"

    with sqlite3.connect(results_uri, uri=True) as r_conn:
        meta = _fetch_meta(r_conn, assignment_id)
        if meta is None:
            raise ValueError(
                f"assignment {assignment_id} not found in {results_db_path}"
            )
        samples = _fetch_samples(r_conn, assignment_id)

    if not samples:
        raise ValueError(
            f"no mouse_track samples for assignment {assignment_id} (case {meta.case_id})"
        )

    views_present = []
    seen = set()
    for _, _, v, *_ in samples:
        if v not in seen:
            seen.add(v)
            views_present.append(v)

    with sqlite3.connect(project_uri, uri=True) as p_conn:
        view_images = {}
        for view in views_present:
            info = _fetch_image(p_conn, meta.case_id, view)
            if info is None:
                print(f"  warning: image not found for case={meta.case_id} view={view}")
                continue
            view_images[view] = info

    if not view_images:
        raise ValueError(
            f"no images could be loaded from {project_db_path} for case {meta.case_id}"
        )

    n_views = len(view_images)
    fig, axes = plt.subplots(
        1,
        n_views,
        figsize=(7.5 * n_views, 7.5),
        facecolor="white",
        squeeze=False,
    )
    axes = axes[0]

    used_stages = set()
    any_size_modulated = False
    for ax, view in zip(axes, view_images.keys()):
        img_arr, width, height = view_images[view]
        ax.imshow(
            img_arr,
            extent=[0, width, height, 0],
            aspect="equal",
            interpolation="bilinear",
        )

        view_samples = [s for s in samples if s[2] == view]
        if not view_samples:
            ax.set_title(f"{view} (no samples)", fontsize=11)
            ax.set_xticks([])
            ax.set_yticks([])
            continue

        ts = [s[0] for s in view_samples]
        stages = [s[1] for s in view_samples]
        xs = [s[3] for s in view_samples]
        ys = [s[4] for s in view_samples]
        scales = [s[5] for s in view_samples]

        if scale_encoding == "size":
            sizes = _compute_marker_sizes(scales, point_size)
            if not np.allclose(sizes, sizes[0]):
                any_size_modulated = True
        else:
            sizes = np.full(len(view_samples), point_size, dtype=float)

        # Stage-contiguous segments — no trail crosses a stage boundary.
        seg_start = 0
        for i in range(1, len(view_samples) + 1):
            if i == len(view_samples) or stages[i] != stages[seg_start]:
                stage = stages[seg_start]
                color = STAGE_COLORS.get(stage, STAGE_COLORS[None])
                used_stages.add(stage)
                ax.plot(
                    xs[seg_start:i],
                    ys[seg_start:i],
                    color=color,
                    alpha=trail_alpha,
                    linewidth=1.0,
                    zorder=2,
                )
                ax.scatter(
                    xs[seg_start:i],
                    ys[seg_start:i],
                    c=color,
                    s=sizes[seg_start:i],
                    alpha=point_alpha,
                    edgecolors="none",
                    zorder=3,
                )
                seg_start = i

        # Entry / exit markers sized relative to the first/last sample
        # so they stay visible against any zoom level.
        first_s = max(float(sizes[0]) * 4.0, point_size * 12.0)
        last_s = max(float(sizes[-1]) * 2.5, point_size * 8.0)
        ax.scatter(
            xs[0],
            ys[0],
            facecolors="none",
            edgecolors="white",
            s=first_s,
            linewidths=1.8,
            marker="o",
            zorder=5,
        )
        ax.scatter(
            xs[-1],
            ys[-1],
            c="white",
            s=last_s,
            marker="X",
            linewidths=1.5,
            zorder=5,
            edgecolors="black",
        )

        # Per-panel info banner.
        if scale_encoding == "size" and scales:
            smin, smax = min(scales), max(scales)
            zoom_str = f"zoom range × {smin:.2f}–{smax:.2f}"
        else:
            zoom_str = ""
        duration_s = (ts[-1] - ts[0]) / 1000.0 if len(ts) > 1 else 0.0
        title = f"{view.upper()} — {len(view_samples)} samples · {duration_s:.1f}s"
        if zoom_str:
            title += f" · {zoom_str}"
        ax.set_title(title, fontsize=11)
        ax.set_xlim(0, width)
        ax.set_ylim(height, 0)
        ax.set_xticks([])
        ax.set_yticks([])

    # Build legend in deterministic order.
    handles = []
    for s in STAGE_ORDER:
        if s in used_stages:
            handles.append(
                Line2D(
                    [0],
                    [0],
                    marker="o",
                    color="w",
                    markerfacecolor=STAGE_COLORS[s],
                    markersize=8,
                    label=STAGE_LABELS[s],
                )
            )

    # Marker-size legend: only render if size encoding is on AND at least
    # one panel actually had zoom variation. (For a case where the reader
    # never zoomed, including the size legend would be misleading.)
    if scale_encoding == "size" and any_size_modulated:
        for z, lbl in [(1.0, "fit zoom"), (2.0, "2× zoom"), (4.0, "4× zoom")]:
            log_z = min(np.log2(z), _LOG_ZOOM_CAP)
            area = point_size * (1.0 + log_z) ** 2
            handles.append(
                Line2D(
                    [0],
                    [0],
                    marker="o",
                    color="w",
                    markerfacecolor="dimgray",
                    markeredgecolor="none",
                    markersize=float(np.sqrt(area)),  # Line2D markersize is diameter
                    label=lbl,
                )
            )

    handles.append(
        Line2D(
            [0],
            [0],
            marker="o",
            color="w",
            markerfacecolor="none",
            markeredgecolor="dimgray",
            markersize=10,
            label="Entry",
        )
    )
    handles.append(
        Line2D(
            [0],
            [0],
            marker="X",
            color="w",
            markerfacecolor="dimgray",
            markeredgecolor="black",
            markersize=9,
            label="Last sample",
        )
    )
    if handles:
        fig.legend(
            handles=handles,
            loc="lower center",
            ncol=len(handles),
            frameon=False,
            fontsize=10,
            bbox_to_anchor=(0.5, 0.01),
        )

    final_grade = _format_grade(meta.icdr, meta.dme)
    title_lines = [
        f"Mouse trajectory — assignment {assignment_id} "
        f"(case {meta.case_id}, phase {meta.phase})",
        f"reader: {meta.reader_surname}, {meta.reader_name}  ·  final: {final_grade}",
    ]
    if meta.ai_decision:
        pre = _format_grade(meta.pre_ai_icdr, meta.pre_ai_dme)
        ai = _format_grade(meta.ai_icdr_shown, meta.ai_dme_shown)
        title_lines[1] += (
            f"  ·  pre-AI: {pre}  ·  AI shown: {ai}  ·  decision: {meta.ai_decision}"
        )
    fig.suptitle("\n".join(title_lines), fontsize=11, y=0.985)

    plt.tight_layout(rect=[0, 0.05, 1, 0.94])

    if output_path is not None:
        fig.savefig(
            output_path, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor()
        )
    if show:
        plt.show()
    return fig
