import os
import sys
import subprocess
from typing import Dict, Any, Tuple, List

# Ensure workspace root is on sys.path
WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if WORKSPACE_ROOT not in sys.path:
    sys.path.insert(0, WORKSPACE_ROOT)

from circuit_simulator.backend.circuit_service import (
    PRESET_CIRCUITS,
    simulate_netlist_with_rust
)

def verify_curriculum_benchmarks() -> Dict[str, Any]:
    """
    Verifies that all example circuits solve
    to their exact theoretical expected voltages within tolerance.
    """
    failures = []
    benchmarks_checked = 0

    for circuit in PRESET_CIRCUITS:
        cid = circuit["id"]
        expected = circuit.get("expected_voltages", {})
        if not expected:
            continue

        benchmarks_checked += 1
        for solver in ["gaussian", "sparse_lu"]:
            res = simulate_netlist_with_rust(circuit["netlist"], solver_type=solver)
            if not res.get("success"):
                failures.append(f"{cid} ({solver}): Simulation failed - {res.get('error_message')}")
                continue

            voltages = res.get("node_voltages", {})
            for node, exp_v in expected.items():
                actual_v = voltages.get(node)
                if actual_v is None or abs(actual_v - exp_v) > 1e-4:
                    failures.append(f"{cid} ({solver}): Node {node} expected {exp_v}V, got {actual_v}V")

    return {
        "success": len(failures) == 0,
        "benchmarks_checked": benchmarks_checked,
        "failures": failures
    }

