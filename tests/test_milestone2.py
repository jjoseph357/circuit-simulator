import math
import os
import sys
import unittest
from unittest.mock import patch

WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if WORKSPACE_ROOT not in sys.path:
    sys.path.insert(0, WORKSPACE_ROOT)

from circuit_simulator.backend.circuit_service import (
    generate_circuit_architect,
    simulate_netlist_pure_python,
    simulate_netlist_with_rust,
)

SERVICE = 'circuit_simulator.backend.circuit_service'


class TestDynamicAnalysesThroughService(unittest.TestCase):
    def test_transient_and_ac_come_back_from_the_engine(self):
        res = simulate_netlist_with_rust("V1 1 0 PULSE(0 5 0 1n 1n)\nR1 1 2 1k\nC1 2 0 1u\n.tran 10u 5m\n.ac dec 10 1 100k", "sparse_lu")
        self.assertTrue(res["success"], res.get("error_message"))
        tr = res["transient"]
        self.assertAlmostEqual(tr["node_voltages"]["2"][-1], 5 * (1 - math.exp(-5)), places=3)
        self.assertEqual(tr["time"][-1], 5e-3)
        self.assertIsNotNone(res["ac"])
        self.assertTrue(any(d["code"] == "WARN_NO_AC_SOURCE" for d in res["diagnostics"]))

    def test_fallback_refuses_dynamic_circuits_clearly(self):
        for net in ("V1 1 0 5\nR1 1 2 1k\nC1 2 0 1u", "V1 1 0 5\nR1 1 0 1000\nL1 1 0 1e-3",
                    "V1 1 0 SIN(0 1 1k)\nR1 1 0 1k", "V1 1 0 5\nR1 1 0 1k\n.tran 1u 1m"):
            res = simulate_netlist_pure_python(net)
            self.assertFalse(res["success"], net)
            self.assertIn("Rust engine", res["error_message"])
        # A current source named like "IC1" must not be mistaken for a capacitor
        self.assertTrue(simulate_netlist_pure_python("IC1 0 1 3\nR1 1 0 5")["success"])


class TestArchitectFilters(unittest.TestCase):
    @patch(f'{SERVICE}.ask_ai')
    def test_cutoff_spec_is_checked_and_repaired(self, mock_ask_ai):
        mock_ask_ai.side_effect = [
            # First try: cutoff 1/(2π·1k·1µ) ≈ 159 Hz, not the requested 1 kHz
            "```spice\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac dec 20 10 100k\n```",
            "```spice\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 159.15n\n.ac dec 20 10 100k\n```",
        ]
        res = generate_circuit_architect("Design an RC low-pass filter with a 1 kHz cutoff")
        self.assertEqual(len(res["attempts"]), 2)
        self.assertTrue(any("cutoff" in p for p in res["attempts"][0]["problems"]))
        checks = res["verification"]["spec_checks"]
        self.assertEqual(len(checks), 1)
        self.assertTrue(checks[0]["passed"], checks[0])

    @patch(f'{SERVICE}.ask_ai', return_value="Filters are fun. No netlist here.")
    def test_offline_filter_template_meets_its_cutoff(self, _):
        for spec, node_high in (("Design a low-pass filter with a 2 kHz cutoff", False),
                                ("Design a high-pass filter with a 500 Hz cutoff using 4.7k ohm", True)):
            res = generate_circuit_architect(spec)
            self.assertEqual(res["source"], "offline_template")
            self.assertTrue(res["verification"]["success"])
            self.assertTrue(all(c["passed"] for c in res["verification"]["spec_checks"]), res["verification"]["spec_checks"])
            self.assertIn("C1", res["netlist"])


if __name__ == '__main__':
    unittest.main()
