//! Parser for the SimBridge `terrain.map` database.
//!
//! Port of `apps/server/src/terrain/fileformat/{terrainmap,tile}.ts`.
//!
//! Layout (all little-endian):
//! - 14-byte file header: lat_min i16 @0, lat_max i16 @2, lon_min i16 @4,
//!   lon_max i16 @6, angular_step_lat u8 @8, angular_step_lon u8 @9,
//!   horizontal_resolution f32 @10 (nautical miles).
//! - Tiles follow back-to-back from offset 14. Each tile: 11-byte header
//!   (rows u16 @0, columns u16 @2, sw_lat i8 @4, sw_lon i16 @5,
//!   compressed_len u32 @7) then a GZip payload of `rows*columns` i16
//!   elevations in metres, row-major with row 0 at the tile's NORTH edge.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufReader, Read, Seek, SeekFrom};

use crate::jsmath::js_round;

/// File backend: `std::fs` on the host, but the SDK-libc wrapper in the sim —
/// std's WASI fs layer imports syscalls MSFS does not provide (see cfile.rs).
#[cfg(target_arch = "wasm32")]
use crate::cfile::CFile as MapFile;
#[cfg(not(target_arch = "wasm32"))]
use std::fs::File as MapFile;

pub const ELEV_INVALID: i16 = 32767;
pub const ELEV_UNKNOWN: i16 = 32766;
pub const ELEV_WATER: i16 = -1;

const FILE_HEADER_BYTES: usize = 14;
const TILE_HEADER_BYTES: usize = 11;
const METRES_TO_FEET: f64 = 3.28084;

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainMapHeader {
    pub lat_min: i16,
    pub lat_max: i16,
    pub lon_min: i16,
    pub lon_max: i16,
    pub angular_step_lat: u8,
    pub angular_step_lon: u8,
    /// Metres, converted from the stored nautical-mile f32 (matches TS `readFloatLE(10) * 1852`).
    pub horizontal_resolution_m: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TileIndex {
    pub sw_lat: i8,
    pub sw_lon: i16,
    pub rows: u16,
    pub columns: u16,
    payload_offset: usize,
    compressed_len: u32,
}

#[derive(Debug)]
pub enum ParseError {
    TruncatedHeader,
    TruncatedTile { offset: usize },
    Inflate(std::io::Error),
    Io(std::io::Error),
    PayloadSizeMismatch { expected: usize, actual: usize },
    // terrain2.map (fileformat_v2.rs) validation
    BadMagic,
    UnsupportedVersion { version: u16 },
    LengthMismatch { expected: u64, actual: u64 },
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::TruncatedHeader => write!(f, "terrain.map shorter than the 14-byte header"),
            ParseError::TruncatedTile { offset } => write!(f, "truncated tile at byte offset {offset}"),
            ParseError::Inflate(e) => write!(f, "tile payload inflate failed: {e}"),
            ParseError::Io(e) => write!(f, "terrain.map read failed: {e}"),
            ParseError::PayloadSizeMismatch { expected, actual } => {
                write!(f, "tile payload holds {actual} bytes, header implies {expected}")
            }
            ParseError::BadMagic => write!(f, "terrain2.map magic mismatch (not an FBT2 file)"),
            ParseError::UnsupportedVersion { version } => {
                write!(f, "terrain2.map version {version} is not supported")
            }
            ParseError::LengthMismatch { expected, actual } => {
                write!(f, "terrain2.map is {actual} bytes but the header records {expected}")
            }
        }
    }
}

impl std::error::Error for ParseError {}

/// Backing store of the tile payloads: the whole file in memory (SimBridge
/// service, tests) or an open file handle read on demand (the wasm gauge,
/// which must not hold the ~232 MB database resident).
enum TileSource {
    Memory(Vec<u8>),
    File(RefCell<BufReader<MapFile>>),
}

pub struct TerrainMap {
    pub header: TerrainMapHeader,
    pub tiles: Vec<TileIndex>,
    /// SW corner (lat, lon) -> index into `tiles`.
    grid: HashMap<(i8, i16), usize>,
    source: TileSource,
}

fn parse_header(data: &[u8; FILE_HEADER_BYTES]) -> TerrainMapHeader {
    TerrainMapHeader {
        lat_min: i16::from_le_bytes([data[0], data[1]]),
        lat_max: i16::from_le_bytes([data[2], data[3]]),
        lon_min: i16::from_le_bytes([data[4], data[5]]),
        lon_max: i16::from_le_bytes([data[6], data[7]]),
        angular_step_lat: data[8],
        angular_step_lon: data[9],
        horizontal_resolution_m: f32::from_le_bytes([data[10], data[11], data[12], data[13]])
            as f64
            * 1852.0,
    }
}

