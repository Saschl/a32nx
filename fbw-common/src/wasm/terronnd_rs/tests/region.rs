//! Region-raster runtime: budgeted-vs-sync convergence, rebuild triggers,
//! coalesced row reads, antimeridian/pole rects, and cache eviction.

use std::io::{Cursor, Write};
use std::sync::Arc;

use terronnd::convert::convert_v1_to_v2;
use terronnd::fileformat::{TerrainMap, ELEV_UNKNOWN, ELEV_WATER};
use terronnd::fileformat_v2::TerrainMapV2;
use terronnd::region::{display_level, RegionInputs, RegionManager, SideGeom};

/// Synthetic v2 database: 1x1 degree tiles, each 4x4 cells of a constant
/// metre elevation, converted from v1 bytes through the real converter.
fn synthetic_manager(tiles: &[(i8, i16, i16)]) -> RegionManager {
    let mut data = Vec::new();
    data.extend_from_slice(&(-90i16).to_le_bytes());
    data.extend_from_slice(&90i16.to_le_bytes());
    data.extend_from_slice(&(-180i16).to_le_bytes());
    data.extend_from_slice(&180i16.to_le_bytes());
    data.push(1);
    data.push(1);
    data.extend_from_slice(&0.25f32.to_le_bytes());

    for &(sw_lat, sw_lon, metres) in tiles {
        let mut raw = Vec::new();
        for _ in 0..16 {
            raw.extend_from_slice(&metres.to_le_bytes());
        }
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).unwrap();
        let compressed = encoder.finish().unwrap();

        data.extend_from_slice(&4u16.to_le_bytes());
        data.extend_from_slice(&4u16.to_le_bytes());
        data.push(sw_lat as u8);
        data.extend_from_slice(&sw_lon.to_le_bytes());
        data.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        data.extend_from_slice(&compressed);
    }

    let v1 = TerrainMap::from_bytes(data).unwrap();
    let mut out = Cursor::new(Vec::new());
    convert_v1_to_v2(&v1, &mut out, |_, _| {}).unwrap();
    RegionManager::new(TerrainMapV2::from_bytes(out.into_inner()).unwrap())
}

fn inputs(lat: f64, lon: f64, nd_range: f64, arc_mode: bool) -> RegionInputs {
    RegionInputs {
        ground_truth_lat: lat,
        ground_truth_lon: lon,
        vertical_display_required: false,
        sides: [SideGeom { nd_range, arc_mode }; 2],
    }
}

#[test]
fn sync_assembles_and_extracts() {
    let mut manager = synthetic_manager(&[(47, 11, 100), (47, 12, 200)]);
    let world = manager.update_sync(&inputs(47.5, 11.5, 20.0, true)).expect("snapshot");

    assert!(world.width > 0 && world.height > 0);
    assert_eq!(world.elevations.len(), world.width * world.height);
    assert!(world.ego_x > 0.0 && (world.ego_x as usize) < world.width);
    assert!(world.ego_y > 0.0 && (world.ego_y as usize) < world.height);

    // 100 m -> 328 ft under the aircraft, 200 m -> 656 ft one tile east
    assert_eq!(world.extract_elevation(47.5, 47.5, 11.5), 328);
    assert_eq!(world.extract_elevation(47.5, 47.5, 12.5), 656);
    // in-region cell without a database tile -> water
    assert_eq!(world.extract_elevation(47.5, 47.5, 11.5 - 0.9), ELEV_WATER);
    // far outside the region raster -> unknown
    assert_eq!(world.extract_elevation(47.5, 60.5, 11.5), ELEV_UNKNOWN);

    assert_eq!(world.elevation_at_pixel(world.ego_x as i64, world.ego_y as i64), 328);
}

#[test]
fn budgeted_converges_to_sync_result() {
    let request = inputs(47.5, 11.5, 20.0, true);

    let mut reference = synthetic_manager(&[(47, 11, 100), (47, 12, 200)]);
    let expected = reference.update_sync(&request).unwrap();

    let mut budgeted = synthetic_manager(&[(47, 11, 100), (47, 12, 200)]);
    // one tile / one band per call: the region must publish only when complete
    let mut published = None;
    for _ in 0..64 {
        let snapshot = budgeted.update_budgeted(&request, 32, 1);
        if let Some(snapshot) = snapshot {
            published = Some(snapshot);
            break;
        }
    }
    let world = published.expect("budgeted region published");

    assert_eq!(world.width, expected.width);
    assert_eq!(world.height, expected.height);
    assert_eq!(world.elevations, expected.elevations);
    assert_eq!((world.sw_lat, world.sw_lon), (expected.sw_lat, expected.sw_lon));
    assert_eq!((world.ne_lat, world.ne_lon), (expected.ne_lat, expected.ne_lon));
    assert_eq!((world.ego_x, world.ego_y), (expected.ego_x, expected.ego_y));
}

