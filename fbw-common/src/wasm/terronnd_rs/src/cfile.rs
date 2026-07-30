//! File access through the MSFS SDK's wasi-libc (`fopen`/`fread`/`fseeko`),
//! exactly like the C++ gauges. Rust's `std::fs` must NOT be used in the
//! gauge: its WASI filesystem layer imports nearly the whole
//! `wasi_snapshot_preview1` syscall table (sockets, readdir, path_rename, …),
//! and MSFS only implements the small subset the SDK libc uses — any
//! unresolvable import makes the module fail to load ("wasi_snapshot_preview1
//! module not found"). Going through libc keeps the import set identical to
//! the proven C++ terronnd gauge.

use std::ffi::CString;
use std::io::{self, Read, Seek, SeekFrom};
use std::os::raw::{c_char, c_int, c_void};

const SEEK_SET: c_int = 0;
const SEEK_CUR: c_int = 1;
const SEEK_END: c_int = 2;

// provided by the MSFS SDK wasi-libc linked via .cargo/config.toml
extern "C" {
    fn fopen(path: *const c_char, mode: *const c_char) -> *mut c_void;
    fn fclose(file: *mut c_void) -> c_int;
    fn fread(buf: *mut c_void, size: usize, count: usize, file: *mut c_void) -> usize;
    fn fseeko(file: *mut c_void, offset: i64, whence: c_int) -> c_int;
    fn ftello(file: *mut c_void) -> i64;
}

pub struct CFile(*mut c_void);

impl CFile {
    pub fn open(path: &str) -> io::Result<Self> {
        let c_path = CString::new(path)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in path"))?;
        let handle = unsafe { fopen(c_path.as_ptr(), c"rb".as_ptr()) };
        if handle.is_null() {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("fopen failed for {path}"),
            ))
        } else {
            Ok(Self(handle))
        }
    }
}

impl Read for CFile {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // fread with size 1: the return value is the byte count; 0 is EOF
        // (or error, which read_exact surfaces as UnexpectedEof either way)
        Ok(unsafe { fread(buf.as_mut_ptr() as *mut c_void, 1, buf.len(), self.0) })
    }
}

impl Seek for CFile {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let (offset, whence) = match pos {
            SeekFrom::Start(offset) => (offset as i64, SEEK_SET),
            SeekFrom::Current(offset) => (offset, SEEK_CUR),
            SeekFrom::End(offset) => (offset, SEEK_END),
        };
        if unsafe { fseeko(self.0, offset, whence) } != 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "fseeko failed"));
        }
        let position = unsafe { ftello(self.0) };
        if position < 0 {
            Err(io::Error::new(io::ErrorKind::Other, "ftello failed"))
        } else {
            Ok(position as u64)
        }
    }
}

impl Drop for CFile {
    fn drop(&mut self) {
        unsafe { fclose(self.0) };
    }
}
