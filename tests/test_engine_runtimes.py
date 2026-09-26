import json
import os
import sys
import unittest
from unittest.mock import patch

WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if WORKSPACE_ROOT not in sys.path:
    sys.path.insert(0, WORKSPACE_ROOT)

import circuit_simulator.backend.circuit_service as svc
from circuit_simulator.backend.circuit_service import PRESET_CIRCUITS, engine_runtime, simulate_netlist_with_rust

SERVICE = 'circuit_simulator.backend.circuit_service'


@unittest.skipIf(svc._native_engine is None, "PyO3 module not built (python circuit_simulator/build_engine.py)")
class TestEngineRuntimes(unittest.TestCase):
    """The PyO3 module, the CLI binary and the pure-Python fallback must be interchangeable."""

    def test_pyo3_is_preferred(self):
        info = engine_runtime()
        self.assertEqual(info["runtime"], "pyo3")
        self.assertTrue(info["has_faer"])

    def test_pyo3_matches_cli_for_every_preset_and_solver(self):
        for circuit in PRESET_CIRCUITS:
            for solver in ("gaussian", "sparse_lu", "faer"):
                net = circuit["netlist"]
                in_process = simulate_netlist_with_rust(net, solver)
                with patch(f'{SERVICE}._native_engine', None):
                    via_cli = simulate_netlist_with_rust(net, solver)
                self.assertEqual(in_process["solver_used"], via_cli["solver_used"])
                for node, v in via_cli["node_voltages"].items():
                    self.assertAlmostEqual(in_process["node_voltages"][node], v, places=12, msg=f"{circuit['id']} {solver}")

    def test_faer_solver_through_http(self):
        from circuit_simulator.backend.server import create_standalone_app
        app = create_standalone_app()
        res = app.test_client().post('/api/circuit/solve', json={"netlist": "V1 1 0 12\nR1 1 2 3\nR2 2 0 6", "solver_type": "faer"}).get_json()
        self.assertTrue(res["success"])
        self.assertEqual(res["solver_used"], "FaerSparseLU")
        self.assertAlmostEqual(res["node_voltages"]["2"], 8.0, places=12)
        info = app.test_client().get('/api/circuit/engine').get_json()
        self.assertEqual(info["runtime"], "pyo3")

    def test_unknown_solver_name_defaults_to_gaussian(self):
        self.assertEqual(simulate_netlist_with_rust("I1 0 1 1\nR1 1 0 2", "bogus")["solver_used"], "GaussianElimination")

    def test_lint_matches_cli(self):
        net = "V1 1 0 5\nV2 2 1 3\nV3 2 0 9\nR1 2 0 1k"
        in_process = svc.lint_circuit_netlist(net)
        with patch(f'{SERVICE}._native_engine', None):
            via_cli = svc.lint_circuit_netlist(net)
        self.assertEqual(json.dumps(in_process, sort_keys=True), json.dumps(via_cli, sort_keys=True))


if __name__ == '__main__':
    unittest.main()
