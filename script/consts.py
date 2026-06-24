from matplotlib.colors import ListedColormap

MA_COLOR = "#00e5ff"
HE_COLOR = "#00ff88"
EX_COLOR = "#ff00aa"
SE_COLOR = "#2962ff"
OD_COLOR = "#df3dff"
FILL_OPACITY = 0.7
CMAP = ListedColormap(["#00000000", SE_COLOR, EX_COLOR, HE_COLOR, MA_COLOR, OD_COLOR])
CLASSES: dict[int, tuple[str, str, str, dict]] = {
    4: (
        "1. Microaneurysms",
        "MA",
        "Microaneurysms",
        {
            "fill": MA_COLOR,
            "fill_opacity": FILL_OPACITY,
            "stroke": MA_COLOR,
            "stroke_width": 1.5,
            "stroke_opacity": 1.0,
            "visible_by_default": True,
        },
    ),
    3: (
        "2. Haemorrhages",
        "HE",
        "Haemorrhages",
        {
            "fill": HE_COLOR,
            "fill_opacity": FILL_OPACITY,
            "stroke": HE_COLOR,
            "stroke_width": 1.5,
            "stroke_opacity": 1.0,
            "visible_by_default": True,
        },
    ),
    2: (
        "3. Hard Exudates",
        "EX",
        "Hard Exudates",
        {
            "fill": EX_COLOR,
            "fill_opacity": FILL_OPACITY,
            "stroke": EX_COLOR,
            "stroke_width": 1.5,
            "stroke_opacity": 1.0,
            "visible_by_default": True,
        },
    ),
    1: (
        "4. Soft Exudates",
        "SE",
        "Soft Exudates",
        {
            "fill": SE_COLOR,
            "fill_opacity": FILL_OPACITY,
            "stroke": SE_COLOR,
            "stroke_width": 1.5,
            "stroke_opacity": 1.0,
            "visible_by_default": True,
        },
    ),
    5: (
        "5. Optic Disc",
        "OD",
        "Optic Disc",
        {
            "fill": "none",
            "stroke": OD_COLOR,
            "stroke_width": 2.5,
            "stroke_opacity": 1.0,
            "stroke_dasharray": "6 4",
            "visible_by_default": True,
        },
    ),
}
