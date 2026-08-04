//! Single-threaded rewrite of the SimBridge `orchestrator.rs` for the in-sim
//! gauge: the same per-side display state machines and cycle logic, but driven
//! by the caller's clock (sim time) instead of `Instant`/`thread::sleep`, and
//! returning raw RGBA screen frames plus threshold metadata instead of
//! PNG-over-mpsc. The HTTP publication, source arbitration and pause flag are
//! gone: the gauge is the only producer and consumer, and a paused sim stops
//! advancing sim time which stops the ticks by itself.
//!
//! Keep `tick_side` / `start_cycle` / `advance_cycle` structurally aligned
//! with the upstream orchestrator (port of `processing/terrainworker.ts`) so
//! fixes can be cross-ported.

use std::time::{Duration, Instant};

use crate::block_map::{block_grid, extract_block_maxima_band};
use crate::elevation_map::metres_per_pixel;
use crate::fileformat::ELEV_INVALID;
use crate::geodesy::{project_wgs84, NM_TO_METRES};
use crate::nd_render::{
    absolute_cut_off_altitude, compute_render_stats, compute_thresholds, PreparedRender,
    TerrainLevelMode, Thresholds,
};
use crate::patterns::{ARC_PATTERN, SCANLINE_PATTERN};
use crate::reveal::{RevealState, SideDrawState};
use crate::state::{nd_map_geometry, AircraftStatus, EfisData, NdMapGeometry, Side};
use crate::statistics::elevation_histogram;
use crate::transition::{
    Transition, TransitionStyle, ARC_UPDATE_TIMEOUT_MS, SCANLINE_UPDATE_TIMEOUT_MS,
};
use crate::vd_render::{
    extract_elevation_profile, render_vertical_display, vd_range_from_nd, ElevationProfileConfig,
    VD_PROFILE_HEIGHT, VD_PROFILE_WIDTH,
};
use crate::worldmap::WorldMap;

/// The right side starts with a -1500 ms phase offset for a more realistic look.
pub const RIGHT_SIDE_STARTUP_OFFSET_MS: u64 = 1500;

/// Rows coloured per render slice: coarse enough to amortize per-slice
/// overhead, fine enough for the budget deadline to stay accurate. (The
/// extraction slices by warp-tile bands, which have their own natural size.)
const RENDER_ROWS_PER_SLICE: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub struct VerticalPathData {
    pub path_width: f64,
    pub track_changes_significantly_at_distance: f64,
    pub waypoints: Vec<(f64, f64)>,
}

/// Threshold metadata for the ND legend LVars (the `FrameTransmission`
/// metadata fields minus the PNG).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThresholdWrite {
    pub minimum_elevation: f64,
    pub minimum_elevation_mode: TerrainLevelMode,
    pub maximum_elevation: f64,
    pub maximum_elevation_mode: TerrainLevelMode,
    pub display_range: f64,
    pub display_mode: u8,
}

impl ThresholdWrite {
    /// Reset-state metadata (`resetRenderingCycle`).
    pub fn reset() -> Self {
        Self {
            minimum_elevation: -1.0,
            minimum_elevation_mode: TerrainLevelMode::PeaksMode,
            maximum_elevation: -1.0,
            maximum_elevation_mode: TerrainLevelMode::PeaksMode,
            display_range: 0.0,
            display_mode: 0,
        }
    }
}

/// One finished map frame, handed to the gauge once per cycle (the gauge
/// uploads it as a GPU image; the sweep is drawn as clipped image fills).
#[derive(Debug, Clone, PartialEq)]
pub struct CycleFrame {
    pub rgba: Vec<u8>,
    pub width: usize,
    pub height: usize,
    /// The previous sweep ran to completion: promote the currently installed
    /// "new" image to "old" before installing this frame. false = the
    /// previous cycle was interrupted mid-sweep and its frame must be
    /// discarded (mirrors `Transition::last_frame` updating only on sweep
    /// completion).
    pub promote_previous: bool,
}

/// What one side produced during a tick.
#[derive(Default)]
pub struct SideOutput {
    pub thresholds_write: Option<ThresholdWrite>,
    /// The cycle's final ND frame, emitted once at cycle finalize (only when
    /// TERR ON ND shows it).
    pub nd_frame: Option<CycleFrame>,
    /// The cycle's final VD frame (A380X), emitted once at cycle finalize.
    pub vd_frame: Option<CycleFrame>,
    /// The side state machine was reset this tick (config change): all
    /// displayed images are stale and must be dropped (C++ `destroyImage`).
    pub reset: bool,
}

/// JS `Math.sign`: 0 for zero, unlike `f64::signum`.
fn js_sign(value: f64) -> f64 {
    if value > 0.0 {
        1.0
    } else if value < 0.0 {
        -1.0
    } else {
        0.0
    }
}

/// In-progress cycle computation: the trig-heavy elevation extraction and the
/// frame colouring are row-sliced so a single sim frame never pays the whole
/// ~200 ms cost (the upstream service ran this on its own thread). All inputs
/// are captured at cycle begin, so the result is bit-identical to the
/// synchronous path regardless of how the rows are spread over frames.
struct PendingCompute {
    status: AircraftStatus,
    vd_path: Option<VerticalPathData>,
    world: WorldMap,
    geometry: NdMapGeometry,
    mpp: f64,
    /// Block-maxima grid (`blocks_x * blocks_y`, ~6 KB) — the block-native
    /// extractor's output, not a per-pixel map.
    blocks: Vec<i16>,
    phase: ComputePhase,
    /// Accumulated wall time per phase [extract, analyze+render], ms —
    /// printed once at finalize for in-sim measurement.
    timing_ms: [f64; 2],
}