def run_rust_tests() -> Tuple[bool, str]:
    """Runs native cargo test in circuit_simulator/engine/."""
    cargo_path = os.path.join(WORKSPACE_ROOT, "circuit_simulator", "engine", "Cargo.toml")
    try:
        res = subprocess.run(
            ["cargo", "test", "--manifest-path", cargo_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
            timeout=600  # a cold rebuild after an engine change can take minutes
        )
        return res.returncode == 0, res.stdout
    except Exception as e:
        return False, str(e)

def run_python_tests() -> Tuple[bool, str]:
    """Runs all python test modules in circuit_simulator/tests/."""
    tests_dir = os.path.join(WORKSPACE_ROOT, "circuit_simulator", "tests")
    try:
        res = subprocess.run(
            [sys.executable, "-X", "utf8", "-m", "unittest", "discover", tests_dir],
            cwd=WORKSPACE_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
            timeout=300
        )
        return res.returncode == 0, res.stdout
    except Exception as e:
        return False, str(e)

def run_frontend_typecheck() -> Tuple[bool, str]:
    """Runs TypeScript typecheck on frontend components."""
    frontend_dir = os.path.join(WORKSPACE_ROOT, "circuit_simulator", "frontend")
    try:
        res = subprocess.run(
            ["npx", "tsc", "--noEmit"],
            cwd=frontend_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
            shell=True,
            timeout=300
        )
        return res.returncode == 0, res.stdout
    except Exception as e:
        return False, str(e)

SIM_DIR = os.path.join(WORKSPACE_ROOT, "circuit_simulator")
ENGINE_ARTIFACTS = {
    "PyO3 module": os.path.join(SIM_DIR, "backend", "_native", "circuit_engine" + (".pyd" if sys.platform == "win32" else ".so")),
    "WebAssembly": os.path.join(SIM_DIR, "frontend", "wasm", "circuit_engine.wasm"),
}


def _newest_engine_source_mtime() -> float:
    engine = os.path.join(SIM_DIR, "engine")
    paths = [os.path.join(engine, "Cargo.toml")]
    for root, _, files in os.walk(os.path.join(engine, "src")):
        paths += [os.path.join(root, f) for f in files if f.endswith(".rs")]
    return max(os.path.getmtime(p) for p in paths)


def run_engine_artifact_checks() -> Tuple[bool, str]:
    """
    The browser and the Flask server run *compiled copies* of the engine. If Rust source changed
    after they were built, cargo test passes but users get stale behaviour, so fail loudly.
    Then load the Wasm build in Node and check it against every curriculum preset.
    """
    newest_src = _newest_engine_source_mtime()
    problems = []
    for name, path in ENGINE_ARTIFACTS.items():
        if not os.path.exists(path):
            problems.append(f"{name} missing: {path}")
        elif os.path.getmtime(path) < newest_src:
            problems.append(f"{name} is older than the Rust source: {path}")
    if problems:
        return False, "\n".join(problems + ["Rebuild with: python circuit_simulator/build_engine.py (or verify --rebuild)"])
    try:
        res = subprocess.run(["node", os.path.join(SIM_DIR, "tests", "wasm_parity.mjs")],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", timeout=300)
        return res.returncode == 0, res.stdout
    except Exception as e:
        return False, f"Could not run the WebAssembly parity check with Node: {e}"


def run_frontend_logic_tests() -> Tuple[bool, str]:
    """Runs the schematic/netlist logic (frontend/netlist.ts) in Node against the Wasm engine."""
    try:
        res = subprocess.run(
            ["node", "--experimental-strip-types", "--no-warnings", "--test", os.path.join(SIM_DIR, "tests", "netlist_logic.test.mts")],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", timeout=300)
        return res.returncode == 0, res.stdout
    except Exception as e:
        return False, f"Could not run the frontend logic tests with Node: {e}"


def run_all_verifications(quick_mode: bool = False) -> Dict[str, Any]:
    """
    Executes all circuit simulator verification layers.
    If quick_mode=True, skips cargo test/frontend builds to allow fast unit testing.
    """
    report: Dict[str, Any] = {}

    # 1. Curriculum Benchmarks
    bench_res = verify_curriculum_benchmarks()
    report["curriculum_benchmarks"] = {
        "passed": bench_res["success"],
        "count": bench_res["benchmarks_checked"],
        "failures": bench_res["failures"]
    }

    # 2. Python Backend Tests
    if quick_mode:
        report["python_backend"] = {"passed": True, "details": "Skipped in quick_mode"}
    else:
        py_ok, py_out = run_python_tests()
        report["python_backend"] = {"passed": py_ok, "details": py_out}

    # 3. Rust Engine Tests
    if quick_mode:
        report["rust_engine"] = {"passed": True, "details": "Skipped in quick_mode"}
    else:
        rust_ok, rust_out = run_rust_tests()
        report["rust_engine"] = {"passed": rust_ok, "details": rust_out}

    # 4. Frontend Typecheck
    if quick_mode:
        report["frontend_types"] = {"passed": True, "details": "Skipped in quick_mode"}
    else:
        fe_ok, fe_out = run_frontend_typecheck()
        report["frontend_types"] = {"passed": fe_ok, "details": fe_out}

    # 5. Compiled engine artifacts (PyO3 + WebAssembly) are fresh and agree with the curriculum
    if quick_mode:
        report["engine_artifacts"] = {"passed": True, "details": "Skipped in quick_mode"}
    else:
        art_ok, art_out = run_engine_artifact_checks()
        report["engine_artifacts"] = {"passed": art_ok, "details": art_out}

    # 6. Frontend schematic/netlist logic against the real engine
    if quick_mode:
        report["frontend_logic"] = {"passed": True, "details": "Skipped in quick_mode"}
    else:
        fl_ok, fl_out = run_frontend_logic_tests()
        report["frontend_logic"] = {"passed": fl_ok, "details": fl_out}

    # Overall Success
    overall = all(report[k]["passed"] for k in
                  ("curriculum_benchmarks", "python_backend", "rust_engine", "frontend_types", "engine_artifacts", "frontend_logic"))
    report["overall_success"] = overall
    return report

def main():
    print("=" * 65)
    print("  Circuit Lab: Full System Verification Guardrail")
    print("=" * 65)

    if "--rebuild" in sys.argv:
        print("\nRebuilding engine artifacts (native, PyO3, WebAssembly)...")
        subprocess.run([sys.executable, os.path.join(SIM_DIR, "build_engine.py")], check=True)

    report = run_all_verifications(quick_mode=False)

    print(f"\n[1] Curriculum Benchmarks : {'PASSED' if report['curriculum_benchmarks']['passed'] else 'FAILED'}")
    if not report['curriculum_benchmarks']['passed']:
        for f in report['curriculum_benchmarks']['failures']:
            print(f"    - {f}")

    print(f"[2] Rust Engine Core     : {'PASSED' if report['rust_engine']['passed'] else 'FAILED'}")
    print(f"[3] Python Backend Tests : {'PASSED' if report['python_backend']['passed'] else 'FAILED'}")
    print(f"[4] Frontend Typecheck   : {'PASSED' if report['frontend_types']['passed'] else 'FAILED'}")
    print(f"[5] PyO3 + Wasm Engines  : {'PASSED' if report['engine_artifacts']['passed'] else 'FAILED'}")
    print(f"[6] Frontend Logic       : {'PASSED' if report['frontend_logic']['passed'] else 'FAILED'}")
    for key in ("rust_engine", "python_backend", "frontend_types", "engine_artifacts", "frontend_logic"):
        if not report[key]["passed"]:
            print(f"\n--- {key} output (tail) ---\n" + "\n".join(str(report[key]["details"]).splitlines()[-25:]))

    print("-" * 65)
    if report["overall_success"]:
        print("  RESULT: ALL CIRCUIT SIMULATOR COMPONENTS ARE HEALTHY (0 REGRESSIONS)")
        print("=" * 65)
        sys.exit(0)
    else:
        print("  RESULT: REGRESSION DETECTED IN ONE OR MORE COMPONENTS")
        print("=" * 65)
        sys.exit(1)

if __name__ == '__main__':
    main()
