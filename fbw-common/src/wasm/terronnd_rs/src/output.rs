//! Threshold metadata output: the `A32NX_EGPWC_ND_{L,R}_TERRAIN_*` LVars the
//! JS ND instruments read for the elevation legend — the same LVars the C++
//! gauge wrote from the SimBridge threshold blocks (`display.h`).

use msfs::legacy::NamedVariable;

use crate::jsmath::js_round;
use crate::runner::ThresholdWrite;

struct SideVars {
    min_elevation: NamedVariable,
    min_elevation_mode: NamedVariable,
    max_elevation: NamedVariable,
    max_elevation_mode: NamedVariable,
}

impl SideVars {
    fn new(side: char) -> Self {
        let var = |suffix: &str| {
            NamedVariable::from(&format!("A32NX_EGPWC_ND_{side}_TERRAIN_{suffix}"))
        };
        Self {
            min_elevation: var("MIN_ELEVATION"),
            min_elevation_mode: var("MIN_ELEVATION_MODE"),
            max_elevation: var("MAX_ELEVATION"),
            max_elevation_mode: var("MAX_ELEVATION_MODE"),
        }
    }
}

pub struct ThresholdVars {
    sides: [SideVars; 2],
}

impl Default for ThresholdVars {
    fn default() -> Self {
        Self::new()
    }
}

impl ThresholdVars {
    pub fn new() -> Self {
        Self {
            sides: [SideVars::new('L'), SideVars::new('R')],
        }
    }

    /// SimBridge packed the thresholds as js-rounded integers — keep the ND
    /// legend digits identical.
    pub fn write(&self, side_index: usize, write: &ThresholdWrite) {
        let side = &self.sides[side_index];
        side.min_elevation.set_value(js_round(write.minimum_elevation));
        side.min_elevation_mode
            .set_value(write.minimum_elevation_mode as u8 as f64);
        side.max_elevation.set_value(js_round(write.maximum_elevation));
        side.max_elevation_mode
            .set_value(write.maximum_elevation_mode as u8 as f64);
    }

    /// C++ `resetNavigationDisplayData`.
    pub fn reset(&self, side_index: usize) {
        let side = &self.sides[side_index];
        side.min_elevation.set_value(-1.0);
        side.min_elevation_mode.set_value(0.0);
        side.max_elevation.set_value(-1.0);
        side.max_elevation_mode.set_value(0.0);
    }
}
