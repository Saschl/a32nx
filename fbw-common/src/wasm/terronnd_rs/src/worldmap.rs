//! The flat world-raster snapshot the renderers consume.
//!
//! Historically this module also held the port of the SimBridge 800 nm
//! stitched monolith (`Worldmap`/`TileManager`/`MapHandler`); that manager was
//! replaced by the range-sized region raster in `region.rs` (fed from
//! `terrain2.map`), which publishes the same snapshot type with the same
//! semantics — the golden scenarios were asserted bit-identical across the
//! swap before the monolith was deleted.

use std::sync::Arc;

use crate::fileformat::{ELEV_INVALID, ELEV_UNKNOWN};
use crate::geodesy::degrees_per_pixel;

/// Immutable snapshot handed to the renderers. Cheap to clone.
#[derive(Clone)]
pub struct WorldMap {
    pub sw_lat: f64,
    pub sw_lon: f64,
    pub ne_lat: f64,
    pub ne_lon: f64,
    pub width: usize,
    pub height: usize,
    pub elevations: Arc<Vec<i16>>,
    /// Ground-truth aircraft position and its (fractional) pixel coordinate.
    pub ground_truth_lat: f64,
    pub ground_truth_lon: f64,
    pub ego_x: f64,
    pub ego_y: f64,
}

impl WorldMap {
    #[inline]
    pub fn elevation_at_pixel(&self, x: i64, y: i64) -> i16 {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            ELEV_UNKNOWN
        } else {
            self.elevations[y as usize * self.width + x as usize]
        }
    }

    /// Point elevation lookup (port of `MapHandler.extractElevation`).
    /// `aircraft_latitude` is the ADIRU latitude used for the pole checks.
    pub fn extract_elevation(&self, aircraft_latitude: f64, latitude: f64, longitude: f64) -> i16 {
        if self.elevations.is_empty() {
            return ELEV_INVALID;
        }

        let (lat_step, lon_step) = degrees_per_pixel(
            self.sw_lat,
            self.sw_lon,
            self.ne_lat,
            self.ne_lon,
            aircraft_latitude,
            self.width,
            self.height,
        );
        let lat_pixel_delta = (self.ground_truth_lat - latitude) / lat_step;
        let lon_pixel_delta = (longitude - self.ground_truth_lon) / lon_step;

        // FIXED vs the TS original, which floored the *combined* flat index
        // ((egoY+latDelta)*width + egoX+lonDelta): the fractional part of the
        // y coordinate leaked width-scaled pixels into x, shifting the lookup
        // thousands of cells sideways. Floor row and column separately.
        self.elevation_at_pixel(
            (self.ego_x + lon_pixel_delta).floor() as i64,
            (self.ego_y + lat_pixel_delta).floor() as i64,
        )
    }
}