enum ComputePhase {
    /// Block extraction, advanced one block row per slice; `next_row` is the
    /// next BLOCK row (not a pixel row).
    Extract {
        next_row: usize,
    },
    Render {
        thresholds: Thresholds,
        /// Block bands + colour tables, classified once at analyze time; the
        /// per-slice painting is pure table lookups.
        prepared: PreparedRender,
        frame: Vec<u8>,
        next_row: usize,
    },
}

/// Per-side display state machine (upstream `SideState` minus the HTTP
/// publication fields).
struct SideState {
    side: Side,
    startup_ms: u64,
    nd_transition: Transition,
    vd_transition: Transition,
    /// Last EFIS configuration seen (`displayConfiguration()` equivalent).
    last_efis: Option<EfisData>,
    last_manual_azim_enabled: bool,
    current_track_changes: f64,
    /// Live thresholds/metadata of the current cycle (`displayData()`).
    display_range: f64,
    display_mode: u8,
    thresholds: Option<Thresholds>,
    /// Cycle currently animating?
    cycle_active: bool,
    vd_rendered_this_cycle: bool,
    nd_done: bool,
    vd_done: bool,
    /// Vertical path change detection (`updatePathData` force redraw).
    seen_vd_path_seq: u64,
    last_vd_waypoint_count: usize,
    /// Sim-time ms to start the next cycle after the previous one completed.
    next_cycle_at: Option<u64>,
    /// Cycle computation in progress (budgeted mode).
    pending: Option<PendingCompute>,
    /// Recycled block-maxima buffer (~6 KB; kept out of the per-cycle churn).
    blocks_scratch: Vec<i16>,
    /// ND frame handed out for the current cycle (TERR ON ND active).
    nd_visible: bool,
    /// Geometry of the current cycle's ND frame.
    cycle_geometry: Option<NdMapGeometry>,
    /// The cycle was finalized for a 768x1024 screen (A380X with VD strip).
    screen_with_vd: bool,
}

impl SideState {
    fn new(side: Side) -> Self {
        Self {
            side,
            startup_ms: 0,
            nd_transition: Transition::new(TransitionStyle::Arc),
            vd_transition: Transition::new(TransitionStyle::VerticalDisplay),
            last_efis: None,
            last_manual_azim_enabled: false,
            current_track_changes: -1.0,
            display_range: 0.0,
            display_mode: 0,
            thresholds: None,
            cycle_active: false,
            vd_rendered_this_cycle: false,
            nd_done: true,
            vd_done: true,
            seen_vd_path_seq: 0,
            last_vd_waypoint_count: 0,
            next_cycle_at: None,
            pending: None,
            blocks_scratch: Vec::new(),
            nd_visible: false,
            cycle_geometry: None,
            screen_with_vd: false,
        }
    }

    fn reset(&mut self) {
        self.nd_transition.reset();
        self.vd_transition.reset();
        self.thresholds = None;
        self.cycle_active = false;
        self.next_cycle_at = None;
        self.pending = None;
        self.nd_visible = false;
        self.cycle_geometry = None;
    }
}

pub struct Runner {
    sides: [SideState; 2],
    started: bool,
    /// None = synchronous (upstream behavior: a cycle computes entirely within
    /// the tick that starts it — used by tests). Some = per-call time budget
    /// for `advance_compute`, which the gauge drives once per sim frame.
    compute_budget: Option<Duration>,
    /// Which side's pending compute gets the budget first (fairness).
    compute_turn: usize,
}

impl Default for Runner {
    fn default() -> Self {
        Self::new()
    }
}

impl Runner {
    pub fn new() -> Self {
        Self {
            sides: [SideState::new(Side::Left), SideState::new(Side::Right)],
            started: false,
            compute_budget: None,
            compute_turn: 0,
        }
    }

    /// Enable amortized cycle computation with a per-`advance_compute` time
    /// budget. The caller must then invoke `advance_compute` every frame.
    pub fn set_compute_budget(&mut self, budget: Option<Duration>) {
        self.compute_budget = budget;
    }

    /// Full reset (sim reset / gauge reinstall): clears both side state
    /// machines. The caller resets the world map and writes the reset
    /// threshold LVars itself.
    pub fn reset(&mut self) {
        for state in &mut self.sides {
            state.reset();
            state.last_efis = None;
        }
    }

    /// One 40 ms tick for both sides. `now_ms` is sim time; the caller drives
    /// this on the transition cadence (`TRANSITION_DELTA_TIME_MS`).
    /// Each side gets the world raster it may render from — `None` while the
    /// side's region does not cover its display circle yet (cold start,
    /// position jump). A `None` side keeps animating but starts no cycle; the
    /// retry stays armed via `next_cycle_at`, so the cycle begins the moment
    /// coverage is published instead of rendering an Unknown fringe.
    pub fn tick(
        &mut self,
        now_ms: u64,
        status: &AircraftStatus,
        vd_path: Option<&VerticalPathData>,
        vd_path_seq: u64,
        worlds: [Option<&WorldMap>; 2],
    ) -> [SideOutput; 2] {
        if !self.started {
            self.started = true;
            self.sides[0].startup_ms = now_ms;
            self.sides[1].startup_ms = now_ms.saturating_sub(RIGHT_SIDE_STARTUP_OFFSET_MS);
        }
        [
            self.tick_side(0, now_ms, status, vd_path, vd_path_seq, worlds[0]),
            self.tick_side(1, now_ms, status, vd_path, vd_path_seq, worlds[1]),
        ]
    }

