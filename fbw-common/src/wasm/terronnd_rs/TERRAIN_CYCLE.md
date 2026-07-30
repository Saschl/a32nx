# How a terrain frame is made

A walkthrough of one terrain image's life, from the sim's gauge callbacks to
the pixels on the ND/VD — including where the in-memory mips come from.
Companion to [README.md](README.md), which covers provenance and file
formats; this file covers the runtime flow.

## The two callbacks

The sim calls every gauge instance (captain + F/O) twice per frame:

- **`terronnd_gauge_update`** — has frame-time slack; all heavy CPU work
  lives here. Only the *first* instance runs the shared work
  (`gauge::update_work`); both instances then upload any changed frame
  images to their NanoVG textures (`blit.sync_images`).
- **`terronnd_gauge_draw`** — gates the instrument texture hand-off, so it
  stays minimal: advance the 40 ms renderer ticks once per frame timestamp
  (`gauge::draw_ticks`), then draw the side's images clipped to the sweep.

```
                            one sim frame
 ──────────────────────────────────────────────────────────────────────
  UPDATE (first instance only)                DRAW (per frame timestamp)
 ┌──────────────────────────────────┐        ┌───────────────────────────┐
 │ 1 sample inputs                  │        │ 5 runner.tick (40 ms)     │
 │   LVars / CommBus status, VD path│        │   · start cycle when due  │
 │ 2 region.update_budgeted         │        │     (needs side_covered + │
 │   · poll fsIORead completions    │        │      level snapshot)      │
 │   · inflate ≤640 KB (budget)     │        │   · advance sweep state   │
 │   · issue next coalesced read    │        │   · promote finished frame│
 │   · stitch ≤2 bands of the level │        │ 6 blit.render per display │
 │     being built (L1/L2: per-tile │        │   old/new ND+VD images    │
 │     max-reduce while stitching)  │        │   clipped to sweep wedge  │
 │   · publish the finished raster  │        │   (GPU does the blend)    │
 │ 3 sides_ready = side_covered     │        └───────────────────────────┘
 │ 4 runner.advance_compute         │
 │   ≤ CYCLE_COMPUTE_BUDGET_MS of   │
 │   extract/render slices (drops   │
 │   stale-config cycles)           │
 └──────────────────────────────────┘
```

## The data path (update side)

`terrain2.map` (v3: flat directory + grid-sorted verbatim v1 gzip payloads)
feeds three persistent region rasters kept warm around the aircraft, one per
display level ([region.rs](src/region.rs)):

```
 terrain2.map ──fsIORead──► run buffer ──slice──► per-tile gzip ──inflate──► LRU cache
 (1 coalesced row range                (directory offsets)      (≤640 KB/frame)  (24 MB)
  in flight, ≤1 MB)                                                        │
                                                                     band ready?
                                                                           ▼
                                                        band stitch (≤2 bands/frame)
                                                        L0: copy tile rows verbatim
                                                        L1/L2: 2x2/4x4 max-reduce
                                                                each tile first
                                                                           ▼
                                            publish the level's raster on complete
```

- **Sizing** (per level, by aircraft capability): L0 covers the ranges that
  display full res (≤160 nm → ~217 nm rect, ~16 MB); L1 covers 320 nm at
  1/4 density (~15 MB); L2 covers 640 nm at 1/16 (~19 MB) — ~50 MB
  resident. Range changes never load anything; only drifting past a level's
  margin (15/30/90 nm — the expensive L2 rebuild is rare) or a position
  jump rebuilds that level in the background (displayed levels first, old
  raster stays published meanwhile).
- **Loading**: thanks to the v3 grid-sort, all present tiles of one tile row
  are one contiguous byte range → one `fsIORead` per rect row (split at
  1 MB / the antimeridian). Strictly one read in flight; a watchdog retires
  reads the sim never answers (600 frames) into the normal retry path
  (4 attempts, then the tile assembles as Unknown).
- **Stitching**: a band (one tile row) is copied into the raster as soon as
  all its tiles are decoded — north to south, publish-on-complete. Absent
  DB tiles become water, unreadable ones Unknown; tiles crop to the rect's
  min dims with centered offsets (exact v1 stitch semantics).

## How the mips are generated

There are no mips in the file — they are **derived per tile while a coarse
raster assembles**. When an L1/L2 build stitches a band, each decoded
full-resolution tile in that band's row is first 2×2 (L1) or 4×4 (L2)
max-reduced — straight from the tile cache entry, once per band — and the
reduced grid is then cropped and copied with the exact same centered
crop-to-min-dims rule as the full-res stitch:

- **Maximum** is the TAWS-safe reduction — a coarse cell can overstate but
  never hide a peak. Unknown (32766) dominates the max, so an unreadable
  patch stays visible at every level; water (−1) loses to any land. Dims
  are ceil-halved; the odd last row/column reduces whatever remains.
