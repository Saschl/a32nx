//! The gauge itself: raw multi-callback exports with the exact shape of the
//! C++ gauge (`terronnd_gauge_init/update/draw/kill`). panel.cfg passes
//! `<L|R>,<terrain folder>` as the install parameter string (e.g.
//! `L,fbw-a32nx`), selecting the display side and the aircraft's terrain2.map
//! location. `#[msfs::gauge]` cannot be used here: terronnd is instantiated
//! twice (L/R) and the macro's single static executor drops the first
//! instance's future on the second install, and never surfaces
//! `strParameters`.
//!
//! All work runs on the draw callback: once per sim frame the shared state is
//! advanced (input sampling, budgeted world-map work, 40 ms renderer ticks),
//! then every instance blits its side's frame.

use std::cell::RefCell;
use std::rc::Rc;

use msfs::commbus::CommBus;
use msfs::sys;

use crate::blit::Blit;
use crate::fileformat_v2::TerrainMapV2;
use crate::input::InputAdapter;
use crate::output::ThresholdVars;
use crate::region::{RegionInputs, RegionManager};
use crate::runner::{CycleFrame, Runner, SideOutput, VerticalPathData};
use crate::state::AircraftStatus;
use crate::transition::TRANSITION_DELTA_TIME_MS;
use crate::vd_path::{parse_aircraft_status, parse_vd_path};

/// Map location inside the aircraft package (VFS `.` = package root), placed
/// there by `scripts/terrain_map.js` (v1 -> v2 conversion at build time).
/// The per-aircraft folder (`fbw-a32nx` / `fbw-a380x`) comes from the second
/// gauge parameter in panel.cfg.
fn terrain_map_path(folder: &str) -> String {
    format!("./terrain/{folder}/terrain2.map")
}

/// Decompressed tile bytes inflated per sim frame during region rebuilds
/// (~4 full-res tiles per frame; the full A380X-sized raster warms up in a
/// few seconds, streaming north to south).
const LOAD_BUDGET_BYTES_PER_FRAME: usize = 640 * 1024;
/// Region tile-row bands copied per sim frame (a few hundred KB each).
const STITCH_BAND_BUDGET_PER_FRAME: usize = 2;

/// How long a CommBus aircraft status overrides the LVar-derived one — the
/// same window SimBridge granted HTTP client data over SimConnect.
const STATUS_OVERRIDE_TIMEOUT_MS: u64 = 2 * 60 * 1000;

/// Per-frame time budget for the amortized cycle computation (the ~200 ms
/// elevation extraction + render, spread across frames by the runner). Bigger
/// = faster terrain refresh, smaller = smoother frame times. This work runs in
/// the UPDATE callback, which has more frame-time slack than the draw phase
/// (draw gates the instrument texture hand-off to the render pipeline).
const CYCLE_COMPUTE_BUDGET_MS: u64 = 4;

/// Warn on the MSFS console when the shared per-frame work exceeds this.
const SLOW_FRAME_WARN_MS: u128 = 8;

const SIDE_LEFT: usize = 0;
const SIDE_RIGHT: usize = 1;

pub(crate) const SLOT_ND_OLD: usize = 0;
pub(crate) const SLOT_ND_NEW: usize = 1;
pub(crate) const SLOT_VD_OLD: usize = 2;
pub(crate) const SLOT_VD_NEW: usize = 3;
pub(crate) const SLOT_COUNT: usize = 4;

/// One cycle frame held CPU-side, mirrored into an NVG image by the blit.
pub(crate) struct FrameBuf {
    pub rgba: Vec<u8>,
    pub width: usize,
    pub height: usize,
}

/// Per-side frame slots (previous/current ND and VD frames). Stamps let each
/// display's blit mirror the slots idempotently — one upload per change,
/// automatic full resync for a fresh NVG context.
#[derive(Default)]
pub(crate) struct SideImages {
    pub slots: [Option<FrameBuf>; SLOT_COUNT],
    pub stamps: [u64; SLOT_COUNT],
    pub generation: u64,
}

/// Install a cycle's frame: on `promote_previous` the completed previous
/// frame becomes the base image; otherwise the interrupted previous frame is
/// discarded while the base (last COMPLETED frame) stays — mirroring
/// `Transition::last_frame` semantics.
fn install_frame(images: &mut SideImages, old_slot: usize, new_slot: usize, frame: CycleFrame) {
    images.generation += 1;
    let generation = images.generation;
    if frame.promote_previous {
        images.slots[old_slot] = images.slots[new_slot]
            .take()
            // geometry changes always come through a reset; never keep a
            // mismatched base regardless
            .filter(|old| old.width == frame.width && old.height == frame.height);
        images.stamps[old_slot] = generation;
    }
    images.slots[new_slot] = Some(FrameBuf {
        rgba: frame.rgba,
        width: frame.width,
        height: frame.height,
    });
    images.stamps[new_slot] = generation;
}

