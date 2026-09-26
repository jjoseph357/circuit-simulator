"""
One-click launcher for the standalone Circuit Lab: builds whatever is missing or stale
(Rust CLI, PyO3 module, WebAssembly engine, frontend bundle), then serves the app and opens it.

    python circuit_simulator/start.py            # build if needed, then serve on :5050
    python circuit_simulator/start.py --rebuild  # force a full rebuild first
    CIRCUIT_PORT=8080 python circuit_simulator/start.py
"""
import os
import subprocess
import sys
import webbrowser

SIM_DIR = os.path.dirname(os.path.abspath(__file__))
# Make `import circuit_simulator` work when run as a script
if os.path.dirname(SIM_DIR) not in sys.path:
    sys.path.insert(0, os.path.dirname(SIM_DIR))

FRONTEND_DIR = os.path.join(SIM_DIR, "frontend")
CLI_BINARY = os.path.join(SIM_DIR, "engine", "target", "release", "circuit_engine" + (".exe" if sys.platform == "win32" else ""))


def _is_stale(path: str, newest_source: float) -> bool:
    return not os.path.exists(path) or os.path.getmtime(path) < newest_source


def build_engines(force: bool) -> None:
    from circuit_simulator.verify import ENGINE_ARTIFACTS, _newest_engine_source_mtime
    newest = _newest_engine_source_mtime()
    targets = []
    if force or _is_stale(CLI_BINARY, newest):
        targets.append("native")
    if force or _is_stale(ENGINE_ARTIFACTS["PyO3 module"], newest):
        targets.append("python")
    if force or _is_stale(ENGINE_ARTIFACTS["WebAssembly"], newest):
        targets.append("wasm")
    if not targets:
        print("[1/3] Rust engine (CLI, PyO3, WebAssembly) up to date.")
        return
    print(f"[1/3] Building Rust engine: {', '.join(targets)} ...")
    res = subprocess.run([sys.executable, os.path.join(SIM_DIR, "build_engine.py"), "--only", ",".join(targets)])
    if res.returncode != 0:
        print("      Warning: engine build failed; the server will fall back to the CLI or pure-Python solver.")


def build_frontend(force: bool) -> None:
    index = os.path.join(FRONTEND_DIR, "dist", "index.html")
    sources = [os.path.join(r, f) for r, _, fs in os.walk(FRONTEND_DIR)
               if "node_modules" not in r and os.path.join(FRONTEND_DIR, "dist") not in r for f in fs]
    sources.append(os.path.join(SIM_DIR, "presets.json"))
    newest = max(os.path.getmtime(p) for p in sources if os.path.exists(p))
    if not force and not _is_stale(index, newest):
        print("[2/3] Frontend bundle up to date.")
        return
    print("[2/3] Building frontend bundle ...")
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    if not os.path.isdir(os.path.join(FRONTEND_DIR, "node_modules")):
        subprocess.run([npm, "install"], cwd=FRONTEND_DIR, check=True)
    subprocess.run([npm, "run", "build"], cwd=FRONTEND_DIR, check=True)


def main():
    force = "--rebuild" in sys.argv
    print("=" * 65)
    print("  Launching Circuit Lab")
    print("=" * 65)

    build_engines(force)
    build_frontend(force)

    from circuit_simulator.backend.server import DEFAULT_PORT, create_standalone_app
    from circuit_simulator.backend.circuit_service import engine_runtime
    port = int(os.environ.get("CIRCUIT_PORT", DEFAULT_PORT))
    print(f"[3/3] Server engine: {engine_runtime()['runtime']} · starting on http://localhost:{port}")
    app = create_standalone_app()

    url = f"http://localhost:{port}"
    print(f"\nReady! Circuit Lab is at {url}")
    try:
        webbrowser.open(url)
    except Exception:
        pass

    app.run(host="127.0.0.1", port=port, debug=False)


if __name__ == '__main__':
    main()
