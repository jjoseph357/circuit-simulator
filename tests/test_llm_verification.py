import os
import sys
import unittest
from unittest.mock import patch

# Ensure repository root is on sys.path
WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if WORKSPACE_ROOT not in sys.path:
    sys.path.insert(0, WORKSPACE_ROOT)

from circuit_simulator.backend.circuit_service import generate_circuit_architect

class TestLLMVerificationSeam(unittest.TestCase):
    """
    TDD Suite: Seam 1 (LLM Netlist Synthesis & Defensive Sanitization Seam)
    Verifies that whenever an LLM generates or edits circuit netlists,
    the simulator robustly sanitizes, parses, and validates the circuit.
    """

    @patch('circuit_simulator.backend.circuit_service.ask_ai')
    def test_llm_code_block_with_trailing_spaces_and_cr_lf(self, mock_ask_ai):
        """Test extraction when LLM outputs code fences with trailing spaces and Windows CRLF."""
        mock_ask_ai.return_value = (
            "Here is the synthesized circuit:\n\n"
            "```SPICE   \r\n"
            "V1 1 0 15V\r\n"
            "R1 1 2 10k\r\n"
            "R2 2 0 5k\r\n"
            "```\r\n"
            "This circuit divides 15V down to 5V across R2."
        )

        res = generate_circuit_architect("Design a 15V to 5V divider")
        self.assertTrue(res["verification"]["success"], f"Failed: {res['verification']}")
        voltages = res["verification"]["node_voltages"]
        self.assertAlmostEqual(voltages.get("1", 0.0), 15.0, places=3)
        self.assertAlmostEqual(voltages.get("2", 0.0), 5.0, places=3)
        self.assertIn("V1 1 0 15V", res["netlist"])

    @patch('circuit_simulator.backend.circuit_service.ask_ai')
    def test_llm_output_with_inline_comments_and_symbols(self, mock_ask_ai):
        """Test extraction when LLM includes inline comments with $, //, and ;."""
        mock_ask_ai.return_value = (
            "```spice\n"
            "* Symmetric divider\n"
            "V1 1 0 10V $ Main DC rail\n"
            "R1 1 2 1k // Upper resistor\n"
            "R2 2 0 1k ; Lower pull-down\n"
            "```"
        )

        res = generate_circuit_architect("Design a symmetric 10V divider")
        self.assertTrue(res["verification"]["success"], f"Failed: {res['verification']}")
        voltages = res["verification"]["node_voltages"]
        self.assertAlmostEqual(voltages.get("1", 0.0), 10.0, places=3)
        self.assertAlmostEqual(voltages.get("2", 0.0), 5.0, places=3)

    @patch('circuit_simulator.backend.circuit_service.ask_ai')
    def test_llm_conversational_text_without_code_block(self, mock_ask_ai):
        """Test extraction when LLM outputs pure prose with valid component lines."""
        mock_ask_ai.return_value = (
            "Here is the circuit you requested:\n"
            "V1 1 0 20.0\n"
            "R1 1 2 2.0k\n"
            "R2 2 0 2.0k\n"
            "This will create a balanced half-rail virtual ground."
        )

        res = generate_circuit_architect("Balanced 20V divider")
        self.assertTrue(res["verification"]["success"], f"Failed: {res['verification']}")
        voltages = res["verification"]["node_voltages"]
        self.assertAlmostEqual(voltages.get("1", 0.0), 20.0, places=3)
        self.assertAlmostEqual(voltages.get("2", 0.0), 10.0, places=3)

    @patch('circuit_simulator.backend.circuit_service.ask_ai')
    def test_llm_defective_circuit_provides_diagnostics(self, mock_ask_ai):
        """Test that an LLM-generated circuit with floating nodes returns actionable diagnostic telemetry."""
        mock_ask_ai.return_value = (
            "```spice\n"
            "V1 1 0 10V\n"
            "R1 1 2 10k\n"
            "R2 3 0 10k\n"
            "```"
        )

        res = generate_circuit_architect("Broken circuit with disconnected nodes")
        self.assertIn("verification", res)
        # The verification must report diagnostics identifying floating nodes or failure
        diagnostics = res["verification"].get("diagnostics", [])
        self.assertGreater(len(diagnostics), 0, "Expected diagnostics for disconnected circuit")
        diag_codes = [d.get("code") for d in diagnostics]
        self.assertTrue(any("FLOATING" in c or "SINGULAR" in c or "GROUND" in c for c in diag_codes),
                        f"Expected floating node diagnostic, got: {diag_codes}")

    @patch('circuit_simulator.backend.circuit_service.ask_ai')
    def test_llm_titled_netlist_extraction(self, mock_ask_ai):
        """A SPICE deck whose first line is a bare title (as real SPICE allows) is read correctly."""
        mock_ask_ai.return_value = (
            "Here is the circuit:\n"
            "```spice\n"
            "Two resistors fed by a current source\n"
            "I1 0 1 2\n"
            "R1 1 2 50\n"
            "R2 2 0 50\n"
            ".end\n"
            "```\n"
            "This pushes 2 A through two 50 ohm resistors."
        )

        res = generate_circuit_architect("2A through two 50 ohm resistors")
        self.assertTrue(res["verification"]["success"], f"Failed: {res['verification']}")
        voltages = res["verification"]["node_voltages"]
        self.assertAlmostEqual(voltages.get("1", 0.0), 200.0, places=1)
        self.assertAlmostEqual(voltages.get("2", 0.0), 100.0, places=1)

    @patch('circuit_simulator.backend.circuit_service.ask_ai')
    def test_llm_conflicting_parallel_sources_flagged_by_doctor(self, mock_ask_ai):
        """Test that conflicting parallel voltage sources generated by an LLM are caught by linter."""
        # Differing values -> KVL violation
        mock_ask_ai.return_value = (
            "```spice\n"
            "V1 1 0 5V\n"
            "V2 1 0 10V\n"
            "R1 1 0 100\n"
            "```"
        )
        res = generate_circuit_architect("Two differing power supplies tied in parallel")
        diagnostics = res["verification"].get("diagnostics", [])
        diag_codes = [d.get("code") for d in diagnostics]
        self.assertIn("ERR_KVL_VIOLATION", diag_codes,
                      f"Expected ERR_KVL_VIOLATION in diagnostics, got: {diag_codes}")

        # Identical values -> Parallel voltage sources (indeterminate branch current)
        mock_ask_ai.return_value = (
            "```spice\n"
            "V1 1 0 5V\n"
            "V2 1 0 5V\n"
            "R1 1 0 100\n"
            "```"
        )
        res2 = generate_circuit_architect("Two identical 5V supplies in parallel")
        diagnostics2 = res2["verification"].get("diagnostics", [])
        diag_codes2 = [d.get("code") for d in diagnostics2]
        self.assertIn("ERR_PARALLEL_VOLTAGE_SOURCES", diag_codes2,
                      f"Expected ERR_PARALLEL_VOLTAGE_SOURCES in diagnostics, got: {diag_codes2}")

if __name__ == '__main__':
    unittest.main()
