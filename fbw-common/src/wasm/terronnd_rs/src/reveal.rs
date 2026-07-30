//! Reveal-region algebra for the GPU-side sweep: which part of the NEW cycle
//! frame and which part of the PREVIOUS cycle frame are visible for a given
//! transition border state. Replaces the per-tick CPU blending of
//! `transition.rs` (whose blend functions remain as the semantic reference —
//! the bridge tests below assert pixel-exact equivalence against them).
//!
//! Semantics to preserve from the CPU blends:
//! - the new frame REPLACES pixels inside the reveal region (its transparent
//!   pixels erase old content there), so the old frame must be clipped to the
//!   complement — never drawn underneath;
//! - the old frame only holds content where its own completed sweep painted
//!   it (`old_valid_border`); outside that band it was background. Clipping
//!   the old frame to its valid band makes the complement a single band —
//!   no hole-punched paths needed;
//! - border overshoot (arc up to 91, scanline below 0, VD past the width) is
//!   clamped here, like the CPU clamped at blend time.

use crate::state::NdMapGeometry;
use crate::transition::TransitionStyle;

/// Border snapshot of one display's transition, consumed at draw time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RevealState {
    pub style: TransitionStyle,
    pub start_border: i64,
    pub current_border: i64,
    /// Sweep finished; borders at rest.
    pub done: bool,
    /// A previous completed frame exists as the base.
    pub has_old: bool,
    /// Validity border of the base frame (see `Transition::old_valid_border`).
    pub old_valid_border: i64,
}

/// Everything the gauge needs to draw one side, no pixel data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SideDrawState {
    pub show_nd: bool,
    pub show_vd: bool,
    pub nd: RevealState,
    pub vd: RevealState,
    pub nd_geometry: NdMapGeometry,
    /// Logical screen is 768x1024 (with VD strip) instead of 768x768.
    pub screen_with_vd: bool,
}

/// Region of a frame to paint, in frame-local pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Region {
    Empty,
    Full,
    /// Mirrored double wedge: pixels whose angle off the up-axis (anchored at
    /// the frame's bottom-center, `acos(dy/distance)` in degrees — the
    /// `arc_mode_frame` formula) lies in `lo..=hi`.
    ArcBand { lo_deg: i64, hi_deg: i64 },
    /// Rows `y0..=y1`.
    RowBand { y0: i64, y1: i64 },
    /// Columns `x0..=x1`.
    ColBand { x0: i64, x1: i64 },
}

/// Where the NEW cycle frame shows through (the CPU blends' `use_new` region).
pub fn new_frame_region(r: &RevealState, width: usize, height: usize) -> Region {
    match r.style {
        TransitionStyle::Arc => {
            let hi = r.current_border.min(90);
            if r.start_border > hi {
                Region::Empty
            } else if r.start_border == 0 && r.current_border >= 90 {
                Region::Full
            } else {
                Region::ArcBand {
                    lo_deg: r.start_border,
                    hi_deg: hi,
                }
            }
        }
        TransitionStyle::ScanlineNd => {
            let y0 = r.current_border.max(0);
            let y1 = r.start_border.min(height as i64 - 1);
            if y0 > y1 {
                Region::Empty
            } else if y0 == 0 && y1 == height as i64 - 1 {
                Region::Full
            } else {
                Region::RowBand { y0, y1 }
            }
        }
        TransitionStyle::VerticalDisplay => {
            let x0 = r.start_border;
            let x1 = r.current_border.min(width as i64 - 1);
            if x0 > x1 {
                Region::Empty
            } else if x0 == 0 && x1 == width as i64 - 1 {
                Region::Full
            } else {
                Region::ColBand { x0, x1 }
            }
        }
    }
}

