//! `WorldMap` snapshot semantics: point probes and the separated row/column
//! flooring fix. (The former 800 nm manager tests moved to `tests/region.rs`
//! when the data layer was replaced by the region raster.)

use std::sync::Arc;

use terronnd::fileformat::{ELEV_INVALID, ELEV_UNKNOWN};
use terronnd::worldmap::WorldMap;

/// 3x3-degree world of 4x4-cell tiles (12x12 raster) centred on (47.5, 11.5),
/// with a distinct elevation per raster cell.
fn test_world() -> WorldMap {
    let width = 12;
    let height = 12;
    let elevations: Vec<i16> = (0..width * height).map(|i| i as i16).collect();
    WorldMap {
        sw_lat: 46.0,
        sw_lon: 10.0,
        ne_lat: 49.0,
        ne_lon: 13.0,
        width,
        height,
        elevations: Arc::new(elevations),
        ground_truth_lat: 47.5,
        ground_truth_lon: 11.5,
        // tile (47, 11), 2 pixels into the tile block
        ego_x: 6.0,
        ego_y: 6.0,
    }
}

#[test]
fn pixel_probe_bounds() {
    let world = test_world();
    assert_eq!(world.elevation_at_pixel(0, 0), 0);
    assert_eq!(world.elevation_at_pixel(11, 11), 143);
    assert_eq!(world.elevation_at_pixel(-1, 0), ELEV_UNKNOWN);
    assert_eq!(world.elevation_at_pixel(0, -1), ELEV_UNKNOWN);
    assert_eq!(world.elevation_at_pixel(12, 0), ELEV_UNKNOWN);
    assert_eq!(world.elevation_at_pixel(0, 12), ELEV_UNKNOWN);
}

#[test]
fn extract_elevation_reads_under_and_around_the_aircraft() {
    let world = test_world();
    // under the aircraft: exactly the ego pixel
    assert_eq!(world.extract_elevation(47.5, 47.5, 11.5), 6 * 12 + 6);
    // one raster cell is 0.25 degrees; a cell east moves +1 column
    assert_eq!(world.extract_elevation(47.5, 47.5, 11.75), 6 * 12 + 7);
    // north decreases the row
    assert_eq!(world.extract_elevation(47.5, 47.75, 11.5), 5 * 12 + 6);
    // far outside the raster
    assert_eq!(world.extract_elevation(47.5, 60.0, 11.5), ELEV_UNKNOWN);
}

/// The TS original floored the combined flat index, leaking the fractional y
/// into x. Row and column must floor separately.
#[test]
fn extract_elevation_floors_row_and_column_separately() {
    let world = test_world();
    // a probe 0.6 cells north: row floor(6 - 0.6) = 5, column stays 6
    let north = 47.5 + 0.6 * 0.25;
    assert_eq!(world.extract_elevation(47.5, north, 11.5), 5 * 12 + 6);
    // a probe 0.6 cells west: column floor(6 - 0.6) = 5, row stays 6
    let west = 11.5 - 0.6 * 0.25;
    assert_eq!(world.extract_elevation(47.5, 47.5, west), 6 * 12 + 5);
}

#[test]
fn empty_world_reports_invalid() {
    let mut world = test_world();
    world.elevations = Arc::new(Vec::new());
    assert_eq!(world.extract_elevation(47.5, 47.5, 11.5), ELEV_INVALID);
}