    fn tick_side(
        &mut self,
        index: usize,
        now_ms: u64,
        status: &AircraftStatus,
        vd_path: Option<&VerticalPathData>,
        vd_path_seq: u64,
        world: Option<&WorldMap>,
    ) -> SideOutput {
        let side = self.sides[index].side;
        let efis = *status.efis(side);
        let state = &mut self.sides[index];
        let mut out = SideOutput::default();

        // configuration diffing (`updateRendering`)
        let config_changed = state
            .last_efis
            .as_ref()
            .is_some_and(|last| last.render_config_differs(&efis));
        let start_rendering = config_changed
            || state.last_manual_azim_enabled != status.manual_azim_enabled
            || state.last_efis.is_none();
        state.last_manual_azim_enabled = status.manual_azim_enabled;
        state.last_efis = Some(efis);

        if start_rendering {
            state.reset();
            // TS `resetRenderingCycle` pushes the reset threshold metadata to
            // the aircraft so the visualizer clears stale state
            out.thresholds_write = Some(ThresholdWrite::reset());
            out.reset = true;
            if efis.nd_range > 0.0 && (efis.terr_on_nd || efis.terr_on_vd) {
                if let Some(world) = world {
                    self.start_cycle(index, now_ms, status, vd_path, world, &mut out);
                } else {
                    // wait for region coverage; retried every tick
                    self.sides[index].next_cycle_at = Some(now_ms);
                }
            }
            return out;
        }

        // vertical path updates can force an immediate redraw (`updatePathData`)
        let state = &mut self.sides[index];
        if state.seen_vd_path_seq != vd_path_seq {
            state.seen_vd_path_seq = vd_path_seq;
            let posted_count = vd_path.map_or(0, |p| p.waypoints.len());
            let posted_track = vd_path.map_or(-1.0, |p| p.track_changes_significantly_at_distance);

            let force_redraw = state.last_vd_waypoint_count != posted_count
                || (posted_track - state.current_track_changes).abs() > 0.1
                || js_sign(posted_track) != js_sign(state.current_track_changes);

            // mirror what the TS renderer stores: manual azimuth replaces the
            // posted path with the single projected endpoint
            state.last_vd_waypoint_count = if status.manual_azim_enabled || posted_count == 0 {
                1
            } else {
                posted_count
            };
            state.current_track_changes = posted_track;

            if force_redraw && efis.nd_range > 0.0 && (efis.terr_on_nd || efis.terr_on_vd) {
                if let Some(world) = world {
                    self.start_cycle(index, now_ms, status, vd_path, world, &mut out);
                } else {
                    self.sides[index].next_cycle_at = Some(now_ms);
                }
                return out;
            }
        }

        let state = &mut self.sides[index];
        if state.cycle_active {
            self.advance_cycle(index, now_ms, status);
        } else if state.next_cycle_at.is_some_and(|at| now_ms >= at) {
            let efis = status.efis(side);
            if efis.terr_on_nd || efis.terr_on_vd {
                // when the region does not cover this side yet, leave the
                // trigger armed — the cycle starts as soon as coverage lands
                if let Some(world) = world {
                    self.start_cycle(index, now_ms, status, vd_path, world, &mut out);
                }
            } else {
                self.sides[index].next_cycle_at = None;
            }
        }
        out
    }

    /// `startNavigationDisplayRenderingCycle` + `startNewMapCycle`, phase 1:
    /// capture the inputs and queue the computation. In synchronous mode
    /// (tests / upstream behavior) the whole cycle completes within this call.
    fn start_cycle(
        &mut self,
        index: usize,
        now_ms: u64,
        status: &AircraftStatus,
        vd_path: Option<&VerticalPathData>,
        world: &WorldMap,
        out: &mut SideOutput,
    ) {
        let side = self.sides[index].side;
        let efis = status.efis(side);
        let geometry = nd_map_geometry(efis.arc_mode, status.vertical_display_required());

        if efis.nd_range == 0.0 {
            self.sides[index].reset();
            return;
        }

        let mpp = metres_per_pixel(efis.nd_range, &geometry, efis.arc_mode);
        let phase = ComputePhase::Extract { next_row: 0 };
        let (blocks_x, blocks_y) = block_grid(&geometry);
        let mut blocks = std::mem::take(&mut self.sides[index].blocks_scratch);
        blocks.clear();
        blocks.resize(blocks_x * blocks_y, ELEV_INVALID);
        self.sides[index].pending = Some(PendingCompute {
            status: status.clone(),
            vd_path: vd_path.cloned(),
            world: world.clone(),
            geometry,
            mpp,
            blocks,
            phase,
            timing_ms: [0.0; 2],
        });
        // clear the trigger immediately — otherwise every following tick sees
        // it still due and requeues the compute from row 0, so it never
        // finishes (one sweep, then a frozen display)
        self.sides[index].next_cycle_at = None;

        if self.compute_budget.is_none() {
            while self.sides[index].pending.is_some() {
                self.advance_side_compute(index, now_ms, out);
            }
        }
    }

