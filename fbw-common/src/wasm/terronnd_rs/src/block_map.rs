//! Block-native ND elevation extraction: the display only ever shows terrain
//! at 8x8-pixel block resolution (`nd_render` colours whole blocks by their
//! maximum), so instead of back-projecting every display pixel this projects
//! only the block-corner lattice — the same 8-px lattice the warp grid used —
//! and takes the maximum over each block's world-space footprint, read from
//! the region raster.
//!
//! Compared to the per-pixel kernel (`elevation_map.rs`, retained as the
//! SimBridge-lineage reference):
//! - ~6k exact corner projections replace ~370k+ per-pixel evaluations;
//! - the footprint maximum reads *every* raster cell the block covers, so a
//!   peak between the old sample points can no longer be missed at any range
//!   (TAWS-conservative by construction);
//! - the frame statistics are computed over the block maxima (one histogram
//!   entry per block instead of per pixel) — same percentile intent, coarser
//!   weighting.
//!
//! This is a deliberate fork of the display *algorithm* (output is close to,
//! but not pixel-identical with, the per-pixel pipeline); the goldens pin the
//! block-native output. The corner projection itself is the verbatim math of
//! `elevation_map::Warp::exact_uv_lat` (closed-form bearing, same wrap fixes)
//! so the geometry cannot drift from the reference kernel.

use crate::fileformat::{ELEV_INVALID, ELEV_UNKNOWN};
use crate::geodesy::{deg2rad, degrees_per_pixel, rad2deg, EARTH_RADIUS_M};
use crate::jsmath::js_round;
use crate::state::NdMapGeometry;
use crate::worldmap::WorldMap;

/// Display-pixel edge of one terrain block — must match the 8x8 block size of
/// `nd_render`'s classification/paint.
pub const BLOCK: usize = 8;

/// Block-grid dimensions for a display geometry.
pub fn block_grid(geometry: &NdMapGeometry) -> (usize, usize) {
    (
        geometry.width.div_ceil(BLOCK),
        geometry.height.div_ceil(BLOCK),
    )
}

/// Hoisted invariants of the display->world corner projection — the same
/// fields, formulas and operation order as `elevation_map::Warp`.
struct CornerProjector<'a> {
    world: &'a WorldMap,
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

impl<'a> CornerProjector<'a> {
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

    /// Exact pre-rounding world coordinates `(u, v)` of a display pixel —
    /// verbatim `Warp::exact_uv_lat` minus the polar-guard latitude return.
    fn exact_uv(&self, x: usize, y: usize) -> (f64, f64) {
        let delta_x = x as f64 - self.center_x;
        let delta_y = self.height_f - y as f64 - self.center_offset_y;
        let distance_pixels = (delta_x * delta_x + delta_y * delta_y).sqrt();

        let distance = distance_pixels * self.half_mpp;
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
        )
    }

    /// Maximum over the axis-aligned world-raster bounding box of a block's
    /// four projected corners. Any overlap with the raster edge behaves like
    /// the per-pixel kernel's out-of-map samples: Unknown, which dominates
    /// the maximum anyway.
    fn footprint_max(&self, corners: [(f64, f64); 4]) -> i16 {
        let mut u_min = f64::INFINITY;
        let mut u_max = f64::NEG_INFINITY;
        let mut v_min = f64::INFINITY;
        let mut v_max = f64::NEG_INFINITY;
        for (u, v) in corners {
            u_min = u_min.min(u);
            u_max = u_max.max(u);
            v_min = v_min.min(v);
            v_max = v_max.max(v);
        }

        let px0 = js_round(u_min) as i64;
        let px1 = js_round(u_max) as i64;
        let py0 = js_round(v_min) as i64;
        let py1 = js_round(v_max) as i64;
        let width = self.world.width as i64;
        let height = self.world.height as i64;
        if px0 < 0 || py0 < 0 || px1 >= width || py1 >= height {
            return ELEV_UNKNOWN;
        }

        let mut max = i16::MIN;
        for py in py0..=py1 {
            let row_start = py as usize * self.world.width;
            for &cell in &self.world.elevations[row_start + px0 as usize..=row_start + px1 as usize]
            {
                if cell > max {
                    max = cell;
                }
            }
        }
        max
    }
}

