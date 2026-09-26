import os
import sys
import argparse
import json

# Ensure workspace root is on sys.path
WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if WORKSPACE_ROOT not in sys.path:
    sys.path.insert(0, WORKSPACE_ROOT)

from circuit_simulator.backend.circuit_service import (
    simulate_netlist_with_rust,
    lint_circuit_netlist,
    PRESET_CIRCUITS
)

def run_cli():
    parser = argparse.ArgumentParser(
        description="Circuit Lab command-line runner"
    )
    parser.add_argument("input", nargs="?", help="Path to netlist file or inline SPICE string")
    parser.add_argument("--solver", choices=["gaussian", "sparse_lu", "faer"], default="gaussian", help="Linear algebra solver type")
    parser.add_argument("--lint", action="store_true", help="Run Circuit Doctor linter on netlist")
    parser.add_argument("--benchmark", action="store_true", help="Check every example circuit against its expected voltages")
    parser.add_argument("--json", action="store_true", help="Output raw machine-readable JSON")
    
    args = parser.parse_args()

    if args.benchmark:
        print("Checking the example circuits...")
        from circuit_simulator.verify import verify_curriculum_benchmarks
        res = verify_curriculum_benchmarks()
        if res["success"]:
            print(f"PASS: All {res['benchmarks_checked']} benchmarks passed!")
            sys.exit(0)
        else:
            print(f"FAIL: {len(res['failures'])} failures detected:")
            for f in res["failures"]:
                print(f"  - {f}")
            sys.exit(1)

    if not args.input:
        parser.print_help()
        print("\nExample circuits:")
        for c in PRESET_CIRCUITS:
            print(f"  - {c['id']}: {c['title']}")
        sys.exit(0)

    # Check if input is a file path
    if os.path.exists(args.input):
        with open(args.input, 'r', encoding='utf-8') as f:
            netlist = f.read()
    else:
        netlist = args.input

    if args.lint:
        diagnostics = lint_circuit_netlist(netlist)
        if args.json:
            print(json.dumps(diagnostics, indent=2))
        else:
            if not diagnostics:
                print("Linter: Clean topology! No errors or warnings detected.")
            else:
                print(f"Linter detected {len(diagnostics)} diagnostic item(s):")
                for d in diagnostics:
                    print(f"  [{d['severity'].upper()}] {d['code']}: {d['title']}")
                    print(f"    Message: {d['message']}")
                    print(f"    Fix: {d['suggestion']}")
        return

    result = simulate_netlist_with_rust(netlist, solver_type=args.solver)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if not result.get("success"):
            print(f"Simulation Failed: {result.get('error_message')}")
            sys.exit(1)

        print("=" * 60)
        print("  Circuit Lab result")
        print("=" * 60)
        print(f"Solver used: {result.get('solver_used')}")
        print(f"Execution time: {result.get('execution_time_us')} µs")
        print("\nNode Voltages:")
        for node, v in sorted(result.get("node_voltages", {}).items()):
            print(f"  Node {node}: {v:.4f} V")

        print("\nBranch Currents:")
        for branch, i in sorted(result.get("branch_currents", {}).items()):
            print(f"  {branch}: {i:.4f} A")

        print("\nKCL Equations:")
        for eq in result.get("kcl_equations", []):
            print(f"  Node {eq['node']}: {eq['raw_equation']}")

if __name__ == '__main__':
    run_cli()
