//! Reader for the gauge-native `terrain2.map` database — the v1 SimBridge
//! `terrain.map` repacked at build time (`convert.rs` via the
//! `terrain_map_convert` bin).
//!
//! What the conversion buys over v1:
//! - a flat tile directory up front, so `open()` is two reads (a 40-byte
//!   header and the ~760 KB directory) instead of walking every tile header
//!   of the 232 MB file;
//! - payloads are written GRID-SORTED (ascending tile row, then column), so
//!   all present tiles of one directory row occupy one contiguous byte range
//!   and the region loader can fetch a whole rect row with a single read;
//! - payload bytes are copied verbatim from v1 at conversion time, so the
//!   content is v1-identical by construction.
//!
//! Format version 3 dropped the mip levels of version 2: block-native ND
//! extraction reads every database cell under a block anyway, so the
//! reductions no longer bought peak-safety, only memory locality.
//!
//! Layout (all little-endian):
//! - 40-byte header: magic "FBT2" @0, version u16 @4, lat_min i16 @6,
//!   lat_max i16 @8, lon_min i16 @10, lon_max i16 @12, angular_step_lat u8
//!   @14, angular_step_lon u8 @15, horizontal_resolution f32 @16 (nautical
//!   miles, raw copy of the v1 field), level_count u8 @20 (= 1), reserved
//!   [u8; 3] @21, file_length u64 @24, dir_rows u32 @32, dir_cols u32 @36.
//! - directory: `dir_rows * dir_cols` records of 12 bytes (rows u16, cols
//!   u16, payload_offset u32, payload_len u32), row-major with
//!   `row = (sw_lat + 90) / step`, `col = (sw_lon + 180) / step` (row 0 =
//!   southernmost — the `world_map_indices` orientation). `rows == 0` marks
//!   an empty cell (no tile in the database).
//! - payloads: back-to-back gzip streams of i16 METRES grids, row-major with
//!   row 0 at the tile's NORTH edge (v1 orientation); water = -1. Written in
//!   ascending (row, col) directory order — the grid-sort contract above.

use std::cell::RefCell;
use std::io::{BufReader, Read, Seek, SeekFrom};

use crate::fileformat::{feet_from_metres_cell, ParseError};

/// File backend: `std::fs` on the host, the SDK-libc wrapper in the sim (see
/// fileformat.rs / cfile.rs).
#[cfg(target_arch = "wasm32")]
use crate::cfile::CFile as MapFile;
#[cfg(not(target_arch = "wasm32"))]
use std::fs::File as MapFile;

pub const V2_MAGIC: [u8; 4] = *b"FBT2";
/// Format version 3: single level (no mips), grid-sorted payloads, 12-byte
/// directory records. Version 2 files are rejected so a stale terrain2.map
/// forces a reconversion at build time.
pub const V2_VERSION: u16 = 3;
pub const V2_HEADER_BYTES: usize = 40;
pub const V2_RECORD_BYTES: usize = 12;

#[derive(Debug, Clone, PartialEq)]
pub struct V2Header {
    pub lat_min: i16,
    pub lat_max: i16,
    pub lon_min: i16,
    pub lon_max: i16,
    pub angular_step_lat: u8,
    pub angular_step_lon: u8,
    /// Raw nautical-mile f32 exactly as stored in v1.
    pub horizontal_resolution_nm: f32,
    pub level_count: u8,
    pub file_length: u64,
    pub dir_rows: u32,
    pub dir_cols: u32,
}

impl V2Header {
    /// Metres, converted like the v1 header (`readFloatLE * 1852`).
    pub fn horizontal_resolution_m(&self) -> f64 {
        self.horizontal_resolution_nm as f64 * 1852.0
    }

    pub fn to_bytes(&self) -> [u8; V2_HEADER_BYTES] {
        let mut b = [0u8; V2_HEADER_BYTES];
        b[0..4].copy_from_slice(&V2_MAGIC);
        b[4..6].copy_from_slice(&V2_VERSION.to_le_bytes());
        b[6..8].copy_from_slice(&self.lat_min.to_le_bytes());
        b[8..10].copy_from_slice(&self.lat_max.to_le_bytes());
        b[10..12].copy_from_slice(&self.lon_min.to_le_bytes());
        b[12..14].copy_from_slice(&self.lon_max.to_le_bytes());
        b[14] = self.angular_step_lat;
        b[15] = self.angular_step_lon;
        b[16..20].copy_from_slice(&self.horizontal_resolution_nm.to_le_bytes());
        b[20] = self.level_count;
        b[24..32].copy_from_slice(&self.file_length.to_le_bytes());
        b[32..36].copy_from_slice(&self.dir_rows.to_le_bytes());
        b[36..40].copy_from_slice(&self.dir_cols.to_le_bytes());
        b
    }

