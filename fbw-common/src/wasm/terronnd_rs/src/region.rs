//! Range-independent world region assembled from the terrain2.map tile grid —
//! the replacement for the v1 800 nm stitched monolith (`WorldMapManager`).
//!
//! Three persistent rasters are kept warm around the aircraft, one per
//! display level, EACH SIZED BY WHAT THAT LEVEL ACTUALLY RENDERS: L0 full
//! resolution out to the largest range that displays full res (<=160 nm,
//! ~217 nm corner radius, ~15 MB), and the L1/L2 max-reductions out to the
//! 320/640 nm corner radii at 1/4 and 1/16 the cell count (~12-25 MB each).
//! The reductions are DERIVED PER TILE while a raster assembles — a decoded
//! full-resolution tile is 2x2/4x4 max-reduced straight into the coarse
//! raster — so there are no file mips, no per-level payloads and no level
//! streaming: a reduction can never be stale or missing, and the whole
//! resident set is ~50 MB instead of a full-resolution 640 nm monolith
//! (~220 MB). Range changes never load anything once the rasters are warm;
//! per-level drift margins keep the expensive L2 rebuild rare.
//!
//! Tile loading exploits the v3 grid-sort contract: all present tiles of one
//! directory row occupy one contiguous byte range, so a rect row is fetched
//! with a single coalesced read. Bands are assembled as soon as their row's
//! tiles are decoded, so a raster streams north-to-south and decoded tiles
//! become evictable right after they are consumed. The published raster is
//! handed out as the same [`WorldMap`] snapshot the whole render stack
//! already consumes; at L0 the assembly reproduces the v1 stitch semantics
//! exactly (same crop-to-min-dims rule with centered offsets, same
//! water/unknown fills, same corner snapping and ego-pixel math), which
//! keeps the golden scenarios pixel-identical.
//!
//! Not part of the upstream SimBridge port: SimBridge keeps its 800 nm
//! monolith (out-of-process RAM is free there). This module is gauge-only.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use crate::elevation_map::metres_per_pixel;
use crate::fileformat::{ELEV_UNKNOWN, ELEV_WATER};
use crate::fileformat_v2::{decode_tile_feet, TerrainMapV2, TileRecord};
use crate::geodesy::NM_TO_METRES;
use crate::state::{nd_map_geometry, AircraftStatus, NdMapGeometry};
use crate::vd_render::vd_range_from_nd;
use crate::worldmap::WorldMap;

/// Nominal tile grid dimension (v1 `DefaultTileSize`): the min-dims fallback
/// for tile-free regions and the basis of the deterministic cell-cap estimate.
const DEFAULT_TILE_SIZE: usize = 300;

/// Rasters kept warm: L0 full res plus the derived 2x2/4x4 max-reductions
/// read by the 320/640 nm ranges.
const LEVEL_COUNT: usize = 3;

/// Extra ring beyond each level's display corner radius — drift hysteresis
/// before that level rebuilds. The coarse levels get wide margins because
/// their rebuilds decode the full-resolution tiles of a huge rect (an L2
/// rebuild is ~1,100 tile decodes); the cheap L0 rebuild keeps the tight
/// margin.
const LEVEL_MARGINS_NM: [f64; LEVEL_COUNT] = [15.0, 30.0, 90.0];

/// Raster cell cap (i16 cells, 128 M = 256 MB) — the polar column crop.
/// With per-level extents the estimate uses each level's reduced tile dims,
/// so in practice only extreme polar rects ever hit it.
pub const MAX_REGION_CELLS: usize = 128_000_000;
/// Decompressed tile cache bound (full-resolution tiles; the coarse-level
/// builds reduce straight from these entries).
pub const TILE_CACHE_BYTES: usize = 24 * 1024 * 1024;
/// Coalesced reads in flight: exactly one — the next range is requested only
/// after the previous one completed. Decode (not transport) bounds the
/// warm-up, and a strictly serial request stream is the gentlest possible
/// load on the sim's streamed-package IO.
const MAX_IN_FLIGHT_RUNS: usize = 1;
/// Split a coalesced row read when it would exceed this many bytes.
const MAX_RUN_BYTES: u32 = 1024 * 1024;
/// Polls (frames) before an unanswered read is written off as lost and its
/// tiles retried. Without this a single dropped transport callback would
/// deadlock the build (and the display) forever.
const RUN_TIMEOUT_POLLS: u32 = 600;
/// Read attempts per tile before it is assembled as Unknown. A failed run
/// charges every tile it covers one attempt, so transient transport hiccups
/// (rejected/short fsIORead) retry; only persistently unreadable tiles
/// become Unknown patches.
const READ_ATTEMPT_LIMIT: u8 = 4;

/// Tile-grid cell (row, col).
pub type TileCell = (usize, usize);
/// Transport request key: one coalesced row-run read.
pub type ReadKey = u64;

/// One in-flight coalesced read: the byte range starts at `offset` and covers
/// every tile in `tiles` (contiguous per the v3 grid-sort contract).
struct RunPlan {
    offset: u32,
    tiles: Vec<TileCell>,
    /// Polls since the request was issued (watchdog).
    age: u32,
}

/// How tile payload bytes reach the manager.
enum TileBackend {
    /// Blocking reads through the TerrainMapV2 handle (host tests; wasm
    /// fallback when the IO API rejects the file).
    Sync,
    /// MSFS 2024 async IO — requests never block a frame on the sim's VFS.
    #[cfg(target_arch = "wasm32")]
    Async(crate::io::AsyncTileIo),
    /// Host test double: completes requests after a fixed number of polls.
    #[cfg(not(target_arch = "wasm32"))]
    Deferred(DeferredIo),
}

/// Test stand-in for the async transport (host only).
#[cfg(not(target_arch = "wasm32"))]
pub struct DeferredIo {
    latency: u32,
    /// The next N completions come back failed (transport-fault injection).
    fail_next: u32,
    pending: Vec<(ReadKey, u32, u32, u32)>,
}

#[cfg(not(target_arch = "wasm32"))]
impl DeferredIo {
    fn request(&mut self, key: ReadKey, offset: u32, len: u32) {
        self.pending.push((key, 0, offset, len));
    }

