"""
Builds the Rust engine for all three runtimes and installs the artifacts where the app loads them:

  native CLI      engine/target/release/circuit_engine(.exe)          <- subprocess fallback, run.py
  Python module   backend/_native/circuit_engine.pyd|.so              <- Flask service, in-process
  WebAssembly     frontend/wasm/circuit_engine.wasm                   <- browser, no server needed

Usage:  python circuit_simulator/build_engine.py [--only native,python,wasm]
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(ROOT, "engine")
MANIFEST = os.path.join(ENGINE, "Cargo.toml")
IS_WINDOWS = sys.platform == "win32"


def _run(cmd, env=None):
    print("  $", " ".join(cmd))
    subprocess.run(cmd, check=True, env=env)


def build_native():
    _run(["cargo", "build", "--release", "--manifest-path", MANIFEST])
    return os.path.join(ENGINE, "target", "release", "circuit_engine" + (".exe" if IS_WINDOWS else ""))


def build_wasm():
    _run(["rustup", "target", "add", "wasm32-unknown-unknown"])
    _run(["cargo", "rustc", "--release", "--lib", "--crate-type", "cdylib", "--target", "wasm32-unknown-unknown",
          "--no-default-features", "--manifest-path", MANIFEST])
    src = os.path.join(ENGINE, "target", "wasm32-unknown-unknown", "release", "circuit_engine.wasm")
    dest_dir = os.path.join(ROOT, "frontend", "wasm")
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "circuit_engine.wasm")
    shutil.copyfile(src, dest)
    return dest


def build_python():
    # Separate target dir: the cdylib shares the CLI's file stem, which collides on Windows.
    env = dict(os.environ, PYO3_PYTHON=sys.executable)
    _run(["cargo", "rustc", "--release", "--lib", "--crate-type", "cdylib", "--features", "python",
          "--target-dir", os.path.join(ENGINE, "target", "python"), "--manifest-path", MANIFEST], env=env)
    built = os.path.join(ENGINE, "target", "python", "release",
                         "circuit_engine.dll" if IS_WINDOWS else
                         ("libcircuit_engine.dylib" if sys.platform == "darwin" else "libcircuit_engine.so"))
    dest_dir = os.path.join(ROOT, "backend", "_native")
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "circuit_engine" + (".pyd" if IS_WINDOWS else ".so"))
    # Clear leftovers from earlier swaps (they stay locked until their server process exits).
    for name in os.listdir(dest_dir):
        if name.startswith("circuit_engine.") and name.endswith(".old"):
            try:
                os.remove(os.path.join(dest_dir, name))
            except OSError:
                pass
    try:
        shutil.copyfile(built, dest)
    except PermissionError:
        # A running server has the module loaded. Windows can't overwrite a loaded DLL but can
        # rename it: move it aside so the new build is picked up on the server's next restart.
        aside = f"{dest}.{int(time.time())}.old"
        os.replace(dest, aside)
        shutil.copyfile(built, dest)
        print(f"  note: a running server had the old module loaded; restart it to use the new engine.")
    return dest


TARGETS = {"native": build_native, "python": build_python, "wasm": build_wasm}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", default="native,python,wasm", help="comma-separated subset of: native,python,wasm")
    args = parser.parse_args()
    failures = []
    for name in [t.strip() for t in args.only.split(",") if t.strip()]:
        print(f"[{name}]")
        try:
            print(f"  -> {TARGETS[name]()}")
        except (subprocess.CalledProcessError, OSError) as e:
            # Keep building the other targets; report everything at the end.
            print(f"  FAILED: {e}")
            failures.append(name)
    if failures:
        raise SystemExit(f"Build failed for: {', '.join(failures)}")


if __name__ == "__main__":
    main()
