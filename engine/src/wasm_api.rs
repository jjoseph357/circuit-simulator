//! Minimal C ABI for the browser build. No wasm-bindgen: the JS side
//! (`frontend/wasmEngine.ts`) copies UTF-8 in via `cs_alloc`, calls an entry point,
//! and reads back a buffer laid out as `[u32 little-endian length][JSON bytes]`,
//! which it then releases with `cs_free(ptr, 4 + length)`.

use crate::{lint_netlist, simulate_circuit_with, SolverKind};
use crate::optimizer::tune_json;

#[no_mangle]
pub extern "C" fn cs_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` must come from `cs_alloc(cap)` or be a result buffer of total size `cap`.
#[no_mangle]
pub unsafe extern "C" fn cs_free(ptr: *mut u8, cap: usize) {
    drop(Vec::from_raw_parts(ptr, 0, cap.max(1)));
}

unsafe fn read_str<'a>(ptr: *const u8, len: usize) -> &'a str {
    std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).unwrap_or("")
}

fn into_result_buffer(json: String) -> *mut u8 {
    let bytes = json.into_bytes();
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&bytes);
    // Boxed slice: capacity == length, so cs_free(ptr, 4 + len) frees exactly this allocation.
    Box::into_raw(out.into_boxed_slice()) as *mut u8
}

/// solver: 0 = Gaussian (step-by-step), 1 = sparse LU, 2 = faer (falls back to sparse LU here).
///
/// # Safety
/// `ptr..ptr+len` must be a valid UTF-8 buffer written by the caller.
#[no_mangle]
pub unsafe extern "C" fn cs_simulate(ptr: *const u8, len: usize, solver: u32) -> *mut u8 {
    let kind = match solver {
        1 => SolverKind::SparseLu,
        2 => SolverKind::Faer,
        _ => SolverKind::Gaussian,
    };
    let result = simulate_circuit_with(read_str(ptr, len), kind);
    into_result_buffer(serde_json::to_string(&result).unwrap_or_else(|e| format!("{{\"success\":false,\"error_message\":\"{}\"}}", e)))
}

/// Tuner: JSON TuneRequest in, JSON TuneResult out.
///
/// # Safety
/// `ptr..ptr+len` must be a valid UTF-8 buffer written by the caller.
#[no_mangle]
pub unsafe extern "C" fn cs_tune(ptr: *const u8, len: usize) -> *mut u8 {
    into_result_buffer(tune_json(read_str(ptr, len)))
}

/// # Safety
/// `ptr..ptr+len` must be a valid UTF-8 buffer written by the caller.
#[no_mangle]
pub unsafe extern "C" fn cs_lint(ptr: *const u8, len: usize) -> *mut u8 {
    into_result_buffer(serde_json::to_string(&lint_netlist(read_str(ptr, len))).unwrap_or_else(|_| "[]".to_string()))
}