    fn poll(&mut self, map: &TerrainMapV2) -> Vec<(ReadKey, Option<Vec<u8>>)> {
        let mut done = Vec::new();
        let latency = self.latency;
        let mut i = 0;
        while i < self.pending.len() {
            self.pending[i].1 += 1;
            if self.pending[i].1 >= latency {
                let (key, _, offset, len) = self.pending.swap_remove(i);
                if self.fail_next > 0 {
                    self.fail_next -= 1;
                    done.push((key, None));
                } else {
                    done.push((key, map.raw_range(offset, len).ok()));
                }
            } else {
                i += 1;
            }
        }
        done
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SideGeom {
    pub nd_range: f64,
    pub arc_mode: bool,
}

/// Everything the region planner needs from the aircraft state.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RegionInputs {
    pub ground_truth_lat: f64,
    pub ground_truth_lon: f64,
    /// A380X: taller ND geometries, an always-warm VD range, and the 640 nm
    /// EFIS range position (the A32NX knob stops at 320 nm) — this flag
    /// therefore also sizes the persistent rasters.
    pub vertical_display_required: bool,
    pub sides: [SideGeom; 2],
}

impl RegionInputs {
    pub fn from_status(status: &AircraftStatus) -> Self {
        Self {
            ground_truth_lat: status.ground_truth_latitude,
            ground_truth_lon: status.ground_truth_longitude,
            vertical_display_required: status.vertical_display_required(),
            sides: [&status.efis_data_capt, &status.efis_data_fo].map(|efis| SideGeom {
                nd_range: efis.nd_range,
                arc_mode: efis.arc_mode,
            }),
        }
    }
}

/// Raster level for one display: the coarsest derived reduction whose cell
/// size still oversamples the kernel's sample spacing (`metres_per_pixel /
/// 2`). Every range <= 160 nm selects L0 with the shipped 0.215 nm database;
/// 320/640 nm read the peak-preserving in-memory reductions.
pub fn display_level(
    nd_range: f64,
    arc_mode: bool,
    vertical_display_required: bool,
    resolution_m: f64,
) -> u8 {
    let geometry = nd_map_geometry(arc_mode, vertical_display_required);
    let half_mpp = metres_per_pixel(nd_range, &geometry, arc_mode) / 2.0;
    let mut level = 0u8;
    while usize::from(level) + 1 < LEVEL_COUNT
        && resolution_m * f64::from(1u32 << (level + 1)) <= half_mpp
    {
        level += 1;
    }
    level
}

/// Farthest sampled distance of one display in metres: the arc cutoff limits
/// the A32NX arc to `height` pixels straight up, every other geometry samples
/// out to its corners; the VD (when equipped) keeps its profile range warm
/// regardless of TERR ON VD.
fn side_radius_m(side: &SideGeom, vertical_display_required: bool) -> f64 {
    let geometry: NdMapGeometry = nd_map_geometry(side.arc_mode, vertical_display_required);
    let half_mpp = metres_per_pixel(side.nd_range, &geometry, side.arc_mode) / 2.0;
    let max_px = if side.arc_mode && geometry.center_offset_y == 0 {
        geometry.height as f64
    } else {
        let dx = geometry.width as f64 / 2.0;
        let dy = (geometry.height - geometry.center_offset_y).max(geometry.center_offset_y) as f64;
        (dx * dx + dy * dy).sqrt()
    };
    let mut radius = max_px * half_mpp;
    if vertical_display_required {
        radius = radius.max(vd_range_from_nd(side.nd_range, side.arc_mode) * NM_TO_METRES);
    }
    radius
}

/// The 1-degree tile rect + level a raster covers. Columns may wrap the
/// antimeridian (`col0 + col_count` past `dir_cols` wraps modulo).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegionSpec {
    pub level: u8,
    /// Southernmost tile row of the rect (`world_map_indices` orientation).
    pub row0: usize,
    pub row_count: usize,
    /// Westernmost tile column.
    pub col0: usize,
    pub col_count: usize,
}

struct GridMeta {
    dir_rows: usize,
    dir_cols: usize,
    lat_step: f64,
    lon_step: f64,
    resolution_m: f64,
}

fn tile_rect(meta: &GridMeta, lat: f64, lon: f64, radius_m: f64, level: u8) -> RegionSpec {
    let radius_deg_lat = radius_m / NM_TO_METRES / 60.0;

    let row_lo = (((lat - radius_deg_lat + 90.0) / meta.lat_step).floor())
        .clamp(0.0, meta.dir_rows as f64 - 1.0) as usize;
    let row_hi = (((lat + radius_deg_lat + 90.0) / meta.lat_step).floor())
        .clamp(0.0, meta.dir_rows as f64 - 1.0) as usize;

    // longitudinal span grows with the circle's most poleward latitude; at
    // extreme latitudes fall back to the full ring (v1's pole mirroring is
    // dropped — the database is empty above 83 N / below 84 S anyway)
    let edge_lat = (lat.abs() + radius_deg_lat).min(90.0);
    let cos_edge = (edge_lat.to_radians()).cos();
    let full_ring = edge_lat >= 89.0 || {
        let radius_deg_lon = radius_deg_lat / cos_edge.max(1e-6);
        radius_deg_lon * 2.0 >= 360.0 - meta.lon_step
    };

    let (col0, col_count) = if full_ring {
        (0, meta.dir_cols)
    } else {
        let radius_deg_lon = radius_deg_lat / cos_edge.max(1e-6);
        let col_lo = ((lon - radius_deg_lon + 180.0) / meta.lon_step).floor() as i64;
        let col_hi = ((lon + radius_deg_lon + 180.0) / meta.lon_step).floor() as i64;
        let count = ((col_hi - col_lo + 1).max(1) as usize).min(meta.dir_cols);
        (col_lo.rem_euclid(meta.dir_cols as i64) as usize, count)
    };

    RegionSpec {
        level,
        row0: row_lo,
        row_count: row_hi - row_lo + 1,
        col0,
        col_count,
    }
}

/// The EFIS range set; the A380X (vertical display equipped) has the 640 nm
/// knob position, the A32NX stops at 320 nm.
const EFIS_RANGES: [f64; 7] = [10.0, 20.0, 40.0, 80.0, 160.0, 320.0, 640.0];