    fn from_bytes(b: &[u8; V2_HEADER_BYTES], actual_len: u64) -> Result<Self, ParseError> {
        if b[0..4] != V2_MAGIC {
            return Err(ParseError::BadMagic);
        }
        let version = u16::from_le_bytes([b[4], b[5]]);
        if version != V2_VERSION {
            return Err(ParseError::UnsupportedVersion { version });
        }
        let header = Self {
            lat_min: i16::from_le_bytes([b[6], b[7]]),
            lat_max: i16::from_le_bytes([b[8], b[9]]),
            lon_min: i16::from_le_bytes([b[10], b[11]]),
            lon_max: i16::from_le_bytes([b[12], b[13]]),
            angular_step_lat: b[14],
            angular_step_lon: b[15],
            horizontal_resolution_nm: f32::from_le_bytes([b[16], b[17], b[18], b[19]]),
            level_count: b[20],
            file_length: u64::from_le_bytes(b[24..32].try_into().unwrap()),
            dir_rows: u32::from_le_bytes([b[32], b[33], b[34], b[35]]),
            dir_cols: u32::from_le_bytes([b[36], b[37], b[38], b[39]]),
        };
        if header.file_length != actual_len {
            return Err(ParseError::LengthMismatch {
                expected: header.file_length,
                actual: actual_len,
            });
        }
        Ok(header)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PayloadRef {
    pub offset: u32,
    pub len: u32,
}

/// One directory cell. `rows == 0 || cols == 0` marks an empty cell —
/// `TerrainMapV2::record` returns `None` for those.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileRecord {
    pub rows: u16,
    pub cols: u16,
    pub payload: PayloadRef,
}

impl TileRecord {
    pub const EMPTY: TileRecord = TileRecord {
        rows: 0,
        cols: 0,
        payload: PayloadRef { offset: 0, len: 0 },
    };

    pub fn to_bytes(&self) -> [u8; V2_RECORD_BYTES] {
        let mut b = [0u8; V2_RECORD_BYTES];
        b[0..2].copy_from_slice(&self.rows.to_le_bytes());
        b[2..4].copy_from_slice(&self.cols.to_le_bytes());
        b[4..8].copy_from_slice(&self.payload.offset.to_le_bytes());
        b[8..12].copy_from_slice(&self.payload.len.to_le_bytes());
        b
    }

    pub fn from_bytes(b: &[u8; V2_RECORD_BYTES]) -> Self {
        Self {
            rows: u16::from_le_bytes([b[0], b[1]]),
            cols: u16::from_le_bytes([b[2], b[3]]),
            payload: PayloadRef {
                offset: u32::from_le_bytes(b[4..8].try_into().unwrap()),
                len: u32::from_le_bytes(b[8..12].try_into().unwrap()),
            },
        }
    }
}

enum TileSource {
    Memory(Vec<u8>),
    File(RefCell<BufReader<MapFile>>),
}

pub struct TerrainMapV2 {
    pub header: V2Header,
    directory: Vec<TileRecord>,
    source: TileSource,
}

impl TerrainMapV2 {
    pub fn from_bytes(data: Vec<u8>) -> Result<Self, ParseError> {
        if data.len() < V2_HEADER_BYTES {
            return Err(ParseError::TruncatedHeader);
        }
        let header = V2Header::from_bytes(
            data[..V2_HEADER_BYTES].try_into().unwrap(),
            data.len() as u64,
        )?;
        let directory = parse_directory(&header, &data[V2_HEADER_BYTES..])?;
        Ok(Self {
            header,
            directory,
            source: TileSource::Memory(data),
        })
    }

    /// Open for streamed access: reads the header and the directory only.
    pub fn open(path: &str) -> Result<Self, ParseError> {
        let mut file = MapFile::open(path).map_err(ParseError::Io)?;
        let file_len = file.seek(SeekFrom::End(0)).map_err(ParseError::Io)?;
        file.seek(SeekFrom::Start(0)).map_err(ParseError::Io)?;
        let mut reader = BufReader::with_capacity(64 * 1024, file);

        if file_len < V2_HEADER_BYTES as u64 {
            return Err(ParseError::TruncatedHeader);
        }
        let mut header_bytes = [0u8; V2_HEADER_BYTES];
        reader.read_exact(&mut header_bytes).map_err(ParseError::Io)?;
        let header = V2Header::from_bytes(&header_bytes, file_len)?;

        let dir_bytes_len =
            header.dir_rows as usize * header.dir_cols as usize * V2_RECORD_BYTES;
        let mut dir_bytes = vec![0u8; dir_bytes_len];
        reader.read_exact(&mut dir_bytes).map_err(ParseError::Io)?;
        let directory = parse_directory(&header, &dir_bytes)?;

        Ok(Self {
            header,
            directory,
            source: TileSource::File(RefCell::new(reader)),
        })
    }

