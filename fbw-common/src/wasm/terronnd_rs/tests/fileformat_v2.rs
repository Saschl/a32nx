//! terrain2.map format: converter/reader round trips, verbatim-copy
//! faithfulness against v1, and the grid-sort payload contract.

use std::io::{Cursor, Write};

use terronnd::convert::{check_v2, convert_v1_to_v2};
use terronnd::fileformat::{ParseError, TerrainMap, ELEV_WATER};
use terronnd::fileformat_v2::{TerrainMapV2, V2_HEADER_BYTES, V2_RECORD_BYTES};

struct V1Tile {
    sw_lat: i8,
    sw_lon: i16,
    rows: u16,
    cols: u16,
    metres: Vec<i16>,
}

/// Deterministic terrain with negatives (below sea level) and water sprinkled
/// in.
fn terrain_pattern(rows: u16, cols: u16, seed: i16) -> Vec<i16> {
    let mut cells = Vec::with_capacity(rows as usize * cols as usize);
    for y in 0..rows as i32 {
        for x in 0..cols as i32 {
            if (x + y) % 13 == 0 {
                cells.push(ELEV_WATER);
            } else {
                cells.push((((y * 31 + x * 17 + seed as i32) % 997) - 200) as i16);
            }
        }
    }
    cells
}

/// Synthetic v1 terrain.map bytes (1x1 degree steps, 0.25 nm resolution).
fn synthetic_v1(tiles: &[V1Tile]) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(&(-90i16).to_le_bytes());
    data.extend_from_slice(&90i16.to_le_bytes());
    data.extend_from_slice(&(-180i16).to_le_bytes());
    data.extend_from_slice(&180i16.to_le_bytes());
    data.push(1);
    data.push(1);
    data.extend_from_slice(&0.25f32.to_le_bytes());

    for tile in tiles {
        assert_eq!(tile.metres.len(), tile.rows as usize * tile.cols as usize);
        let mut raw = Vec::new();
        for &metres in &tile.metres {
            raw.extend_from_slice(&metres.to_le_bytes());
        }
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).unwrap();
        let compressed = encoder.finish().unwrap();

        data.extend_from_slice(&tile.rows.to_le_bytes());
        data.extend_from_slice(&tile.cols.to_le_bytes());
        data.push(tile.sw_lat as u8);
        data.extend_from_slice(&tile.sw_lon.to_le_bytes());
        data.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        data.extend_from_slice(&compressed);
    }
    data
}

fn convert(v1_bytes: &[u8]) -> (TerrainMap, Vec<u8>) {
    let v1 = TerrainMap::from_bytes(v1_bytes.to_vec()).unwrap();
    let mut out = Cursor::new(Vec::new());
    convert_v1_to_v2(&v1, &mut out, |_, _| {}).unwrap();
    (v1, out.into_inner())
}

/// Deliberately NOT in grid order — the converter must sort.
fn test_tiles() -> Vec<V1Tile> {
    vec![
        // odd dims like the real DB
        V1Tile { sw_lat: 47, sw_lon: 12, rows: 279, cols: 279, metres: terrain_pattern(279, 279, 7) },
        V1Tile { sw_lat: 47, sw_lon: 11, rows: 16, cols: 16, metres: terrain_pattern(16, 16, 100) },
        // corner cell of the directory
        V1Tile { sw_lat: -90, sw_lon: -180, rows: 4, cols: 5, metres: terrain_pattern(4, 5, 3) },
    ]
}

#[test]
fn header_and_directory_round_trip() {
    let (_, v2_bytes) = convert(&synthetic_v1(&test_tiles()));
    let v2 = TerrainMapV2::from_bytes(v2_bytes).unwrap();

    assert_eq!(v2.header.lat_min, -90);
    assert_eq!(v2.header.lat_max, 90);
    assert_eq!(v2.header.lon_min, -180);
    assert_eq!(v2.header.lon_max, 180);
    assert_eq!(v2.header.angular_step_lat, 1);
    assert_eq!(v2.header.angular_step_lon, 1);
    assert_eq!(v2.header.horizontal_resolution_nm, 0.25);
    assert_eq!(v2.header.horizontal_resolution_m(), 0.25 * 1852.0);
    assert_eq!(v2.header.level_count, 1);
    assert_eq!(v2.header.dir_rows, 180);
    assert_eq!(v2.header.dir_cols, 360);

    // populated cells at (sw_lat + 90, sw_lon + 180)
    let innsbruck = v2.record(137, 192).expect("47N 12E");
    assert_eq!((innsbruck.rows, innsbruck.cols), (279, 279));
    let corner = v2.record(0, 0).expect("90S 180W");
    assert_eq!((corner.rows, corner.cols), (4, 5));

    // empty and out-of-range cells
    assert!(v2.record(137, 193).is_none());
    assert!(v2.record(0, 1).is_none());
    assert!(v2.record(180, 0).is_none());
    assert!(v2.record(0, 360).is_none());
}

