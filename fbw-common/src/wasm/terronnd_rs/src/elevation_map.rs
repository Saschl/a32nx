//! Local ND elevation map extraction: for every display pixel, back-project
//! through bearing/distance onto the world map and sample it.
//!
//! Port of the `createLocalElevationMap` kernel
//! (`apps/server/src/terrain/processing/gpu/elevationmap.ts`) plus the
//! `metresPerPixel` setup from `MapHandler.createLocalElevationMap`.
//!
//! Follows the upstream terrain-rust warp-grid implementation (simbridge
//! commit a63ba66): the display->world mapping is a smooth function, so it is
//! evaluated exactly only at the corners of small tiles and bilinearly
//! interpolated in between (~1/13th of the exact evaluations). Guards keep
//! the approximation honest:
//!
//! * a centre probe per tile — if bilinear interpolation cannot reproduce the
//!   exact mapping at the tile centre to within [`PROBE_TOLERANCE_PX`], the
//!   whole tile is evaluated exactly (this catches the antimeridian wrap,
//!   where the mapping is discontinuous);
//! * a polar guard — above [`POLAR_EXACT_LIMIT_DEG`] projected latitude the
//!   equirectangular longitude mapping degenerates (cos(lat) -> 0), so
//!   interpolation is disabled outright and polar frames are exact.
//!
//! Accuracy (upstream, measured over 240 region/geometry/range/heading
//! cases): ~0.02% of samples land on a world-map cell adjacent to the exact
//! one (<= ~10 ft elevation delta), almost entirely at the 160 nm range;
//! rendered ND threshold metadata is unchanged. The exact path uses the
//! closed-form bearing (`cos b = (dy*cos_h - dx*sin_h)/r`,
//! `sin b = (dx*cos_h + dy*sin_h)/r`, one formula for both sign branches of
//! the original acos chain); everything downstream keeps the operation order
//! of the `geodesy` helpers. The TS original ran in f32 on the GPU — both
//! deviations are well inside its own noise floor.
//!
//! LOCAL DEVIATION vs upstream: the tile walk is split into resumable
//! horizontal bands (`extract_local_elevation_band`) so the single-threaded
//! gauge can amortize a cycle's extraction across sim frames;
//! `extract_local_elevation_map` drives all bands and is otherwise the
//! upstream function.

use crate::fileformat::{ELEV_INVALID, ELEV_UNKNOWN};
use crate::geodesy::{deg2rad, degrees_per_pixel, rad2deg, EARTH_RADIUS_M, NM_TO_METRES};
use crate::jsmath::js_round;
use crate::state::NdMapGeometry;
use crate::worldmap::WorldMap;

/// Warp tile edge in display pixels. 8 keeps the worst measured sample
/// divergence at 0.28% for a single 160 nm case (16 would be ~2x faster but
/// ~4x the divergence).
const WARP_TILE: usize = 8;

/// Maximum allowed centre-probe error, in world-map pixels, before a tile
/// falls back to exact evaluation.
const PROBE_TOLERANCE_PX: f64 = 0.05;

/// Projected latitude (degrees) beyond which tiles are always exact.
const POLAR_EXACT_LIMIT_DEG: f64 = 80.0;

/// `metresPerPixel` for a cycle (JS `Math.round`, doubled in arc mode; the
/// kernel divides by 2 again so arc mode covers twice the range per pixel).
pub fn metres_per_pixel(nd_range: f64, geometry: &NdMapGeometry, arc_mode: bool) -> f64 {
    let mut mpp = js_round(
        nd_range * NM_TO_METRES / (geometry.height - geometry.center_offset_y) as f64,
    );
    if arc_mode {
        mpp *= 2.0;
    }
    mpp
}

/// Loop-invariant inputs of the display->world mapping. Hoisting them out of
/// `project_wgs84`/`wgs84_to_pixel_coordinate` changes no values — the
/// helpers would recompute exactly these from constant arguments.
struct Warp<'a> {
    world: &'a WorldMap,
    /// sin/cos of the aircraft heading, for the centre pixel whose bearing is
    /// defined as the heading itself.
    sin_heading: f64,
    cos_heading: f64,
    lon_rad: f64,
    sin_lat: f64,
    cos_lat: f64,
    lat_step: f64,
    lon_step: f64,
    center_x: f64,
    height_f: f64,
    center_offset_y: f64,
    half_mpp: f64,
}

