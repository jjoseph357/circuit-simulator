import os
import sys
import re
import unittest
from unittest.mock import patch

WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if WORKSPACE_ROOT not in sys.path:
    sys.path.insert(0, WORKSPACE_ROOT)

from circuit_simulator.backend.circuit_service import (
    PRESET_CIRCUITS,
    explain_diagnostics,
    generate_circuit_architect,
    lint_circuit_netlist,
    simulate_netlist_pure_python,
    simulate_netlist_with_rust,
)

SERVICE = 'circuit_simulator.backend.circuit_service'


class TestArchitectClosedLoop(unittest.TestCase):
    """The Architect must verify LLM output and feed failures back, never paper over them."""

    @patch(f'{SERVICE}.ask_ai')
    def test_defective_first_attempt_is_repaired_using_doctor_feedback(self, mock_ask_ai):
        mock_ask_ai.side_effect = [
            "```spice\nV1 1 0 5\nV2 1 0 10\nR1 1 0 100\n```",
            "```spice\nV1 1 0 10\nR1 1 2 1k\nR2 2 0 1k\n```",
        ]
        res = generate_circuit_architect("Design a 10V to 5V divider")
        self.assertEqual(len(res["attempts"]), 2)
        self.assertTrue(any("ERR_KVL_VIOLATION" in p for p in res["attempts"][0]["problems"]))
        self.assertEqual(res["attempts"][1]["problems"], [])
        # The repair prompt must carry the Doctor's findings and the rules.
        repair_query = mock_ask_ai.call_args_list[1].kwargs["query"]
        self.assertIn("ERR_KVL_VIOLATION", repair_query)
        self.assertIn("unique name", repair_query)
        self.assertTrue(res["verification"]["success"])
        self.assertTrue(all(c["passed"] for c in res["verification"]["spec_checks"]))

    @patch(f'{SERVICE}.ask_ai')
    def test_spec_checks_catch_wrong_values(self, mock_ask_ai):
        mock_ask_ai.return_value = "```spice\nV1 1 0 12\nR1 1 2 1k\nR2 2 0 1k\n```"
        res = generate_circuit_architect("Design a 12V to 3.3V divider")
        first = res["attempts"][0]
        self.assertTrue(any("3.3 V" in p for p in first["problems"]), first["problems"])
        # Milestone 3: the topology was sound, so the tuner fixed the values in the same round
        self.assertTrue(res["attempts"][-1].get("tuned"))
        checks = {c["label"]: c["passed"] for c in res["verification"]["spec_checks"]}
        self.assertTrue(checks["Some node sits at 3.3 V"])
        self.assertEqual(mock_ask_ai.call_count, 1)

    @patch(f'{SERVICE}.ask_ai')
    def test_offline_template_designs_divider_exactly(self, mock_ask_ai):
        mock_ask_ai.return_value = "General circuit advice without any netlist."
        res = generate_circuit_architect("Design a 12V to 3.3V voltage divider with 1mA current draw")
        self.assertEqual(res["source"], "offline_template")
        v = res["verification"]["node_voltages"]
        self.assertAlmostEqual(v["1"], 12.0, places=6)
        self.assertAlmostEqual(v["2"], 3.3, places=6)
        self.assertTrue(all(c["passed"] for c in res["verification"]["spec_checks"]))

    @patch(f'{SERVICE}.ask_ai')
    def test_no_silent_default_circuit_for_unsupported_specs(self, mock_ask_ai):
        mock_ask_ai.return_value = "I cannot help with that."
        res = generate_circuit_architect("Design a 1 kHz Butterworth low-pass filter")
        self.assertFalse(res["verification"]["success"])
        self.assertEqual(res["netlist"], "")
        self.assertEqual(res["source"], "none")


class TestDoctorExplanation(unittest.TestCase):
    def test_offline_explanation_is_plain_english_and_includes_fix(self):
        diags = lint_circuit_netlist("V1 1 2 10\nR1 1 2 1k")
        out = explain_diagnostics("V1 1 2 10\nR1 1 2 1k", diags, settings={"provider": "local"})
        self.assertEqual(out["source"], "offline")
        self.assertIn("sea level", out["explanation"])
        self.assertIn("Suggested fix", out["explanation"])

    @patch(f'{SERVICE}.ask_ai', return_value="Plain words.")
    def test_llm_receives_deterministic_telemetry(self, mock_ask_ai):
        diags = lint_circuit_netlist("I1 0 1 2\nI2 1 0 2")
        out = explain_diagnostics("I1 0 1 2\nI2 1 0 2", diags, settings={"provider": "ollama"})
        self.assertEqual(out["source"], "llm")
        self.assertIn("ERR_CURRENT_ONLY_NODE", mock_ask_ai.call_args.kwargs["context"])

    def test_clean_circuit(self):
        out = explain_diagnostics("V1 1 0 10\nR1 1 0 1k", [])
        self.assertIn("No problems", out["explanation"])


class TestPythonFallbackParity(unittest.TestCase):
    """The fallback must describe the same circuit as the Rust engine, or results silently diverge."""

    def test_all_presets_match_rust(self):
        # Presets with C, L, devices, waveforms or .tran/.ac/.dc need the Rust engine by design.
        resistive = [c for c in PRESET_CIRCUITS
                     if not re.search(r'^\s*([CLDQM]\w*\s|\.(tran|ac|dc|model)\b)|\b(PULSE|SIN|PWL|AC)\b', c["netlist"], re.I | re.M)]
        self.assertGreaterEqual(len(resistive), 5)
        for circuit in resistive:
            net = circuit["netlist"]
            rust = simulate_netlist_with_rust(net)
            py = simulate_netlist_pure_python(net)
            self.assertTrue(py["success"], f"{circuit['id']}: {py.get('error_message')}")
            for node, v in rust["node_voltages"].items():
                self.assertAlmostEqual(py["node_voltages"][node], v, places=9, msg=f"{circuit['id']} node {node}")
            self.assertEqual(set(py["branch_currents"]), set(rust["branch_currents"]), f"{circuit['id']}: element names differ")

    def test_unsupported_element_is_an_error_not_a_voltage_source(self):
        res = simulate_netlist_pure_python("V1 1 0 5\nR1 1 2 1k\nJ1 2 0 1")
        self.assertFalse(res["success"])
        self.assertIn("JFET", res["error_message"])

    def test_mixed_node_names_do_not_crash(self):
        res = simulate_netlist_pure_python("V1 in 0 10\nR1 in 10 1k\nR2 10 1a 1k\nR3 1a 0 1k")
        self.assertTrue(res["success"], res.get("error_message"))
        self.assertAlmostEqual(res["node_voltages"]["10"], 20 / 3, places=9)

    def test_non_spice_lines_are_errors_and_first_line_can_be_a_title(self):
        for bad in ("V1 1 0 5\nres(1, 0, 10);", "V1 1 0 5\nR1 1 0", "V1 1 0 5\nZ1 1 0 10"):
            self.assertFalse(simulate_netlist_pure_python(bad)["success"], bad)
            self.assertFalse(simulate_netlist_with_rust(bad)["success"], bad)
        titled = "My divider\nV1 1 0 10\nR1 1 2 1k\nR2 2 0 1k ; load\n.end"
        for res in (simulate_netlist_pure_python(titled), simulate_netlist_with_rust(titled)):
            self.assertTrue(res["success"], res.get("error_message"))
            self.assertAlmostEqual(res["node_voltages"]["2"], 5.0)


if __name__ == '__main__':
    unittest.main()