/// Fixed sizing radius per level for one aircraft capability: the farthest
/// any display geometry can sample at the LARGEST selectable range that
/// renders the level. Each raster is sized by this (not by the currently
/// selected range), which is what makes range changes instant.
fn level_sizing_radii(vertical_display_required: bool, resolution_m: f64) -> [f64; LEVEL_COUNT] {
    let mut radii = [0.0f64; LEVEL_COUNT];
    let max_range = if vertical_display_required { 640.0 } else { 320.0 };
    for &range in EFIS_RANGES.iter().filter(|&&range| range <= max_range) {
        for arc_mode in [false, true] {
            let level = display_level(range, arc_mode, vertical_display_required, resolution_m);
            let radius = side_radius_m(
                &SideGeom {
                    nd_range: range,
                    arc_mode,
                },
                vertical_display_required,
            );
            radii[level as usize] = radii[level as usize].max(radius);
        }
    }
    radii
}

struct PendingBuild {
    spec: RegionSpec,
    /// Min tile dims AT THE SPEC'S LEVEL (the v1 crop-to-min rule).
    min_h: usize,
    min_w: usize,
    /// Tiles whose payload failed to load; assembled as unknown, retried on
    /// the next rebuild (v1 semantics).
    failed: HashSet<TileCell>,
    /// The raster, assembled band by band as rows finish loading.
    data: Vec<i16>,
    next_band: usize,
}

struct CacheEntry {
    data: Arc<Vec<i16>>,
    last_used: u64,
}

struct Published {
    spec: RegionSpec,
    min_h: usize,
    min_w: usize,
    sw_lat: f64,
    sw_lon: f64,
    ne_lat: f64,
    ne_lon: f64,
    width: usize,
    height: usize,
    elevations: Arc<Vec<i16>>,
}

pub struct RegionManager {
    map: TerrainMapV2,
    meta: GridMeta,
    backend: TileBackend,
    /// Coalesced reads outstanding on the transport.
    in_flight_runs: HashMap<ReadKey, RunPlan>,
    /// Tiles covered by an outstanding run (duplicate-request guard).
    in_flight_tiles: HashSet<TileCell>,
    next_run_id: ReadKey,
    /// Completed reads awaiting (budgeted) inflation in arrival (band)
    /// order, plus the mirror set.
    pending_decode: VecDeque<(TileCell, Vec<u8>)>,
    queued_decode: HashSet<TileCell>,
    /// Failed read attempts per tile (retried up to `READ_ATTEMPT_LIMIT`).
    attempts: HashMap<TileCell, u8>,
    /// Transport diagnostics: (reads ok, requests rejected, short/failed
    /// reads, tiles given up as Unknown). Logged by the gauge.
    io_stats: (u64, u64, u64, u64),
    cache: HashMap<TileCell, CacheEntry>,
    cache_bytes: usize,
    cache_limit: usize,
    cache_clock: u64,
    /// Fixed per-level sizing radii by aircraft capability
    /// (vertical-display flag).
    radius_by_vdr: [[f64; LEVEL_COUNT]; 2],
    /// Latched once the vertical-display flag is seen true, so the rasters
    /// never shrink (and never rebuild-churn) if the flag flickers.
    vdr_latched: bool,
    /// One persistent raster per level, all kept warm around the aircraft —
    /// range changes switch rasters instead of loading tiles.
    published: [Option<Published>; LEVEL_COUNT],
    pending: Option<PendingBuild>,
    /// Retired raster buffers, reused to keep the wasm heap from growing
    /// (wasm linear memory never shrinks — every fresh giant allocation
    /// risks ratcheting the address-space high-water mark).
    retired: Vec<Vec<i16>>,
    /// Replaced rasters a renderer snapshot still holds; drained into
    /// `retired` once the last `Arc` clone drops (end of the cycle that
    /// captured it) instead of freeing at an allocator-unfriendly moment.
    reclaim: Vec<Arc<Vec<i16>>>,
    last_position: (f64, f64),
}

impl RegionManager {
    pub fn new(map: TerrainMapV2) -> Self {
        let meta = GridMeta {
            dir_rows: map.header.dir_rows as usize,
            dir_cols: map.header.dir_cols as usize,
            lat_step: map.header.angular_step_lat as f64,
            lon_step: map.header.angular_step_lon as f64,
            resolution_m: map.header.horizontal_resolution_m(),
        };
        let radius_by_vdr = [
            level_sizing_radii(false, meta.resolution_m),
            level_sizing_radii(true, meta.resolution_m),
        ];
        Self {
            map,
            meta,
            backend: TileBackend::Sync,
            in_flight_runs: HashMap::new(),
            in_flight_tiles: HashSet::new(),
            next_run_id: 0,
            pending_decode: VecDeque::new(),
            queued_decode: HashSet::new(),
            attempts: HashMap::new(),
            io_stats: (0, 0, 0, 0),
            cache: HashMap::new(),
            cache_bytes: 0,
            cache_limit: TILE_CACHE_BYTES,
            cache_clock: 0,
            radius_by_vdr,
            vdr_latched: false,
            published: std::array::from_fn(|_| None),
            pending: None,
            retired: Vec::new(),
            reclaim: Vec::new(),
            last_position: (0.0, 0.0),
        }
    }

    /// Switch tile loading to the MSFS async IO transport (fsIORead).
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn use_async_io(&mut self, io: crate::io::AsyncTileIo) {
        self.backend = TileBackend::Async(io);
    }

    /// Test hook: simulate async transport latency (completions after
    /// `latency` polls); `fail_next` injects that many failed completions.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn use_deferred_io(&mut self, latency: u32) {
        self.use_deferred_io_failing(latency, 0);
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn use_deferred_io_failing(&mut self, latency: u32, fail_next: u32) {
        self.backend = TileBackend::Deferred(DeferredIo {
            latency,
            fail_next,
            pending: Vec::new(),
        });
    }

    /// Transport diagnostics: (reads ok, requests rejected, short/failed
    /// reads, tiles given up as Unknown).
    pub fn io_stats(&self) -> (u64, u64, u64, u64) {
        self.io_stats
    }

    /// Progress of the pending raster build, for the gauge's diagnostics
    /// log: (bands assembled, bands total, reads in flight, payloads
    /// awaiting decode). `None` when no build is pending.
    pub fn build_progress(&self) -> Option<(usize, usize, usize, usize)> {
        self.pending.as_ref().map(|pending| {
            (
                pending.next_band,
                pending.spec.row_count,
                self.in_flight_runs.len(),
                self.pending_decode.len(),
            )
        })
    }

