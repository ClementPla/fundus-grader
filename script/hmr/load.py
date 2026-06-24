import numpy as np
import pandas as pd


def select_balanced_eye_set(
    df,
    n=200,
    task="dr",
    date_col="Date",
    patient_col="id_patient",
    session_col="session",
    drop_grades=None,
    seed=0,
    verbose=True,
):
    """
    Select `n` eye-images (one per distinct patient) for an annotation/reader set,
    balanced across grading classes and biased toward recent visits.

    One "image" = one eye (OD or OS) of one patient. A patient contributes at most
    one eye, so n images == n distinct patients. Laterality is free: for a given
    patient the chosen eye is whichever helps fill the target class.

    Balance is best-effort. Classes with fewer available eyes than their fair share
    are taken in full; the remainder is spread evenly over the abundant classes (it
    does NOT all land on grade 0). Within a class, most recent visits win.

    Returns a DataFrame: [id_patient, session, Date, eye, grade].
    """
    if task == "dr":
        od_col, os_col = "ICDR_OD", "ICDR_OS"
    elif task == "dme":
        od_col, os_col = "ICDR_DME_OD", "ICDR_DME_OS"
    else:
        raise ValueError("task must be 'dr' or 'dme'")

    rng = np.random.default_rng(seed)
    d = df.copy()
    d[date_col] = pd.to_datetime(d[date_col])

    # 1) most recent visit per patient
    recent = d.loc[d.groupby(patient_col)[date_col].idxmax()]

    # 2) explode to one row per eye, carrying that eye's grade
    base_cols = [patient_col, session_col, date_col]
    long = pd.concat(
        [
            recent[base_cols].assign(eye="OD", grade=recent[od_col].values),
            recent[base_cols].assign(eye="OS", grade=recent[os_col].values),
        ],
        ignore_index=True,
    )

    # 3) drop ungradable / excluded grades
    long = long.dropna(subset=["grade"])
    if drop_grades:
        long = long[~long["grade"].isin(drop_grades)]
    long["grade"] = long["grade"].astype(int)

    n_patients = long[patient_col].nunique()
    if n_patients < n:
        if verbose:
            print(
                f"[warn] only {n_patients} gradable patients; capping n to {n_patients}"
            )
        n = n_patients

    # 4) water-fill target per class: balanced where possible, capped at availability
    avail = long.groupby("grade")[patient_col].nunique().to_dict()
    targets = _water_fill(avail, n)

    # 5) greedy fill, rarest class first so it claims shared patients before abundant ones
    order = sorted(avail, key=lambda c: avail[c])
    used, picks = set(), []
    for c in order:
        cand = long[(long["grade"] == c) & (~long[patient_col].isin(used))].copy()
        cand["_r"] = rng.random(len(cand))  # random tiebreak
        cand = cand.sort_values(
            [date_col, "_r"], ascending=[False, True], kind="mergesort"
        ).drop_duplicates(patient_col)  # one eye per patient
        chosen = cand.head(targets[c])
        picks.append(chosen)
        used.update(chosen[patient_col].tolist())
    selected = pd.concat(picks, ignore_index=True)

    # 6) top-up if patient sharing left us short of n
    short = n - len(selected)
    if short > 0:
        pool = (
            long[~long[patient_col].isin(used)]
            .assign(_r=lambda x: rng.random(len(x)))
            .sort_values([date_col, "_r"], ascending=[False, True], kind="mergesort")
            .drop_duplicates(patient_col)
            .head(short)
        )
        selected = pd.concat([selected, pool], ignore_index=True)

    selected = selected.drop(columns="_r", errors="ignore")
    if verbose:
        print(
            f"selected {len(selected)} images from {selected[patient_col].nunique()} patients"
        )
        print(selected["grade"].value_counts().sort_index().to_string())
    return selected.reset_index(drop=True)


