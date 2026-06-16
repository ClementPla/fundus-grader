// src-tauri/src/preprocessing.rs

use image::RgbImage;
use rayon::prelude::*;

pub fn stretch_histogram(rgb: &mut RgbImage, percent: f32) {
    let total = (rgb.width() as u32 * rgb.height() as u32) as f32;
    if total == 0.0 {
        return;
    }
    let mut hist = [[0u32; 256]; 3];
    for px in rgb.pixels() {
        hist[0][px[0] as usize] += 1;
        hist[1][px[1] as usize] += 1;
        hist[2][px[2] as usize] += 1;
    }
    let mut lo = [0.0f32; 3];
    let mut hi = [255.0f32; 3];
    for c in 0..3 {
        let mut cdf = 0.0f32;
        let mut lo_set = false;
        let mut hi_set = false;
        for i in 0..256 {
            cdf += hist[c][i] as f32 / total;
            if !lo_set && cdf > percent {
                lo[c] = i as f32;
                lo_set = true;
            }
            if !hi_set && cdf > 1.0 - percent {
                hi[c] = i as f32;
                hi_set = true;
                break;
            }
        }
        // Defensive: degenerate channel (single value) — avoid /0.
        if (hi[c] - lo[c]).abs() < f32::EPSILON {
            hi[c] = lo[c] + 1.0;
        }
    }
    let scale = [
        255.0 / (hi[0] - lo[0]),
        255.0 / (hi[1] - lo[1]),
        255.0 / (hi[2] - lo[2]),
    ];
    rgb.as_mut().par_chunks_exact_mut(3).for_each(|p| {
        for c in 0..3 {
            let v = (p[c] as f32 - lo[c]) * scale[c];
            // .round() matches OpenCV's cvRound; .abs() matches convertScaleAbs.
            p[c] = v.abs().clamp(0.0, 255.0).round() as u8;
        }
    });
}