    /// Test hook: shrink the tile cache to force evictions.
    pub fn set_cache_limit(&mut self, bytes: usize) {
        self.cache_limit = bytes;
    }

    pub fn reset(&mut self) {
        self.cache.clear();
        self.cache_bytes = 0;
        self.published = std::array::from_fn(|_| None);
        self.pending = None;
        self.retired.clear();
        self.reclaim.clear();
        self.pending_decode.clear();
        self.queued_decode.clear();
        self.attempts.clear();
        // in-flight runs NOT cleared: outstanding async reads still complete
        // and must be matched to drain cleanly; their results land in the
        // cache
    }

    /// Finest published raster (tests / side-agnostic probes).
    pub fn snapshot(&self) -> Option<WorldMap> {
        self.published
            .iter()
            .flatten()
            .next()
            .map(|published| self.make_snapshot(published, self.last_position))
    }

    /// The raster `side` renders from: its level's persistent raster, with
    /// the ego pixel at the given inputs' position.
    pub fn snapshot_for_side(&self, inputs: &RegionInputs, side: usize) -> Option<WorldMap> {
        let level = self.side_level(inputs, side) as usize;
        self.published[level].as_ref().map(|published| {
            self.make_snapshot(
                published,
                (inputs.ground_truth_lat, inputs.ground_truth_lon),
            )
        })
    }

    /// Derived level side `side` renders from (exposed for tests/benches).
    pub fn side_level(&self, inputs: &RegionInputs, side: usize) -> u8 {
        display_level(
            inputs.sides[side].nd_range,
            inputs.sides[side].arc_mode,
            inputs.vertical_display_required,
            self.meta.resolution_m,
        )
    }

    /// Budgeted per-frame driver: starts a rebuild when a published level no
    /// longer covers the inputs, loads at most `load_budget_bytes` of
    /// decompressed tile data and copies at most `band_budget` tile-row bands
    /// per call, and publishes only complete rasters (v1
    /// `update_position_budgeted` semantics). Returns the current snapshot.
    pub fn update_budgeted(
        &mut self,
        inputs: &RegionInputs,
        load_budget_bytes: usize,
        band_budget: usize,
    ) -> Option<WorldMap> {
        self.last_position = (inputs.ground_truth_lat, inputs.ground_truth_lon);
        self.vdr_latched |= inputs.vertical_display_required;
        let (lat, lon) = self.last_position;
        let vdr = self.vdr_latched;

        // recover replaced rasters once their last renderer snapshot dropped
        let mut i = 0;
        while i < self.reclaim.len() {
            if Arc::strong_count(&self.reclaim[i]) == 1 {
                let arc = self.reclaim.swap_remove(i);
                if let Ok(buffer) = Arc::try_unwrap(arc) {
                    if self.retired.len() < LEVEL_COUNT {
                        self.retired.push(buffer);
                    }
                }
            } else {
                i += 1;
            }
        }

        // abandon a build whose rect no longer covers its level's core
        // (position jump / slew / raster growth). Range changes never
        // invalidate builds — the specs are range-independent by design.
        if let Some(pending) = &self.pending {
            let (_, core) = self.level_specs(pending.spec.level, vdr, lat, lon);
            if !rect_contains(&pending.spec, &core, self.meta.dir_cols) {
                if let Some(pending) = self.pending.take() {
                    if self.retired.len() < LEVEL_COUNT {
                        self.retired.push(pending.data);
                    }
                }
            }
        }

        // keep every level warm; the levels the displays are showing rebuild
        // first (one build in flight at a time)
        if self.pending.is_none() {
            for level in self.level_priority(inputs) {
                if let Some(spec) = self.rebuild_needed_level(level, vdr, lat, lon) {
                    let (min_h, min_w) = self.rect_min_dims(&spec);

                    // recycle the largest retired buffer and reserve exactly
                    // — Vec doubling on a big buffer would both spike and
                    // fragment the never-shrinking wasm heap
                    self.retired.sort_by_key(|buffer| buffer.capacity());
                    let mut data = self.retired.pop().unwrap_or_default();
                    data.clear();
                    data.reserve(spec.col_count * min_w * spec.row_count * min_h);
                    self.pending = Some(PendingBuild {
                        spec,
                        min_h,
                        min_w,
                        failed: HashSet::new(),
                        data,
                        next_band: 0,
                    });
                    break;
                }
            }
        }

        if let Some(mut pending) = self.pending.take() {
            let mut failed = std::mem::take(&mut pending.failed);
            self.pump_loads(&pending.spec, &mut failed, load_budget_bytes, pending.next_band);
            pending.failed = failed;

            // stream the assembly: a band is copied (and, for coarse levels,
            // reduced per tile) as soon as its row's tiles are all decoded
            // (or given up), north to south
            let total_bands = pending.spec.row_count;
            let mut bands_done = 0;
            while pending.next_band < total_bands
                && bands_done < band_budget
                && self.band_ready(&pending.spec, pending.next_band, &pending.failed)
            {
                assemble_band(
                    &self.map,
                    &self.meta,
                    &self.cache,
                    &pending.spec,
                    pending.min_h,
                    pending.min_w,
                    pending.next_band,
                    &mut pending.data,
                );
                pending.next_band += 1;
                bands_done += 1;
            }

            if pending.next_band == total_bands {
                self.publish(pending);
            } else {
                self.pending = Some(pending);
            }
        }

        self.snapshot_for_side(inputs, 0)
    }

    /// Synchronous reference: drives the budgeted path with unbounded budgets
    /// until EVERY level is warm — bit-identical output, used by tests and
    /// the goldens. Returns the capt side's raster.
    pub fn update_sync(&mut self, inputs: &RegionInputs) -> Option<WorldMap> {
        let mut guard = 0;
        loop {
            let snapshot = self.update_budgeted(inputs, usize::MAX, usize::MAX);
            let (lat, lon) = self.last_position;
            let vdr = self.vdr_latched;
            let all_warm = (0..LEVEL_COUNT as u8)
                .all(|level| self.rebuild_needed_level(level, vdr, lat, lon).is_none());
            if self.pending.is_none() && all_warm {
                return snapshot;
            }
            guard += 1;
            assert!(guard < 10_000, "region sync failed to converge");
        }
    }

    /// Every side's raster is warm for the current inputs.
    pub fn covered(&self, inputs: &RegionInputs) -> bool {
        self.side_covered(inputs, 0) && self.side_covered(inputs, 1)
    }

