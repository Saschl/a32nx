//! CommBus payload parsing for the A380X `EfisTawsBridge` messages (previously
//! POSTed to SimBridge over HTTP):
//!
//! - `FBW_TERR_VD_PATH`: the `ElevationSamplePathDto` vertical-display path.
//! - `FBW_TERR_AIRCRAFT_STATUS`: the full `TawsAircraftStatusDataDto`, which
//!   carries A380X state that has no LVar representation (TERR failures,
//!   ND/VD availability, AESU VD ranges, track-line predicate). The gauge
//!   prefers it over the LVar-derived status while fresh — the same override
//!   semantics SimBridge applied to HTTP client data.
//!
//! Parsing is portable and host-tested; the CommBus registration lives in the
//! wasm-only gauge layer.

use serde::Deserialize;

use crate::runner::VerticalPathData;
use crate::state::AircraftStatus;

/// CommBus payloads arrive with the C string's trailing NUL included in the
/// reported size — strip it before JSON parsing.
pub fn trim_commbus_payload(payload: &str) -> &str {
    payload.trim_end_matches('\0')
}

/// Parse the `FBW_TERR_AIRCRAFT_STATUS` payload (`TawsAircraftStatusDataDto`;
/// `AircraftStatus` mirrors its field names exactly).
pub fn parse_aircraft_status(json: &str) -> Result<AircraftStatus, serde_json::Error> {
    serde_json::from_str(trim_commbus_payload(json))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaypointDto {
    latitude: f64,
    longitude: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElevationSamplePathDto {
    path_width: f64,
    track_changes_significantly_at_distance: f64,
    waypoints: Vec<WaypointDto>,
}

/// Parse the `FBW_TERR_VD_PATH` payload into the renderer's path type.
pub fn parse_vd_path(json: &str) -> Result<VerticalPathData, serde_json::Error> {
    let dto: ElevationSamplePathDto = serde_json::from_str(trim_commbus_payload(json))?;
    Ok(VerticalPathData {
        path_width: dto.path_width,
        track_changes_significantly_at_distance: dto.track_changes_significantly_at_distance,
        waypoints: dto
            .waypoints
            .iter()
            .map(|w| (w.latitude, w.longitude))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::parse_vd_path;

    #[test]
    fn parses_efis_taws_bridge_dto() {
        let json = r#"{
            "pathWidth": 1,
            "trackChangesSignificantlyAtDistance": 12.5,
            "waypoints": [
                {"latitude": 47.26081, "longitude": 11.34966},
                {"latitude": 47.5, "longitude": 11.5}
            ]
        }"#;
        let path = parse_vd_path(json).unwrap();
        assert_eq!(path.path_width, 1.0);
        assert_eq!(path.track_changes_significantly_at_distance, 12.5);
        assert_eq!(path.waypoints, vec![(47.26081, 11.34966), (47.5, 11.5)]);
    }

    #[test]
    fn rejects_malformed_payloads() {
        assert!(parse_vd_path("not json").is_err());
        assert!(parse_vd_path(r#"{"pathWidth": 1}"#).is_err());
    }

    #[test]
    fn tolerates_trailing_nul_from_commbus() {
        let json = "{\"pathWidth\": 1, \"trackChangesSignificantlyAtDistance\": -1, \"waypoints\": []}\0";
        assert!(parse_vd_path(json).is_ok());
    }

    #[test]
    fn parses_taws_aircraft_status_dto() {
        // the same DTO shape the state.rs serde test uses, as EfisTawsBridge sends it
        let json = r#"{
            "adiruDataValid": true, "tawsInop": false,
            "latitude": 50.03, "longitude": 8.57,
            "altitude": 3487.2, "heading": 204.7, "verticalSpeed": -1200.5,
            "gearIsDown": true, "runwayDataValid": false,
            "runwayLatitude": 0, "runwayLongitude": 0,
            "efisDataCapt": {"ndRange": 20, "arcMode": true, "terrOnNd": true, "terrOnVd": true,
                             "efisMode": 3, "vdRangeLower": -500, "vdRangeUpper": 24000},
            "efisDataFO": {"ndRange": 40, "arcMode": true, "terrOnNd": false, "terrOnVd": false,
                           "efisMode": 3, "vdRangeLower": -500, "vdRangeUpper": 24000},
            "navigationDisplayRenderingMode": 3,
            "manualAzimEnabled": true, "manualAzimDegrees": 204.7,
            "groundTruthLatitude": 50.03, "groundTruthLongitude": 8.57
        }"#;
        let status = super::parse_aircraft_status(json).unwrap();
        assert!(status.adiru_data_valid);
        assert_eq!(status.navigation_display_rendering_mode, 3);
        assert!(status.efis_data_capt.terr_on_vd);
    }
}
