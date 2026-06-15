use crate::error::{Error, Result};
use image::RgbImage;
use std::io::Cursor;

/// Illumination correction by background subtraction:
///   corrected = raw - blur(raw, sigma) + mid_gray
/// Standard for fundus images; sigma scales with image size.
pub fn illumination_correct(png_bytes: &[u8]) -> Result<Vec<u8>> {
    let img = image::load_from_memory_with_format(png_bytes, image::ImageFormat::Png)?
        .to_rgb8();
    let (w, h) = img.dimensions();
    // Sigma proportional to image extent; clamp for safety.
    let sigma = ((w.max(h) as f32) / 30.0).clamp(8.0, 80.0);

    let blurred = imageproc::filter::gaussian_blur_f32(&img, sigma);

    let raw_buf: &[u8] = img.as_raw();
    let bg_buf: &[u8] = blurred.as_raw();
    let n = raw_buf.len();
    let mut out_buf = vec![0u8; n];
    for i in 0..n {
        let v = raw_buf[i] as i32 - bg_buf[i] as i32 + 128;
        out_buf[i] = v.clamp(0, 255) as u8;
    }
    let out: RgbImage = RgbImage::from_raw(w, h, out_buf)
        .ok_or_else(|| Error::Internal("preprocessing: output buffer size mismatch".into()))?;

    let mut buf = Vec::with_capacity(png_bytes.len());
    {
        let mut cursor = Cursor::new(&mut buf);
        image::DynamicImage::ImageRgb8(out).write_to(&mut cursor, image::ImageFormat::Png)?;
    }
    Ok(buf)
}
