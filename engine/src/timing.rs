//! Wall-clock timing that also works on `wasm32-unknown-unknown`, where
//! `std::time::Instant::now()` panics. In the browser the JS loader supplies
//! `env.now_ms` (performance.now()).

#[cfg(not(target_arch = "wasm32"))]
pub use std::time::Instant;

#[cfg(target_arch = "wasm32")]
mod wasm_clock {
    #[link(wasm_import_module = "env")]
    extern "C" {
        fn now_ms() -> f64;
    }

    #[derive(Debug, Clone, Copy)]
    pub struct Instant(f64);

    pub struct Elapsed(f64);

    impl Elapsed {
        pub fn as_micros(&self) -> u128 {
            (self.0 * 1000.0).max(0.0) as u128
        }
    }

    impl Instant {
        pub fn now() -> Self {
            Instant(unsafe { now_ms() })
        }
        pub fn elapsed(&self) -> Elapsed {
            Elapsed(unsafe { now_ms() } - self.0)
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm_clock::Instant;