    /// The persistent raster of `side`'s level covers the position — after
    /// the initial warm-up this holds through every range change, so gating
    /// only matters at cold start and after position jumps.
    pub fn side_covered(&self, inputs: &RegionInputs, side: usize) -> bool {
        let vdr = self.vdr_latched || inputs.vertical_display_required;
        let level = self.side_level(inputs, side);
        self.rebuild_needed_level(level, vdr, inputs.ground_truth_lat, inputs.ground_truth_lon)
            .is_none()
    }

    /// Rebuild order: the levels the displays currently show first (unlocks
    /// them fastest at cold start), then the remaining levels.
    fn level_priority(&self, inputs: &RegionInputs) -> [u8; LEVEL_COUNT] {
        let mut order = [0u8; LEVEL_COUNT];
        let mut count = 0usize;
        let candidates = [
            self.side_level(inputs, 0),
            self.side_level(inputs, 1),
            0,
            1,
            2,
        ];
        for candidate in candidates {
            if count < LEVEL_COUNT && !order[..count].contains(&candidate) {
                order[count] = candidate;
                count += 1;
            }
        }
        debug_assert_eq!(count, LEVEL_COUNT);
        order
    }

    /// Build spec (with the level's drift margin) + coverage core for one
    /// level. The core is clipped into the build rect so the polar column
    /// clamp can never claim coverage the raster does not hold.
    fn level_specs(&self, level: u8, vdr: bool, lat: f64, lon: f64) -> (RegionSpec, RegionSpec) {
        let radius = self.radius_by_vdr[vdr as usize][level as usize];
        let margin = LEVEL_MARGINS_NM[level as usize] * NM_TO_METRES;
        let build = self.clamped_rect(level, lat, lon, radius + margin);
        let mut core = self.clamped_rect(level, lat, lon, radius);
        if !rect_contains(&build, &core, self.meta.dir_cols) {
            core = build;
        }
        (build, core)
    }

    /// `tile_rect` plus the polar cell cap: near the poles the full
    /// longitude ring would blow the heap, so the rect is cropped in columns
    /// around the aircraft instead; coverage beyond the crop honestly
    /// reports uncovered.
    fn clamped_rect(&self, level: u8, lat: f64, lon: f64, radius_m: f64) -> RegionSpec {
        let mut spec = tile_rect(&self.meta, lat, lon, radius_m, level);
        let tile_dim = (DEFAULT_TILE_SIZE >> level).max(1);
        let max_cols = (MAX_REGION_CELLS / (spec.row_count * tile_dim * tile_dim).max(1)).max(1);
        if spec.col_count > max_cols {
            let aircraft_col = ((lon + 180.0) / self.meta.lon_step).floor() as i64;
            spec.col_count = max_cols.min(self.meta.dir_cols);
            spec.col0 = (aircraft_col - spec.col_count as i64 / 2)
                .rem_euclid(self.meta.dir_cols as i64) as usize;
        }
        spec
    }

    /// A level needs a rebuild when unpublished or its rect no longer
    /// contains the level's (unmargined) core — the margin is the drift
    /// hysteresis.
    fn rebuild_needed_level(&self, level: u8, vdr: bool, lat: f64, lon: f64) -> Option<RegionSpec> {
        let (build, core) = self.level_specs(level, vdr, lat, lon);
        match &self.published[level as usize] {
            Some(published) if rect_contains(&published.spec, &core, self.meta.dir_cols) => None,
            _ => Some(build),
        }
    }

    /// Minimum tile dims AT THE SPEC'S LEVEL across the rect — the v1
    /// crop-to-min rule evaluated over the local rect, with the same
    /// `DEFAULT_TILE_SIZE` fallback when the rect holds no tiles.
    fn rect_min_dims(&self, spec: &RegionSpec) -> (usize, usize) {
        let mut min_rows = usize::MAX;
        let mut min_cols = usize::MAX;
        for_each_cell(spec, self.meta.dir_cols, |row, col| {
            if let Some(record) = self.map.record(row, col) {
                let (rows, cols) = mip_dims(record.rows, record.cols, spec.level);
                min_rows = min_rows.min(rows);
                min_cols = min_cols.min(cols);
            }
        });
        if min_rows == usize::MAX {
            let fallback = (DEFAULT_TILE_SIZE >> spec.level).max(1);
            (fallback, fallback)
        } else {
            (min_rows, min_cols)
        }
    }

    /// Every present tile of the band's row is decoded or given up.
    fn band_ready(&self, spec: &RegionSpec, band: usize, failed: &HashSet<TileCell>) -> bool {
        let row = spec.row0 + spec.row_count - 1 - band;
        for j in 0..spec.col_count {
            let col = (spec.col0 + j) % self.meta.dir_cols;
            if self.map.record(row, col).is_some()
                && !failed.contains(&(row, col))
                && !self.cache.contains_key(&(row, col))
            {
                return false;
            }
        }
        true
    }