#[test]
fn level_selection_matches_policy_table() {
    // shipped database resolution: 0.215 nm
    let r0 = 0.215f32 as f64 * 1852.0;
    for vd in [false, true] {
        for arc in [false, true] {
            for range in [10.0, 20.0, 40.0, 80.0, 160.0] {
                assert_eq!(display_level(range, arc, vd, r0), 0, "range {range} arc {arc} vd {vd}");
            }
            assert_eq!(display_level(320.0, arc, vd, r0), 1, "arc {arc} vd {vd}");
            assert_eq!(display_level(640.0, arc, vd, r0), 2, "arc {arc} vd {vd}");
        }
    }
}

#[test]
fn derived_levels_preserve_tile_maxima() {
    let mut manager = synthetic_manager(&[(47, 11, 100), (47, 12, 200)]);
    let l0 = manager.update_sync(&inputs(47.5, 11.5, 20.0, true)).unwrap();

    // synthetic DB resolution is 0.25 nm -> 463 m; 320 arc half_mpp -> L1
    let large = inputs(47.5, 11.5, 320.0, true);
    assert!(manager.side_covered(&large, 0), "warm-up covers every level");
    let l1 = manager.snapshot_for_side(&large, 0).expect("L1 view");

    // the L1 raster is its own rect at quarter the cell count — a different
    // buffer, half the per-tile dims (4x4 tiles -> 2x2)
    assert!(!Arc::ptr_eq(&l1.elevations, &l0.elevations));

    // per-tile max reduction: constant tiles are reduction-invariant, and a
    // tile's reduced cells never mix with the neighbour tile's
    assert_eq!(l1.extract_elevation(47.5, 47.5, 11.5), 328);
    assert_eq!(l1.extract_elevation(47.5, 47.5, 12.5), 656);
    assert_eq!(l1.extract_elevation(47.5, 47.5, 11.5 - 0.9), ELEV_WATER);

    // L2 likewise (640 rose selects it)
    let very_large = inputs(47.5, 11.5, 640.0, false);
    let l2 = manager.snapshot_for_side(&very_large, 0).expect("L2 view");
    assert_eq!(l2.extract_elevation(47.5, 47.5, 11.5), 328);
}

#[test]
fn mixed_sides_read_their_own_levels() {
    let mut manager = synthetic_manager(&[(47, 11, 100)]);
    // capt at 640 rose (L2), F/O at 10 arc (L0): per-side level views of the
    // one build
    let mixed = RegionInputs {
        ground_truth_lat: 47.5,
        ground_truth_lon: 11.5,
        vertical_display_required: false,
        sides: [
            SideGeom { nd_range: 640.0, arc_mode: false },
            SideGeom { nd_range: 10.0, arc_mode: true },
        ],
    };
    manager.update_sync(&mixed).unwrap();

    let capt = manager.snapshot_for_side(&mixed, 0).expect("capt raster");
    let fo = manager.snapshot_for_side(&mixed, 1).expect("fo raster");
    assert_eq!(capt.extract_elevation(47.5, 47.5, 11.5), 328);
    assert_eq!(fo.extract_elevation(47.5, 47.5, 11.5), 328);
    assert!(
        !Arc::ptr_eq(&capt.elevations, &fo.elevations),
        "capt (L2) view must not be the F/O (L0) view"
    );
    assert!(capt.elevations.len() < fo.elevations.len());
    assert!(manager.side_covered(&mixed, 0) && manager.side_covered(&mixed, 1));
}

#[test]
fn vertical_display_flag_grows_the_rasters_and_latches() {
    let mut manager = synthetic_manager(&[(47, 11, 100)]);
    // 640 rose reads the L2 raster — the level whose sizing the A380X's
    // 640 nm knob position drives
    let large_range = inputs(47.5, 11.5, 640.0, false);
    manager.update_sync(&large_range).unwrap();
    let small = manager.snapshot_for_side(&large_range, 0).expect("L2 view");

    let mut vd_inputs = large_range;
    vd_inputs.vertical_display_required = true;
    manager.update_sync(&vd_inputs).unwrap();
    let large = manager.snapshot_for_side(&vd_inputs, 0).expect("L2 view");
    assert!(
        large.width > small.width && large.height > small.height,
        "vertical-display L2 raster must out-size the A32NX one ({}x{} vs {}x{})",
        large.width,
        large.height,
        small.width,
        small.height
    );
    assert_eq!(large.extract_elevation(47.5, 47.5, 11.5), 328);

    // and it latches: dropping the flag must not shrink-rebuild the raster
    manager.update_sync(&large_range).unwrap();
    let after = manager.snapshot_for_side(&large_range, 0).expect("L2 view");
    assert_eq!((after.width, after.height), (large.width, large.height));
}

