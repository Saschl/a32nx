//! Aircraft/EFIS data input: reads the exact LVars and aircraft variables the
//! C++ terronnd gauge read (`collection.cpp` / `configuration.h`) and builds
//! the renderer's `AircraftStatus` with the same value semantics the old
//! LVar -> 46-byte client-data -> `decode.rs` chain produced (including its
//! deliberate quirks: f32/i32/i16 transport truncation, TERR-ON-VD sharing the
//! TERR-ON-ND flag, manual azimuth following the heading).

use msfs::legacy::{AircraftVariable, NamedVariable};

use crate::state::{
    AircraftStatus, EfisData, RENDERING_MODE_VERTICAL_DISPLAY_REQUIRED,
};

/// Arinc429 SSM values (`arinc429.hpp`).
const SSM_NORMAL_OPERATION: u32 = 0b11;

/// EFIS ND mode ids (`configuration.h`): 0..=2 rose modes, 3 arc, 4 plan.
const ND_MODE_ARC: u8 = 3;

/// Unpack an FBW Arinc429 LVar: numeric-cast to u64, low 32 bits are the f32
/// payload, high 32 bits the SSM (`Arinc429Word::fromSimVar`).
fn arinc429(var: &NamedVariable) -> (f64, u32) {
    let q = var.get_value::<f64>() as u64;
    let value = f32::from_bits((q & 0xffff_ffff) as u32) as f64;
    (value, (q >> 32) as u32)
}

/// Per-display state consumed at draw time (C++ `NdConfiguration` subset that
/// stays outside the renderer).
#[derive(Clone, Copy)]
pub struct DisplayConfig {
    pub powered: bool,
    pub potentiometer: f32,
}

pub struct InputAdapter {
    // EGPWC aircraft status (Arinc429-packed LVars)
    dest_lat: NamedVariable,
    dest_lon: NamedVariable,
    present_lat: NamedVariable,
    present_lon: NamedVariable,
    altitude: NamedVariable,
    heading: NamedVariable,
    vertical_speed: NamedVariable,
    // plain LVars
    gear_is_down: NamedVariable,
    rendering_mode: NamedVariable,
    nd_range: [NamedVariable; 2],
    efis_mode: [NamedVariable; 2],
    terr_active: [NamedVariable; 2],
    bus_powered: [NamedVariable; 2],
    /// A380X: the VD instrument's auto-ranged altitude window (capt/fo) — the
    /// rendered VD image must use the same window or it won't line up with
    /// the instrument's linear altitude axis.
    vd_range_lower: [NamedVariable; 2],
    vd_range_upper: [NamedVariable; 2],
    // aircraft variables
    plane_lat: Option<AircraftVariable>,
    plane_lon: Option<AircraftVariable>,
    potentiometer: [Option<AircraftVariable>; 2],
}

fn lvar(name: &str) -> NamedVariable {
    // like the C++ LVarObject, all names are A32NX_-prefixed on both aircraft
    NamedVariable::from(&format!("A32NX_{name}"))
}

impl Default for InputAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl InputAdapter {
    pub fn new() -> Self {
        Self {
            dest_lat: lvar("EGPWC_DEST_LAT"),
            dest_lon: lvar("EGPWC_DEST_LONG"),
            present_lat: lvar("EGPWC_PRESENT_LAT"),
            present_lon: lvar("EGPWC_PRESENT_LONG"),
            altitude: lvar("EGPWC_PRESENT_ALTITUDE"),
            heading: lvar("EGPWC_PRESENT_HEADING"),
            vertical_speed: lvar("EGPWC_PRESENT_VERTICAL_SPEED"),
            gear_is_down: lvar("EGPWC_GEAR_IS_DOWN"),
            rendering_mode: lvar("EGPWC_TERRONND_RENDERING_MODE"),
            nd_range: [lvar("EGPWC_ND_L_RANGE"), lvar("EGPWC_ND_R_RANGE")],
            efis_mode: [lvar("EFIS_L_ND_MODE"), lvar("EFIS_R_ND_MODE")],
            terr_active: [
                lvar("EGPWC_ND_L_TERRAIN_ACTIVE"),
                lvar("EGPWC_ND_R_TERRAIN_ACTIVE"),
            ],
            bus_powered: [
                lvar("ELEC_AC_ESS_BUS_IS_POWERED"),
                lvar("ELEC_AC_2_BUS_IS_POWERED"),
            ],
            vd_range_lower: [lvar("VD_1_RANGE_LOWER"), lvar("VD_2_RANGE_LOWER")],
            vd_range_upper: [lvar("VD_1_RANGE_UPPER"), lvar("VD_2_RANGE_UPPER")],
            plane_lat: AircraftVariable::from("PLANE LATITUDE", "degrees", 0).ok(),
            plane_lon: AircraftVariable::from("PLANE LONGITUDE", "degrees", 0).ok(),
            potentiometer: [
                AircraftVariable::from("LIGHT POTENTIOMETER", "percent over 100", 94).ok(),
                AircraftVariable::from("LIGHT POTENTIOMETER", "percent over 100", 95).ok(),
            ],
        }
    }