    /// Drive tile loading for the rect: drain transport completions, inflate
    /// under the decompressed-byte budget, then issue new coalesced row reads
    /// (async) or load directly (sync). Loads are always the full-resolution
    /// payloads — coarse-level builds reduce from the same cache entries.
    fn pump_loads(
        &mut self,
        spec: &RegionSpec,
        failed: &mut HashSet<TileCell>,
        budget_bytes: usize,
        next_band: usize,
    ) {
        // 1. drain transport completions into the decode queue
        let mut completions: Vec<(ReadKey, Option<Vec<u8>>)> = match &mut self.backend {
            TileBackend::Sync => Vec::new(),
            #[cfg(target_arch = "wasm32")]
            TileBackend::Async(io) => io.poll(),
            #[cfg(not(target_arch = "wasm32"))]
            TileBackend::Deferred(io) => io.poll(&self.map),
        };

        // watchdog: a read the transport never answers is treated as a
        // failed completion so its tiles go through the normal retry path —
        // otherwise one lost callback would gate the display forever (the
        // late callback, should it still fire, drains as an unmatched key)
        for (key, run) in self.in_flight_runs.iter_mut() {
            run.age += 1;
            if run.age > RUN_TIMEOUT_POLLS {
                completions.push((*key, None));
            }
        }

        for (key, bytes) in completions {
            let Some(run) = self.in_flight_runs.remove(&key) else {
                continue;
            };
            for &tile in &run.tiles {
                self.in_flight_tiles.remove(&tile);
            }
            match bytes {
                Some(bytes) => {
                    self.io_stats.0 += 1;
                    // slice the coalesced buffer into per-tile payloads via
                    // the directory offsets
                    for &(row, col) in &run.tiles {
                        let Some(record) = self.map.record(row, col) else {
                            continue;
                        };
                        let start = (record.payload.offset - run.offset) as usize;
                        let end = start + record.payload.len as usize;
                        if end > bytes.len() {
                            continue;
                        }
                        self.attempts.remove(&(row, col));
                        if self.queued_decode.insert((row, col)) {
                            self.pending_decode
                                .push_back(((row, col), bytes[start..end].to_vec()));
                        }
                    }
                }
                None => {
                    // short/failed read: retry (transient transport hiccups
                    // must not become Unknown patches); only persistently
                    // unreadable tiles of the CURRENT rect are given up —
                    // stale completions from an abandoned build never poison
                    // this build's failed set
                    self.io_stats.2 += 1;
                    for &(row, col) in &run.tiles {
                        let attempts = self.attempts.entry((row, col)).or_insert(0);
                        *attempts += 1;
                        if *attempts >= READ_ATTEMPT_LIMIT
                            && rect_has_cell(spec, self.meta.dir_cols, row, col)
                        {
                            failed.insert((row, col));
                            self.io_stats.3 += 1;
                        }
                    }
                }
            }
        }

        // 2. inflate completed payloads under the budget (the CPU-heavy part)
        let mut spent = 0usize;
        while spent < budget_bytes {
            let Some((key, bytes)) = self.pending_decode.pop_front() else {
                break;
            };
            self.queued_decode.remove(&key);
            let Some(record) = self.map.record(key.0, key.1) else {
                continue;
            };
            match decode_tile_feet(record, &bytes) {
                Ok(feet) => {
                    spent += feet.len() * 2;
                    self.insert_cached(key, Arc::new(feet), spec, next_band);
                }
                Err(_) => {
                    // corrupt payload is deterministic — no retry, but only
                    // the current rect may mark this build's cell Unknown
                    if rect_has_cell(spec, self.meta.dir_cols, key.0, key.1) {
                        failed.insert(key);
                        self.io_stats.3 += 1;
                    }
                }
            }
        }

        // 3. request / load whatever the rect still misses, in assembly
        // (north-to-south) order so bands become ready in sequence
        if matches!(self.backend, TileBackend::Sync) {
            // sync path: budgeted blocking loads
            let mut cells: Vec<(usize, usize, TileRecord)> = Vec::new();
            for_each_cell(spec, self.meta.dir_cols, |row, col| {
                if let Some(record) = self.map.record(row, col) {
                    cells.push((row, col, record));
                }
            });
            for (row, col, record) in cells {
                if failed.contains(&(row, col)) || self.cache.contains_key(&(row, col)) {
                    continue;
                }
                if spent >= budget_bytes {
                    break;
                }
                match self.map.load_tile_feet(record) {
                    Ok(feet) => {
                        spent += feet.len() * 2;
                        self.insert_cached((row, col), Arc::new(feet), spec, next_band);
                    }
                    Err(_) => {
                        failed.insert((row, col));
                        self.io_stats.3 += 1;
                    }
                }
            }
        } else {
            self.issue_runs(spec, failed, next_band);
        }
    }

