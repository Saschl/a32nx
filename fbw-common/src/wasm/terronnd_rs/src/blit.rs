//! NanoVG output: per display instance one render context and four images
//! (previous/current ND frame, previous/current VD frame). The sweep is
//! composed on the GPU each draw — the old frame clipped to the not-yet-swept
//! band, the new frame clipped to the reveal band (regions from reveal.rs) —
//! so no CPU blending, no per-tick texture uploads: each cycle's frame is
//! uploaded exactly once. Power/brightness handling matches the C++
//! `displaybase.cpp` (edge antialiasing off, same background/blank fills,
//! potentiometer as image-pattern alpha).
//!
//! Uses the raw `msfs::sys` NanoVG bindings; the vendored NanoVG source
//! (fbw-common/src/wasm/terronnd/src/nanovg/nanovg.cpp) is the reference for
//! rasterization semantics (non-zero fill rule, transform-space scissor,
//! image patterns extending past the image extent — hence the scissor around
//! the arc sectors).

use msfs::sys;

use crate::compositor::{
    ND_MAP_START_OFFSET_Y, SCREEN_HEIGHT_WITHOUT_VD, SCREEN_HEIGHT_WITH_VD, SCREEN_WIDTH,
    VD_MAP_START_OFFSET_X, VD_MAP_START_OFFSET_Y,
};
use crate::gauge::{SideImages, SLOT_COUNT, SLOT_ND_NEW, SLOT_ND_OLD, SLOT_VD_NEW, SLOT_VD_OLD};
use crate::reveal::{new_frame_region, old_frame_region, Region, SideDrawState};
use crate::vd_render::{VD_PROFILE_HEIGHT, VD_PROFILE_WIDTH};

#[derive(Default, Clone, Copy)]
struct Image {
    id: std::os::raw::c_int,
    width: i32,
    height: i32,
    /// Mirrors `SideImages::stamps` — differing stamps trigger a resync.
    stamp: u64,
}

pub struct Blit {
    ctx: *mut sys::NVGcontext,
    slots: [Image; SLOT_COUNT],
}

impl Blit {
    pub fn create(fs_ctx: sys::FsContext) -> Option<Self> {
        let uninit = std::mem::MaybeUninit::<sys::NVGparams>::zeroed();
        let mut params = unsafe { uninit.assume_init() };
        params.userPtr = fs_ctx;
        params.edgeAntiAlias = 0;

        let ctx = unsafe { sys::nvgCreateInternal(&mut params) };
        if ctx.is_null() {
            None
        } else {
            Some(Self {
                ctx,
                slots: [Image::default(); SLOT_COUNT],
            })
        }
    }

    /// Mirror the CPU-side frame slots into NVG images. Stamps make this a
    /// cheap no-op when nothing changed and an idempotent full resync for
    /// fresh contexts (display re-init) — at most one upload per slot per
    /// cycle.
    pub fn sync_images(&mut self, images: &SideImages) {
        for slot in 0..SLOT_COUNT {
            if self.slots[slot].stamp == images.stamps[slot] {
                continue;
            }
            match &images.slots[slot] {
                None => {
                    if self.slots[slot].id != 0 {
                        unsafe { sys::nvgDeleteImage(self.ctx, self.slots[slot].id) };
                    }
                    self.slots[slot] = Image {
                        stamp: images.stamps[slot],
                        ..Image::default()
                    };
                }
                Some(buf) => {
                    let (width, height) = (buf.width as i32, buf.height as i32);
                    unsafe {
                        if self.slots[slot].id != 0
                            && (self.slots[slot].width != width
                                || self.slots[slot].height != height)
                        {
                            sys::nvgDeleteImage(self.ctx, self.slots[slot].id);
                            self.slots[slot].id = 0;
                        }
                        if self.slots[slot].id == 0 {
                            self.slots[slot].id = sys::nvgCreateImageRGBA(
                                self.ctx,
                                width,
                                height,
                                0,
                                buf.rgba.as_ptr(),
                            );
                        } else {
                            sys::nvgUpdateImage(self.ctx, self.slots[slot].id, buf.rgba.as_ptr());
                        }
                    }
                    self.slots[slot].width = width;
                    self.slots[slot].height = height;
                    self.slots[slot].stamp = images.stamps[slot];
                }
            }
        }
    }