    /// Advance every pending cycle computation within the configured time
    /// budget (at least one row slice per side per call, so progress is
    /// guaranteed even with a zero budget). Driven once per sim frame.
    pub fn advance_compute(&mut self, now_ms: u64, status: &AircraftStatus) -> [SideOutput; 2] {
        let mut outs = [SideOutput::default(), SideOutput::default()];
        let Some(budget) = self.compute_budget else {
            return outs; // synchronous mode: cycles never stay pending
        };

        let deadline = Instant::now() + budget;
        let first = self.compute_turn;
        self.compute_turn = (self.compute_turn + 1) % 2;
        for k in 0..2 {
            let index = (first + k) % 2;

            // a compute captured for a configuration the pilot has since
            // changed must never finalize: its frame would start a sweep of
            // the OLD-range image in the ticks before the config diff resets
            // the side (a visible flicker, widened by the A380X's throttled
            // CommBus status). Drop it and re-arm the trigger — the next
            // tick restarts with the current configuration.
            if self.pending_config_stale(index, status) {
                if let Some(pending) = self.sides[index].pending.take() {
                    self.sides[index].blocks_scratch = pending.blocks;
                }
                self.sides[index].next_cycle_at = Some(now_ms);
                continue;
            }

            if self.sides[index].pending.is_some() {
                self.advance_side_compute(index, now_ms, &mut outs[index]);
            }
            while self.sides[index].pending.is_some() && Instant::now() < deadline {
                self.advance_side_compute(index, now_ms, &mut outs[index]);
            }
        }
        outs
    }

    /// The pending compute's captured EFIS configuration no longer matches
    /// the current status (the same diff `tick_side` uses for its reset).
    fn pending_config_stale(&self, index: usize, status: &AircraftStatus) -> bool {
        let side = self.sides[index].side;
        let Some(pending) = &self.sides[index].pending else {
            return false;
        };
        pending
            .status
            .efis(side)
            .render_config_differs(status.efis(side))
            || pending.status.manual_azim_enabled != status.manual_azim_enabled
    }

    /// One row slice of the pending computation; runs the (cheap) analyze step
    /// on extraction completion and finalizes the cycle after the last render
    /// row.
    fn advance_side_compute(&mut self, index: usize, now_ms: u64, out: &mut SideOutput) {
        let side = self.sides[index].side;
        let Some(pending) = self.sides[index].pending.as_mut() else {
            return;
        };
        let efis = *pending.status.efis(side);
        let timing_bucket = match &pending.phase {
            ComputePhase::Extract { .. } => 0,
            ComputePhase::Render { .. } => 1,
        };
        let slice_started = Instant::now();

        let mut completed = false;
        match &mut pending.phase {
            ComputePhase::Extract { next_row } => {
                *next_row = extract_block_maxima_band(
                    &pending.world,
                    pending.status.latitude,
                    pending.status.longitude,
                    pending.status.heading,
                    &pending.geometry,
                    pending.mpp,
                    efis.arc_mode,
                    &mut pending.blocks,
                    *next_row,
                );

                if *next_row >= block_grid(&pending.geometry).1 {
                    // analyze: single cheap pass over the finished block grid
                    let histogram = elevation_histogram(&pending.blocks);
                    let cut_off = absolute_cut_off_altitude(
                        &pending.world,
                        pending.status.latitude,
                        pending.status.longitude,
                        pending.status.altitude,
                        pending.status.runway_data_valid,
                        pending.status.runway_latitude,
                        pending.status.runway_longitude,
                    );
                    let stats = compute_render_stats(
                        &histogram,
                        pending.status.altitude,
                        pending.status.vertical_speed,
                        pending.status.gear_is_down,
                        cut_off,
                    );
                    let mut thresholds = compute_thresholds(&stats);
                    // A380X: metadata must keep flowing with TERR ON ND
                    // deselected, but the thresholds are hidden
                    if !efis.terr_on_nd {
                        thresholds.minimum_elevation = -1.0;
                        thresholds.maximum_elevation = -1.0;
                    }
                    let prepared =
                        PreparedRender::from_blocks(&pending.blocks, &pending.geometry, &stats);
                    let frame = vec![0u8; pending.geometry.width * pending.geometry.height * 4];
                    pending.phase = ComputePhase::Render {
                        thresholds,
                        prepared,
                        frame,
                        next_row: 0,
                    };
                }
            }
            ComputePhase::Render {
                prepared,
                frame,
                next_row,
                ..
            } => {
                let pattern: &[u8] = if pending.status.scanline_mode() {
                    &SCANLINE_PATTERN[..]
                } else {
                    &ARC_PATTERN[..]
                };
                let row = *next_row;
                let end = (row + RENDER_ROWS_PER_SLICE).min(pending.geometry.height);
                prepared.paint_rows(pattern, pending.geometry.width, frame, row, end);
                *next_row = end;
                completed = *next_row == pending.geometry.height;
            }
        }

        let elapsed_ms = slice_started.elapsed().as_secs_f64() * 1000.0;
        if completed {
            let mut pending = self.sides[index].pending.take().unwrap();
            pending.timing_ms[timing_bucket] += elapsed_ms;
            self.finalize_cycle(index, now_ms, pending, out);
        } else if let Some(pending) = self.sides[index].pending.as_mut() {
            pending.timing_ms[timing_bucket] += elapsed_ms;
        }
    }