    /// Group the rect's still-missing tiles into contiguous byte-range runs
    /// (the v3 grid-sort contract) and hand them to the transport, oldest
    /// band first, up to the in-flight cap.
    fn issue_runs(&mut self, spec: &RegionSpec, failed: &HashSet<TileCell>, next_band: usize) {
        let dir_cols = self.meta.dir_cols;

        // ascending-column segments (split at the antimeridian wrap so file
        // offsets ascend within each segment)
        let segments: [(usize, usize); 2] = if spec.col0 + spec.col_count <= dir_cols {
            [(spec.col0, spec.col_count), (0, 0)]
        } else {
            [
                (spec.col0, dir_cols - spec.col0),
                (0, spec.col0 + spec.col_count - dir_cols),
            ]
        };

        let mut transport_busy = false;
        'bands: for band in next_band..spec.row_count {
            let row = spec.row0 + spec.row_count - 1 - band;
            for (seg_col0, seg_count) in segments {
                let mut run_tiles: Vec<TileCell> = Vec::new();
                let mut run_start = 0u32;
                let mut run_end = 0u32;
                for col in seg_col0..seg_col0 + seg_count {
                    let record = self.map.record(row, col);
                    let needed = record.is_some()
                        && !failed.contains(&(row, col))
                        && !self.cache.contains_key(&(row, col))
                        && !self.queued_decode.contains(&(row, col))
                        && !self.in_flight_tiles.contains(&(row, col));
                    if let (true, Some(record)) = (needed, record) {
                        let payload = record.payload;
                        if run_tiles.is_empty() {
                            run_start = payload.offset;
                            run_end = payload.offset + payload.len;
                            run_tiles.push((row, col));
                        } else if payload.offset + payload.len - run_start <= MAX_RUN_BYTES {
                            run_end = payload.offset + payload.len;
                            run_tiles.push((row, col));
                        } else {
                            if !self.dispatch_run(&mut run_tiles, run_start, run_end, &mut transport_busy) {
                                break 'bands;
                            }
                            run_start = payload.offset;
                            run_end = payload.offset + payload.len;
                            run_tiles.push((row, col));
                        }
                    } else if !run_tiles.is_empty() {
                        // a cached/failed/absent-request tile ends the run
                        if !self.dispatch_run(&mut run_tiles, run_start, run_end, &mut transport_busy) {
                            break 'bands;
                        }
                    }
                }
                if !run_tiles.is_empty()
                    && !self.dispatch_run(&mut run_tiles, run_start, run_end, &mut transport_busy)
                {
                    break 'bands;
                }
            }
        }
    }

    /// Issue one coalesced read; returns whether issuing may continue.
    fn dispatch_run(
        &mut self,
        tiles: &mut Vec<TileCell>,
        start: u32,
        end: u32,
        transport_busy: &mut bool,
    ) -> bool {
        if *transport_busy || self.in_flight_runs.len() >= MAX_IN_FLIGHT_RUNS {
            tiles.clear();
            return false;
        }
        let key = self.next_run_id;
        let len = end - start;
        let issued = match &mut self.backend {
            TileBackend::Sync => unreachable!("sync backend never issues runs"),
            #[cfg(target_arch = "wasm32")]
            TileBackend::Async(io) => {
                if !io.ready() {
                    tiles.clear();
                    return false; // not open yet: retry next frame
                }
                if io.request(key, start, len) {
                    true
                } else {
                    // rejected synchronously (busy handle?) — NEVER a
                    // permanent failure; back off until next frame
                    self.io_stats.1 += 1;
                    *transport_busy = true;
                    false
                }
            }
            #[cfg(not(target_arch = "wasm32"))]
            TileBackend::Deferred(io) => {
                io.request(key, start, len);
                true
            }
        };
        if issued {
            self.next_run_id += 1;
            for &tile in tiles.iter() {
                self.in_flight_tiles.insert(tile);
            }
            self.in_flight_runs.insert(
                key,
                RunPlan {
                    offset: start,
                    tiles: std::mem::take(tiles),
                    age: 0,
                },
            );
            true
        } else {
            tiles.clear();
            false
        }
    }

    fn insert_cached(
        &mut self,
        key: TileCell,
        data: Arc<Vec<i16>>,
        spec: &RegionSpec,
        next_band: usize,
    ) {
        self.cache_clock += 1;
        self.cache_bytes += data.len() * 2;
        self.cache.insert(
            key,
            CacheEntry {
                data,
                last_used: self.cache_clock,
            },
        );

        // evict least-recently-used entries no unassembled band still needs
        // (consumed bands' tiles become evictable right away — the streaming
        // assembly is what keeps peak memory at raster + cache, not 2x rect)
        let dir_cols = self.meta.dir_cols;
        while self.cache_bytes > self.cache_limit {
            let victim = self
                .cache
                .iter()
                .filter(|(&(row, col), _)| {
                    !tile_pending_assembly(spec, dir_cols, next_band, row, col)
                })
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(&key, _)| key);
            let Some(victim) = victim else {
                break; // everything cached is needed by the current build
            };
            if let Some(entry) = self.cache.remove(&victim) {
                self.cache_bytes -= entry.data.len() * 2;
            }
        }
    }

    fn publish(&mut self, pending: PendingBuild) {
        let PendingBuild {
            spec,
            min_h,
            min_w,
            data,
            ..
        } = pending;
        let width = spec.col_count * min_w;
        let height = spec.row_count * min_h;
        debug_assert_eq!(data.len(), width * height);

        // corner snapping, the stitched_meta port; ne_lon wraps past 180
        let sw_lat = spec.row0 as f64 * self.meta.lat_step - 90.0;
        let ne_lat = (spec.row0 + spec.row_count) as f64 * self.meta.lat_step - 90.0;
        let sw_lon = spec.col0 as f64 * self.meta.lon_step - 180.0;
        let ne_lon_raw = sw_lon + spec.col_count as f64 * self.meta.lon_step;
        let ne_lon = if ne_lon_raw > 180.0 {
            ne_lon_raw - 360.0
        } else {
            ne_lon_raw
        };

        // recycle this level's previous raster; if a renderer snapshot still
        // holds it, park it for reclamation once the cycle finishes
        if let Some(old) = self.published[spec.level as usize].take() {
            match Arc::try_unwrap(old.elevations) {
                Ok(buffer) => {
                    if self.retired.len() < LEVEL_COUNT {
                        self.retired.push(buffer);
                    }
                }
                Err(arc) => {
                    if self.reclaim.len() < LEVEL_COUNT {
                        self.reclaim.push(arc);
                    }
                }
            }
        }

        self.published[spec.level as usize] = Some(Published {
            spec,
            min_h,
            min_w,
            sw_lat,
            sw_lon,
            ne_lat,
            ne_lon,
            width,
            height,
            elevations: Arc::new(data),
        });
    }

    /// Ego pixel inside the published raster — the direct-arithmetic port of
    /// v1 `ego_pixel` (bit-identical divisions at L0; coarse levels use
    /// their own integer per-tile dims), with the same map-center fallback
    /// outside the rect.
    fn make_snapshot(&self, published: &Published, position: (f64, f64)) -> WorldMap {
        let (latitude, longitude) = position;
        let row = ((latitude + 90.0) / self.meta.lat_step).floor();
        let col = ((longitude + 180.0) / self.meta.lon_step).floor();

        let in_grid = row >= 0.0
            && row < self.meta.dir_rows as f64
            && col >= 0.0
            && col < self.meta.dir_cols as f64;
        let (ego_x, ego_y) = if in_grid {
            let row = row as usize;
            let col = col as usize;
            let row_in =
                row >= published.spec.row0 && row < published.spec.row0 + published.spec.row_count;
            let col_idx = (col as i64 - published.spec.col0 as i64)
                .rem_euclid(self.meta.dir_cols as i64) as usize;
            if row_in && col_idx < published.spec.col_count {
                let tile_sw_lat = row as f64 * self.meta.lat_step - 90.0;
                let tile_sw_lon = col as f64 * self.meta.lon_step - 180.0;
                let lat_step = self.meta.lat_step / published.min_h as f64;
                let lon_step = self.meta.lon_step / published.min_w as f64;
                let lat_delta = latitude - tile_sw_lat;
                let lon_delta = longitude - tile_sw_lon;
                let row_idx = (published.spec.row0 + published.spec.row_count - 1) - row;
                let x_offset = (col_idx * published.min_w) as f64;
                let y_offset = (row_idx * published.min_h) as f64;
                (
                    x_offset + lon_delta / lon_step,
                    y_offset + published.min_h as f64 - lat_delta / lat_step,
                )
            } else {
                (published.width as f64 / 2.0, published.height as f64 / 2.0)
            }
        } else {
            (published.width as f64 / 2.0, published.height as f64 / 2.0)
        };

        WorldMap {
            sw_lat: published.sw_lat,
            sw_lon: published.sw_lon,
            ne_lat: published.ne_lat,
            ne_lon: published.ne_lon,
            width: published.width,
            height: published.height,
            elevations: Arc::clone(&published.elevations),
            ground_truth_lat: latitude,
            ground_truth_lon: longitude,
            ego_x,
            ego_y,
        }
    }
}