impl<'a> Warp<'a> {
    fn new(
        world: &'a WorldMap,
        latitude: f64,
        longitude: f64,
        heading: f64,
        geometry: &NdMapGeometry,
        metres_per_pixel: f64,
    ) -> Self {
        let lat_rad = deg2rad(latitude);
        let heading_rad = deg2rad(heading);
        let (lat_step, lon_step) = degrees_per_pixel(
            world.sw_lat,
            world.sw_lon,
            world.ne_lat,
            world.ne_lon,
            latitude,
            world.width,
            world.height,
        );
        Self {
            world,
            sin_heading: heading_rad.sin(),
            cos_heading: heading_rad.cos(),
            lon_rad: deg2rad(longitude),
            sin_lat: lat_rad.sin(),
            cos_lat: lat_rad.cos(),
            lat_step,
            lon_step,
            center_x: geometry.width as f64 / 2.0,
            height_f: geometry.height as f64,
            center_offset_y: geometry.center_offset_y as f64,
            half_mpp: metres_per_pixel / 2.0,
        }
    }

    /// Exact pre-rounding world coordinates `(u, v)` of a display pixel
    /// (`u = ego_x + lon_pixel_delta`, `v = ego_y + lat_pixel_delta`), plus
    /// the projected latitude in degrees for the polar guard.
    fn exact_uv_lat(&self, x: usize, y: usize) -> (f64, f64, f64) {
        let delta_x = x as f64 - self.center_x;
        let delta_y = self.height_f - y as f64 - self.center_offset_y;
        let distance_pixels = (delta_x * delta_x + delta_y * delta_y).sqrt();

        let distance = distance_pixels * self.half_mpp;
        // The pixel exactly at the projection centre divides 0/0 in the TS
        // kernel (NaN cascade, undefined GPU sampling); define it as the
        // aircraft's own position instead.
        let (sin_bearing, cos_bearing) = if distance_pixels == 0.0 {
            (self.sin_heading, self.cos_heading)
        } else {
            (
                (delta_x * self.cos_heading + delta_y * self.sin_heading) / distance_pixels,
                (delta_y * self.cos_heading - delta_x * self.sin_heading) / distance_pixels,
            )
        };
        let ratio = distance / EARTH_RADIUS_M;
        let cos_ratio = ratio.cos();
        let sin_ratio = ratio.sin();

        let lat_dest = (self.sin_lat * cos_ratio + self.cos_lat * sin_ratio * cos_bearing).asin();
        let lon_dest = self.lon_rad
            + (sin_bearing * sin_ratio * self.cos_lat)
                .atan2(cos_ratio - self.sin_lat * lat_dest.sin());

        let mut lat_dest = rad2deg(lat_dest);
        if lat_dest < -90.0 {
            lat_dest = -180.0 - lat_dest;
        }
        if lat_dest > 90.0 {
            lat_dest = 180.0 - lat_dest;
        }

        let mut lon_dest = rad2deg(lon_dest);
        if lon_dest < -180.0 {
            lon_dest += 360.0;
        }
        if lon_dest > 180.0 {
            lon_dest -= 360.0;
        }

        // FIXED vs the TS original: the antimeridian wrap, see
        // `geodesy::wgs84_to_pixel_coordinate`
        let lat_pixel_delta = (self.world.ground_truth_lat - lat_dest) / self.lat_step;
        let mut lon_delta = lon_dest - self.world.ground_truth_lon;
        if lon_delta >= 180.0 {
            lon_delta -= 360.0;
        } else if lon_delta < -180.0 {
            lon_delta += 360.0;
        }
        let lon_pixel_delta = lon_delta / self.lon_step;

        (
            self.world.ego_x + lon_pixel_delta,
            self.world.ego_y + lat_pixel_delta,
            lat_dest,
        )
    }

    #[inline]
    fn exact_uv(&self, x: usize, y: usize) -> (f64, f64) {
        let (u, v, _) = self.exact_uv_lat(x, y);
        (u, v)
    }

    /// Round to a world pixel and sample; out-of-map reads are Unknown.
    #[inline]
    fn gather(&self, u: f64, v: f64) -> i16 {
        let px = js_round(u) as i64;
        let py = js_round(v) as i64;
        if px < 0 || py < 0 || px >= self.world.width as i64 || py >= self.world.height as i64 {
            ELEV_UNKNOWN
        } else {
            self.world.elevations[py as usize * self.world.width + px as usize]
        }
    }
}

/// Extracts the `width x height` local elevation map, row 0 = top of the
/// display (farthest ahead). Aircraft position is the ADIRU position; the
/// world map carries the ground-truth position/pixel.
pub fn extract_local_elevation_map(
    world: &WorldMap,
    latitude: f64,
    longitude: f64,
    heading: f64,
    geometry: &NdMapGeometry,
    metres_per_pixel: f64,
    arc_mode: bool,
) -> Vec<i16> {
    let mut map = vec![ELEV_INVALID; geometry.width * geometry.height];
    let mut ty = 0usize;
    while ty < geometry.height {
        ty = extract_local_elevation_band(
            world,
            latitude,
            longitude,
            heading,
            geometry,
            metres_per_pixel,
            arc_mode,
            &mut map,
            ty,
        );
    }
    map
}