#[test]
fn drift_within_margin_keeps_region_then_rebuilds() {
    let mut manager = synthetic_manager(&[(47, 11, 100), (47, 12, 200), (50, 11, 300)]);
    let world = manager.update_sync(&inputs(47.5, 11.5, 20.0, true)).unwrap();
    let corners = (world.sw_lat, world.sw_lon, world.ne_lat, world.ne_lon);

    // drift inside the margin: same published rect (ego moves, corners do not)
    let world = manager.update_sync(&inputs(47.55, 11.5, 20.0, true)).unwrap();
    assert_eq!((world.sw_lat, world.sw_lon, world.ne_lat, world.ne_lon), corners);

    // relocation past the margin: new rect, terrain still resolves
    let world = manager.update_sync(&inputs(50.5, 11.5, 20.0, true)).unwrap();
    assert_ne!((world.sw_lat, world.sw_lon, world.ne_lat, world.ne_lon), corners);
    assert_eq!(world.extract_elevation(50.5, 50.5, 11.5), 984); // 300 m
}

#[test]
fn antimeridian_rect_covers_both_sides() {
    let mut manager = synthetic_manager(&[(0, 179, 100), (0, -180, 200)]);
    let world = manager.update_sync(&inputs(0.5, 179.9, 40.0, true)).expect("snapshot");

    // the near side resolves through the point probe...
    assert_eq!(world.extract_elevation(0.5, 0.5, 179.5), 328);
    // ...while the tile across the wrap is assembled into the raster (the
    // point probe itself has the v1 unwrapped-longitude-delta quirk, so it is
    // asserted via raster content instead)
    assert!(world.elevations.contains(&328));
    assert!(world.elevations.contains(&656));
    assert!(world.ego_x > 0.0 && (world.ego_x as usize) < world.width);
}

#[test]
fn polar_rect_stays_bounded() {
    let mut manager = synthetic_manager(&[(82, 11, 100)]);
    let world = manager.update_sync(&inputs(82.5, 11.5, 20.0, true)).expect("snapshot");

    assert!(world.height > 0 && world.width > 0);
    assert_eq!(world.extract_elevation(82.5, 82.5, 11.5), 328);
    // tile-free cells inside the rect are water like everywhere the
    // database has no tile
    assert_eq!(world.extract_elevation(82.5, 85.4, 11.5), ELEV_WATER);
    // the polar rect stays bounded around the aircraft: far-away longitudes
    // fall outside the raster -> unknown, never a panic
    assert_eq!(world.extract_elevation(82.5, 82.5, 150.0), ELEV_UNKNOWN);
}

#[test]
fn eviction_and_reload_after_relocation() {
    let mut manager = synthetic_manager(&[(47, 11, 100), (-40, -101, 500)]);
    manager.set_cache_limit(64); // a couple of 4x4 tiles at most

    let world = manager.update_sync(&inputs(47.5, 11.5, 20.0, true)).unwrap();
    assert_eq!(world.extract_elevation(47.5, 47.5, 11.5), 328);

    // fly far away (Innsbruck tiles evicted), then come back
    let world = manager.update_sync(&inputs(-39.5, -100.5, 20.0, true)).unwrap();
    assert_eq!(world.extract_elevation(-39.5, -39.5, -100.5), 1640); // 500 m
    let world = manager.update_sync(&inputs(47.5, 11.5, 20.0, true)).unwrap();
    assert_eq!(world.extract_elevation(47.5, 47.5, 11.5), 328);
}

#[test]
fn deferred_backend_converges_to_sync_result() {
    let request = inputs(47.5, 11.5, 20.0, true);

    let mut reference = synthetic_manager(&[(47, 11, 100), (47, 12, 200)]);
    let expected = reference.update_sync(&request).unwrap();

    // async transport with 3-poll latency, driven like the gauge would
    let mut deferred = synthetic_manager(&[(47, 11, 100), (47, 12, 200)]);
    deferred.use_deferred_io(3);
    let mut published = None;
    for _ in 0..256 {
        if let Some(snapshot) = deferred.update_budgeted(&request, 64, 1) {
            published = Some(snapshot);
            break;
        }
    }
    let world = published.expect("deferred region published");

    assert_eq!(world.elevations, expected.elevations);
    assert_eq!((world.width, world.height), (expected.width, expected.height));
    assert_eq!((world.sw_lat, world.sw_lon), (expected.sw_lat, expected.sw_lon));
    assert_eq!((world.ego_x, world.ego_y), (expected.ego_x, expected.ego_y));
}