#[derive(Default)]
struct CommBusInbox {
    vd_path: Option<VerticalPathData>,
    vd_path_seq: u64,
    vd_path_errors: u64,
    status_pending: Option<AircraftStatus>,
    status_received: u64,
    status_errors: u64,
}

enum MapState {
    /// terrain2.map missing/corrupt: gauge stays alive, displays stay empty.
    Failed,
    Ready(Box<RegionManager>),
}

struct DisplayInstance {
    ctx: sys::FsContext,
    side_index: usize,
    blit: Blit,
}

struct TerrainModule {
    map: MapState,
    runner: Runner,
    input: InputAdapter,
    output: ThresholdVars,
    // keeps the CommBus registrations alive
    _commbus: CommBus<'static>,
    inbox: Rc<RefCell<CommBusInbox>>,
    status_override: Option<AircraftStatus>,
    status_override_until_ms: u64,
    /// Latest sampled aircraft status + VD path, refreshed by the update
    /// callback and consumed by the draw-side renderer ticks.
    status: Option<AircraftStatus>,
    vd_path: Option<VerticalPathData>,
    vd_path_seq: u64,
    displays: Vec<DisplayInstance>,
    /// Per-side frame slots the displays' blits mirror into NVG images.
    images: [SideImages; 2],
    next_tick_ms: u64,
    last_frame_ms: u64,
    ticks_initialized: bool,
    /// Per-side region coverage, refreshed by update_work; gates cycle starts.
    sides_ready: [bool; 2],
    /// Last logged tile-IO stats + earliest next log time (rate limit).
    logged_io_stats: (u64, u64, u64, u64),
    next_io_log_ms: u64,
    /// Earliest next region-build progress log (rate limit).
    next_build_log_ms: u64,
    /// Deferred CommBus diagnostics (printed from update_work, never from the
    /// callbacks themselves).
    logged_status_active: bool,
    logged_vd_waypoints: Option<usize>,
    logged_commbus_errors: u64,
}

impl TerrainModule {
    fn new(map_path: Option<&str>) -> Self {
        let map = match map_path {
            Some(map_path) => match TerrainMapV2::open(map_path) {
                Ok(terrain) => {
                    println!(
                        "TERR ON ND: {map_path} opened, {}x{} tile directory",
                        terrain.header.dir_rows, terrain.header.dir_cols
                    );
                    let mut region = RegionManager::new(terrain);
                    // async tile reads (fsIORead): package files may be streamed
                    // by the sim, and blocking freads in the update callback can
                    // stall whole frames — observed as lockups on range changes
                    match crate::io::AsyncTileIo::open(map_path) {
                        Some(io) => {
                            println!("TERR ON ND: async tile IO enabled (fsIORead)");
                            region.use_async_io(io);
                        }
                        None => {
                            eprintln!(
                                "TERR ON ND: fsIOOpen rejected — falling back to blocking reads"
                            );
                        }
                    }
                    MapState::Ready(Box::new(region))
                }
                Err(e) => {
                    eprintln!("TERR ON ND: cannot open {map_path}: {e} — terrain disabled");
                    MapState::Failed
                }
            },
            None => {
                eprintln!(
                    "TERR ON ND: no terrain folder in gauge parameters (expected e.g. `L,fbw-a32nx` in panel.cfg) — terrain disabled"
                );
                MapState::Failed
            }
        };

        let inbox = Rc::new(RefCell::new(CommBusInbox::default()));
        let mut commbus = CommBus::default();
        {
            let inbox = Rc::clone(&inbox);
            commbus.register("FBW_TERR_VD_PATH", move |payload| {
                let mut inbox = inbox.borrow_mut();
                match parse_vd_path(payload) {
                    Ok(path) => {
                        inbox.vd_path = Some(path);
                        inbox.vd_path_seq += 1;
                    }
                    Err(_) => inbox.vd_path_errors += 1,
                }
            });
        }
        {
            let inbox = Rc::clone(&inbox);
            commbus.register("FBW_TERR_AIRCRAFT_STATUS", move |payload| {
                let mut inbox = inbox.borrow_mut();
                match parse_aircraft_status(payload) {
                    Ok(status) => {
                        inbox.status_pending = Some(status);
                        inbox.status_received += 1;
                    }
                    Err(_) => inbox.status_errors += 1,
                }
            });
        }

        let mut runner = Runner::new();
        runner.set_compute_budget(Some(std::time::Duration::from_millis(
            CYCLE_COMPUTE_BUDGET_MS,
        )));

        Self {
            map,
            runner,
            input: InputAdapter::new(),
            output: ThresholdVars::new(),
            _commbus: commbus,
            inbox,
            status_override: None,
            status_override_until_ms: 0,
            status: None,
            vd_path: None,
            vd_path_seq: 0,
            displays: Vec::new(),
            images: [SideImages::default(), SideImages::default()],
            next_tick_ms: 0,
            last_frame_ms: u64::MAX,
            ticks_initialized: false,
            sides_ready: [false; 2],
            logged_io_stats: (0, 0, 0, 0),
            next_io_log_ms: 0,
            next_build_log_ms: 0,
            logged_status_active: false,
            logged_vd_waypoints: None,
            logged_commbus_errors: 0,
        }
    }