- Each level is a raster over **its own rect** (L1/L2 reach further out than
  L0) and publishes on completion. Because the reductions are computed from
  the same decoded tiles at assembly time, they can never be stale, missing
  or half-loaded — the failure modes of the old *streamed* file mips are
  structurally impossible.

At render time each side picks its level from the display's sample spacing
(`display_level`): **≤160 nm → L0 (full res), 320 nm → L1, 640 nm → L2**.
`snapshot_for_side` hands the renderer a `WorldMap` view of that level's
raster. The point of the exercise is memory locality: a 640 nm block max
reads ~300 cells of a ~19 MB cache-resident L2 instead of ~4,600 cells
scattered over a 220 MB full-resolution monolith (~1.25 ms vs ~4 ms host per
extraction; in-sim the gap is far larger because a big raster never survives
in cache between budget slices) — and per-level extents keep the whole
resident set at ~50 MB.

## The render cycle (draw side driving, update side computing)

`runner.tick` fires on the 40 ms transition cadence from `draw_ticks`. When
a side's idle timeout expires (1000 ms arc / 500 ms scanline after the
previous sweep finished) *and* the region covers the side
(`sides_ready`), a **cycle** starts: it captures the aircraft status and the
side's level snapshot, then the actual work is sliced by
`runner.advance_compute` — up to `CYCLE_COMPUTE_BUDGET_MS` per update
callback:

1. **Extract** ([block_map.rs](src/block_map.rs)): project only the 8×8
   block-corner lattice (~6k exact projections), take each block's maximum
   over its world-space footprint in the level raster — one block row per
   slice, ~5,800 block maxima total.
2. **Stats** ([nd_render.rs](src/nd_render.rs) /
   [statistics.rs](src/statistics.rs)): histogram over the block maxima,
   runway cut-off altitude, percentile thresholds → band table
   (peaks/caution/warning colours).
3. **Paint**: `PreparedRender::from_blocks` classifies each block once, then
   paints RGBA rows against the arc/scanline density patterns.
4. **VD** (A380X): elevation profile sampled from the same level raster
   along the FMS path / manual azimuth, rendered to the VD strip.

The finished `CycleFrame` lands in the gauge's per-side image slots
(old/new ND, old/new VD). The **sweep is pure GPU**: `blit.render` draws the
previous image clipped to the not-yet-swept region and the new image clipped
to the swept wedge ([reveal.rs](src/reveal.rs)); per tick only the border
angle advances. When the sweep completes, the idle timeout re-arms and the
next cycle waits its turn.

Cold start / position jumps are the only times a display waits: cycle starts
are gated on `side_covered`, so the screen shows the reset background (never
an Unknown fringe) until the first publish; after that every range/mode flip
renders instantly from the already-resident level rasters.

## Budgets and knobs (current values)

| Constant | Where | Value | Meaning |
|---|---|---|---|
| `LOAD_BUDGET_BYTES_PER_FRAME` | gauge.rs | 640 KB | decompressed tile bytes inflated per frame |
| `STITCH_BAND_BUDGET_PER_FRAME` | gauge.rs | 2 | tile-row bands stitched (+ reduced) per frame |
| `CYCLE_COMPUTE_BUDGET_MS` | gauge.rs | 10 | per-frame slice of extract/render work |
| `TRANSITION_DELTA_TIME_MS` | transition.rs | 40 ms | renderer tick / sweep step cadence |
| `ARC/SCANLINE_UPDATE_TIMEOUT_MS` | transition.rs | 1000 / 500 ms | idle time between a finished sweep and the next cycle |
| `MAX_RUN_BYTES` / in-flight | region.rs | 1 MB / 1 | coalesced read size / concurrency |
| `RUN_TIMEOUT_POLLS` | region.rs | 600 | frames before a silent read is retried |
| `READ_ATTEMPT_LIMIT` | region.rs | 4 | attempts before a tile degrades to Unknown |
| `TILE_CACHE_BYTES` | region.rs | 24 MB | decoded-tile LRU bound |
| `LEVEL_MARGINS_NM` | region.rs | 15/30/90 nm | per-level drift hysteresis before a rebuild |
| `MAX_REGION_CELLS` | region.rs | 128 M | polar column clamp (256 MB raster cap) |

## Console breadcrumbs

- `TERR ON ND: terrain2.map opened, 180x360 tile directory` — file OK.
- `TERR ON ND: async tile IO enabled (fsIORead)` — async transport active
  (otherwise: blocking-read fallback warning).
- `TERR ON ND: region build: band X/Y, N reads in flight, M payloads queued`
  — every 5 s while a raster assembles.
- `TERR ON ND: tile IO: A reads ok, B rejected, C short/failed, D tiles
  unknown` — transport health, every 5 s while the counters move.
- `TERR ON ND: L/R cycle computed: extract X ms, render Y ms` — per-cycle
  cost, summed over the budget slices.