/// Where the PREVIOUS cycle frame shows through: the complement of the reveal,
/// intersected with the old frame's own validity band. (`_height` kept for
/// signature symmetry with `new_frame_region`.)
pub fn old_frame_region(r: &RevealState, width: usize, _height: usize) -> Region {
    if !r.has_old {
        return Region::Empty;
    }
    match r.style {
        TransitionStyle::Arc => {
            // complement of [start(=0), cur] within [0, 90], valid from old_valid
            let lo = (r.current_border.max(r.old_valid_border)).max(0);
            if lo > 90 || r.current_border >= 90 {
                Region::Empty
            } else {
                Region::ArcBand { lo_deg: lo, hi_deg: 90 }
            }
        }
        TransitionStyle::ScanlineNd => {
            // complement of rows [cur, start(=height)] is rows above cur,
            // valid up to old_valid
            let y1 = (r.current_border - 1).min(r.old_valid_border);
            if y1 < 0 {
                Region::Empty
            } else {
                Region::RowBand { y0: 0, y1 }
            }
        }
        TransitionStyle::VerticalDisplay => {
            // complement of cols [start(=0), cur] is cols right of cur,
            // valid from old_valid
            let x0 = (r.current_border + 1).max(r.old_valid_border);
            if x0 > width as i64 - 1 {
                Region::Empty
            } else {
                Region::ColBand {
                    x0,
                    x1: width as i64 - 1,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transition::{
        arc_angle_mask, arc_mode_frame, scanline_mode_frame, vd_frame, ND_BACKGROUND, VD_BACKGROUND,
    };
    use crate::vd_render::{VD_PROFILE_HEIGHT, VD_PROFILE_WIDTH};

    /// The `arc_mode_frame` per-pixel angle — f32-cast like the cached
    /// `arc_angle_mask` storage, so band membership stays bit-identical to the
    /// CPU reference blend.
    fn arc_angle(x: usize, y: usize, width: usize, height: usize) -> f64 {
        let dx = x as f64 - width as f64 / 2.0;
        let dy = height as f64 - y as f64;
        let distance = (dx * dx + dy * dy).sqrt();
        (((dy / distance).acos() * (180.0 / std::f64::consts::PI)) as f32) as f64
    }

    fn region_contains(region: &Region, x: usize, y: usize, width: usize, height: usize) -> bool {
        match region {
            Region::Empty => false,
            Region::Full => true,
            Region::ArcBand { lo_deg, hi_deg } => {
                let angle = arc_angle(x, y, width, height);
                *lo_deg as f64 <= angle && angle <= *hi_deg as f64
            }
            Region::RowBand { y0, y1 } => *y0 <= y as i64 && y as i64 <= *y1,
            Region::ColBand { x0, x1 } => *x0 <= x as i64 && x as i64 <= *x1,
        }
    }

    /// Distinct per-pixel byte patterns so frame identity is checkable.
    fn frame(width: usize, height: usize, tag: u8) -> Vec<u8> {
        let mut f = vec![0u8; width * height * 4];
        for (i, px) in f.chunks_exact_mut(4).enumerate() {
            px[0] = tag;
            px[1] = (i % 251) as u8;
            px[2] = (i / 251 % 251) as u8;
            px[3] = 255;
        }
        f
    }

    /// GPU-simulated composition: background, then old clipped to
    /// old_frame_region, then new clipped to new_frame_region.
    fn compose_gpu(
        r: &RevealState,
        old: Option<&[u8]>,
        new: &[u8],
        width: usize,
        height: usize,
        background: [u8; 4],
    ) -> Vec<u8> {
        let old_region = old_frame_region(r, width, height);
        let new_region = new_frame_region(r, width, height);
        let mut out = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                let idx = (y * width + x) * 4;
                if region_contains(&new_region, x, y, width, height) {
                    out.extend_from_slice(&new[idx..idx + 4]);
                } else if old.is_some() && region_contains(&old_region, x, y, width, height) {
                    out.extend_from_slice(&old.unwrap()[idx..idx + 4]);
                } else {
                    out.extend_from_slice(&background);
                }
            }
        }
        out
    }

    /// Two full cycles against the CPU blend: cycle 1 first-activation partial
    /// sweep, cycle 2 sweeping over its result — pixel-exact at every border.
    #[test]
    fn arc_reveal_matches_cpu_blend() {
        let (w, h) = (40, 30);
        let new1 = frame(w, h, 1);
        let new2 = frame(w, h, 2);
        let s1 = 37; // first-activation partial start
        let mask = arc_angle_mask(w, h);

        // cycle 1 completed: CPU base frame + our validity band
        let base = arc_mode_frame(None, &new1, s1, 90, w, h, &mask);
        for cur in [s1, s1 + 8, 40, 89] {
            let expected = arc_mode_frame(None, &new1, s1, cur.min(90), w, h, &mask);
            let state = RevealState {
                style: TransitionStyle::Arc,
                start_border: s1,
                current_border: cur,
                done: false,
                has_old: false,
                old_valid_border: 0,
            };
            assert_eq!(
                compose_gpu(&state, None, &new1, w, h, ND_BACKGROUND),
                expected,
                "cycle 1 at border {cur}"
            );
        }

        // cycle 2: full sweep from 0 over the partially valid base
        for cur in [0, 2, 20, s1, 60, 89, 90, 91] {
            let expected = arc_mode_frame(Some(&base), &new2, 0, cur.min(90), w, h, &mask);
            let state = RevealState {
                style: TransitionStyle::Arc,
                start_border: 0,
                current_border: cur,
                done: cur >= 90,
                has_old: true,
                old_valid_border: s1,
            };
            assert_eq!(
                compose_gpu(&state, Some(&base), &new2, w, h, ND_BACKGROUND),
                expected,
                "cycle 2 at border {cur}"
            );
        }
    }

    #[test]
    fn scanline_reveal_matches_cpu_blend() {
        let (w, h) = (24, 32);
        let new1 = frame(w, h, 1);
        let new2 = frame(w, h, 2);
        let s1 = 11; // first activation: only rows 0..=11 get painted

        let base = scanline_mode_frame(None, &new1, s1, 0, w, h);
        for cur in [s1, 6, 0] {
            let expected = scanline_mode_frame(None, &new1, s1, cur, w, h);
            let state = RevealState {
                style: TransitionStyle::ScanlineNd,
                start_border: s1,
                current_border: cur,
                done: false,
                has_old: false,
                old_valid_border: 0,
            };
            assert_eq!(
                compose_gpu(&state, None, &new1, w, h, ND_BACKGROUND),
                expected,
                "cycle 1 at border {cur}"
            );
        }

        // cycle 2: start at the bottom (height), sweep up past 0 (overshoot)
        for cur in [h as i64, 20, s1 as i64 + 1, s1 as i64, 5, 0, -3] {
            let expected = scanline_mode_frame(Some(&base), &new2, h as i64, cur, w, h);
            let state = RevealState {
                style: TransitionStyle::ScanlineNd,
                start_border: h as i64,
                current_border: cur,
                done: cur <= 0,
                has_old: true,
                old_valid_border: s1,
            };
            assert_eq!(
                compose_gpu(&state, Some(&base), &new2, w, h, ND_BACKGROUND),
                expected,
                "cycle 2 at border {cur}"
            );
        }
    }

    #[test]
    fn vd_reveal_matches_cpu_blend() {
        let (w, h) = (VD_PROFILE_WIDTH, VD_PROFILE_HEIGHT);
        let new1 = frame(w, h, 1);
        let new2 = frame(w, h, 2);
        let s1 = 420; // first activation: only columns 420.. painted

        let base = vd_frame(None, &new1, s1, w as i64 - 1);
        for cur in [s1, 480, w as i64 - 1] {
            let expected = vd_frame(None, &new1, s1, cur);
            let state = RevealState {
                style: TransitionStyle::VerticalDisplay,
                start_border: s1,
                current_border: cur,
                done: false,
                has_old: false,
                old_valid_border: 0,
            };
            assert_eq!(
                compose_gpu(&state, None, &new1, w, h, VD_BACKGROUND),
                expected,
                "cycle 1 at border {cur}"
            );
        }

        // cycle 2: sweep from 0 rightwards past the width (overshoot)
        for cur in [0, 36, s1 - 1, s1, 500, w as i64 - 1, w as i64 + 5] {
            let expected = vd_frame(Some(&base), &new2, 0, cur.min(w as i64 - 1));
            let state = RevealState {
                style: TransitionStyle::VerticalDisplay,
                start_border: 0,
                current_border: cur,
                done: cur >= w as i64,
                has_old: true,
                old_valid_border: s1,
            };
            assert_eq!(
                compose_gpu(&state, Some(&base), &new2, w, h, VD_BACKGROUND),
                expected,
                "cycle 2 at border {cur}"
            );
        }
    }
}
