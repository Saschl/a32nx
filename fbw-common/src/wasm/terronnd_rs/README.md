# terronnd_rs — in-process terrain gauge

Rust WASM gauge that replaces the C++ `terronnd` gauge plus the external
SimBridge terrain service. It runs the SimBridge terrain renderer inside the
sim: aircraft/EFIS data is read from the same LVars/SimVars the C++ gauge read
(`fbw-common/src/wasm/terronnd/src/navigationdisplay/collection.cpp`), the
terrain frame is computed single-threaded on the gauge's draw callback, and the
resulting RGBA buffer is drawn directly with NanoVG. No HTTP server, no
threads, no PNG encoding, no SimConnect image transport.

## Provenance

The rendering core (`jsmath`, `geodesy`, `fileformat`, `worldmap`,
`elevation_map`, `statistics`, `nd_render`, `vd_render`, `patterns`,
`transition`, `compositor`, `state` and the `assets/` pattern tables) is copied
from the SimBridge repo, `terrain-rust/` at commit
`82191e6c3074949f48a9c4439e7030a11d74b163`, with three modules tracking later
upstream commits: `elevation_map.rs` the warp-grid rewrite of `a63ba66`,
`nd_render.rs` the band/LUT renderer of `2a03b7e` and `transition.rs` the
cached arc angle mask of `86baf89` (port of SimBridge PR #157). Local
deviations, kept as small as possible so upstream fixes cross-port:

- `fileformat.rs`: tile payloads are streamed from an open file handle
  (`TerrainMap::open`) instead of holding the whole ~232 MB `terrain.map` in
  memory; the metres->feet cell conversion is extracted as
  `feet_from_metres_cell` (shared with the v2 reader) and `raw_tile_payload`
  exposes compressed payloads to the converter. `from_bytes` is unchanged —
  the module remains the SimBridge v1 format reference.
- `worldmap.rs`: only the `WorldMap` snapshot struct (+ `extract_elevation`)
  remains from the upstream port. The 800 nm stitched monolith
  (`WorldMapManager`) was replaced by the gauge-only region runtime (see "The
  terrain2.map data layer" below); before deletion, every golden scenario was
  rendered through both data layers and asserted bit-identical.
- `orchestrator.rs` is NOT copied; `runner.rs` is its single-threaded rewrite
  driven by sim time instead of `Instant`/`thread::sleep`, returning raw RGBA
  frames instead of PNG-over-mpsc.
- the per-cycle ND computation (`extract_local_elevation_map`'s ~2.5M
  transcendentals + the frame colouring, ~200 ms total) is row-sliced and
  amortized across sim frames under a time budget
  (`gauge::CYCLE_COMPUTE_BUDGET_MS`, runner `advance_compute`) — the upstream
  service ran it on its own thread. Inputs are captured at cycle begin, so the
  output is bit-identical to the synchronous path (asserted by
  `runner::tests::budgeted_compute_matches_synchronous_output`); the cycle just
  starts a beat later. `elevation_map.rs` gained a resumable band variant and
  `nd_render.rs` a `PreparedRender` wrapper (classification once at analyze
  time, painting row-sliced) for this; the full-buffer functions delegate to
  them.
- `elevation_map.rs` follows the upstream warp-grid rewrite (simbridge
  commit `a63ba66`): exact projection only at 8x8 tile corners, bilinear
  interpolation in between, a per-tile centre probe (exact fallback when the
  mapping isn't locally affine — catches the antimeridian) and a polar guard.
  Local deviation: the tile walk is split into resumable bands
  (`extract_local_elevation_band`) so the runner can amortize it across sim
  frames; band-vs-full equality and warp-vs-exact tolerance are
  test-asserted, and the goldens (still pixel-exact) pin the production
  output. Benched ~2.4 ms per extraction, flat across ranges. The earlier
  local table/fastmath/row-lerp optimizations were superseded by this and
  removed. Table-vs-inline equivalence is test-asserted; the VD
  profile walk is O(waypoints + 540) instead of O(waypoints x 540)
  (bit-exact, test-asserted). `tests/golden.rs` also has a
  `GOLDEN_REGENERATE=1` mode that reports tolerances and rewrites the goldens,
  should a future change actually move pixels.
- `nd_render.rs` follows the upstream renderer optimization (simbridge commit
  `2a03b7e`): per-block colour-band classification plus 256-entry per-band
  colour LUTs, with a vectorizable row-wise `block_maxima` pass (the
  `#[inline(never)]` split between the passes is load-bearing for LLVM).
  Local deviation: the classification + tables are held in `PreparedRender`
  so the runner can paint in row slices; output is unchanged (goldens stayed
  pixel-exact).
- `transition.rs` carries the cached `arc_angle_mask` of simbridge commit
  `86baf89` in its reference blend functions; the mask-caching `Transition`
  field was not taken since our `Transition` no longer blends pixels. The
  `reveal.rs` bridge tests f32-cast their angle membership to match the mask
  storage.
- PRODUCTION ND EXTRACTION IS A DELIBERATE FORK: `block_map.rs` projects only
  the 8x8 block-corner lattice (the display never resolves terrain finer than
  the 8x8 blocks `nd_render` colours) and takes each block's maximum over its
  full world-space footprint in the region raster; the frame statistics run
  over the block maxima. Unlike the per-pixel kernel it can never miss a peak
  between sample points (TAWS-conservative at every range) and it is faster
  (0.5 ms/extract host at 10-80 nm, ~4 ms at 640 nm on the full-res raster —
  the footprint gather grows with range), but output is close-to rather than
  pixel-identical (0.4-6.7% of pixels shifted at the band edges when the
  goldens were re-pinned; the tolerance report lives in the golden
  regeneration log). The corner projection is the verbatim
  `Warp::exact_uv_lat` math, so the geometry cannot drift. `elevation_map.rs`
  (the upstream per-pixel kernel) is retained unchanged as the
  SimBridge-lineage reference — `block_map`'s dominance tests compare against
  it, and reverting production to it is a one-line runner change.
- the sweep animation is composed on the GPU instead of the CPU: the per-tick
  pixel blends in `transition.rs` and the screen assembly in `compositor.rs`
  are retained only as the SimBridge reference. The runner hands the gauge
  each cycle's final ND/VD frame once (`CycleFrame`), `Transition` is border
  bookkeeping only, and each draw clips the previous/current frame images to
  the swept bands (`reveal.rs` region algebra, drawn in `blit.rs` as scissored
  rect/pie image-pattern fills). The `reveal.rs` bridge tests assert the
  region algebra reproduces the CPU blends pixel-exactly, including
  first-activation partial sweeps and interrupted cycles.

## The terrain2.map data layer

(For the runtime flow — update/draw callbacks, cycle slicing, the in-memory
mip derivation — see [TERRAIN_CYCLE.md](TERRAIN_CYCLE.md).)

The gauge does not read the SimBridge `terrain.map` directly. At build time
`scripts/terrain_map.js` downloads the v1 database and converts it
(`src/convert.rs` via the host-run `terrain_map_convert` bin) into
`terrain2.map`, which is what ships in the aircraft package (~243 MB, format
version 3):

- **40-byte header + flat 180x360 tile directory** (12-byte records: dims +
  `{offset, len}`): `open()` is two reads instead of walking every tile
  header of the 232 MB v1 file.
- **Grid-sorted verbatim payloads**: the conversion is a pure repack — every
  gzip payload is copied verbatim from v1 (content is v1-identical by
  construction), written in ascending (row, col) order so all present tiles
  of one directory row occupy one contiguous byte range.
- Full layout spec in the `fileformat_v2.rs` module docs. Version 2 (the
  interim mip format) is rejected by the reader; the mips were dropped once
  block-native extraction made them redundant for peak-safety — see the
  history note below.

At runtime `region.rs` (gauge-only, not upstream-tracked) keeps THREE
persistent rasters warm around the aircraft — one per display level, each
sized by what that level actually renders: L0 full resolution out to the
largest range that displays full res (<=160 nm, ~217 nm corner radius,
~16 MB), and the L1/L2 max-reductions out to the 320/640 nm corner radii at
1/4 and 1/16 the cell density (~15/~19 MB) — ~50 MB resident total. The
vertical-display flag distinguishes the A380X (640 nm knob) from the A32NX
(320 nm) and latches once seen. The reductions are DERIVED PER TILE while a
raster assembles: a decoded full-resolution tile is 2x2/4x4 max-reduced
straight into the coarse raster (Unknown dominates the max, so unreadable
patches stay visible) — no file mips, no per-level payloads, no level
streaming; a reduction can never be stale or missing. Each display side
renders from the level its range selects (`snapshot_for_side`: <=160 nm L0,
320 nm L1, 640 nm L2), keeping every extraction cache-resident (~0.5-1.3 ms
host at every range). Range and mode changes never load anything: after the
warm-up every range change is instant, and at cold start the displayed
level's small raster publishes first (~1-2 s), with the coarse levels
warming in the background. The rasters follow the aircraft with per-level
drift margins (15/30/90 nm — the expensive L2 rebuild is rare; background
rebuilds, one at a time, displayed levels first; a build whose rect goes
stale after a position jump is abandoned). Near the poles a rect's longitude
span is cropped in columns around the aircraft (128 M cell cap) instead of
blowing the heap. Full-resolution tiles are cached in a byte-bounded LRU
(24 MB — coarse builds reduce from the same entries), loading/decode is
budgeted per frame, and bands are assembled as soon as their row's tiles are
decoded (streaming north to south, publish-on-complete). The assembly
reproduces the v1 stitch rules exactly (centered crop-to-min-dims, water/
unknown fills, corner snapping, ego-pixel math).

In the sim, payloads are read through the MSFS 2024 async IO API (`io.rs`:
raw `fsIOOpen`/`fsIORead` bindings until msfs-rs grows them) — package files
may be streamed and the SDK warns blocking reads can pause a module for
frames, which showed up as sim lockups on rapid range changes. The v3
grid-sort lets the loader COALESCE each rect row's missing tiles into a
single ranged read (`issue_runs`): a full A380X warm-up is a few dozen
multi-MB requests instead of ~1,100 scattered small ones. Up to 4 runs are in
flight; completions are drained once per frame, sliced back into per-tile
payloads via the directory offsets and inflated under the byte budget; hosts
and the fsIOOpen fallback use blocking reads through the same pump
(`tests/region.rs` covers the async path with a latency-simulating test
transport, including read-coalescing and transport-fault injection). Cycle
starts are gated on published-raster coverage (`side_covered`), so a cold
start shows the reset background (never an Unknown/magenta fringe) until the
raster publishes. Deliberate deviations from v1: pole row mirroring is
dropped (the database is empty above 83 N / below 84 S) and the crop-min is
evaluated over the local rect (verified golden-neutral).

History note — the interim v2 format kept three mip levels per tile and the
runtime streamed three level-rasters from them. Once ND extraction went
block-native (footprint maxima read EVERY cell under a block), the mips no
longer bought peak-safety, only memory locality, and the streaming machinery
(per-level loading, warm-up ordering, level-transition gating) was the main
source of complexity — so v3 dropped the file mips. An in-sim A/B then
showed the locality loss was severe at 640 nm (~50 ms per extraction on the
uncacheable 217 MB full-resolution monolith vs ~1-3 ms on a cache-resident
reduction), which brought the coarse levels back as derived in-memory
reductions; a second iteration moved from whole-raster derivation (which
forced full resolution over the whole 640 nm rect, ~285 MB + an equal
retired set) to the per-level extents described above: mip data without mip
streaming, at ~50 MB.

## Build

Built like the other Rust gauges, inside the FBW docker dev-env, but via
`cargo rustc --lib` with `--no-export-dynamic` plus explicit `--export=` of the
four gauge callbacks (`npm run build-a32nx:terronnd` / `build-a380x:terronnd`),
then wasm-opt to each aircraft's `panel/terronnd.wasm` (`--lib` keeps cargo off
the host-only `terrain_map_convert` bin target). panel.cfg is unchanged from
the C++ gauge: same module name, same `terronnd_gauge_init/update/draw/kill`
callbacks, side (`L`/`R`) from the gauge parameter string.

Two MSFS wasm-loader constraints shape this crate; violating either makes the
module fail to load with "wasi_snapshot_preview1 module not found":

- The sim resolves imports eagerly and implements only a subset of WASI (the
  union observed across the working FBW modules: fd_read/seek/close/write,
  path_open, prestat/fdstat, clock_time_get, environ, random_get, proc_exit,
  sched_yield, commit_pages, …). `std::fs` is banned in gauge code — its WASI
  layer imports nearly the full syscall table (sockets, path_rename, …); file
  I/O goes through the SDK libc instead (`cfile.rs`).
- This crate is `crate-type = ["cdylib", "rlib"]` (the rlib is what lets the
  host tests link it) — and **an rlib in the crate-type list makes cargo
  silently skip the workspace's fat LTO**. Without LTO no symbol gets
  internalized, so the shared `.cargo/config.toml`'s `--export-dynamic`
  exports ~1800 Rust-internal symbols; exported symbols are GC roots, which
  pins the std `wasi` crate's unused syscall wrappers and their unsupported
  imports (measured: 1823 exports / 47 WASI imports vs 19 / 15). The
  cdylib-only gauges (`a320_systems_wasm` etc.) never hit this because LTO
  internalizes everything first. The build scripts therefore use
  `cargo rustc --crate-type cdylib` (restores LTO for the shipped artifact)
  plus `--no-export-dynamic` and explicit `--export=` of the four gauge
  callbacks as defense in depth.

To audit the import surface after toolchain/dependency changes:
`node -e "console.log(WebAssembly.Module.imports(new WebAssembly.Module(require('fs').readFileSync('<wasm>'))).filter(i=>i.module!=='env').map(i=>i.name).join('\n'))"`

The gauge reads the terrain database from `./terrain/terrain2.map` inside the
aircraft package. `npm run build-a32nx:terrain-map` (or `-a380x:`) downloads
the v1 database from the FBW CDN, converts it with the host cargo toolchain
(idempotent — skipped when `cache/terrain2.map` is fresh and passes
`terrain_map_convert --check`) and places the converted file in the package
out tree (both files cached in `/cache`, git-ignored).

## Host tests

`cargo test -p terronnd` — no MSFS SDK required (the `msfs` dependency is
target-gated to wasm32). The golden pixel tests need a real `terrain.map`:
place it at the repo-root `cache/terrain.map` or set `SIMBRIDGE_TERRAIN_MAP`;
they are skipped otherwise. The test converts `cache/terrain2.map` on the fly
(a quick repack) when the build has not already produced it; the extraction
bench (`--test bench_extract -- --ignored --nocapture`) needs that converted
file too.