#[test]
fn payloads_are_verbatim_v1_and_feet_identical() {
    let tiles = test_tiles();
    let (v1, v2_bytes) = convert(&synthetic_v1(&tiles));
    let v2 = TerrainMapV2::from_bytes(v2_bytes.clone()).unwrap();

    for (index, tile) in tiles.iter().enumerate() {
        let row = (tile.sw_lat as i32 + 90) as usize;
        let col = (tile.sw_lon as i32 + 180) as usize;
        let record = v2.record(row, col).expect("tile present");

        // feet values equal through the shared conversion path
        assert_eq!(
            v2.load_tile_feet(record).unwrap(),
            v1.load_tile_feet(index).unwrap(),
            "tile {index} feet"
        );

        // and the compressed bytes are the v1 bytes, verbatim
        let payload = record.payload;
        let v2_slice = &v2_bytes[payload.offset as usize..(payload.offset + payload.len) as usize];
        assert_eq!(
            v2_slice,
            v1.raw_tile_payload(index).unwrap().as_slice(),
            "tile {index} bytes"
        );
    }
}

/// The grid-sort contract the region loader's coalesced row reads rely on:
/// payload offsets ascend in (row, col) directory order, regardless of the
/// v1 file order.
#[test]
fn payloads_are_grid_sorted() {
    let (_, v2_bytes) = convert(&synthetic_v1(&test_tiles()));
    let v2 = TerrainMapV2::from_bytes(v2_bytes).unwrap();

    let mut previous_end = 0u64;
    for row in 0..180 {
        for col in 0..360 {
            if let Some(record) = v2.record(row, col) {
                assert!(
                    record.payload.offset as u64 >= previous_end,
                    "payload at ({row},{col}) not grid-sorted"
                );
                previous_end = record.payload.offset as u64 + record.payload.len as u64;
            }
        }
    }
    assert!(previous_end > 0, "no tiles seen");
}

#[test]
fn corruption_is_rejected() {
    let (_, v2_bytes) = convert(&synthetic_v1(&test_tiles()));

    // truncation -> length mismatch
    let truncated = v2_bytes[..v2_bytes.len() - 10].to_vec();
    assert!(matches!(
        TerrainMapV2::from_bytes(truncated),
        Err(ParseError::LengthMismatch { .. })
    ));

    // wrong magic
    let mut bad_magic = v2_bytes.clone();
    bad_magic[0] = b'X';
    assert!(matches!(
        TerrainMapV2::from_bytes(bad_magic),
        Err(ParseError::BadMagic)
    ));

    // stale version (a leftover v2 mip-format file must be rejected)
    let mut bad_version = v2_bytes.clone();
    bad_version[4] = 2;
    assert!(matches!(
        TerrainMapV2::from_bytes(bad_version),
        Err(ParseError::UnsupportedVersion { version: 2 })
    ));

    // shorter than the header
    assert!(matches!(
        TerrainMapV2::from_bytes(v2_bytes[..V2_HEADER_BYTES - 1].to_vec()),
        Err(ParseError::TruncatedHeader)
    ));

    let _ = V2_RECORD_BYTES; // layout constant exercised via record addressing above
}

#[test]
fn check_v2_validates_files_on_disk() {
    let (_, v2_bytes) = convert(&synthetic_v1(&test_tiles()));

    let dir = std::env::temp_dir();
    let good = dir.join(format!("terronnd_v2_good_{}.map", std::process::id()));
    let bad = dir.join(format!("terronnd_v2_bad_{}.map", std::process::id()));
    std::fs::write(&good, &v2_bytes).unwrap();
    std::fs::write(&bad, &v2_bytes[..v2_bytes.len() - 1]).unwrap();

    assert!(check_v2(good.to_str().unwrap()));
    assert!(!check_v2(bad.to_str().unwrap()));
    assert!(!check_v2(dir.join("terronnd_v2_missing.map").to_str().unwrap()));

    let _ = std::fs::remove_file(good);
    let _ = std::fs::remove_file(bad);
}

#[test]
fn open_streams_from_disk_like_from_bytes() {
    let tiles = test_tiles();
    let (_, v2_bytes) = convert(&synthetic_v1(&tiles));

    let path = std::env::temp_dir().join(format!("terronnd_v2_open_{}.map", std::process::id()));
    std::fs::write(&path, &v2_bytes).unwrap();

    let streamed = TerrainMapV2::open(path.to_str().unwrap()).unwrap();
    let in_memory = TerrainMapV2::from_bytes(v2_bytes).unwrap();
    assert_eq!(streamed.header, in_memory.header);
    for tile in &tiles {
        let row = (tile.sw_lat as i32 + 90) as usize;
        let col = (tile.sw_lon as i32 + 180) as usize;
        let record = streamed.record(row, col).unwrap();
        assert_eq!(Some(record), in_memory.record(row, col));
        assert_eq!(
            streamed.load_tile_feet(record).unwrap(),
            in_memory.load_tile_feet(record).unwrap()
        );
    }

    let _ = std::fs::remove_file(path);
}
