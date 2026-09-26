import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from circuit_simulator.backend.circuit_service import (
    generate_circuit_architect,
    simulate_netlist_pure_python,
    simulate_netlist_with_rust,
    tune_netlist,
)
from circuit_simulator.backend.server import create_standalone_app

SERVICE = 'circuit_simulator.backend.circuit_service'


class TestNonlinearThroughService(unittest.TestCase):
    def test_diode_circuit_returns_newton_log_and_device_ops(self):
        res = simulate_netlist_with_rust("V1 1 0 5\nR1 1 2 1k\nD1 2 0 DX\n.model DX D(IS=1e-14)", "gaussian")
        self.assertTrue(res["success"], res.get("error_message"))
        self.assertEqual(res["solver_used"], "NewtonRaphson")
        self.assertTrue(res["newton"]["converged"])
        self.assertEqual(res["device_ops"][0]["kind"], "diode")
        self.assertLess(res["residual_max_abs"], 1e-9)

    def test_fallback_refuses_semiconductors_clearly(self):
        for net in ("V1 1 0 5\nR1 1 2 1k\nD1 2 0", "V1 1 0 5\nQ1 1 1 0 QN\n.model QN NPN"):
            res = simulate_netlist_pure_python(net)
            self.assertFalse(res["success"])
            self.assertIn("Rust engine", res["error_message"])


class TestTunerService(unittest.TestCase):
    def test_tune_endpoint(self):
        client = create_standalone_app().test_client()
        r = client.post('/api/circuit/tune', json={
            "netlist": "V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u",
            "parameters": [{"element": "C1", "min": 1e-9, "max": 1e-5}],
            "goals": [{"kind": "cutoff_hz", "node": "out", "target": 2000}],
        }).get_json()
        self.assertTrue(r["success"], r["message"])
        self.assertAlmostEqual(r["values"][0], 1 / (2 * 3.141592653589793 * 1e3 * 2e3), delta=1e-9)

    @patch(f'{SERVICE}.ask_ai')
    def test_architect_topology_is_finished_by_the_tuner(self, mock_ask_ai):
        # Right topology, wrong numbers: the tuner fixes it without another AI round trip.
        mock_ask_ai.return_value = "```spice\nV1 1 0 12\nR1 1 2 1k\nR2 2 0 1k\n```"
        res = generate_circuit_architect("Design a 12V to 3.3V voltage divider")
        self.assertEqual(mock_ask_ai.call_count, 1)
        self.assertTrue(res["attempts"][-1].get("tuned"))
        self.assertTrue(all(c["passed"] for c in res["verification"]["spec_checks"]), res["verification"]["spec_checks"])
        self.assertIn("Tuned by the numeric optimizer", res["explanation"])
        self.assertAlmostEqual(res["verification"]["node_voltages"]["2"], 3.3, delta=0.033)

    def test_bad_tune_request(self):
        r = tune_netlist({"netlist": "R1 1 0 1k", "parameters": [], "goals": []})
        self.assertFalse(r["success"])


if __name__ == '__main__':
    unittest.main()
