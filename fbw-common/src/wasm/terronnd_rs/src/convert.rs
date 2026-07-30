//! Build-time v1 `terrain.map` -> `terrain2.map` conversion (host only; the
//! wasm gauge only ever reads the converted file via fileformat_v2.rs).
//!
//! A pure repack: every compressed payload is copied verbatim from v1 (the
//! content is v1-identical by construction), written in ascending
//! (row, col) directory order — the grid-sort contract that lets the region
//! loader read a whole rect row with one coalesced request.

use std::io::{Read, Seek, SeekFrom, Write};

use crate::fileformat::TerrainMap;
use crate::fileformat_v2::{
    PayloadRef, TileRecord, V2Header, V2_HEADER_BYTES, V2_RECORD_BYTES, V2_VERSION,
};

fn other(message: String) -> std::io::Error {
    std::io::Error::other(message)
}

/// Convert an opened v1 database into the v2 layout. `progress` is called with
/// `(tiles_done, tiles_total)` after every tile.
pub fn convert_v1_to_v2(
    v1: &TerrainMap,
    out: &mut (impl Write + Seek),
    mut progress: impl FnMut(usize, usize),
) -> std::io::Result<()> {
    let step_lat = v1.header.angular_step_lat;
    let step_lon = v1.header.angular_step_lon;
    let dir_rows = (180.0 / step_lat as f64).ceil() as u32;
    let dir_cols = (360.0 / step_lon as f64).ceil() as u32;
    let dir_bytes = dir_rows as usize * dir_cols as usize * V2_RECORD_BYTES;

    let mut header = V2Header {
        lat_min: v1.header.lat_min,
        lat_max: v1.header.lat_max,
        lon_min: v1.header.lon_min,
        lon_max: v1.header.lon_max,
        angular_step_lat: step_lat,
        angular_step_lon: step_lon,
        // exact inverse of the v1 parse (f32 -> f64 * 1852 is lossless)
        horizontal_resolution_nm: (v1.header.horizontal_resolution_m / 1852.0) as f32,
        level_count: 1,
        file_length: 0, // patched at the end
        dir_rows,
        dir_cols,
    };
    debug_assert_eq!(V2_VERSION, 3);

    // placeholder header + zeroed directory; both rewritten once offsets are known
    out.write_all(&header.to_bytes())?;
    out.write_all(&vec![0u8; dir_bytes])?;

    // grid-sort: v1 stores tiles in arbitrary file order, v2 payloads must
    // ascend in (row, col) so a directory row is one contiguous byte range
    let cell_of = |tile_index: usize| -> (usize, usize) {
        let tile = &v1.tiles[tile_index];
        let row = ((tile.sw_lat as f64 + 90.0) / step_lat as f64).floor() as usize;
        let col = ((tile.sw_lon as f64 + 180.0) / step_lon as f64).floor() as usize;
        (row, col)
    };
    let mut order: Vec<usize> = (0..v1.tiles.len()).collect();
    order.sort_by_key(|&tile_index| cell_of(tile_index));

    let mut directory = vec![TileRecord::EMPTY; dir_rows as usize * dir_cols as usize];
    let mut cursor = (V2_HEADER_BYTES + dir_bytes) as u64;
    let tile_count = v1.tiles.len();

    for (done, &tile_index) in order.iter().enumerate() {
        let tile = &v1.tiles[tile_index];
        let (row, col) = cell_of(tile_index);
        let cell = row * dir_cols as usize + col;

        let raw = v1
            .raw_tile_payload(tile_index)
            .map_err(|e| other(format!("tile {tile_index}: {e}")))?;
        let offset = u32::try_from(cursor)
            .map_err(|_| other("terrain2.map exceeds the 4 GiB u32 offset space".into()))?;
        out.write_all(&raw)?;
        cursor += raw.len() as u64;

        directory[cell] = TileRecord {
            rows: tile.rows,
            cols: tile.columns,
            payload: PayloadRef {
                offset,
                len: raw.len() as u32,
            },
        };
        progress(done + 1, tile_count);
    }

    // patch the directory and the final header (now with the true length)
    header.file_length = cursor;
    out.seek(SeekFrom::Start(0))?;
    out.write_all(&header.to_bytes())?;
    for record in &directory {
        out.write_all(&record.to_bytes())?;
    }
    out.flush()?;
    Ok(())
}

/// Cheap validity probe used by the build script (`--check`): magic, version
/// and recorded-vs-actual length. Payload integrity is left to the reader.
pub fn check_v2(path: &str) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(actual_len) = file.seek(SeekFrom::End(0)) else {
        return false;
    };
    if file.seek(SeekFrom::Start(0)).is_err() {
        return false;
    }
    let mut header = [0u8; V2_HEADER_BYTES];
    if file.read_exact(&mut header).is_err() {
        return false;
    }
    header[0..4] == *b"FBT2"
        && u16::from_le_bytes([header[4], header[5]]) == V2_VERSION
        && u64::from_le_bytes(header[24..32].try_into().unwrap()) == actual_len
}