    /// VD-required bit of the rendering mode: set by the A380X systems (mode
    /// 3), clear on the A32NX (mode 0). Drives screen height and background.
    pub fn vertical_display_required(&self) -> bool {
        let mode: f64 = self.rendering_mode.get_value();
        (mode as u8) & RENDERING_MODE_VERTICAL_DISPLAY_REQUIRED != 0
    }

    pub fn display_config(&self, side_index: usize) -> DisplayConfig {
        DisplayConfig {
            powered: self.bus_powered[side_index].get_value::<f64>() as u8 != 0,
            potentiometer: self.potentiometer[side_index]
                .as_ref()
                .map_or(0.0, |v| v.get::<f64>() as f32),
        }
    }

    /// Build the renderer input from the LVars, reproducing the value chain of
    /// `collection.cpp` (encode) + `decode.rs` (decode).
    pub fn aircraft_status(&self) -> AircraftStatus {
        let (present_lat, lat_ssm) = arinc429(&self.present_lat);
        let (present_lon, lon_ssm) = arinc429(&self.present_lon);
        let (altitude, altitude_ssm) = arinc429(&self.altitude);
        let (heading, heading_ssm) = arinc429(&self.heading);
        let (vertical_speed, vs_ssm) = arinc429(&self.vertical_speed);
        let (dest_lat, dest_lat_ssm) = arinc429(&self.dest_lat);
        let (dest_lon, dest_lon_ssm) = arinc429(&self.dest_lon);

        let adiru_data_valid = [lat_ssm, lon_ssm, altitude_ssm, heading_ssm, vs_ssm]
            .iter()
            .all(|&ssm| ssm == SSM_NORMAL_OPERATION);
        let runway_data_valid =
            dest_lat_ssm == SSM_NORMAL_OPERATION && dest_lon_ssm == SSM_NORMAL_OPERATION;

        let rendering_mode = self.rendering_mode.get_value::<f64>() as u8;
        let vd_always_active = rendering_mode & RENDERING_MODE_VERTICAL_DISPLAY_REQUIRED != 0;

        let efis = |side_index: usize| -> EfisData {
            let mode = self.efis_mode[side_index].get_value::<f64>() as u8;
            // C++ float -> u16 transport cast
            let range = self.nd_range[side_index].get_value::<f64>() as u16;
            let terr_active = self.terr_active[side_index].get_value::<f64>() as u8 != 0;

            let terrain_map_mode = mode <= ND_MODE_ARC;
            let active = terr_active && terrain_map_mode;
            // NOT the collection.cpp/decode.rs shared-byte quirk: that OR'd
            // the always-active VD flag into the FO TERR bit, which made the
            // FO ND terrain permanently on once the gauge renders in-process
            // (in the SimBridge chain the EfisTawsBridge HTTP status override
            // masked it). ND follows each side's TERRAIN_ACTIVE LVar; the VD
            // (A380X) renders in map modes regardless — which is what the
            // always-active flag actually meant.
            let terr_on_vd = if vd_always_active {
                terrain_map_mode
            } else {
                active
            };

            // A380X: render the VD image in the SAME altitude window the VD
            // instrument auto-ranges its (linear) axis to — otherwise the
            // terrain profile is squashed and misaligned. Guard against the
            // pre-init 0/0 window.
            let (vd_range_lower, vd_range_upper) = if vd_always_active {
                let lower: f64 = self.vd_range_lower[side_index].get_value();
                let upper: f64 = self.vd_range_upper[side_index].get_value();
                if upper > lower {
                    (lower, upper)
                } else {
                    (-500.0, 24000.0)
                }
            } else {
                // A32NX (no VD): decode.rs defaults
                (-500.0, 24000.0)
            };

            EfisData {
                nd_range: range as f64,
                arc_mode: mode == ND_MODE_ARC,
                terr_on_nd: active,
                terr_on_vd,
                efis_mode: mode,
                vd_range_lower,
                vd_range_upper,
            }
        };

        // transport truncation kept: f32 positions, i32 altitude, i16 heading/VS
        let heading = heading as i16 as f64;
        AircraftStatus {
            adiru_data_valid,
            taws_inop: false,
            latitude: present_lat,
            longitude: present_lon,
            altitude: altitude as i32 as f64,
            heading,
            vertical_speed: vertical_speed as i16 as f64,
            gear_is_down: self.gear_is_down.get_value::<f64>() as u8 != 0,
            runway_data_valid,
            runway_latitude: dest_lat,
            runway_longitude: dest_lon,
            efis_data_capt: efis(0),
            efis_data_fo: efis(1),
            navigation_display_rendering_mode: rendering_mode,
            // decode.rs quirks: manual azimuth always on, following the heading
            manual_azim_enabled: true,
            manual_azim_degrees: heading,
            ground_truth_latitude: self
                .plane_lat
                .as_ref()
                .map_or(0.0, |v| v.get::<f64>() as f32 as f64),
            ground_truth_longitude: self
                .plane_lon
                .as_ref()
                .map_or(0.0, |v| v.get::<f64>() as f32 as f64),
        }
    }
}
