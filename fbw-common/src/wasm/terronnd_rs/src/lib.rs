//! In-process terrain-on-ND/VD gauge.
//!
//! The rendering core under the plain module list is a port of the SimBridge
//! terrain module (`simbridge/terrain-rust`, commit 82191e6c) — keep diffs
//! against upstream minimal so fixes can be cross-ported. The wasm-only
//! modules replace SimBridge's HTTP/thread/SimConnect-transport infrastructure
//! with direct LVar input and NanoVG output inside the sim.

pub mod block_map;
pub mod compositor;
#[cfg(not(target_arch = "wasm32"))]
pub mod convert;
pub mod elevation_map;
pub mod fileformat;
pub mod fileformat_v2;
pub mod geodesy;
pub mod jsmath;
pub mod nd_render;
pub mod patterns;
pub mod region;
pub mod reveal;
pub mod runner;
pub mod state;
pub mod statistics;
pub mod transition;
pub mod vd_path;
pub mod vd_render;
pub mod worldmap;

#[cfg(target_arch = "wasm32")]
mod blit;
#[cfg(target_arch = "wasm32")]
mod cfile;
#[cfg(target_arch = "wasm32")]
mod gauge;
#[cfg(target_arch = "wasm32")]
mod input;
#[cfg(target_arch = "wasm32")]
mod io;
#[cfg(target_arch = "wasm32")]
mod output;