struct ParsedTileHeader {
    rows: u16,
    columns: u16,
    sw_lat: i8,
    sw_lon: i16,
    compressed_len: u32,
}

fn parse_tile_header(data: &[u8; TILE_HEADER_BYTES]) -> ParsedTileHeader {
    ParsedTileHeader {
        rows: u16::from_le_bytes([data[0], data[1]]),
        columns: u16::from_le_bytes([data[2], data[3]]),
        sw_lat: data[4] as i8,
        sw_lon: i16::from_le_bytes([data[5], data[6]]),
        compressed_len: u32::from_le_bytes([data[7], data[8], data[9], data[10]]),
    }
}

impl TerrainMap {
    pub fn from_bytes(data: Vec<u8>) -> Result<Self, ParseError> {
        if data.len() < FILE_HEADER_BYTES {
            return Err(ParseError::TruncatedHeader);
        }

        let header = parse_header(data[..FILE_HEADER_BYTES].try_into().unwrap());

        let mut tiles = Vec::new();
        let mut grid = HashMap::new();
        let mut offset = FILE_HEADER_BYTES;
        while offset < data.len() {
            if offset + TILE_HEADER_BYTES > data.len() {
                return Err(ParseError::TruncatedTile { offset });
            }
            let tile =
                parse_tile_header(data[offset..offset + TILE_HEADER_BYTES].try_into().unwrap());
            let payload_offset = offset + TILE_HEADER_BYTES;
            if payload_offset + tile.compressed_len as usize > data.len() {
                return Err(ParseError::TruncatedTile { offset });
            }

            grid.insert((tile.sw_lat, tile.sw_lon), tiles.len());
            tiles.push(TileIndex {
                sw_lat: tile.sw_lat,
                sw_lon: tile.sw_lon,
                rows: tile.rows,
                columns: tile.columns,
                payload_offset,
                compressed_len: tile.compressed_len,
            });
            offset = payload_offset + tile.compressed_len as usize;
        }

        Ok(Self {
            header,
            tiles,
            grid,
            source: TileSource::Memory(data),
        })
    }

    /// Open a `terrain.map` for streamed access: only the 14-byte file header
    /// and the 11-byte tile headers are read (payloads are skipped with
    /// relative seeks); `load_tile_feet` seeks back to a payload on demand.
    pub fn open(path: &str) -> Result<Self, ParseError> {
        let mut file = MapFile::open(path).map_err(ParseError::Io)?;
        let file_len = file.seek(SeekFrom::End(0)).map_err(ParseError::Io)? as usize;
        file.seek(SeekFrom::Start(0)).map_err(ParseError::Io)?;
        let mut reader = BufReader::with_capacity(64 * 1024, file);

        if file_len < FILE_HEADER_BYTES {
            return Err(ParseError::TruncatedHeader);
        }
        let mut header_bytes = [0u8; FILE_HEADER_BYTES];
        reader.read_exact(&mut header_bytes).map_err(ParseError::Io)?;
        let header = parse_header(&header_bytes);

        let mut tiles = Vec::new();
        let mut grid = HashMap::new();
        let mut offset = FILE_HEADER_BYTES;
        let mut tile_header_bytes = [0u8; TILE_HEADER_BYTES];
        while offset < file_len {
            if offset + TILE_HEADER_BYTES > file_len {
                return Err(ParseError::TruncatedTile { offset });
            }
            reader
                .read_exact(&mut tile_header_bytes)
                .map_err(ParseError::Io)?;
            let tile = parse_tile_header(&tile_header_bytes);
            let payload_offset = offset + TILE_HEADER_BYTES;
            if payload_offset + tile.compressed_len as usize > file_len {
                return Err(ParseError::TruncatedTile { offset });
            }

            grid.insert((tile.sw_lat, tile.sw_lon), tiles.len());
            tiles.push(TileIndex {
                sw_lat: tile.sw_lat,
                sw_lon: tile.sw_lon,
                rows: tile.rows,
                columns: tile.columns,
                payload_offset,
                compressed_len: tile.compressed_len,
            });
            reader
                .seek_relative(tile.compressed_len as i64)
                .map_err(ParseError::Io)?;
            offset = payload_offset + tile.compressed_len as usize;
        }

        Ok(Self {
            header,
            tiles,
            grid,
            source: TileSource::File(RefCell::new(reader)),
        })
    }

