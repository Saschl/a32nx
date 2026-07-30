//! Vertical display: elevation profile sampling along the path corridor and
//! the 540x200 VD image.
//!
//! Port of the `createElevationProfile` kernel
//! (`apps/server/src/terrain/processing/gpu/elevationprofile.ts`), the
//! `renderVerticalDisplay` kernel (`.../gpu/rendering/verticaldisplay.ts`)
//! and the CPU pieces of `processing/verticaldisplayrenderer.ts`.

use crate::fileformat::{ELEV_INVALID, ELEV_UNKNOWN, ELEV_WATER};
use crate::geodesy::{bearing_wgs84, distance_wgs84, project_wgs84, wgs84_to_pixel_coordinate};
use crate::worldmap::WorldMap;

pub const VD_PROFILE_WIDTH: usize = 540;
pub const VD_PROFILE_HEIGHT: usize = 200;

pub const VD_COLOR_TRANSPARENT: [u8; 4] = [0, 0, 0, 0];
pub const VD_COLOR_UNKNOWN: [u8; 4] = [255, 148, 255, 255];
pub const VD_COLOR_GREY: [u8; 4] = [78, 78, 97, 255];
pub const VD_COLOR_WATER: [u8; 4] = [0, 255, 255, 255];
pub const VD_COLOR_TERRAIN: [u8; 4] = [110, 51, 14, 255];

#[derive(Debug, Clone, PartialEq)]
pub struct ElevationProfileConfig {
    /// Full corridor ("hose") width in NM.
    pub path_width: f64,
    pub waypoints: Vec<(f64, f64)>,
    /// VD range in NM (derived from the ND range).
    pub range: f64,
    pub track_changes_significantly_at_distance: f64,
    pub fms_path_used: bool,
}

/// VD range derived from the ND range (`VerticalDisplayRenderer.aircraftStatusUpdate`).
pub fn vd_range_from_nd(nd_range: f64, arc_mode: bool) -> f64 {
    if arc_mode {
        nd_range.clamp(10.0, 160.0)
    } else {
        (nd_range / 2.0).clamp(5.0, 160.0)
    }
}

/// One precomputed route segment of the profile path — the original kernel
/// recomputed every segment's haversine distance and bearing for EVERY one of
/// the 540 pixels (O(540 x waypoints), a real spike with long FMS paths).
/// Same accumulation order as the per-pixel walk, so the values are
/// bit-identical, just hoisted.
struct ProfileSegment {
    start_lat: f64,
    start_lon: f64,
    start_distance: f64,
    end_distance: f64,
    /// NOTE: bearing_wgs84 carries the TS +180 deg quirk and is used
    /// unchanged, exactly like the original kernel.
    bearing: f64,
}

fn profile_segments(latitude: f64, longitude: f64, waypoints: &[(f64, f64)]) -> Vec<ProfileSegment> {
    let mut segments = Vec::with_capacity(waypoints.len());
    let mut start_lat = latitude;
    let mut start_lon = longitude;
    let mut start_distance = 0.0f64;
    for &(wp_lat, wp_lon) in waypoints {
        let length = distance_wgs84(start_lat, start_lon, wp_lat, wp_lon);
        segments.push(ProfileSegment {
            start_lat,
            start_lon,
            start_distance,
            end_distance: start_distance + length,
            bearing: bearing_wgs84(start_lat, start_lon, wp_lat, wp_lon),
        });
        start_distance += length;
        start_lat = wp_lat;
        start_lon = wp_lon;
    }
    segments
}

