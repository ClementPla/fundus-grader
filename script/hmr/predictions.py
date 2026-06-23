import numpy as np
from functools import lru_cache
from multistyleseg.experiments.fundus.ensemble import get_ensemble_model
from multistyleseg.postprocess.fundus import convert_small_hem_to_ma
from fundus_odmac_toolkit.models.segmentation import segment, postprocess_od_macula
import timm
from timm.data.constants import (
    IMAGENET_DEFAULT_MEAN,
    IMAGENET_DEFAULT_STD,
)
import torch
import cv2

CLASSES = {
    1: ("Soft Exudates", "SE", "Soft Exudates", {}),
    2: ("Hard Exudates", "EX", "Hard Exudates", {}),
    3: ("Haemorrhages", "HE", "Haemorrhages", {}),
    4: ("Microaneurysms", "MA", "Microaneurysms", {}),
    5: ("Optic Disc", "OD", "Optic Disc", {}),
}


@lru_cache(maxsize=1)
def get_predictor():
    model = get_ensemble_model(
        img_size=1024, model_choices=["UNET", "SEGFORMER", "SERESNET UNET"]
    ).cuda()
    model.eval()
    return model


def pad_and_resize(image: np.ndarray, target_size: int = 1024) -> np.ndarray:
    h, w, _ = image.shape
    scale = target_size / max(h, w)
    new_h, new_w = int(h * scale), int(w * scale)
    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)
    pad_top = (target_size - new_h) // 2
    pad_bottom = target_size - new_h - pad_top
    pad_left = (target_size - new_w) // 2
    pad_right = target_size - new_w - pad_left
    padded = cv2.copyMakeBorder(
        resized, pad_top, pad_bottom, pad_left, pad_right, cv2.BORDER_CONSTANT, value=0
    )
    return padded, pad_left, pad_right, pad_bottom, pad_top


def predict_lesions(
    image: np.ndarray, target_size: int = 1024
) -> dict[str, list[np.ndarray]]:
    model = get_predictor()
    mean = torch.tensor(IMAGENET_DEFAULT_MEAN).view(1, 3, 1, 1).cuda()
    std = torch.tensor(IMAGENET_DEFAULT_STD).view(1, 3, 1, 1).cuda()
    with torch.no_grad():
        h, w = image.shape[:2]
        image, pad_left, pad_right, pad_bottom, pad_top = pad_and_resize(
            image, target_size
        )
        input_tensor = (
            torch.from_numpy(image).float().permute(2, 0, 1).unsqueeze(0) / 255.0
        )
        input_tensor = input_tensor.cuda()
        # Normalize using the same mean and std as during training

        input_tensor = (input_tensor - mean) / std

        output = model(input_tensor)
        output_np = output.squeeze(0).argmax(dim=0).cpu().numpy().astype(np.uint8)
        # Unpad and resize back to original dimensions
        output_np = output_np[
            pad_top : output_np.shape[0] - pad_bottom,
            pad_left : output_np.shape[1] - pad_right,
        ]
        output_np = cv2.resize(output_np, (w, h), interpolation=cv2.INTER_NEAREST)
        output_np = convert_small_hem_to_ma(output_np, 40)
    return {
        class_name: output_np == class_id
        for class_id, (class_name, _, _, _) in CLASSES.items()
    }


def predict_od_mac(image: np.ndarray, target_size: int = 1024) -> dict[str, np.ndarray]:
    """

    Returns:
    dict with keys:
        'mask': Clean segmentation mask (H, W) with 0=bg, 1=OD, 2=macula
        'od_center': (x, y) coordinates of OD center
        'macula_center': (x, y) coordinates of macula/fovea center
        'od_valid': bool indicating if OD was found
        'macula_valid': bool indicating if macula was found
    """
    with torch.no_grad():
        proba = segment(
            image,
        )
        results = postprocess_od_macula(proba.cpu().numpy())
    return results


@lru_cache(maxsize=1)
def get_dr_model():
    model = timm.create_model(
        "convnext_base",
        num_classes=1,
        checkpoint_path="/home/clement/.cache/huggingface/hub/models--ClementP--FundusDRGrading-convnext_base/snapshots/23a24d5e721f0f93f3a21f57fc66c75d92efc69b/model.safetensors",
    )
    model = model.cuda(1).eval()
    return model