/// The v3 grid-sort payoff: all contiguous present tiles of a rect row are
/// fetched with ONE transport read.
#[test]
fn row_reads_are_coalesced() {
    let mut manager = synthetic_manager(&[
        (47, 10, 100),
        (47, 11, 200),
        (47, 12, 300),
        (48, 11, 400),
    ]);
    manager.use_deferred_io(1);

    let request = inputs(47.5, 11.5, 20.0, true);
    let mut published = None;
    for _ in 0..256 {
        if let Some(snapshot) = manager.update_budgeted(&request, usize::MAX, usize::MAX) {
            published = Some(snapshot);
            break;
        }
    }
    let world = published.expect("region published");
    assert_eq!(world.extract_elevation(47.5, 47.5, 10.5), 328);
    assert_eq!(world.extract_elevation(47.5, 47.5, 11.5), 656);
    assert_eq!(world.extract_elevation(47.5, 47.5, 12.5), 984);
    assert_eq!(world.extract_elevation(47.5, 48.5, 11.5), 1312);

    let (ok, rejected, short, unknown_tiles) = manager.io_stats();
    assert_eq!(
        ok, 2,
        "3 contiguous tiles in one row + 1 in another row = exactly 2 coalesced reads"
    );
    assert_eq!((rejected, short, unknown_tiles), (0, 0, 0));
}

#[test]
fn stale_pending_build_is_abandoned_on_position_jump() {
    let mut manager = synthetic_manager(&[(47, 11, 100), (-40, -101, 500)]);
    manager.use_deferred_io(50); // slow transport: builds stay pending

    // start warming at Innsbruck, teleport away before anything completes
    let here = inputs(47.5, 11.5, 20.0, true);
    for _ in 0..4 {
        assert!(manager.update_budgeted(&here, 64, 1).is_none());
    }
    let there = inputs(-39.5, -100.5, 20.0, true);
    let mut published = None;
    for _ in 0..2048 {
        if let Some(snapshot) = manager.update_budgeted(&there, 64, 4) {
            published = Some(snapshot);
            break;
        }
    }
    // the new position publishes without first completing the stale build
    let world = published.expect("region at the new position published");
    assert!(manager.side_covered(&there, 0), "new position covered");
    assert_eq!(world.extract_elevation(-39.5, -39.5, -100.5), 1640); // 500 m
}

#[test]
fn range_changes_are_instant_once_the_raster_is_warm() {
    let mut manager = synthetic_manager(&[(47, 11, 100), (47, 12, 200)]);
    let both_small = RegionInputs {
        ground_truth_lat: 47.5,
        ground_truth_lon: 11.5,
        vertical_display_required: false,
        sides: [
            SideGeom { nd_range: 20.0, arc_mode: true },
            SideGeom { nd_range: 40.0, arc_mode: true },
        ],
    };
    manager.update_sync(&both_small).unwrap();

    // the raster is sized for the largest selectable range and the coarse
    // levels are derived from it: ANY range flip is covered immediately,
    // without loading a single tile
    for range in [10.0, 80.0, 160.0, 320.0, 640.0] {
        for arc in [false, true] {
            let flipped = RegionInputs {
                sides: [
                    SideGeom { nd_range: range, arc_mode: arc },
                    SideGeom { nd_range: 40.0, arc_mode: true },
                ],
                ..both_small
            };
            assert!(
                manager.side_covered(&flipped, 0),
                "range {range} arc {arc} must be instant"
            );
            assert!(manager.side_covered(&flipped, 1));
            assert!(manager.snapshot_for_side(&flipped, 0).is_some());
        }
    }
}