    /// Heavy per-frame work, run once per frame from the UPDATE callback of
    /// the first display instance: input sampling, budgeted world-map work and
    /// the amortized cycle computation. The update phase has frame-time slack
    /// the draw phase does not (draw gates the instrument texture).
    ///
    /// The update callback carries no absolute sim time, so timing-relevant
    /// bits use the last draw timestamp (at most one frame stale — only feeds
    /// the override timeout and the transition start phase).
    fn update_work(&mut self) {
        let started = std::time::Instant::now();
        let now_ms = if self.last_frame_ms == u64::MAX {
            0
        } else {
            self.last_frame_ms
        };

        // ingest CommBus arrivals (A380X full-status override, VD path) and
        // emit the deferred diagnostics — safe to print from here
        {
            let mut inbox = self.inbox.borrow_mut();
            if let Some(status) = inbox.status_pending.take() {
                if !self.logged_status_active {
                    self.logged_status_active = true;
                    println!(
                        "TERR ON ND: aircraft status override active (manualAzim={})",
                        status.manual_azim_enabled
                    );
                }
                self.status_override = Some(status);
                self.status_override_until_ms = now_ms + STATUS_OVERRIDE_TIMEOUT_MS;
            }

            self.vd_path = inbox.vd_path.clone();
            self.vd_path_seq = inbox.vd_path_seq;
            if let Some(path) = &inbox.vd_path {
                if self.logged_vd_waypoints != Some(path.waypoints.len()) {
                    self.logged_vd_waypoints = Some(path.waypoints.len());
                    println!(
                        "TERR ON ND: VD path received: {} waypoints, track change at {:.1} nm",
                        path.waypoints.len(),
                        path.track_changes_significantly_at_distance
                    );
                }
            }

            let errors = inbox.vd_path_errors + inbox.status_errors;
            if errors != self.logged_commbus_errors {
                self.logged_commbus_errors = errors;
                println!(
                    "TERR ON ND: CommBus parse errors: vdPath={} status={}",
                    inbox.vd_path_errors, inbox.status_errors
                );
            }
        }
        if self.status_override.is_some() && now_ms >= self.status_override_until_ms {
            self.status_override = None;
        }

        let status = match &self.status_override {
            Some(status) => status.clone(),
            None => self.input.aircraft_status(),
        };

        {
            let MapState::Ready(world) = &mut self.map else {
                self.status = Some(status);
                return;
            };
            let inputs = RegionInputs::from_status(&status);
            world.update_budgeted(
                &inputs,
                LOAD_BUDGET_BYTES_PER_FRAME,
                STITCH_BAND_BUDGET_PER_FRAME,
            );
            // per-side gating: a side whose display circle the published
            // region does not cover yet starts no cycle (no Unknown fringe
            // mid-load); the other side keeps rendering
            self.sides_ready = [
                world.side_covered(&inputs, SIDE_LEFT),
                world.side_covered(&inputs, SIDE_RIGHT),
            ];

            // transport diagnostics, rate-limited (deferred-print pattern)
            let io_stats = world.io_stats();
            if io_stats != self.logged_io_stats && now_ms >= self.next_io_log_ms {
                self.logged_io_stats = io_stats;
                self.next_io_log_ms = now_ms + 5000;
                let (ok, rejected, short, unknown_tiles) = io_stats;
                println!(
                    "TERR ON ND: tile IO: {ok} reads ok, {rejected} rejected, {short} short/failed, {unknown_tiles} tiles unknown"
                );
            }

            // build progress while a raster is assembling — the breadcrumb
            // that separates "transport is silent" from "decode is slow"
            if let Some((band, total, in_flight, queued)) = world.build_progress() {
                if now_ms >= self.next_build_log_ms {
                    self.next_build_log_ms = now_ms + 5000;
                    println!(
                        "TERR ON ND: region build: band {band}/{total}, {in_flight} reads in flight, {queued} payloads queued"
                    );
                }
            }
        }
        self.status = Some(status);

        // amortized cycle computation: a time-budgeted slice every frame.
        // The current status lets the runner drop a compute whose captured
        // EFIS configuration went stale mid-cycle (range flip) instead of
        // sweeping the old-range image for a moment.
        let status_ref = self.status.as_ref().expect("assigned above");
        let outputs = self.runner.advance_compute(now_ms, status_ref);
        Self::apply_side_outputs(&mut self.images, &self.output, outputs);

        let elapsed = started.elapsed().as_millis();
        if elapsed > CYCLE_COMPUTE_BUDGET_MS as u128 + 4 {
            println!("TERR ON ND: slow update: {elapsed} ms");
        }
    }