    /// Draw one gauge frame (C++ `DisplayBase::render` power/brightness
    /// behavior; the terrain overlay is composed from the clipped images).
    pub fn render(
        &self,
        draw: &sys::sGaugeDrawData,
        powered: bool,
        dark_background: bool,
        potentiometer: f32,
        ds: &SideDrawState,
    ) {
        if self.ctx.is_null() {
            return;
        }

        let win_width = draw.winWidth as f32;
        let win_height = draw.winHeight as f32;
        let ratio = draw.fbWidth as f32 / draw.fbHeight as f32;

        unsafe {
            sys::nvgBeginFrame(self.ctx, win_width, win_height, ratio);

            if powered {
                // A380X panels use a pure black background, A32NX (4, 4, 4)
                let bg = if dark_background {
                    sys::nvgRGBA(0, 0, 0, 255)
                } else {
                    sys::nvgRGBA(4, 4, 4, 255)
                };
                sys::nvgFillColor(self.ctx, &bg);
                sys::nvgBeginPath(self.ctx);
                sys::nvgRect(self.ctx, 0.0, 0.0, win_width, win_height);
                sys::nvgFill(self.ctx);

                if potentiometer.abs() >= 1e-6 {
                    // work in the logical 768 x (768|1024) screen space the
                    // frames were laid out for, stretched to the window like
                    // the old full-screen blit
                    let screen_height = if ds.screen_with_vd {
                        SCREEN_HEIGHT_WITH_VD
                    } else {
                        SCREEN_HEIGHT_WITHOUT_VD
                    } as f32;
                    sys::nvgSave(self.ctx);
                    sys::nvgScale(
                        self.ctx,
                        win_width / SCREEN_WIDTH as f32,
                        win_height / screen_height,
                    );

                    if ds.show_nd {
                        let geometry = ds.nd_geometry;
                        let ox = geometry.offset_x as f32;
                        let oy = ND_MAP_START_OFFSET_Y as f32;
                        self.fill_region(
                            self.slots[SLOT_ND_OLD],
                            ox,
                            oy,
                            old_frame_region(&ds.nd, geometry.width, geometry.height),
                            potentiometer,
                        );
                        self.fill_region(
                            self.slots[SLOT_ND_NEW],
                            ox,
                            oy,
                            new_frame_region(&ds.nd, geometry.width, geometry.height),
                            potentiometer,
                        );
                    }
                    if ds.show_vd {
                        let ox = VD_MAP_START_OFFSET_X as f32;
                        let oy = VD_MAP_START_OFFSET_Y as f32;
                        self.fill_region(
                            self.slots[SLOT_VD_OLD],
                            ox,
                            oy,
                            old_frame_region(&ds.vd, VD_PROFILE_WIDTH, VD_PROFILE_HEIGHT),
                            potentiometer,
                        );
                        self.fill_region(
                            self.slots[SLOT_VD_NEW],
                            ox,
                            oy,
                            new_frame_region(&ds.vd, VD_PROFILE_WIDTH, VD_PROFILE_HEIGHT),
                            potentiometer,
                        );
                    }

                    sys::nvgRestore(self.ctx);
                }
            } else {
                let black = sys::nvgRGBA(0, 0, 0, 255);
                sys::nvgFillColor(self.ctx, &black);
                sys::nvgBeginPath(self.ctx);
                sys::nvgRect(self.ctx, 0.0, 0.0, win_width, win_height);
                sys::nvgFill(self.ctx);
            }

            sys::nvgEndFrame(self.ctx);
        }
    }

    /// Fill one region of a frame image placed at (ox, oy), 1:1 in logical
    /// space, with the image as pattern and the potentiometer as alpha.
    unsafe fn fill_region(&self, img: Image, ox: f32, oy: f32, region: Region, alpha: f32) {
        if img.id == 0 || region == Region::Empty {
            return;
        }
        let width = img.width as f32;
        let height = img.height as f32;

        sys::nvgSave(self.ctx);
        sys::nvgBeginPath(self.ctx);
        match region {
            Region::Full => sys::nvgRect(self.ctx, ox, oy, width, height),
            Region::RowBand { y0, y1 } => sys::nvgRect(
                self.ctx,
                ox,
                oy + y0 as f32,
                width,
                (y1 - y0 + 1) as f32,
            ),
            Region::ColBand { x0, x1 } => sys::nvgRect(
                self.ctx,
                ox + x0 as f32,
                oy,
                (x1 - x0 + 1) as f32,
                height,
            ),
            Region::ArcBand { lo_deg, hi_deg } => {
                // mirrored double wedge anchored at the frame's bottom-center
                // (arc_mode_frame's angle convention: degrees off the up-axis)
                let cx = ox + width / 2.0;
                let cy = oy + height;
                let radius = width + height; // beyond any frame corner
                let up = -std::f32::consts::FRAC_PI_2;
                let lo = (lo_deg as f32).to_radians();
                let hi = (hi_deg as f32).to_radians();

                // image patterns extend past the image; clip to the frame rect
                sys::nvgIntersectScissor(self.ctx, ox, oy, width, height);
                if lo_deg == 0 {
                    // single pie across the up-axis
                    sys::nvgMoveTo(self.ctx, cx, cy);
                    sys::nvgArc(
                        self.ctx,
                        cx,
                        cy,
                        radius,
                        up - hi,
                        up + hi,
                        sys::NVGwinding_NVG_CW as i32,
                    );
                    sys::nvgClosePath(self.ctx);
                } else {
                    // two mirrored pies [lo, hi] either side of the up-axis
                    sys::nvgMoveTo(self.ctx, cx, cy);
                    sys::nvgArc(
                        self.ctx,
                        cx,
                        cy,
                        radius,
                        up + lo,
                        up + hi,
                        sys::NVGwinding_NVG_CW as i32,
                    );
                    sys::nvgClosePath(self.ctx);
                    sys::nvgMoveTo(self.ctx, cx, cy);
                    sys::nvgArc(
                        self.ctx,
                        cx,
                        cy,
                        radius,
                        up - hi,
                        up - lo,
                        sys::NVGwinding_NVG_CW as i32,
                    );
                    sys::nvgClosePath(self.ctx);
                }
            }
            Region::Empty => unreachable!(),
        }
        let paint = sys::nvgImagePattern(self.ctx, ox, oy, width, height, 0.0, img.id, alpha);
        sys::nvgFillPaint(self.ctx, &paint);
        sys::nvgFill(self.ctx);
        sys::nvgRestore(self.ctx);
    }
}

impl Drop for Blit {
    fn drop(&mut self) {
        if !self.ctx.is_null() {
            for slot in &mut self.slots {
                if slot.id != 0 {
                    unsafe { sys::nvgDeleteImage(self.ctx, slot.id) };
                    slot.id = 0;
                }
            }
            unsafe { sys::nvgDeleteInternal(self.ctx) };
            self.ctx = std::ptr::null_mut();
        }
    }
}