def _water_fill(avail, n):
    """Distribute n across classes as evenly as possible, never exceeding availability."""
    alloc = {c: 0 for c in avail}
    active = {c for c, a in avail.items() if a > 0}
    remaining = n
    while remaining > 0 and active:
        share = remaining // len(active)
        if share == 0:  # hand out the last few units
            for c in sorted(active, key=lambda c: avail[c] - alloc[c], reverse=True):
                if remaining == 0:
                    break
                if alloc[c] < avail[c]:
                    alloc[c] += 1
                    remaining -= 1
            break
        progressed = False
        for c in list(active):
            give = min(share, avail[c] - alloc[c])
            if give > 0:
                alloc[c] += give
                remaining -= give
                progressed = True
            if alloc[c] >= avail[c]:
                active.discard(c)
        if not progressed:
            break
    return alloc


ICDR_MAP = {
    # --- No retinopathy ---
    "R0": 0,
    "R6": np.nan,
    "Absente": 0,
    # --- Mild NPDR ---
    "R1": 1,
    "Rétinopathie non proliférante très légère": 1,  # microaneurysms only
    "Rétinopathie non proliférante légère": 1,
    # --- Moderate NPDR ---
    "R2": 2,
    "Rétinopathie non proliférante modérée": 2,
    # --- Severe NPDR ---
    "Rétinopathie non proliférante grave": 3,
    # --- PDR ---
    "Rétinopathie proliférante": 4,
    # PRP laser scars => previously treated PDR. Graded as 4 (regressed/treated PDR).
    "Cicatrice de photocoagulation de laser avec rétinopathie proliférante active": 4,
    "Cicatrice de photocoagulation de laser avec rétinopathie proliférante inactive": np.nan,
    # --- Ungradable / not applicable ---
    "Qualité de la photographie insuffisante": np.nan,
    "Monophtalme": np.nan,
    "Œil énucléé": np.nan,
    # ------------------------------------------------------------------
    # FLAGGED — confirm these against your grading protocol before use:
    # ------------------------------------------------------------------
    # "possible" categories: definite vs. suspected DR. I default suspected
    # mild to 1 and suspected PDR to 4, but you may prefer 0 / np.nan.
    "Rétinopathie non proliférante possible": 1,
    "Rétinopathie proliférante possible": 4,
    # Unspecified NPDR (no severity given). Defaulting to 1 is a guess;
    # could equally be 2. Consider np.nan if you can't justify a level.
    "Rétinopathie non proliférante": 1,
    # NPDR *with* laser scars => eye was photocoagulated (implies prior PDR)
    # but currently graded non-proliferative. I map to 4 (treated PDR),
    # but if you grade on current findings you may want 2 or 3.
    "Cicatrices de photocoagulation de laser avec rétinopathie non proliférante active": 4,
    "Cicatrice de photocoagulation de laser avec rétinopathie non proliférante inactive": 4,
}


def map_to_icdr(series: pd.Series) -> pd.Series:
    """Map French DR labels to the ICDR 0-4 scale. Unknown labels -> np.nan."""
    unmapped = set(series.dropna().unique()) - set(ICDR_MAP)
    if unmapped:
        raise KeyError(f"Unmapped DR labels: {sorted(unmapped)}")
    return series.map(ICDR_MAP).astype("Int8")  # nullable int, keeps np.nan


# ICDR DME severity scale:
#   0 = DME apparently absent
#   1 = mild  (thickening/exudates distant from macular center)
#   2 = moderate (approaching center, not involving it)
#   3 = severe (involving the center of the macula)
# np.nan = ungradable / not applicable.
ICDR_DME_MAP = {
    # --- Absent ---
    "M0": 0,
    "Absente": 0,
    # --- Present, graded by proximity to fovea ---
    # 2 disc diameters out => distant from center => mild
    "Présente à 2 dd de la fovéa": 1,
    # 1 disc diameter => approaching the center => moderate
    "Présente à 1 dd de la fovéa": 2,
    # --- Ungradable / not applicable ---
    "Qualité de la photographie insuffisante": np.nan,
    "Non applicable": np.nan,
    "Macula non visualisée": np.nan,
    "M6": np.nan,
    # ------------------------------------------------------------------
    # FLAGGED — confirm against your grading protocol before use:
    # ------------------------------------------------------------------
    # M-codes: I can't infer the protocol's M0/M1/M2 thresholds with
    # confidence. M0 is clearly absent. My best reading:
    #   M1 -> present but not center-threatening  => mild (1)
    #   M2 -> center-threatening / CSME           => moderate-to-severe
    # but these are guesses. The "M2/OCT-/E-" compound is especially
    # uncertain (looks like M2 with negative OCT and negative exudates,
    # i.e. NOT confirmed edema => possibly should be 0).
    "M1": 1,
    "M2": 2,
    "M2/OCT-/E-": 0,  # M2 suspected but OCT- and exudate- => likely no true DME
    # "Possible" is a clinician hedge, not a severity level.
    # Defaulting to mild; you may prefer 0 or np.nan.
    "Possible": 1,
    # M6: same unknown "code 6" as R6 in the DR question — left for you
    # to define. Will raise until mapped.
}