    /// `startNewMapCycle` tail: VD frame, transition start, per-cycle frame
    /// handoff, threshold output.
    fn finalize_cycle(
        &mut self,
        index: usize,
        now_ms: u64,
        pending: PendingCompute,
        out: &mut SideOutput,
    ) {
        let ComputePhase::Render {
            thresholds,
            frame: nd_frame,
            ..
        } = pending.phase
        else {
            unreachable!("finalize_cycle called before the render phase completed")
        };
        let status = &pending.status;
        let side = self.sides[index].side;
        let efis = *status.efis(side);
        let geometry = pending.geometry;

        // did the PREVIOUS sweeps run to completion? (decides whether their
        // frames become the base images or get discarded — CPU `last_frame`
        // only updated on completion)
        let nd_promote = self.sides[index].nd_done;
        let vd_promote = self.sides[index].vd_done;

        // VD final frame when rendered on this side
        let vd_rendered = status.vertical_display_required()
            && efis.terr_on_vd
            && (efis.efis_mode == 2 || efis.efis_mode == 3);
        let vd_frame = if vd_rendered {
            let (config, grey_from_x) = vd_profile_config(status, pending.vd_path.as_ref(), &efis);
            let profile = extract_elevation_profile(
                &pending.world,
                status.latitude,
                status.longitude,
                &config,
            );
            Some(render_vertical_display(
                &profile,
                efis.vd_range_lower,
                efis.vd_range_upper,
                grey_from_x,
            ))
        } else {
            None
        };

        println!(
            "TERR ON ND: {} cycle computed: extract {:.1} ms, render {:.1} ms",
            match side {
                Side::Left => "L",
                Side::Right => "R",
            },
            pending.timing_ms[0],
            pending.timing_ms[1],
        );

        let state = &mut self.sides[index];
        state.thresholds = Some(thresholds);
        state.display_range = efis.nd_range;
        state.display_mode = efis.efis_mode;
        state.cycle_geometry = Some(geometry);
        state.screen_with_vd = status.vertical_display_required();
        state.nd_visible = efis.terr_on_nd;
        // recycle the elevation buffer for the next cycle
        state.blocks_scratch = pending.blocks;

        state.nd_transition.style = if status.scanline_mode() {
            TransitionStyle::ScanlineNd
        } else {
            TransitionStyle::Arc
        };
        state
            .nd_transition
            .start_new_cycle(geometry.width, geometry.height, now_ms, state.startup_ms);
        state.nd_done = false;

        if efis.terr_on_nd {
            out.nd_frame = Some(CycleFrame {
                rgba: nd_frame,
                width: geometry.width,
                height: geometry.height,
                promote_previous: nd_promote,
            });
        }

        if let Some(vd_frame) = vd_frame {
            state
                .vd_transition
                .start_new_cycle(VD_PROFILE_WIDTH, VD_PROFILE_HEIGHT, now_ms, state.startup_ms);
            state.vd_done = false;
            state.vd_rendered_this_cycle = true;
            out.vd_frame = Some(CycleFrame {
                rgba: vd_frame,
                width: VD_PROFILE_WIDTH,
                height: VD_PROFILE_HEIGHT,
                promote_previous: vd_promote,
            });
        } else {
            state.vd_done = true;
            state.vd_rendered_this_cycle = false;
        }

        state.cycle_active = true;
        state.next_cycle_at = None;

        out.thresholds_write = Some(ThresholdWrite {
            minimum_elevation: thresholds.minimum_elevation,
            minimum_elevation_mode: thresholds.minimum_elevation_mode,
            maximum_elevation: thresholds.maximum_elevation,
            maximum_elevation_mode: thresholds.maximum_elevation_mode,
            display_range: efis.nd_range,
            display_mode: efis.efis_mode,
        });
    }

    /// One 40 ms animation tick of a running cycle: border stepping and
    /// next-cycle scheduling only — the sweep itself is drawn GPU-side from
    /// `draw_state`.
    fn advance_cycle(&mut self, index: usize, now_ms: u64, status: &AircraftStatus) {
        let state = &mut self.sides[index];
        let efis = status.efis(state.side);

        if !state.nd_done {
            state.nd_done = state.nd_transition.render();
        }
        if !state.vd_done {
            state.vd_done = state.vd_transition.render();
        }

        if state.nd_done && state.vd_done {
            state.cycle_active = false;

            if efis.terr_on_nd || efis.terr_on_vd {
                let timeout = if status.scanline_mode() {
                    SCANLINE_UPDATE_TIMEOUT_MS
                } else {
                    ARC_UPDATE_TIMEOUT_MS
                };
                state.next_cycle_at = Some(now_ms + timeout);
            }
        }
    }

    /// Border/visibility snapshot for one side, consumed by the gauge every
    /// draw to composite the sweep on the GPU. No pixel data, no nvg types.
    pub fn draw_state(&self, index: usize) -> SideDrawState {
        let state = &self.sides[index];
        let reveal = |t: &Transition, done: bool| RevealState {
            style: t.style,
            start_border: t.start_border,
            current_border: t.current_border,
            done,
            has_old: t.has_previous,
            old_valid_border: t.old_valid_border,
        };
        SideDrawState {
            show_nd: state.nd_visible && state.cycle_geometry.is_some(),
            show_vd: state.vd_rendered_this_cycle,
            nd: reveal(&state.nd_transition, state.nd_done),
            vd: reveal(&state.vd_transition, state.vd_done),
            nd_geometry: state
                .cycle_geometry
                .unwrap_or_else(|| nd_map_geometry(true, false)),
            screen_with_vd: state.screen_with_vd,
        }
    }
}

