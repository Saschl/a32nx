use std::io::Write;

use terronnd::fileformat::{world_to_grid_indices, TerrainMap, ELEV_WATER};

/// Build a synthetic terrain.map with the given tiles: (sw_lat, sw_lon, rows, columns, elevations_in_metres).
fn synthetic_map(tiles: &[(i8, i16, u16, u16, Vec<i16>)]) -> Vec<u8> {
    let mut data = Vec::new();
    // file header: lat [-90, 90], lon [-180, 180], 1x1 degree tiles, 0.25 NM resolution
    data.extend_from_slice(&(-90i16).to_le_bytes());
    data.extend_from_slice(&90i16.to_le_bytes());
    data.extend_from_slice(&(-180i16).to_le_bytes());
    data.extend_from_slice(&180i16.to_le_bytes());
    data.push(1);
    data.push(1);
    data.extend_from_slice(&0.25f32.to_le_bytes());
    assert_eq!(data.len(), 14);

    for (sw_lat, sw_lon, rows, columns, elevations) in tiles {
        assert_eq!(elevations.len(), *rows as usize * *columns as usize);
        let mut raw = Vec::new();
        for e in elevations {
            raw.extend_from_slice(&e.to_le_bytes());
        }
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).unwrap();
        let compressed = encoder.finish().unwrap();

        data.extend_from_slice(&rows.to_le_bytes());
        data.extend_from_slice(&columns.to_le_bytes());
        data.push(*sw_lat as u8);
        data.extend_from_slice(&sw_lon.to_le_bytes());
        data.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        data.extend_from_slice(&compressed);
    }
    data
}

#[test]
fn parses_header_and_tile_index() {
    let bytes = synthetic_map(&[
        (47, 11, 2, 3, vec![100, 200, 300, -1, 0, 580]),
        (48, 12, 3, 2, vec![-430, 10, 20, 30, 40, 50]),
    ]);
    let map = TerrainMap::from_bytes(bytes).unwrap();

    assert_eq!(map.header.lat_min, -90);
    assert_eq!(map.header.lat_max, 90);
    assert_eq!(map.header.lon_min, -180);
    assert_eq!(map.header.lon_max, 180);
    assert_eq!(map.header.angular_step_lat, 1);
    assert_eq!(map.header.angular_step_lon, 1);
    assert!((map.header.horizontal_resolution_m - 463.0).abs() < 1e-9);

    assert_eq!(map.tiles.len(), 2);
    assert_eq!(map.tile_at_southwest(47, 11), Some(0));
    assert_eq!(map.tile_at_southwest(48, 12), Some(1));
    assert_eq!(map.tile_at_southwest(0, 0), None);

    // containment: (47.5, 11.5) lives in the (47, 11) tile
    assert_eq!(map.tile_containing(47.5, 11.5), Some(0));
    assert_eq!(map.tile_containing(48.01, 12.99), Some(1));
    assert_eq!(map.tile_containing(-33.9, 18.4), None);
}

#[test]
fn converts_metres_to_feet_keeping_water() {
    let bytes = synthetic_map(&[(47, 11, 2, 3, vec![100, 200, 300, -1, 0, 580])]);
    let map = TerrainMap::from_bytes(bytes).unwrap();
    let feet = map.load_tile_feet(0).unwrap();

    // Math.round(m * 3.28084)
    assert_eq!(feet, vec![328, 656, 984, ELEV_WATER, 0, 1903]);
}

#[test]
fn negative_elevations_round_like_js() {
    // Dead Sea: -430 m -> -1410.7612 -> Math.round -> -1411 (floor(x + 0.5))
    let bytes = synthetic_map(&[(31, 35, 1, 1, vec![-430])]);
    let map = TerrainMap::from_bytes(bytes).unwrap();
    assert_eq!(map.load_tile_feet(0).unwrap(), vec![-1411]);
}

