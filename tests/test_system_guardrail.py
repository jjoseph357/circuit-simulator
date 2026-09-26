import os
import sys
import unittest
from unittest.mock import patch

# Ensure workspace root is on sys.path
WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if WORKSPACE_ROOT not in sys.path:
    sys.path.insert(0, WORKSPACE_ROOT)

from circuit_simulator.verify import run_all_verifications, verify_curriculum_benchmarks

class TestSystemGuardrail(unittest.TestCase):
    """
    TDD Suite: Seam 3 (Whole-System Guardrail Runner)
    Verifies that whenever an LLM makes changes to the circuit simulator,
    an automated guardrail verifies the Rust core, Python service,
    curriculum benchmarks, and TypeScript frontend contracts.
    """

    def test_curriculum_benchmarks_all_pass(self):
        """Verifies that all example circuits solve within tolerance."""
        res = verify_curriculum_benchmarks()
        self.assertTrue(res["success"], f"Benchmark failure: {res.get('failures')}")
        self.assertGreaterEqual(res["benchmarks_checked"], 4)

    def test_run_all_verifications_contract(self):
        """Verifies that run_all_verifications returns structured status for each component."""
        report = run_all_verifications(quick_mode=True)
        self.assertIn("rust_engine", report)
        self.assertIn("python_backend", report)
        self.assertIn("curriculum_benchmarks", report)
        self.assertIn("overall_success", report)
        self.assertTrue(report["overall_success"], f"Guardrail failed: {report}")

    def test_guardrail_catches_regression(self):
        """Verifies that when a component check fails, overall_success is False."""
        with patch('circuit_simulator.verify.run_python_tests', return_value=(False, "Simulated regression")):
            report = run_all_verifications(quick_mode=False)
            self.assertFalse(report["overall_success"])
            self.assertFalse(report["python_backend"]["passed"])

if __name__ == '__main__':
    unittest.main()