/// VD elevation profile configuration: the FMS path, or a single projected
/// endpoint when manual azimuth is active or no usable path was posted
/// (`updateRendering` / `updatePathData`). The second value is the x pixel
/// the profile greys out from (-1 = no grey-out).
fn vd_profile_config(
    status: &AircraftStatus,
    vd_path: Option<&VerticalPathData>,
    efis: &EfisData,
) -> (ElevationProfileConfig, f64) {
    let range = vd_range_from_nd(efis.nd_range, efis.arc_mode);

    match vd_path {
        Some(path) if !status.manual_azim_enabled && !path.waypoints.is_empty() => {
            let grey_from_x = if path.track_changes_significantly_at_distance >= 0.0 {
                path.track_changes_significantly_at_distance / range * VD_PROFILE_WIDTH as f64
            } else {
                -1.0
            };
            (
                ElevationProfileConfig {
                    path_width: path.path_width,
                    waypoints: path.waypoints.clone(),
                    range,
                    track_changes_significantly_at_distance: path
                        .track_changes_significantly_at_distance,
                    fms_path_used: true,
                },
                grey_from_x,
            )
        }
        _ => {
            let end = project_wgs84(
                status.latitude,
                status.longitude,
                status.manual_azim_degrees,
                160.0 * NM_TO_METRES,
            );
            (
                ElevationProfileConfig {
                    path_width: 1.0,
                    waypoints: vec![end],
                    range,
                    track_changes_significantly_at_distance: -1.0,
                    fms_path_used: false,
                },
                -1.0,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::{Runner, VerticalPathData};
    use crate::state::{startup_status, AircraftStatus};
    use crate::transition::{TransitionStyle, TRANSITION_DELTA_TIME_MS};
    use crate::worldmap::WorldMap;

    /// Flat 100 ft world around Innsbruck, large enough for a 20 nm ND.
    fn flat_world() -> WorldMap {
        let width = 2048;
        let height = 2048;
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
            ego_x: width as f64 / 2.0,
            ego_y: height as f64 / 2.0,
        }
    }

    fn terr_active_status() -> AircraftStatus {
        let mut status = startup_status();
        status.efis_data_capt.terr_on_nd = true;
        status.efis_data_fo.terr_on_nd = true;
        status
    }

    fn run_ticks(
        runner: &mut Runner,
        status: &AircraftStatus,
        vd_path: Option<&VerticalPathData>,
        vd_path_seq: u64,
        world: &WorldMap,
        start_ms: u64,
        count: usize,
    ) -> Vec<[bool; 2]> {
        let mut frames = Vec::new();
        let mut now = start_ms;
        for _ in 0..count {
            let out = runner.tick(now, status, vd_path, vd_path_seq, [Some(world), Some(world)]);
            frames.push([out[0].nd_frame.is_some(), out[1].nd_frame.is_some()]);
            now += TRANSITION_DELTA_TIME_MS;
        }
        frames
    }

    #[test]
    fn arc_cycle_cadence_and_idle_timeout() {
        let mut runner = Runner::new();
        let status = terr_active_status();
        let world = flat_world();

        // tick 0: config init -> the cycle's single frame handoff happens at
        // cycle start (synchronous mode); border stepping begins next tick
        let frames = run_ticks(&mut runner, &status, None, 0, &world, 100_000, 1);
        assert!(frames[0][0], "cycle frame handed off at cycle start");
        assert_eq!(runner.draw_state(0).nd.current_border, 0);
        assert!(runner.draw_state(0).show_nd);

        // arc sweep: 2 deg per 40 ms tick, no further frame handoffs
        let frames = run_ticks(&mut runner, &status, None, 0, &world, 100_040, 10);
        assert!(frames.iter().all(|f| !f[0]), "no per-tick frames during sweep");
        assert_eq!(runner.draw_state(0).nd.current_border, 20);
        assert!(!runner.draw_state(0).nd.done);

        // sweep completes at tick 45 (border 90)
        let frames = run_ticks(&mut runner, &status, None, 0, &world, 100_440, 35);
        assert!(frames.iter().all(|f| !f[0]));
        assert!(runner.draw_state(0).nd.done);
        assert_eq!(runner.draw_state(0).nd.current_border, 90);

        // idle: ARC_UPDATE_TIMEOUT_MS = 1000 -> ticks 46..=69 quiet
        let idle = run_ticks(&mut runner, &status, None, 0, &world, 101_840, 24);
        assert!(idle.iter().all(|f| !f[0]), "no frames during idle timeout");

        // tick 70: next cycle starts — new frame handoff, completed sweep
        // becomes the base image
        let mut out = runner.tick(102_800, &status, None, 0, [Some(&world), Some(&world)]);
        let frame = out[0].nd_frame.take().expect("restart frame");
        assert!(frame.promote_previous, "completed sweep must be promoted");
        let ds = runner.draw_state(0);
        assert!(!ds.nd.done, "restart begins a fresh sweep");
        assert_eq!(ds.nd.start_border, 0);
        assert!(ds.nd.has_old);
    }

    #[test]
    fn right_side_startup_is_staggered() {
        let mut runner = Runner::new();
        let status = terr_active_status();
        let world = flat_world();

        // With now == startup the left side starts its sweep at border 0; the
        // right side's startup is offset by -1500 ms, placing it mid-sweep
        // (1500/2500 through the arc validity window -> border 54).
        runner.tick(100_000, &status, None, 0, [Some(&world), Some(&world)]);
        let left_start = runner.sides[0].nd_transition.start_border;
        let right_start = runner.sides[1].nd_transition.start_border;
        assert_eq!(left_start, 0);
        assert_eq!(right_start, 54);
    }

    #[test]
    fn config_change_resets_and_restarts() {
        let mut runner = Runner::new();
        let mut status = terr_active_status();
        let world = flat_world();

        run_ticks(&mut runner, &status, None, 0, &world, 100_000, 10);
        assert!(runner.sides[0].cycle_active);

        // range change -> reset metadata write + fresh cycle
        status.efis_data_capt.nd_range = 20.0;
        let out = runner.tick(100_000 + 10 * 40, &status, None, 0, [Some(&world), Some(&world)]);
        let tw = out[0].thresholds_write.expect("threshold write on config change");
        // start_cycle overwrites the reset write with the new cycle thresholds
        assert!(tw.display_range == 20.0);
        assert!(runner.sides[0].cycle_active);
        // the right side keeps its old config and just keeps animating
        assert!(runner.sides[1].cycle_active);
    }

    #[test]
    fn budgeted_compute_matches_synchronous_output() {
        let status = terr_active_status();
        let world = flat_world();

        // synchronous reference: cycle computes entirely within the tick
        let mut sync_runner = Runner::new();
        let mut sync_out = sync_runner.tick(100_000, &status, None, 0, [Some(&world), Some(&world)]);
        let sync_thresholds = sync_out[0].thresholds_write.expect("sync thresholds");
        let sync_frame = sync_out[0].nd_frame.take().expect("sync cycle frame");

        // zero budget = exactly one row slice per side per advance call —
        // maximum fragmentation of the computation
        let mut budgeted = Runner::new();
        budgeted.set_compute_budget(Some(Duration::ZERO));
        let out = budgeted.tick(100_000, &status, None, 0, [Some(&world), Some(&world)]);
        assert!(
            out[0].nd_frame.is_none(),
            "no frame may appear before the compute finishes"
        );
        assert!(budgeted.sides[0].pending.is_some(), "compute must be pending");

        let mut thresholds = None;
        let mut frame = None;
        let mut now = 100_000;
        for _ in 0..10_000 {
            let mut outs = budgeted.advance_compute(now, &status);
            if let Some(t) = outs[0].thresholds_write {
                thresholds = Some(t);
            }
            if let Some(f) = outs[0].nd_frame.take() {
                frame = Some(f);
            }
            if budgeted.sides[0].pending.is_none() && budgeted.sides[1].pending.is_none() {
                break;
            }
            now += 16;
        }
        let thresholds = thresholds.expect("budgeted compute never finished");
        let frame = frame.expect("budgeted cycle frame");

        assert_eq!(thresholds, sync_thresholds);
        assert_eq!(frame.rgba, sync_frame.rgba, "sliced compute must be bit-identical");
        assert_eq!((frame.width, frame.height), (sync_frame.width, sync_frame.height));
        assert!(budgeted.sides[0].cycle_active);
    }

    #[test]
    fn cycle_start_waits_for_side_readiness() {
        let status = terr_active_status();
        let world = flat_world();

        let mut runner = Runner::new();
        // region covers neither side yet: the reset runs, no cycle starts,
        // the retry trigger stays armed
        let out = runner.tick(100_000, &status, None, 0, [None, None]);
        assert!(out[0].nd_frame.is_none());
        assert!(!runner.sides[0].cycle_active);
        assert!(runner.sides[0].next_cycle_at.is_some(), "retry must stay armed");

        // one side becomes ready: only that side starts
        runner.tick(100_040, &status, None, 0, [None, Some(&world)]);
        assert!(!runner.sides[0].cycle_active);
        assert!(runner.sides[1].cycle_active, "ready side must start");

        // coverage lands for the left side too
        runner.tick(100_080, &status, None, 0, [Some(&world), Some(&world)]);
        assert!(runner.sides[0].cycle_active, "deferred cycle starts once ready");
    }

    #[test]
    fn recurring_cycles_survive_interleaved_ticks() {
        let status = terr_active_status();
        let world = flat_world();

        let mut runner = Runner::new();
        runner.set_compute_budget(Some(Duration::ZERO));
        let mut now = 100_000;
        runner.tick(now, &status, None, 0, [Some(&world), Some(&world)]);
        while runner.sides[0].pending.is_some() || runner.sides[1].pending.is_some() {
            runner.advance_compute(now, &status);
        }
        assert!(runner.sides[0].cycle_active, "first cycle must start");

        // sweep + idle timeout until the follow-up compute gets queued
        let mut queued = false;
        for _ in 0..200 {
            now += 40;
            runner.tick(now, &status, None, 0, [Some(&world), Some(&world)]);
            if runner.sides[0].pending.is_some() {
                queued = true;
                break;
            }
        }
        assert!(queued, "follow-up cycle compute never queued");

        // interleave ticks with single-row compute slices — the pending
        // compute must still converge (regression: a stale next_cycle_at made
        // every tick requeue it from row 0, freezing the display after the
        // first sweep)
        let mut completed = false;
        for _ in 0..5000 {
            now += 40;
            runner.tick(now, &status, None, 0, [Some(&world), Some(&world)]);
            runner.advance_compute(now, &status);
            if runner.sides[0].pending.is_none() {
                completed = true;
                break;
            }
        }
        assert!(completed, "follow-up cycle compute never completed");
        assert!(runner.sides[0].cycle_active, "follow-up cycle did not start");
    }

    #[test]
    fn config_change_cancels_pending_compute() {
        let mut status = terr_active_status();
        let world = flat_world();

        let mut runner = Runner::new();
        runner.set_compute_budget(Some(Duration::ZERO));
        runner.tick(100_000, &status, None, 0, [Some(&world), Some(&world)]);
        runner.advance_compute(100_016, &status);
        assert!(runner.sides[0].pending.is_some());

        // range change mid-compute: stale computation is dropped, new one queued
        status.efis_data_capt.nd_range = 20.0;
        let out = runner.tick(100_040, &status, None, 0, [Some(&world), Some(&world)]);
        assert!(out[0].reset);
        let pending = runner.sides[0].pending.as_ref().expect("new compute queued");
        assert_eq!(pending.status.efis_data_capt.nd_range, 20.0);
    }

    #[test]
    fn stale_config_compute_never_installs() {
        let mut status = terr_active_status();
        let world = flat_world();

        let mut runner = Runner::new();
        runner.set_compute_budget(Some(Duration::ZERO));
        runner.tick(100_000, &status, None, 0, [Some(&world), Some(&world)]);
        runner.advance_compute(100_016, &status);
        assert!(runner.sides[0].pending.is_some());

        // the range changes while the compute is pending; the next
        // advance_compute (which runs every frame, unlike the 40 ms tick)
        // must DROP the stale compute rather than finalize it — finalizing
        // would start a visible sweep of the old-range image
        status.efis_data_capt.nd_range = 20.0;
        for _ in 0..10_000 {
            let outs = runner.advance_compute(100_032, &status);
            assert!(
                outs[0].nd_frame.is_none() && outs[0].thresholds_write.is_none(),
                "stale compute must never install a frame"
            );
            if runner.sides[0].pending.is_none() {
                break;
            }
        }
        assert!(runner.sides[0].pending.is_none(), "stale compute dropped");
        assert!(!runner.sides[0].cycle_active);
        assert!(
            runner.sides[0].next_cycle_at.is_some(),
            "retry armed so the new configuration renders promptly"
        );

        // the following tick resets the side and queues the new-range cycle
        let out = runner.tick(100_040, &status, None, 0, [Some(&world), Some(&world)]);
        assert!(out[0].reset);
        let pending = runner.sides[0].pending.as_ref().expect("new compute queued");
        assert_eq!(pending.status.efis_data_capt.nd_range, 20.0);
    }

    #[test]
    fn terr_off_stops_after_reset() {
        let mut runner = Runner::new();
        let mut status = terr_active_status();
        let world = flat_world();

        run_ticks(&mut runner, &status, None, 0, &world, 100_000, 5);
        status.efis_data_capt.terr_on_nd = false;
        let out = runner.tick(100_000 + 5 * 40, &status, None, 0, [Some(&world), Some(&world)]);
        let tw = out[0].thresholds_write.expect("reset write");
        assert_eq!(tw.minimum_elevation, -1.0);
        assert!(out[0].reset, "stale images must be dropped");
        assert!(!runner.sides[0].cycle_active);
        assert!(!runner.draw_state(0).show_nd, "nothing to draw after reset");

        // stays quiet afterwards
        let frames = run_ticks(&mut runner, &status, None, 0, &world, 100_000 + 6 * 40, 30);
        assert!(frames.iter().all(|f| !f[0]));
    }

    #[test]
    fn interrupted_sweep_frame_is_not_promoted() {
        let mut runner = Runner::new();
        let status = terr_active_status();
        let world = flat_world();

        // cycle 1 completes fully (tick 0 start + 45 sweep ticks + idle)
        run_ticks(&mut runner, &status, None, 0, &world, 100_000, 46);
        // cycle 2 starts at tick 70 with the completed sweep promoted
        let mut out = runner.tick(102_800, &status, None, 0, [Some(&world), Some(&world)]);
        assert!(out[0].nd_frame.take().expect("restart frame").promote_previous);

        // a VD-path change mid-sweep forces a redraw; the interrupted cycle-2
        // frame must be discarded, not promoted
        run_ticks(&mut runner, &status, None, 0, &world, 102_840, 5);
        let path = VerticalPathData {
            path_width: 1.0,
            track_changes_significantly_at_distance: -1.0,
            waypoints: vec![(47.3, 11.4)],
        };
        let mut out = runner.tick(103_040, &status, Some(&path), 1, [Some(&world), Some(&world)]);
        let frame = out[0].nd_frame.take().expect("forced redraw frame");
        assert!(!frame.promote_previous, "interrupted sweep must be discarded");
    }

    #[test]
    fn first_activation_partial_validity_tracked() {
        let mut runner = Runner::new();
        let status = terr_active_status();
        let world = flat_world();

        // right side starts mid-phase at border 54 (see the stagger test)
        runner.tick(100_000, &status, None, 0, [Some(&world), Some(&world)]);
        assert_eq!(runner.draw_state(1).nd.start_border, 54);

        // its sweep completes after (90 - 54) / 2 = 18 ticks
        run_ticks(&mut runner, &status, None, 0, &world, 100_040, 18);
        assert!(runner.draw_state(1).nd.done);

        // idle, then cycle 2 starts from 0 over the partially valid base
        run_ticks(&mut runner, &status, None, 0, &world, 100_760, 26);
        let ds = runner.draw_state(1);
        assert!(ds.nd.has_old);
        assert_eq!(ds.nd.old_valid_border, 54, "base only valid from its start border");
        assert_eq!(ds.nd.start_border, 0);
    }

    #[test]
    fn vd_only_cycle_emits_only_vd_frame() {
        // A380X-shaped status: scanline + VD required, TERR ON ND deselected
        let mut status = startup_status();
        status.navigation_display_rendering_mode = 3;
        status.efis_data_capt.terr_on_nd = false;
        status.efis_data_capt.terr_on_vd = true;
        status.efis_data_capt.efis_mode = 2; // ROSE NAV renders the VD
        status.efis_data_capt.arc_mode = false;
        let world = flat_world();

        let mut runner = Runner::new();
        let mut out = runner.tick(100_000, &status, None, 0, [Some(&world), Some(&world)]);
        assert!(out[0].nd_frame.is_none(), "TERR ON ND deselected: no ND frame");
        assert!(out[0].vd_frame.take().is_some(), "VD frame expected");

        let ds = runner.draw_state(0);
        assert!(!ds.show_nd);
        assert!(ds.show_vd);
        assert_eq!(ds.nd.style, TransitionStyle::ScanlineNd);
        assert!(ds.screen_with_vd);
    }
}
