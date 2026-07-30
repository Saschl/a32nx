//! Raw MSFS 2024 IO API bindings (`fsIOOpen`/`fsIORead`) plus a small async
//! read pool for coalesced terrain payload reads — direct `extern "C"`
//! bindings until msfs-rs grows them.
//!
//! Why: package files may be STREAMED by the sim, and the SDK explicitly
//! warns that synchronous reads can pause a module for multiple frames. The
//! old blocking `fread` path stalled the sim when a region rebuild pulled
//! hundreds of tile payloads out of the ~240 MB terrain2.map; with fsIORead
//! the requests are issued non-blocking and completions are drained once per
//! frame. Each request is one coalesced row-run (see region.rs), a few MB at
//! most.
//!
//! Callback discipline (the CommBus rule): fsIO callbacks fire from the sim's
//! dispatch context, NOT from our gauge callbacks. They must only flip a
//! `Cell` in a heap-pinned slot — no allocation, no file I/O, no printing.

use std::cell::Cell;
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};

use crate::region::ReadKey;

/// `typedef unsigned long long FsIOFile;`
pub type FsIOFile = u64;
/// `#define FS_IO_ERROR_FILE 0`
const FS_IO_ERROR_FILE: FsIOFile = 0;
/// `FsIOOpenFlag_RDONLY = 1 << 0`
const FS_IO_OPEN_FLAG_RDONLY: u32 = 1 << 0;
/// `FsIOErr_Success = 0`
const FS_IO_ERR_SUCCESS: u32 = 0;

type FsIOFileOpenCallback = extern "C" fn(file: FsIOFile, user_data: *mut c_void);
type FsIOFileReadCallback = extern "C" fn(
    file: FsIOFile,
    out_buffer: *mut c_char,
    byte_offset: c_int,
    bytes_read: c_int,
    user_data: *mut c_void,
);

extern "C" {
    fn fsIOOpen(
        path: *const c_char,
        flags: u32,
        callback: FsIOFileOpenCallback,
        user_data: *mut c_void,
    ) -> FsIOFile;
    fn fsIORead(
        file: FsIOFile,
        out_buffer: *mut c_char,
        byte_offset: c_int,
        bytes_to_read: c_int,
        callback: FsIOFileReadCallback,
        user_data: *mut c_void,
    ) -> u32;
}

/// One in-flight payload read. Boxed so its address is stable for the
/// callback's user-data pointer; the `Vec` data pointer handed to fsIORead is
/// heap-stable independently of where the Box itself is stored.
struct ReadSlot {
    key: ReadKey,
    buffer: Vec<u8>,
    /// -1 = in flight; >= 0 = bytes read, written by the callback.
    state: Cell<i32>,
}

extern "C" fn on_open(_file: FsIOFile, user_data: *mut c_void) {
    if !user_data.is_null() {
        unsafe { &*(user_data as *const Cell<bool>) }.set(true);
    }
}

extern "C" fn on_read(
    _file: FsIOFile,
    _out_buffer: *mut c_char,
    _byte_offset: c_int,
    bytes_read: c_int,
    user_data: *mut c_void,
) {
    if !user_data.is_null() {
        unsafe { &*(user_data as *const ReadSlot) }
            .state
            .set(bytes_read.max(0));
    }
}

pub struct AsyncTileIo {
    file: FsIOFile,
    /// Set by the open callback; reads are issued only after it fires.
    opened: Box<Cell<bool>>,
    slots: Vec<Box<ReadSlot>>,
}

impl AsyncTileIo {
    /// Non-blocking open of a package file (`./...` VFS path). `None` when
    /// the sim rejects the call outright — callers fall back to blocking
    /// reads.
    pub fn open(path: &str) -> Option<Self> {
        let opened = Box::new(Cell::new(false));
        let c_path = CString::new(path).ok()?;
        let file = unsafe {
            fsIOOpen(
                c_path.as_ptr(),
                FS_IO_OPEN_FLAG_RDONLY,
                on_open,
                opened.as_ref() as *const Cell<bool> as *mut c_void,
            )
        };
        if file == FS_IO_ERROR_FILE {
            return None;
        }
        Some(Self {
            file,
            opened,
            slots: Vec::new(),
        })
    }

    /// The open callback fired; the handle accepts reads.
    pub fn ready(&self) -> bool {
        self.opened.get()
    }

    /// Issue one async range read; `false` when the sim rejected the
    /// request synchronously (the caller backs off until the next frame).
    pub fn request(&mut self, key: ReadKey, offset: u32, len: u32) -> bool {
        debug_assert!(offset as u64 + len as u64 <= i32::MAX as u64);
        let mut slot = Box::new(ReadSlot {
            key,
            buffer: vec![0u8; len as usize],
            state: Cell::new(-1),
        });
        let err = unsafe {
            fsIORead(
                self.file,
                slot.buffer.as_mut_ptr() as *mut c_char,
                offset as c_int,
                len as c_int,
                on_read,
                slot.as_ref() as *const ReadSlot as *mut c_void,
            )
        };
        if err != FS_IO_ERR_SUCCESS {
            return false; // slot dropped; per the docs no callback follows an error return
        }
        self.slots.push(slot);
        true
    }

    /// Drain completed reads: `Some(bytes)` on a full read, `None` on a
    /// short/failed one.
    pub fn poll(&mut self) -> Vec<(ReadKey, Option<Vec<u8>>)> {
        let mut done = Vec::new();
        let mut i = 0;
        while i < self.slots.len() {
            if self.slots[i].state.get() >= 0 {
                let slot = self.slots.swap_remove(i);
                let complete = slot.state.get() == slot.buffer.len() as i32;
                done.push((slot.key, complete.then_some(slot.buffer)));
            } else {
                i += 1;
            }
        }
        done
    }
}

impl Drop for AsyncTileIo {
    fn drop(&mut self) {
        // a late callback into a freed slot would be UB — leak any read the
        // sim still holds a pointer into (only reachable at module teardown)
        for slot in self.slots.drain(..) {
            if slot.state.get() < 0 {
                std::mem::forget(slot);
            }
        }
    }
}
