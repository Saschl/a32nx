//! Cost decomposition for the ND extraction — run explicitly:
//!   cargo test -p terronnd --release --test bench_extract -- --nocapture --ignored
//! Needs the converted database at repo-root `cache/terrain2.map` (produced by
//! `scripts/terrain_map.js` or the golden test).

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use terronnd::block_map::extract_block_maxima;
use terronnd::elevation_map::{extract_local_elevation_map, metres_per_pixel};
use terronnd::fileformat_v2::TerrainMapV2;
use terronnd::region::{RegionInputs, RegionManager, SideGeom};
use terronnd::state::nd_map_geometry;
use terronnd::worldmap::WorldMap;

fn database_path() -> Option<String> {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../cache/terrain2.map");
    if repo.is_file() {
        return Some(repo.to_string_lossy().into_owned());
    }
    None
}

/// Tiny L1-resident world: same math per pixel, near-zero memory cost.
fn tiny_world() -> WorldMap {
    let width = 64;
    let height = 64;
    WorldMap {
        sw_lat: 40.0,
        sw_lon: 4.0,
        ne_lat: 54.0,
        ne_lon: 18.0,
        width,
        height,
        elevations: Arc::new(vec![100i16; width * height]),
        ground_truth_lat: 47.26081,
        ground_truth_lon: 11.34966,
        ego_x: 32.0,
        ego_y: 32.0,
    }
}

#[test]
#[ignore]
fn decompose_extraction_cost() {
    let Some(db) = database_path() else {
        eprintln!("no cache/terrain2.map — skipping");
        return;
    };
    let mut manager = RegionManager::new(TerrainMapV2::open(&db).unwrap());

    let geometry = nd_map_geometry(true, false); // A32NX arc 756x492
    let pixels = geometry.width * geometry.height;

    let bench = |label: &str, world: &WorldMap, range: f64, iterations: u32| {
        let mpp = metres_per_pixel(range, &geometry, true);
        // warm-up
        let _ = extract_local_elevation_map(world, 47.26081, 11.34966, 260.0, &geometry, mpp, true);
        let start = Instant::now();
        for _ in 0..iterations {
            let _ =
                extract_local_elevation_map(world, 47.26081, 11.34966, 260.0, &geometry, mpp, true);
        }
        let total_ms = start.elapsed().as_secs_f64() * 1000.0 / iterations as f64;
        println!(
            "{label:28} range {range:5.0} nm: {total_ms:6.2} ms/extract ({:5.1} ns/px)",
            total_ms * 1e6 / pixels as f64
        );
    };

    bench("math only (tiny world)", &tiny_world(), 20.0, 20);
    for range in [10.0, 20.0, 40.0, 80.0, 160.0, 320.0, 640.0] {
        // A380X-capability sizing (640 nm knob) so the raster covers every
        // benched range — the worst-case single full-resolution raster
        let inputs = RegionInputs {
            ground_truth_lat: 47.26081,
            ground_truth_lon: 11.34966,
            vertical_display_required: true,
            sides: [SideGeom { nd_range: range, arc_mode: true }; 2],
        };
        let world = manager.update_sync(&inputs).unwrap();
        let label = format!(
            "region {}x{} ({} MB)",
            world.width,
            world.height,
            world.width * world.height * 2 / 1_000_000
        );
        bench(&label, &world, range, 10);

        // production path: block-native footprint maxima
        let mpp = metres_per_pixel(range, &geometry, true);
        let _ = extract_block_maxima(&world, 47.26081, 11.34966, 260.0, &geometry, mpp, true);
        let start = Instant::now();
        let iterations = 20;
        for _ in 0..iterations {
            let _ =
                extract_block_maxima(&world, 47.26081, 11.34966, 260.0, &geometry, mpp, true);
        }
        let total_ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iterations);
        println!("{:28} range {range:5.0} nm: {total_ms:6.2} ms/extract", "block-native");
    }
}