def predict_DR(image: np.ndarray) -> int:
    model = get_dr_model()
    with torch.no_grad():
        image = pad_and_resize(image, target_size=1024)[0]
        input_tensor = (
            torch.from_numpy(image).float().permute(2, 0, 1).unsqueeze(0) / 255.0
        )
        input_tensor = input_tensor.cuda(1)
        mean = torch.tensor(IMAGENET_DEFAULT_MEAN).view(1, 3, 1, 1).cuda(1)
        std = torch.tensor(IMAGENET_DEFAULT_STD).view(1, 3, 1, 1).cuda(1)
        input_tensor = (input_tensor - mean) / std
        score = model(input_tensor).item()
    return score


def _disc_diameter_px(od_mask: np.ndarray) -> float:
    """Horizontal bounding-box width (px) of the optic disc region.

    Matches the UI, which derives the disc diameter from the horizontal
    extent (maxX - minX) of the disc contour's bounding box.
    """
    xs = np.nonzero(od_mask)[1]
    return float(xs.max() - xs.min()) if xs.size else 0.0


def _lesion_distances(
    mask: np.ndarray, fx: float, fy: float, min_px: int = 0
) -> np.ndarray:
    """Euclidean distance (px) from the fovea centre to every lesion pixel.
    Components smaller than `min_px` are dropped first (segmentation speckle)."""
    if min_px > 0 and mask.any():
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
        keep = np.zeros_like(mask, dtype=bool)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= min_px:
                keep |= labels == i
        mask = keep
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        return np.empty(0, dtype=np.float32)
    return np.hypot(xs.astype(np.float32) - fx, ys.astype(np.float32) - fy)


def predict_DME(
    lesions: dict[str, np.ndarray],
    od_mac: dict[str, np.ndarray],
    min_lesion_px: int = 0,
    return_details: bool = False,
):
    """
    Grade diabetic maculopathy (M0/M1/M2/M6) from lesion masks and the
    OD/macula segmentation, using a distance-from-fovea protocol. Distances
    are expressed in disc diameters (DD), the DD measured from the segmented
    optic disc.

      M2  any hard exudate, microaneurysm, or haemorrhage <= 1 DD     -> refer
      M1  any hard exudate or microaneurysm in the (1, 2] DD annulus
      M0  no such feature within 2 DD                                 -> rescreen
      M6  macula (or disc) not localisable -> ungradable, alt. screening

    Returns the M-code string, or a details dict if return_details=True.
    """
    # Need the fovea to measure anything.
    if not od_mac.get("macula_valid", False):
        out = {"grade": "M6", "reason": "macula not localised"}
        return out if return_details else "M6"

    # The disc diameter is the distance unit; no disc => no spatial grade.
    dd_px = (
        _disc_diameter_px(od_mac["mask"] == 1) if od_mac.get("od_valid", False) else 0.0
    )
    if dd_px <= 0:
        out = {"grade": "M6", "reason": "optic disc not localised (no DD reference)"}
        return out if return_details else "M6"

    fx, fy = od_mac["macula_center"]
    one_dd, two_dd = dd_px, 2.0 * dd_px

    he_d = _lesion_distances(lesions["Hard Exudates"], fx, fy, min_lesion_px)
    ma_d = _lesion_distances(lesions["Microaneurysms"], fx, fy, min_lesion_px)
    hem_d = _lesion_distances(lesions["Haemorrhages"], fx, fy, min_lesion_px)

    # M2: within 1 DD of the fovea -> any HE, MA, or haemorrhage.
    m2 = np.any(he_d <= one_dd) or np.any(ma_d <= one_dd) or np.any(hem_d <= one_dd)
    # M1: in the (1 DD, 2 DD] annulus -> any HE or MA (haemorrhages don't count here).
    in_annulus = lambda d: np.any((d > one_dd) & (d <= two_dd))
    m1 = in_annulus(he_d) or in_annulus(ma_d)

    grade = "M2" if m2 else "M1" if m1 else "M0"

    if return_details:
        return {
            "grade": grade,
            "dd_px": dd_px,
            "fovea": (float(fx), float(fy)),
            "min_dist_dd": {
                "Hard Exudates": float(he_d.min() / dd_px) if he_d.size else None,
                "Microaneurysms": float(ma_d.min() / dd_px) if ma_d.size else None,
                "Haemorrhages": float(hem_d.min() / dd_px) if hem_d.size else None,
            },
        }
    return grade