/// `dim` after `level` ceil-halving reduction steps.
fn reduced_dim(dim: usize, level: usize) -> usize {
    let mut dim = dim;
    for _ in 0..level {
        dim = dim.div_ceil(2);
    }
    dim
}

/// Grid dimensions of a tile at `level`, ceil-halved per step — shared by
/// the min-dims rule and the per-tile reduction so they can never disagree.
fn mip_dims(rows: u16, cols: u16, level: u8) -> (usize, usize) {
    (
        reduced_dim(rows as usize, level as usize),
        reduced_dim(cols as usize, level as usize),
    )
}

/// One 2x2 max-reduction step (edge cells reduce whatever remains) — the
/// runtime revival of the old build-time converter reduction. Maximum is the
/// TAWS-safe reduction; Unknown dominates it, so unreadable patches stay
/// honestly visible in the coarse rasters, and water (-1) loses to any land.
fn mip_reduce(src: &[i16], rows: usize, cols: usize) -> (Vec<i16>, usize, usize) {
    let out_rows = rows.div_ceil(2);
    let out_cols = cols.div_ceil(2);
    let mut out = Vec::with_capacity(out_rows * out_cols);
    for oy in 0..out_rows {
        for ox in 0..out_cols {
            let mut max = i16::MIN;
            for y in oy * 2..(oy * 2 + 2).min(rows) {
                for x in ox * 2..(ox * 2 + 2).min(cols) {
                    let cell = src[y * cols + x];
                    if cell > max {
                        max = cell;
                    }
                }
            }
            out.push(max);
        }
    }
    (out, out_rows, out_cols)
}

/// A rect tile a band at or after `next_band` still has to assemble.
fn tile_pending_assembly(
    spec: &RegionSpec,
    dir_cols: usize,
    next_band: usize,
    row: usize,
    col: usize,
) -> bool {
    if !rect_has_cell(spec, dir_cols, row, col) {
        return false;
    }
    let band = (spec.row0 + spec.row_count - 1) - row;
    band >= next_band
}

/// Iterate the rect north->south, west->east (the v1 grid layout).
fn for_each_cell(spec: &RegionSpec, dir_cols: usize, mut f: impl FnMut(usize, usize)) {
    for band in 0..spec.row_count {
        let row = spec.row0 + spec.row_count - 1 - band;
        for j in 0..spec.col_count {
            f(row, (spec.col0 + j) % dir_cols);
        }
    }
}

fn rect_has_cell(spec: &RegionSpec, dir_cols: usize, row: usize, col: usize) -> bool {
    if row < spec.row0 || row >= spec.row0 + spec.row_count {
        return false;
    }
    let offset = (col as i64 - spec.col0 as i64).rem_euclid(dir_cols as i64) as usize;
    offset < spec.col_count
}

/// `inner` fully contained in `outer` (rows plain, columns modulo-wrapped).
fn rect_contains(outer: &RegionSpec, inner: &RegionSpec, dir_cols: usize) -> bool {
    if inner.row0 < outer.row0 || inner.row0 + inner.row_count > outer.row0 + outer.row_count {
        return false;
    }
    if outer.col_count >= dir_cols {
        return true;
    }
    let offset = (inner.col0 as i64 - outer.col0 as i64).rem_euclid(dir_cols as i64) as usize;
    offset + inner.col_count <= outer.col_count
}

/// One tile-row band of the raster — the `stitch_band` port: water where the
/// database has no tile, unknown where a tile exists but is not loaded, and
/// the v1 centered crop to the rect's min dims otherwise. For coarse levels
/// each tile of the band is max-reduced from its cached full-resolution
/// cells first (once per band, cache-hot), then cropped exactly like L0.
#[allow(clippy::too_many_arguments)]
fn assemble_band(
    map: &TerrainMapV2,
    meta: &GridMeta,
    cache: &HashMap<TileCell, CacheEntry>,
    spec: &RegionSpec,
    min_h: usize,
    min_w: usize,
    band: usize,
    data: &mut Vec<i16>,
) {
    let row = spec.row0 + spec.row_count - 1 - band;

    // per-tile reduced grids for this band (level > 0 only)
    let reduced: Vec<Option<(Vec<i16>, usize, usize)>> = if spec.level == 0 {
        Vec::new()
    } else {
        (0..spec.col_count)
            .map(|j| {
                let col = (spec.col0 + j) % meta.dir_cols;
                let record = map.record(row, col)?;
                let entry = cache.get(&(row, col))?;
                let (mut cells, mut rows, mut cols) =
                    mip_reduce(&entry.data, record.rows as usize, record.cols as usize);
                for _ in 1..spec.level {
                    let (next, next_rows, next_cols) = mip_reduce(&cells, rows, cols);
                    cells = next;
                    rows = next_rows;
                    cols = next_cols;
                }
                Some((cells, rows, cols))
            })
            .collect()
    };

    for y in 0..min_h {
        for j in 0..spec.col_count {
            let col = (spec.col0 + j) % meta.dir_cols;
            let record = map.record(row, col);

            // resolve the tile's (possibly reduced) cell grid
            let grid: Option<(&[i16], usize, usize)> = if spec.level == 0 {
                record
                    .and_then(|_| cache.get(&(row, col)))
                    .zip(record)
                    .map(|(entry, record)| {
                        (
                            entry.data.as_slice(),
                            record.rows as usize,
                            record.cols as usize,
                        )
                    })
            } else {
                reduced[j]
                    .as_ref()
                    .map(|(cells, rows, cols)| (cells.as_slice(), *rows, *cols))
            };

            match (record, grid) {
                (None, _) => {
                    // no tile in the database -> open water
                    data.extend(std::iter::repeat_n(ELEV_WATER, min_w));
                }
                (Some(_), None) => {
                    // tile exists but is not loaded -> unknown
                    data.extend(std::iter::repeat_n(ELEV_UNKNOWN, min_w));
                }
                (Some(_), Some((cells, t_rows, t_cols))) => {
                    // share the subsampling crop between all tile sides
                    let row_delta = t_rows - min_h;
                    let col_delta = t_cols - min_w;
                    let y_off = row_delta.div_ceil(2);
                    let x_off = col_delta.div_ceil(2);

                    let start = (y + y_off) * t_cols + x_off;
                    data.extend_from_slice(&cells[start..start + min_w]);
                }
            }
        }
    }
}
