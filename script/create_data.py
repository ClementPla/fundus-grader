import cv2

from pathlib import Path
INPUT_RAW_IMAGES = Path("./data/raw/images")
INPUT_RAW_MASKS = Path("./data/raw/masks")

OUTPUT_IMAGES = Path("./data/images")
OUTPUT_MASKS = Path("./data/masks")
OUTPUT_IMAGES.mkdir(parents=True, exist_ok=True)
OUTPUT_MASKS.mkdir(parents=True, exist_ok=True)
list_images = sorted(INPUT_RAW_IMAGES.glob("*.jpg"), key=lambda x: int(x.stem.split("_")[1]))
list_masks = sorted(INPUT_RAW_MASKS.glob("*.tif"), key=lambda x: int(x.stem.split("_")[1]))
for img_path, mask_path in zip(list_images, list_masks):
    print(f"Processing {img_path.name} and {mask_path.name}")
    image_id = img_path.stem.replace("IDRiD_", "")
    img = cv2.imread(str(img_path))
    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    cv2.imwrite(str(OUTPUT_IMAGES / f"{image_id}_left.png"), img)
    cv2.imwrite(str(OUTPUT_MASKS / f"{image_id}_left_class1.png"), (mask > 0 ).astype("uint8") * 255)
    
    