/// Extracts the full `blocks_x x blocks_y` block-maxima grid (row 0 = top of
/// the display). Aircraft position is the ADIRU position; the world map
/// carries the ground-truth position/pixel.
pub fn extract_block_maxima(
    world: &WorldMap,
    latitude: f64,
    longitude: f64,
    heading: f64,
    geometry: &NdMapGeometry,
    metres_per_pixel: f64,
    arc_mode: bool,
) -> Vec<i16> {
    let (blocks_x, blocks_y) = block_grid(geometry);
    let mut blocks = vec![ELEV_INVALID; blocks_x * blocks_y];
    let mut row = 0usize;
    while row < blocks_y {
        row = extract_block_maxima_band(
            world,
            latitude,
            longitude,
            heading,
            geometry,
            metres_per_pixel,
            arc_mode,
            &mut blocks,
            row,
        );
    }
    blocks
}

/// One block row (`blocks_x` blocks); `blocks` is the full grid buffer,
/// initialized to `ELEV_INVALID`; returns the next block row (`>= blocks_y`
/// when done). The lattice rows are recomputed per band — adjacent bands
/// share a corner row, idempotent like the warp bands.
#[allow(clippy::too_many_arguments)]
pub fn extract_block_maxima_band(
    world: &WorldMap,
    latitude: f64,
    longitude: f64,
    heading: f64,
    geometry: &NdMapGeometry,
    metres_per_pixel: f64,
    arc_mode: bool,
    blocks: &mut [i16],
    block_row_start: usize,
) -> usize {
    let (blocks_x, blocks_y) = block_grid(geometry);
    let by = block_row_start;
    if by >= blocks_y {
        return blocks_y;
    }
    let projector =
        CornerProjector::new(world, latitude, longitude, heading, geometry, metres_per_pixel);

    // lattice pixel coordinate of block edge `i` (the last edge is clamped to
    // the final pixel, like the warp tiles)
    let lattice_x = |i: usize| (i * BLOCK).min(geometry.width - 1);
    let lattice_y = |i: usize| (i * BLOCK).min(geometry.height - 1);

    // cut off the arc shape for the A32NX in arc mode, at block granularity:
    // a block whose nearest pixel is already beyond the arc radius stays
    // Invalid (never sampled, excluded from the histogram), like the
    // per-pixel kernel's cut pixels
    let arc = geometry.center_offset_y == 0 && arc_mode;
    let height_sq = (geometry.height * geometry.height) as f64;

    let y0 = lattice_y(by);
    let y1 = lattice_y(by + 1);
    let mut top_row = Vec::with_capacity(blocks_x + 1);
    let mut bottom_row = Vec::with_capacity(blocks_x + 1);
    for i in 0..=blocks_x {
        top_row.push(projector.exact_uv(lattice_x(i), y0));
        bottom_row.push(projector.exact_uv(lattice_x(i), y1));
    }

    for bx in 0..blocks_x {
        if arc {
            // nearest display point of the block's pixel rect to the arc
            // centre (center_x, height): clamp the centre into the rect
            let x_near = projector
                .center_x
                .clamp(lattice_x(bx) as f64, lattice_x(bx + 1) as f64);
            let y_near = projector
                .height_f
                .clamp(y0 as f64, y1 as f64);
            let dx = x_near - projector.center_x;
            let dy = projector.height_f - y_near;
            if dx * dx + dy * dy > height_sq {
                blocks[by * blocks_x + bx] = ELEV_INVALID;
                continue;
            }
        }

        blocks[by * blocks_x + bx] = projector.footprint_max([
            top_row[bx],
            top_row[bx + 1],
            bottom_row[bx],
            bottom_row[bx + 1],
        ]);
    }

    by + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::elevation_map::{extract_local_elevation_map, metres_per_pixel};
    use crate::state::nd_map_geometry;
    use std::sync::Arc;

    /// Smooth world: elevation varies gently with position so a footprint max
    /// can only exceed the per-pixel point-sample max by the local gradient.
    fn smooth_world(width: usize, height: usize) -> WorldMap {
        let mut elevations = Vec::with_capacity(width * height);
        for y in 0..height {
            for x in 0..width {
                let fx = x as f64 / width as f64;
                let fy = y as f64 / height as f64;
                let e = 3000.0
                    + 2500.0 * (fx * 9.0).sin() * (fy * 7.0).cos()
                    + 1500.0 * (fx * 23.0 + fy * 17.0).sin();
                elevations.push(e as i16);
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
            ground_truth_lat: 47.0,
            ground_truth_lon: 11.0,
            ego_x: width as f64 / 2.0,
            ego_y: height as f64 / 2.0,
        }
    }

    /// Per-pixel reference: block maxima of the warp-grid elevation map, with
    /// the same Invalid-loses semantics as `nd_render::block_maxima`.
    fn per_pixel_block_maxima(
        world: &WorldMap,
        geometry: &NdMapGeometry,
        mpp: f64,
        arc_mode: bool,
    ) -> Vec<i16> {
        let map = extract_local_elevation_map(world, 47.0, 11.0, 260.0, geometry, mpp, arc_mode);
        let (blocks_x, blocks_y) = block_grid(geometry);
        let mut blocks = vec![ELEV_INVALID; blocks_x * blocks_y];
        for by in 0..blocks_y {
            for bx in 0..blocks_x {
                let mut max = i16::MIN;
                let mut any_valid = false;
                for y in by * BLOCK..((by + 1) * BLOCK).min(geometry.height) {
                    for x in bx * BLOCK..((bx + 1) * BLOCK).min(geometry.width) {
                        let e = map[y * geometry.width + x];
                        if e != ELEV_INVALID {
                            any_valid = true;
                            if e > max {
                                max = e;
                            }
                        }
                    }
                }
                blocks[by * blocks_x + bx] = if any_valid { max } else { ELEV_INVALID };
            }
        }
        blocks
    }

    #[test]
    fn block_maxima_dominate_the_per_pixel_reference() {
        let world = smooth_world(2048, 2048);
        for (arc_mode, vd) in [(true, false), (false, false), (true, true)] {
            let geometry = nd_map_geometry(arc_mode, vd);
            for range in [20.0, 80.0, 160.0] {
                let mpp = metres_per_pixel(range, &geometry, arc_mode);
                let blocks =
                    extract_block_maxima(&world, 47.0, 11.0, 260.0, &geometry, mpp, arc_mode);
                let reference = per_pixel_block_maxima(&world, &geometry, mpp, arc_mode);
                assert_eq!(blocks.len(), reference.len());

                let mut worse = 0usize;
                for (i, (&b, &r)) in blocks.iter().zip(&reference).enumerate() {
                    match (b, r) {
                        // arc-cut blocks: both sides must agree on Invalid
                        // except at the block-granular rim
                        (ELEV_INVALID, ELEV_INVALID) => {}
                        (ELEV_INVALID, _) | (_, ELEV_INVALID) => worse += 1,
                        // the footprint max may never MISS terrain the
                        // point samples saw
                        (b, r) => {
                            assert!(
                                b >= r,
                                "block {i}: footprint max {b} below point-sample max {r} \
                                 (range {range}, arc {arc_mode})"
                            );
                            // and on a smooth world it may only exceed it by
                            // the intra-block gradient
                            assert!(
                                (b as i32 - r as i32) < 400,
                                "block {i}: {b} vs {r} exceeds the smooth-world gradient bound"
                            );
                        }
                    }
                }
                // Invalid-rim disagreement only at the arc boundary
                let limit = if arc_mode { blocks.len() / 20 } else { 0 };
                assert!(
                    worse <= limit,
                    "{worse} blocks disagree on the arc cut (limit {limit})"
                );
            }
        }
    }

    #[test]
    fn band_slicing_is_identical_to_full_grid() {
        let world = smooth_world(1024, 1024);
        let geometry = nd_map_geometry(true, false);
        let mpp = metres_per_pixel(40.0, &geometry, true);

        let full = extract_block_maxima(&world, 47.0, 11.0, 260.0, &geometry, mpp, true);

        let (blocks_x, blocks_y) = block_grid(&geometry);
        let mut sliced = vec![ELEV_INVALID; blocks_x * blocks_y];
        let mut row = 0usize;
        let mut calls = 0usize;
        while row < blocks_y {
            row = extract_block_maxima_band(
                &world, 47.0, 11.0, 260.0, &geometry, mpp, true, &mut sliced, row,
            );
            calls += 1;
        }
        assert_eq!(calls, blocks_y);
        assert_eq!(sliced, full);
    }

    #[test]
    fn out_of_world_blocks_are_unknown() {
        // geographically tiny world (0.2 deg): a 320 nm display projects far
        // beyond it, so nearly every block footprint clips the raster edge
        let mut world = smooth_world(64, 64);
        world.sw_lat = 46.9;
        world.ne_lat = 47.1;
        world.sw_lon = 10.9;
        world.ne_lon = 11.1;
        let geometry = nd_map_geometry(true, false);
        let mpp = metres_per_pixel(320.0, &geometry, true);
        let blocks = extract_block_maxima(&world, 47.0, 11.0, 0.0, &geometry, mpp, true);
        let unknown = blocks.iter().filter(|&&b| b == ELEV_UNKNOWN).count();
        assert!(unknown > blocks.len() / 2, "expected mostly unknown, got {unknown}");
    }
}