#[test]
fn rejects_truncated_files() {
    assert!(TerrainMap::from_bytes(vec![0; 10]).is_err());

    let mut bytes = synthetic_map(&[(47, 11, 2, 3, vec![100, 200, 300, -1, 0, 580])]);
    bytes.truncate(bytes.len() - 4);
    assert!(TerrainMap::from_bytes(bytes).is_err());
}

#[test]
fn grid_indices_row_zero_is_north() {
    // 4x4 grid over the (47, 11)..(48, 12) tile
    let (row, col) = world_to_grid_indices(4, 4, 47.0, 11.0, 48.0, 12.0, 47.99, 11.01);
    assert_eq!((row, col), (0, 0)); // NW corner
    let (row, col) = world_to_grid_indices(4, 4, 47.0, 11.0, 48.0, 12.0, 47.01, 11.99);
    assert_eq!((row, col), (3, 3)); // SE corner
    let (row, col) = world_to_grid_indices(4, 4, 47.0, 11.0, 48.0, 12.0, 47.5, 11.5);
    assert_eq!((row, col), (1, 2));
}

/// Smoke test against the real database; set SIMBRIDGE_TERRAIN_MAP to run it.
#[test]
fn real_database_smoke() {
    let Ok(path) = std::env::var("SIMBRIDGE_TERRAIN_MAP") else {
        eprintln!("SIMBRIDGE_TERRAIN_MAP not set — skipping");
        return;
    };
    let map = TerrainMap::from_bytes(std::fs::read(path).unwrap()).unwrap();

    assert_eq!(map.header.angular_step_lat, 1);
    assert_eq!(map.header.angular_step_lon, 1);
    assert!(map.tiles.len() > 10_000, "expected a global-ish tile set");

    // Innsbruck valley floor is ~1900 ft; the tile max should be alpine (>7000 ft)
    let idx = map.tile_containing(47.26081, 11.34966).expect("Alps tile present");
    let feet = map.load_tile_feet(idx).unwrap();
    let max = feet.iter().copied().max().unwrap();
    assert!(max > 7000, "Alps tile max elevation {max} ft looks wrong");
}

/// The streamed file backend must be byte-identical to the in-memory backend.
#[test]
fn streamed_backend_matches_memory_backend() {
    let bytes = synthetic_map(&[
        (47, 11, 2, 3, vec![100, 200, 300, -1, 0, 580]),
        (48, 12, 3, 2, vec![-430, 10, 20, 30, 40, 50]),
        (31, 35, 1, 1, vec![-430]),
    ]);

    let path = std::env::temp_dir().join("terronnd_streamed_backend_test.map");
    std::fs::write(&path, &bytes).unwrap();

    let memory = TerrainMap::from_bytes(bytes).unwrap();
    let streamed = TerrainMap::open(path.to_str().unwrap()).unwrap();

    assert_eq!(memory.header, streamed.header);
    assert_eq!(memory.tiles, streamed.tiles);
    for tile_index in 0..memory.tiles.len() {
        assert_eq!(
            memory.load_tile_feet(tile_index).unwrap(),
            streamed.load_tile_feet(tile_index).unwrap(),
            "tile {tile_index} differs between backends"
        );
    }
    // out-of-order re-reads must work (the gauge seeks arbitrarily)
    assert_eq!(
        memory.load_tile_feet(0).unwrap(),
        streamed.load_tile_feet(0).unwrap()
    );

    std::fs::remove_file(&path).ok();
}

#[test]
fn open_rejects_truncated_files() {
    let mut bytes = synthetic_map(&[(47, 11, 2, 3, vec![100, 200, 300, -1, 0, 580])]);
    bytes.truncate(bytes.len() - 4);
    let path = std::env::temp_dir().join("terronnd_truncated_test.map");
    std::fs::write(&path, &bytes).unwrap();
    assert!(TerrainMap::open(path.to_str().unwrap()).is_err());
    std::fs::remove_file(&path).ok();
}