#[test]
fn cold_start_gates_only_unwarmed_levels() {
    let mut manager = synthetic_manager(&[(47, 11, 100), (47, 12, 200)]);
    manager.use_deferred_io(2);
    let both_small = RegionInputs {
        ground_truth_lat: 47.5,
        ground_truth_lon: 11.5,
        vertical_display_required: false,
        sides: [
            SideGeom { nd_range: 20.0, arc_mode: true },
            SideGeom { nd_range: 40.0, arc_mode: true },
        ],
    };
    assert!(!manager.side_covered(&both_small, 0), "cold start is gated");

    // drive until the displayed level (L0) is warm — L1/L2 may still be cold
    let mut warmed = false;
    for _ in 0..512 {
        manager.update_budgeted(&both_small, 64, 1);
        if manager.side_covered(&both_small, 0) {
            warmed = true;
            break;
        }
    }
    assert!(warmed, "displayed level warms first");
    assert!(manager.side_covered(&both_small, 1), "both displayed sides read L0");

    // the background warm-up completes the coarse levels without any large
    // range being selected; then a 320 nm flip is instant
    let capt_large = RegionInputs {
        sides: [
            SideGeom { nd_range: 320.0, arc_mode: true },
            SideGeom { nd_range: 40.0, arc_mode: true },
        ],
        ..both_small
    };
    let mut guard = 0;
    while !manager.covered(&capt_large) {
        manager.update_budgeted(&both_small, usize::MAX, usize::MAX);
        guard += 1;
        assert!(guard < 512, "background warm-up never finished");
    }
    assert!(manager.side_covered(&capt_large, 0) && manager.side_covered(&capt_large, 1));
}

#[test]
fn transient_read_failures_retry_without_unknown_patches() {
    let mut manager = synthetic_manager(&[(47, 11, 100), (47, 12, 200)]);
    // the first 3 completions fail (simulated transport hiccups)
    manager.use_deferred_io_failing(2, 3);

    let request = inputs(47.5, 11.5, 20.0, true);
    let mut published = None;
    for _ in 0..512 {
        if let Some(snapshot) = manager.update_budgeted(&request, 256, 1) {
            published = Some(snapshot);
            break;
        }
    }
    let world = published.expect("region published despite transient failures");

    // retried reads must fill every cell — no Unknown patch may publish
    assert!(!world.elevations.contains(&ELEV_UNKNOWN), "transient failures leaked Unknown");
    assert_eq!(world.extract_elevation(47.5, 47.5, 11.5), 328);
    let (ok, _rejected, short, unknown_tiles) = manager.io_stats();
    assert!(ok >= 1, "retried reads eventually succeed");
    assert!(short >= 3, "failures were seen");
    assert_eq!(unknown_tiles, 0, "no tile may be given up");
}

#[test]
fn persistent_read_failures_degrade_to_unknown_without_deadlock() {
    let mut manager = synthetic_manager(&[(47, 11, 100), (47, 12, 200)]);
    // every completion fails: tiles exhaust their attempts
    manager.use_deferred_io_failing(1, u32::MAX);

    let request = inputs(47.5, 11.5, 20.0, true);
    let mut published = None;
    for _ in 0..2048 {
        if let Some(snapshot) = manager.update_budgeted(&request, 256, 4) {
            published = Some(snapshot);
            break;
        }
    }
    // the region must still publish (Unknown where tiles are unreadable)
    // rather than blocking the display forever
    let world = published.expect("region published despite dead transport");
    assert!(world.elevations.contains(&ELEV_UNKNOWN));
    let (_, _, _, unknown_tiles) = manager.io_stats();
    assert!(unknown_tiles >= 2);
}

/// The wasm heap never shrinks, so replaced rasters must be RECYCLED, not
/// freed — even when a renderer snapshot still holds the old buffer at
/// publish time (the reclaim list recovers it once the snapshot drops).
#[test]
fn replaced_rasters_are_recycled_after_snapshots_release() {
    let mut manager = synthetic_manager(&[(47, 11, 100), (47, 40, 200)]);
    let a = manager.update_sync(&inputs(47.5, 11.5, 20.0, true)).unwrap();
    let ptr_a = a.elevations.as_ptr();

    // relocate while `a` is still held: the publish cannot unwrap the old
    // raster and must park it for reclamation
    let b = manager.update_sync(&inputs(47.5, 40.5, 20.0, true)).unwrap();
    assert_ne!(b.elevations.as_ptr(), ptr_a);
    assert_eq!(b.extract_elevation(47.5, 47.5, 40.5), 656);
    drop(a);

    // the next rebuild (same latitude -> same dims) must reuse the
    // recovered allocation instead of growing the heap
    let c = manager.update_sync(&inputs(47.5, 11.5, 20.0, true)).unwrap();
    assert_eq!(
        c.elevations.as_ptr(),
        ptr_a,
        "released raster buffer must be recycled into the next build"
    );
    assert_eq!(c.extract_elevation(47.5, 47.5, 11.5), 328);
}

#[test]
fn snapshot_survives_between_updates() {
    let mut manager = synthetic_manager(&[(47, 11, 100)]);
    manager.update_sync(&inputs(47.5, 11.5, 20.0, true)).unwrap();
    let world = manager.snapshot().expect("published snapshot");
    assert_eq!(world.extract_elevation(47.5, 47.5, 11.5), 328);
}