/// One horizontal warp-tile band (`WARP_TILE` display rows; adjacent bands
/// share a corner row, recomputed and idempotent to write twice). `map` is
/// the full `width x height` buffer, initialized to `ELEV_INVALID`; returns
/// the next band's start row (`>= height` when done). Splitting the upstream
/// tile walk here lets the gauge amortize the extraction across frames.
#[allow(clippy::too_many_arguments)]
pub fn extract_local_elevation_band(
    world: &WorldMap,
    latitude: f64,
    longitude: f64,
    heading: f64,
    geometry: &NdMapGeometry,
    metres_per_pixel: f64,
    arc_mode: bool,
    map: &mut [i16],
    band_start: usize,
) -> usize {
    let width = geometry.width;
    let height = geometry.height;
    let warp = Warp::new(world, latitude, longitude, heading, geometry, metres_per_pixel);
    // cut off the arc shape for the A32NX in arc mode
    let arc = geometry.center_offset_y == 0 && arc_mode;
    let height_sq = (height * height) as f64;

    // walk this band in WARP_TILE x WARP_TILE tiles; adjacent tiles share a
    // corner row/column (recomputed, and idempotent to write twice)
    let y0 = band_start;
    let y1 = (band_start + WARP_TILE).min(height - 1);
    let mut tx = 0usize;
    while tx < width {
        let x0 = tx;
        let x1 = (tx + WARP_TILE).min(width - 1);

        let (u00, v00, l00) = warp.exact_uv_lat(x0, y0);
        let (u10, v10, l10) = warp.exact_uv_lat(x1, y0);
        let (u01, v01, l01) = warp.exact_uv_lat(x0, y1);
        let (u11, v11, l11) = warp.exact_uv_lat(x1, y1);

        let polar =
            l00.abs().max(l10.abs()).max(l01.abs()).max(l11.abs()) > POLAR_EXACT_LIMIT_DEG;

        // centre probe: trust the tile only if bilinear interpolation
        // reproduces the exact mapping at its centre
        let inv_span_x = if x1 > x0 { 1.0 / (x1 - x0) as f64 } else { 0.0 };
        let inv_span_y = if y1 > y0 { 1.0 / (y1 - y0) as f64 } else { 0.0 };
        let interpolate = !polar && {
            let xc = (x0 + x1) / 2;
            let yc = (y0 + y1) / 2;
            let (uc, vc) = warp.exact_uv(xc, yc);
            let fx = (xc - x0) as f64 * inv_span_x;
            let fy = (yc - y0) as f64 * inv_span_y;
            let top = (u00 + (u10 - u00) * fx, v00 + (v10 - v00) * fx);
            let bottom = (u01 + (u11 - u01) * fx, v01 + (v11 - v01) * fx);
            let u = top.0 + (bottom.0 - top.0) * fy;
            let v = top.1 + (bottom.1 - top.1) * fy;
            (u - uc).abs().max((v - vc).abs()) <= PROBE_TOLERANCE_PX
        };

        for y in y0..=y1 {
            let row = &mut map[y * width..(y + 1) * width];
            let delta_y = warp.height_f - y as f64 - warp.center_offset_y;
            let fy = (y - y0) as f64 * inv_span_y;
            let left = (u00 + (u01 - u00) * fy, v00 + (v01 - v00) * fy);
            let right = (u10 + (u11 - u10) * fy, v10 + (v11 - v10) * fy);

            for (x, out) in row[x0..=x1].iter_mut().enumerate().map(|(i, o)| (x0 + i, o)) {
                if arc {
                    let delta_x = x as f64 - warp.center_x;
                    // exact equivalent of the original
                    // `sqrt(dx^2 + dy^2) > height` test: both sides are
                    // exactly representable and sqrt is monotone
                    if delta_x * delta_x + delta_y * delta_y > height_sq {
                        continue; // outside the arc, stays ELEV_INVALID
                    }
                }
                if interpolate {
                    let fx = (x - x0) as f64 * inv_span_x;
                    let u = left.0 + (right.0 - left.0) * fx;
                    let v = left.1 + (right.1 - left.1) * fx;
                    *out = warp.gather(u, v);
                } else {
                    let (u, v) = warp.exact_uv(x, y);
                    *out = warp.gather(u, v);
                }
            }
        }

        tx = if x1 == width - 1 { width } else { x1 };
    }

    if y1 == height - 1 { height } else { y1 }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::state::nd_map_geometry;

    /// Smooth elevation field: a wrong-by-one-cell lookup differs by at most
    /// a few feet, so interpolation error is bounded and measurable.
    fn smooth_world() -> WorldMap {
        let width = 1024;
        let height = 1024;
        let mut elevations = Vec::with_capacity(width * height);
        for y in 0..height {
            for x in 0..width {
                elevations.push((x * 3 + y * 5) as i16 - 500);
            }
        }
        WorldMap {
            sw_lat: 40.0,
            sw_lon: 4.0,
            ne_lat: 54.0,
            ne_lon: 18.0,
            width,
            height,
            elevations: Arc::new(elevations),
            ground_truth_lat: 47.26081,
            ground_truth_lon: 11.34966,
            ego_x: 512.3,
            ego_y: 511.7,
        }
    }

    /// The warp grid must stay within a whisker of the fully exact mapping
    /// for every geometry: identical INVALID classification, only a small
    /// fraction of samples off, and those only by adjacent-cell amounts.
    #[test]
    fn warp_grid_matches_exact_within_tolerance() {
        let world = smooth_world();
        for (arc_mode, vd_required, heading, range) in [
            (true, false, 260.0, 20.0),
            (false, false, 260.0, 20.0),
            (true, true, 260.0, 20.0),
            (false, true, 260.0, 20.0),
            (true, true, -45.0, 20.0),
            // large range stresses the interpolation (bigger world-px steps)
            (true, false, 260.0, 320.0),
        ] {
            let geometry = nd_map_geometry(arc_mode, vd_required);
            let mpp = metres_per_pixel(range, &geometry, arc_mode);
            let produced = extract_local_elevation_map(
                &world, 47.26081, 11.34966, heading, &geometry, mpp, arc_mode,
            );

            // fully exact reference straight through Warp
            let warp =
                Warp::new(&world, 47.26081, 11.34966, heading, &geometry, mpp);
            let arc = geometry.center_offset_y == 0 && arc_mode;
            let height_sq = (geometry.height * geometry.height) as f64;

            let mut differing = 0usize;
            let mut max_delta = 0i32;
            for y in 0..geometry.height {
                let delta_y = warp.height_f - y as f64 - warp.center_offset_y;
                for x in 0..geometry.width {
                    let delta_x = x as f64 - warp.center_x;
                    let want = if arc && delta_x * delta_x + delta_y * delta_y > height_sq {
                        ELEV_INVALID
                    } else {
                        let (u, v) = warp.exact_uv(x, y);
                        warp.gather(u, v)
                    };
                    let got = produced[y * geometry.width + x];

                    let got_invalid = got == ELEV_INVALID || got == ELEV_UNKNOWN;
                    let want_invalid = want == ELEV_INVALID || want == ELEV_UNKNOWN;
                    assert_eq!(
                        got_invalid, want_invalid,
                        "classification differs at ({x},{y}): arc={arc_mode} vd={vd_required} range={range}"
                    );
                    if got != want {
                        differing += 1;
                        if !got_invalid {
                            max_delta = max_delta.max((got as i32 - want as i32).abs());
                        }
                    }
                }
            }
            let total = geometry.width * geometry.height;
            let fraction = differing as f64 / total as f64;
            assert!(
                fraction < 0.02,
                "too many warp samples off ({differing}, {:.3}%): arc={arc_mode} vd={vd_required} range={range}",
                fraction * 100.0
            );
            assert!(
                max_delta <= 64,
                "warp moved a sample too far ({max_delta} ft): arc={arc_mode} vd={vd_required} range={range}"
            );
        }
    }

    /// Band-wise extraction is the same tile walk as the full-frame call.
    #[test]
    fn band_slicing_is_identical_to_full_frame() {
        let world = smooth_world();
        let geometry = nd_map_geometry(true, false);
        let mpp = metres_per_pixel(40.0, &geometry, true);

        let full = extract_local_elevation_map(
            &world, 47.26081, 11.34966, 260.0, &geometry, mpp, true,
        );

        let mut banded = vec![ELEV_INVALID; geometry.width * geometry.height];
        let mut ty = 0usize;
        let mut bands = 0usize;
        while ty < geometry.height {
            ty = extract_local_elevation_band(
                &world, 47.26081, 11.34966, 260.0, &geometry, mpp, true, &mut banded, ty,
            );
            bands += 1;
        }
        assert_eq!(banded, full);
        assert_eq!(bands, geometry.height.div_ceil(WARP_TILE));
    }
}