    /// Draw-side shared work, once per sim frame: the 40 ms renderer cadence
    /// (transition blend + compose — a few ms). Kept in draw because it is
    /// driven by the draw data's absolute sim time.
    fn draw_ticks(&mut self, now_ms: u64) {
        let started = std::time::Instant::now();
        let Some(status) = self.status.clone() else {
            return;
        };
        let MapState::Ready(world) = &mut self.map else {
            return;
        };

        if !self.ticks_initialized {
            self.ticks_initialized = true;
            self.next_tick_ms = now_ms;
        }

        // both sides share the single persistent raster; each side renders
        // only when the region coverage is ready
        let inputs = RegionInputs::from_status(&status);
        let snapshots = [
            self.sides_ready[SIDE_LEFT]
                .then(|| world.snapshot_for_side(&inputs, SIDE_LEFT))
                .flatten(),
            self.sides_ready[SIDE_RIGHT]
                .then(|| world.snapshot_for_side(&inputs, SIDE_RIGHT))
                .flatten(),
        ];

        // at most two catch-up ticks, then resync instead of spiraling
        let mut catch_up = 0;
        while now_ms >= self.next_tick_ms && catch_up < 2 {
            let outputs = self.runner.tick(
                self.next_tick_ms,
                &status,
                self.vd_path.as_ref(),
                self.vd_path_seq,
                [snapshots[0].as_ref(), snapshots[1].as_ref()],
            );
            Self::apply_side_outputs(&mut self.images, &self.output, outputs);
            self.next_tick_ms += TRANSITION_DELTA_TIME_MS;
            catch_up += 1;
        }
        if now_ms >= self.next_tick_ms {
            self.next_tick_ms = now_ms + TRANSITION_DELTA_TIME_MS;
        }

        let elapsed = started.elapsed().as_millis();
        if elapsed > SLOW_FRAME_WARN_MS {
            println!("TERR ON ND: slow draw ticks: {elapsed} ms");
        }
    }

    /// Takes the fields directly (not `&mut self`) so it can run while the
    /// world-map borrow from `self.map` is alive.
    fn apply_side_outputs(
        images: &mut [SideImages; 2],
        output: &ThresholdVars,
        outputs: [SideOutput; 2],
    ) {
        for (side, out) in outputs.into_iter().enumerate() {
            if out.reset {
                let side_images = &mut images[side];
                side_images.generation += 1;
                let generation = side_images.generation;
                side_images.slots = Default::default();
                side_images.stamps = [generation; SLOT_COUNT];
            }
            if let Some(thresholds) = &out.thresholds_write {
                output.write(side, thresholds);
            }
            if let Some(frame) = out.nd_frame {
                install_frame(&mut images[side], SLOT_ND_OLD, SLOT_ND_NEW, frame);
            }
            if let Some(frame) = out.vd_frame {
                install_frame(&mut images[side], SLOT_VD_OLD, SLOT_VD_NEW, frame);
            }
        }
    }
}

/// SAFETY: MSFS WASM modules are single threaded; all access happens from the
/// gauge callbacks (the same pattern `msfs_derive` uses for its executors).
static mut MODULE: Option<TerrainModule> = None;

#[allow(static_mut_refs)]
fn module_slot() -> &'static mut Option<TerrainModule> {
    unsafe { &mut *std::ptr::addr_of_mut!(MODULE) }
}