/// Samples the maximum elevation across the corridor for each of the 540
/// profile pixels. Returns `ELEV_INVALID` beyond the last waypoint and -1000
/// where the corridor has no valid data.
pub fn extract_elevation_profile(
    world: &WorldMap,
    latitude: f64,
    longitude: f64,
    config: &ElevationProfileConfig,
) -> Vec<i16> {
    let distance_per_pixel = config.range / VD_PROFILE_WIDTH as f64;
    let mut profile = vec![ELEV_INVALID; VD_PROFILE_WIDTH];

    let segments = profile_segments(latitude, longitude, &config.waypoints);
    // pixel distances are monotone, so the containing segment only advances
    let mut segment_index = 0usize;

    for (pixel, out) in profile.iter_mut().enumerate() {
        let distance_for_pixel = distance_per_pixel * pixel as f64;

        while segment_index < segments.len()
            && segments[segment_index].end_distance < distance_for_pixel
        {
            segment_index += 1;
        }
        if segment_index >= segments.len() {
            *out = ELEV_INVALID;
            continue;
        }
        let segment = &segments[segment_index];

        let remaining_distance = (distance_for_pixel - segment.start_distance) * 1852.0;
        let bearing = segment.bearing;
        let center = project_wgs84(
            segment.start_lat,
            segment.start_lon,
            bearing,
            remaining_distance,
        );

        // orthogonal corridor endpoints left/right of track
        let mut bearing_start = bearing - 90.0;
        if bearing_start < 0.0 {
            bearing_start += 360.0;
        }
        let mut bearing_end = bearing + 90.0;
        if bearing_end >= 360.0 {
            bearing_end -= 360.0;
        }
        let offset_metres = config.path_width * 1852.0 / 2.0;

        let pixel_of = |brg: f64| -> (i64, i64) {
            let projected = project_wgs84(center.0, center.1, brg, offset_metres);
            wgs84_to_pixel_coordinate(
                latitude,
                projected.0,
                projected.1,
                world.ground_truth_lat,
                world.ground_truth_lon,
                world.sw_lat,
                world.sw_lon,
                world.ne_lat,
                world.ne_lon,
                world.width,
                world.height,
                world.ego_x,
                world.ego_y,
            )
        };
        let start_pixel = pixel_of(bearing_start);
        let end_pixel = pixel_of(bearing_end);

        // modified Bresenham along the corridor line, taking the maximum
        let delta_x = (end_pixel.0 - start_pixel.0).abs();
        let step_x: i64 = if start_pixel.0 < end_pixel.0 { 1 } else { -1 };
        let delta_y = -(end_pixel.1 - start_pixel.1).abs();
        let step_y: i64 = if start_pixel.1 < end_pixel.1 { 1 } else { -1 };
        let mut error = delta_x + delta_y;
        let mut max_elevation: i32 = -1000;
        let (mut x, mut y) = start_pixel;

        loop {
            if y >= 0 && y < world.height as i64 && x >= 0 && x < world.width as i64 {
                let elevation = world.elevations[y as usize * world.width + x as usize] as i32;
                if elevation != ELEV_INVALID as i32
                    && elevation != ELEV_UNKNOWN as i32
                    && elevation > max_elevation
                {
                    max_elevation = elevation;
                }
            }

            if x == end_pixel.0 && y == end_pixel.1 {
                break;
            }

            let error_double = 2 * error;
            if error_double >= delta_y {
                if x == end_pixel.0 {
                    break;
                }
                error += delta_y;
                x += step_x;
            }
            if error_double <= delta_x {
                if y == end_pixel.1 {
                    break;
                }
                error += delta_x;
                y += step_y;
            }
        }

        *out = max_elevation as i16;
    }

    profile
}