    /// Index of the tile whose SW corner is exactly (`sw_lat`, `sw_lon`).
    pub fn tile_at_southwest(&self, sw_lat: i8, sw_lon: i16) -> Option<usize> {
        self.grid.get(&(sw_lat, sw_lon)).copied()
    }

    /// Index of the tile containing the coordinate, based on the angular steps
    /// (mirrors `Worldmap.worldMapIndices` grid math).
    pub fn tile_containing(&self, latitude: f64, longitude: f64) -> Option<usize> {
        let lat_step = self.header.angular_step_lat as f64;
        let lon_step = self.header.angular_step_lon as f64;
        let sw_lat = ((latitude + 90.0) / lat_step).floor() * lat_step - 90.0;
        let sw_lon = ((longitude + 180.0) / lon_step).floor() * lon_step - 180.0;
        self.tile_at_southwest(sw_lat as i8, sw_lon as i16)
    }

    /// Decompress a tile and convert metres to feet, keeping the water marker
    /// (-1) untouched — exact port of `Tile.loadElevationGrid`.
    pub fn load_tile_feet(&self, tile_index: usize) -> Result<Vec<i16>, ParseError> {
        let tile = &self.tiles[tile_index];

        let mut decompressed = Vec::new();
        match &self.source {
            TileSource::Memory(data) => {
                let payload =
                    &data[tile.payload_offset..tile.payload_offset + tile.compressed_len as usize];
                flate2::read::GzDecoder::new(payload)
                    .read_to_end(&mut decompressed)
                    .map_err(ParseError::Inflate)?;
            }
            TileSource::File(reader) => {
                let mut reader = reader.borrow_mut();
                reader
                    .seek(SeekFrom::Start(tile.payload_offset as u64))
                    .map_err(ParseError::Io)?;
                let mut payload = vec![0u8; tile.compressed_len as usize];
                reader.read_exact(&mut payload).map_err(ParseError::Io)?;
                flate2::read::GzDecoder::new(&payload[..])
                    .read_to_end(&mut decompressed)
                    .map_err(ParseError::Inflate)?;
            }
        }

        let cell_count = tile.rows as usize * tile.columns as usize;
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

    /// Raw compressed payload bytes of a tile. Used by the v1->v2 converter,
    /// which copies L0 payloads verbatim so their content is v1-identical by
    /// construction.
    pub fn raw_tile_payload(&self, tile_index: usize) -> Result<Vec<u8>, ParseError> {
        let tile = &self.tiles[tile_index];
        match &self.source {
            TileSource::Memory(data) => Ok(data
                [tile.payload_offset..tile.payload_offset + tile.compressed_len as usize]
                .to_vec()),
            TileSource::File(reader) => {
                let mut reader = reader.borrow_mut();
                reader
                    .seek(SeekFrom::Start(tile.payload_offset as u64))
                    .map_err(ParseError::Io)?;
                let mut payload = vec![0u8; tile.compressed_len as usize];
                reader.read_exact(&mut payload).map_err(ParseError::Io)?;
                Ok(payload)
            }
        }
    }
}

/// Metres->feet conversion of one stored cell, keeping the water marker (-1)
/// untouched — the single code path shared by the v1 and v2 readers.
pub fn feet_from_metres_cell(metres: i16) -> i16 {
    if metres == ELEV_WATER {
        ELEV_WATER
    } else {
        js_round(metres as f64 * METRES_TO_FEET) as i16
    }
}

/// Row/column of a coordinate inside a tile grid; row 0 is the NORTH edge.
/// Exact port of `ElevationGrid.worldToGridIndices`.
pub fn world_to_grid_indices(
    rows: u16,
    columns: u16,
    sw_lat: f64,
    sw_lon: f64,
    ne_lat: f64,
    ne_lon: f64,
    latitude: f64,
    longitude: f64,
) -> (usize, usize) {
    let lat_range = ne_lat - sw_lat;
    let lat_delta = latitude - sw_lat;
    let row = (rows as f64).min(rows as f64 - ((lat_delta / lat_range) * rows as f64).floor()) - 1.0;

    let lon_range = ne_lon - sw_lon;
    let lon_delta = longitude - sw_lon;
    let column = (columns as f64 - 1.0).min(((lon_delta / lon_range) * columns as f64).floor());

    (row.max(0.0) as usize, column.max(0.0) as usize)
}