    /// Directory record for the tile-grid cell `(row, col)` (row 0 =
    /// southernmost, the `world_map_indices` orientation); `None` when the
    /// cell is out of range or the database has no tile there.
    pub fn record(&self, row: usize, col: usize) -> Option<TileRecord> {
        if row >= self.header.dir_rows as usize || col >= self.header.dir_cols as usize {
            return None;
        }
        let record = self.directory[row * self.header.dir_cols as usize + col];
        (record.rows > 0 && record.cols > 0).then_some(record)
    }

    /// Decompress one tile and convert metres to feet — the v2 counterpart of
    /// v1 `load_tile_feet`, sharing `feet_from_metres_cell`. Blocking read;
    /// the gauge's async path reads via fsIORead instead and decodes with
    /// [`decode_tile_feet`].
    pub fn load_tile_feet(&self, record: TileRecord) -> Result<Vec<i16>, ParseError> {
        let compressed = self.raw_payload(record.payload)?;
        decode_tile_feet(record, &compressed)
    }

    /// Raw compressed payload bytes (blocking read; used by the sync loader
    /// and the host test doubles).
    pub fn raw_payload(&self, payload: PayloadRef) -> Result<Vec<u8>, ParseError> {
        if payload.len == 0 {
            return Err(ParseError::TruncatedTile {
                offset: payload.offset as usize,
            });
        }
        self.raw_range(payload.offset, payload.len)
    }

    /// Arbitrary byte range of the file (blocking read) — the host test
    /// double's stand-in for a coalesced fsIORead of a whole rect row.
    pub fn raw_range(&self, offset: u32, len: u32) -> Result<Vec<u8>, ParseError> {
        let end = offset as u64 + len as u64;
        if end > self.header.file_length {
            return Err(ParseError::TruncatedTile {
                offset: offset as usize,
            });
        }
        match &self.source {
            TileSource::Memory(data) => Ok(data[offset as usize..end as usize].to_vec()),
            TileSource::File(reader) => {
                let mut reader = reader.borrow_mut();
                reader
                    .seek(SeekFrom::Start(offset as u64))
                    .map_err(ParseError::Io)?;
                let mut bytes = vec![0u8; len as usize];
                reader.read_exact(&mut bytes).map_err(ParseError::Io)?;
                Ok(bytes)
            }
        }
    }
}

/// Inflate + metres->feet one payload whose compressed bytes were already
/// read (by any transport — blocking file, async fsIORead, or memory).
pub fn decode_tile_feet(record: TileRecord, compressed: &[u8]) -> Result<Vec<i16>, ParseError> {
    let mut decompressed = Vec::new();
    flate2::read::GzDecoder::new(compressed)
        .read_to_end(&mut decompressed)
        .map_err(ParseError::Inflate)?;

    let cell_count = record.rows as usize * record.cols as usize;
    if decompressed.len() < cell_count * 2 {
        return Err(ParseError::PayloadSizeMismatch {
            expected: cell_count * 2,
            actual: decompressed.len(),
        });
    }

    let mut elevations = Vec::with_capacity(cell_count);
    for cell in 0..cell_count {
        let metres = i16::from_le_bytes([decompressed[cell * 2], decompressed[cell * 2 + 1]]);
        elevations.push(feet_from_metres_cell(metres));
    }
    Ok(elevations)
}

fn parse_directory(header: &V2Header, bytes: &[u8]) -> Result<Vec<TileRecord>, ParseError> {
    let cells = header.dir_rows as usize * header.dir_cols as usize;
    if bytes.len() < cells * V2_RECORD_BYTES {
        return Err(ParseError::TruncatedHeader);
    }
    Ok((0..cells)
        .map(|i| {
            TileRecord::from_bytes(
                bytes[i * V2_RECORD_BYTES..(i + 1) * V2_RECORD_BYTES]
                    .try_into()
                    .unwrap(),
            )
        })
        .collect())
}