/// panel.cfg gauge parameters: `<L|R>,<terrain folder>`, e.g. `L,fbw-a32nx`.
struct GaugeParameters {
    side_index: usize,
    /// Package subfolder holding terrain2.map (`fbw-a32nx` / `fbw-a380x`).
    terrain_folder: Option<String>,
}

fn parse_parameters(install: *mut sys::sGaugeInstallData) -> Option<GaugeParameters> {
    if install.is_null() {
        return None;
    }
    let parameters = unsafe { (*install).strParameters };
    if parameters.is_null() {
        return None;
    }
    let parameters = unsafe { std::ffi::CStr::from_ptr(parameters) };
    let mut tokens = parameters.to_str().ok()?.split(' ').map(str::trim);
    let side_index = match tokens.next()?.chars().next()? {
        'L' | 'l' => SIDE_LEFT,
        'R' | 'r' => SIDE_RIGHT,
        _ => return None,
    };
    println!("TERR ON ND params: {}", parameters.to_str().unwrap());
    let terrain_folder = tokens
        .next()
        .filter(|folder| !folder.is_empty())
        .map(str::to_owned);
    Some(GaugeParameters {
        side_index,
        terrain_folder,
    })
}

#[no_mangle]
pub extern "C" fn terronnd_gauge_init(
    ctx: sys::FsContext,
    install: *mut sys::sGaugeInstallData,
) -> bool {
    let Some(parameters) = parse_parameters(install) else {
        eprintln!("TERR ON ND: gauge installed without L/R parameter — ignored");
        return true;
    };
    let side_index = parameters.side_index;

    let slot = module_slot();
    if slot.is_none() {
        let map_path = parameters.terrain_folder.as_deref().map(terrain_map_path);
        *slot = Some(TerrainModule::new(map_path.as_deref()));
    }
    let module = slot.as_mut().unwrap();
    let Some(blit) = Blit::create(ctx) else {
        eprintln!("TERR ON ND: NanoVG context creation failed");
        return false;
    };

    module.displays.retain(|d| d.ctx != ctx);
    module.displays.push(DisplayInstance {
        ctx,
        side_index,
        blit,
    });
    // initial threshold reset, like the C++ Display constructor
    module.output.reset(side_index);
    println!(
        "TERR ON ND: created {} display",
        if side_index == SIDE_LEFT {
            "left"
        } else {
            "right"
        }
    );
    true
}

#[no_mangle]
pub extern "C" fn terronnd_gauge_update(ctx: sys::FsContext, _d_time: f32) -> bool {
    let Some(module) = module_slot().as_mut() else {
        return true;
    };
    // both instances get update calls; the shared heavy work runs once, in
    // the first instance's update
    if module.displays.first().map(|d| d.ctx) == Some(ctx) {
        module.update_work();
    }
    // texture uploads also live in the update phase (the C++ gauge created
    // its NVG images from update-context callbacks), keeping draw minimal
    if let Some(instance_index) = module.displays.iter().position(|d| d.ctx == ctx) {
        let side_index = module.displays[instance_index].side_index;
        let side_images = &module.images[side_index];
        module.displays[instance_index]
            .blit
            .sync_images(side_images);
    }
    true
}

#[no_mangle]
pub extern "C" fn terronnd_gauge_draw(ctx: sys::FsContext, draw: *mut sys::sGaugeDrawData) -> bool {
    let Some(module) = module_slot().as_mut() else {
        return true;
    };
    if draw.is_null() {
        return true;
    }
    let draw = unsafe { &*draw };

    let now_ms = (draw.t * 1000.0) as u64;
    if now_ms != module.last_frame_ms {
        module.last_frame_ms = now_ms;
        module.draw_ticks(now_ms);
    }

    let Some(instance_index) = module.displays.iter().position(|d| d.ctx == ctx) else {
        return true;
    };
    let side_index = module.displays[instance_index].side_index;

    let draw_state = module.runner.draw_state(side_index);
    let config = module.input.display_config(side_index);
    let dark_background = module.input.vertical_display_required();
    module.displays[instance_index].blit.render(
        draw,
        config.powered,
        dark_background,
        config.potentiometer,
        &draw_state,
    );
    true
}

#[no_mangle]
pub extern "C" fn terronnd_gauge_kill(ctx: sys::FsContext) -> bool {
    if let Some(module) = module_slot().as_mut() {
        module.displays.retain(|d| d.ctx != ctx);
        if module.displays.is_empty() {
            *module_slot() = None;
            println!("TERR ON ND: last display killed, module shut down");
        }
    }
    true
}