def map_to_icdr_dme(series: pd.Series) -> pd.Series:
    """Map French maculopathy labels to ICDR DME 0-3 scale. Unknown -> raises."""
    unmapped = set(series.dropna().unique()) - set(ICDR_DME_MAP)
    if unmapped:
        raise KeyError(f"Unmapped DME labels: {sorted(unmapped)}")
    return series.map(ICDR_DME_MAP).astype("Int8")


male_df = pd.read_csv("/home/clement/Documents/data/IVisionHMR/metadata/male.csv")
female_df = pd.read_csv("/home/clement/Documents/data/IVisionHMR/metadata/female.csv")
id_df = pd.read_csv("/home/clement/Documents/data/IVisionHMR/metadata/ids.csv")

patient_df = pd.concat([male_df, female_df], ignore_index=True)

DATAFRAME = patient_df.merge(
    id_df, left_on="No session", right_on="session", how="inner"
)

COLUMNS_TO_DROP = [
    "Unnamed: 0",
    "Délai entre rapport disponible et rapport visualisé (Jours)",
    "Délai entre la réception des images et rapport disponible (Jours)",
    "Rapport a été visionné ",
    "Rapport Disponible (date à laquelle le rapport a été généré par le spécialiste)",
    # "Date de l’imagerie (date à laquelles les images sont reçues)",
    "Unnamed: 3",
    "Code du Médecin Tratant",
    "Code de l'Imageur",
    "Code du Lecteur",
    "Tension oculaire OD",
    "Tension oculaire OS",
    "DMLA OD",
    "Glaucome OD",
    "DMLA OS",
    "Glaucome OS",
    "No session",
    "Durée du diabète",
    "Durée d’insuline",
    "Acuité visuelle OD",
    "Acuité visuelle OS",
    "Type de diabète",
]
DATAFRAME = DATAFRAME.drop(columns=COLUMNS_TO_DROP)
# Drop NaN values
DATAFRAME = DATAFRAME.dropna()

# usage
DATAFRAME["ICDR_DME_OD"] = map_to_icdr_dme(
    DATAFRAME["Menace diabétique de la macula OD"]
)
DATAFRAME["ICDR_DME_OS"] = map_to_icdr_dme(
    DATAFRAME["Menace diabétique de la macula OS"]
)

# usage
DATAFRAME["ICDR_OS"] = map_to_icdr(DATAFRAME["Rétinopathie diabétique OS"])
DATAFRAME["ICDR_OD"] = map_to_icdr(DATAFRAME["Rétinopathie diabétique OD"])
DATAFRAME["Date"] = DATAFRAME[
    "Date de l’imagerie (date à laquelles les images sont reçues)"
]

DATAFRAME["Menace diabétique de la macula OS"].value_counts()

DATAFRAME = DATAFRAME[
    [
        "session",
        "id_patient",
        "Date",
        "ICDR_OD",
        "ICDR_OS",
        "ICDR_DME_OD",
        "ICDR_DME_OS",
    ]
]
# Map "Date" to datetime
DATAFRAME["Date"] = pd.to_datetime(DATAFRAME["Date"], dayfirst=True)