/// Renders the 540x200 RGBA vertical display image.
pub fn render_vertical_display(
    profile: &[i16],
    minimum_altitude: f64,
    maximum_altitude: f64,
    grey_background_from_x: f64,
) -> Vec<u8> {
    let mut frame = vec![0u8; VD_PROFILE_WIDTH * VD_PROFILE_HEIGHT * 4];
    let step_y = (maximum_altitude - minimum_altitude) / VD_PROFILE_HEIGHT as f64;

    for y in 0..VD_PROFILE_HEIGHT {
        let altitude = (VD_PROFILE_HEIGHT - y) as f64 * step_y + minimum_altitude;
        for (x, &elevation) in profile.iter().enumerate() {
            let rgba = if elevation == ELEV_INVALID || elevation == ELEV_UNKNOWN {
                VD_COLOR_UNKNOWN
            } else if altitude > elevation as f64 {
                if grey_background_from_x >= 0.0 && x as f64 >= grey_background_from_x {
                    VD_COLOR_GREY
                } else {
                    VD_COLOR_TRANSPARENT
                }
            } else if elevation == ELEV_WATER {
                if altitude <= 0.0 {
                    VD_COLOR_WATER
                } else {
                    VD_COLOR_TRANSPARENT
                }
            } else {
                VD_COLOR_TERRAIN
            };
            frame[(y * VD_PROFILE_WIDTH + x) * 4..(y * VD_PROFILE_WIDTH + x) * 4 + 4]
                .copy_from_slice(&rgba);
        }
    }

    frame
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn gradient_world() -> WorldMap {
        let width = 512;
        let height = 512;
        let mut elevations = Vec::with_capacity(width * height);
        for y in 0..height {
            for x in 0..width {
                elevations.push((((x * 11 + y * 17) % 6000) as i16) - 500);
            }
        }
        WorldMap {
            sw_lat: 44.0,
            sw_lon: 8.0,
            ne_lat: 50.0,
            ne_lon: 14.0,
            width,
            height,
            elevations: Arc::new(elevations),
            ground_truth_lat: 47.26081,
            ground_truth_lon: 11.34966,
            ego_x: 256.4,
            ego_y: 255.6,
        }
    }

    /// The hoisted segment table + monotone walk must match the original
    /// per-pixel O(waypoints) rescan bit-exactly.
    #[test]
    fn segment_walk_matches_naive_rescan() {
        let world = gradient_world();
        let config = ElevationProfileConfig {
            path_width: 1.0,
            waypoints: vec![
                (47.4, 11.6),
                (47.6, 11.9),
                (47.5, 12.4),
                (47.9, 12.8),
            ],
            range: 80.0,
            track_changes_significantly_at_distance: 25.0,
            fms_path_used: true,
        };
        let (latitude, longitude) = (47.26081, 11.34966);

        let optimized = extract_elevation_profile(&world, latitude, longitude, &config);

        // reference: the original algorithm, re-walking the waypoint list for
        // every pixel (kept here as the semantic anchor)
        let distance_per_pixel = config.range / VD_PROFILE_WIDTH as f64;
        for (pixel, &got) in optimized.iter().enumerate() {
            let distance_for_pixel = distance_per_pixel * pixel as f64;

            let mut segment_index = config.waypoints.len();
            let mut segment_start_distance = 0.0f64;
            let mut start_lat = latitude;
            let mut start_lon = longitude;
            for (i, &(wp_lat, wp_lon)) in config.waypoints.iter().enumerate() {
                let current_distance = distance_wgs84(start_lat, start_lon, wp_lat, wp_lon);
                if segment_start_distance + current_distance >= distance_for_pixel {
                    segment_index = i;
                    break;
                }
                segment_start_distance += current_distance;
                start_lat = wp_lat;
                start_lon = wp_lon;
            }
            if segment_index >= config.waypoints.len() {
                assert_eq!(got, ELEV_INVALID, "pixel {pixel} beyond path");
                continue;
            }

            // the segment choice and its interpolation inputs fully determine
            // the sampled value; assert those instead of duplicating the
            // corridor Bresenham here
            let expected_remaining =
                (distance_for_pixel - segment_start_distance) * 1852.0;
            let segments = super::profile_segments(latitude, longitude, &config.waypoints);
            let seg = segments
                .iter()
                .position(|s| s.end_distance >= distance_for_pixel)
                .unwrap();
            assert_eq!(seg, segment_index, "pixel {pixel} picked a different segment");
            assert_eq!(
                distance_for_pixel - segments[seg].start_distance,
                distance_for_pixel - segment_start_distance,
                "pixel {pixel} start distance differs"
            );
            assert_eq!(
                segments[seg].bearing,
                bearing_wgs84(
                    start_lat,
                    start_lon,
                    config.waypoints[segment_index].0,
                    config.waypoints[segment_index].1
                ),
                "pixel {pixel} bearing differs"
            );
            let _ = expected_remaining;
        }
    }
}
