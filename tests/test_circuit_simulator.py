import os
import sys
import unittest
import json

# Ensure repository root is on sys.path
WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if WORKSPACE_ROOT not in sys.path:
    sys.path.insert(0, WORKSPACE_ROOT)

from circuit_simulator.backend.server import create_standalone_app
from circuit_simulator.backend.circuit_service import simulate_netlist_with_rust, simulate_netlist_pure_python

class TestCircuitSimulator(unittest.TestCase):
    def setUp(self):
        self.app = create_standalone_app().test_client()

    def test_examples_endpoint(self):
        response = self.app.get('/api/circuit/examples')
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertIsInstance(data, list)
        self.assertGreaterEqual(len(data), 4)
        network = next(item for item in data if item["id"] == "current_source_network")
        self.assertIn("netlist", network)
        for item in data:
            self.assertNotIn("netlist_octave", item)

    def test_solve_current_source_network_gaussian(self):
        netlist = """* Current source network
        I1 0 1 3
        R1 1 2 5
        R2 2 0 10
        R3 2 3 5
        R4 3 0 10
        .end
        """
        payload = {"netlist": netlist, "solver_type": "gaussian"}
        response = self.app.post('/api/circuit/solve', json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data.get("success"), f"Solve failed: {data.get('error_message')}")
        voltages = data.get("node_voltages", {})
        self.assertAlmostEqual(voltages.get("1", 0.0), 33.0, places=4)
        self.assertAlmostEqual(voltages.get("2", 0.0), 18.0, places=4)
        self.assertAlmostEqual(voltages.get("3", 0.0), 12.0, places=4)

        # Check educational steps
        stamping = data.get("stamping_timeline", [])
        self.assertEqual(len(stamping), 5)
        gaussian_steps = data.get("gaussian_steps", [])
        self.assertGreater(len(gaussian_steps), 0)

    def test_solve_current_source_network_sparse_lu(self):
        netlist = """
        I1 0 1 3.0
        R1 1 2 5.0
        R2 2 0 10.0
        R3 2 3 5.0
        R4 3 0 10.0
        """
        payload = {"netlist": netlist, "solver_type": "sparse_lu"}
        response = self.app.post('/api/circuit/solve', json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data.get("success"))
        voltages = data.get("node_voltages", {})
        self.assertAlmostEqual(voltages.get("1", 0.0), 33.0, places=4)
        self.assertAlmostEqual(voltages.get("2", 0.0), 18.0, places=4)
        self.assertAlmostEqual(voltages.get("3", 0.0), 12.0, places=4)

    def test_solve_voltage_source_with_two_resistors(self):
        netlist = """
        V1 1 0 12.0
        R1 1 2 3.0
        R2 2 0 6.0
        """
        payload = {"netlist": netlist, "solver_type": "gaussian"}
        response = self.app.post('/api/circuit/solve', json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data.get("success"))
        voltages = data.get("node_voltages", {})
        self.assertAlmostEqual(voltages.get("1", 0.0), 12.0, places=4)
        self.assertAlmostEqual(voltages.get("2", 0.0), 8.0, places=4)

    def test_lint_circuit(self):
        # Missing ground
        netlist = "R1 1 2 10.0\nI1 1 2 1.0\n"
        response = self.app.post('/api/circuit/lint', json={"netlist": netlist})
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        diags = data.get("diagnostics", [])
        self.assertTrue(any(d.get("code") == "ERR_NO_GROUND" for d in diags))

    def test_solve_with_engineering_units_and_suffixes(self):
        netlist = """
        V1 1 0 5V
        R1 1 2 10k
        R2 2 0 10kohm
        """
        payload = {"netlist": netlist, "solver_type": "gaussian"}
        response = self.app.post('/api/circuit/solve', json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data.get("success"), f"Failed: {data.get('error_message')}")
        voltages = data.get("node_voltages", {})
        self.assertAlmostEqual(voltages.get("1", 0.0), 5.0, places=4)
        self.assertAlmostEqual(voltages.get("2", 0.0), 2.5, places=4)

    def test_pure_python_solver_with_engineering_units(self):
        netlist = "V1 1 0 10.0\nR1 1 2 5.0k\nR2 2 0 5.0k\n"
        res = simulate_netlist_pure_python(netlist)
        self.assertTrue(res.get("success"), f"Python solver failed: {res.get('error_message')}")
        voltages = res.get("node_voltages", {})
        self.assertAlmostEqual(voltages.get("1", 0.0), 10.0, places=4)
        self.assertAlmostEqual(voltages.get("2", 0.0), 5.0, places=4)

    def test_solve_vsource_slide100_sparse_lu(self):
        netlist = """
        V1 1 0 12.0V
        R1 1 2 3.0
        R2 2 0 6.0
        """
        payload = {"netlist": netlist, "solver_type": "sparse_lu"}
        response = self.app.post('/api/circuit/solve', json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data.get("success"))
        self.assertEqual(data.get("solver_used"), "SparseLU")
        voltages = data.get("node_voltages", {})
        self.assertAlmostEqual(voltages.get("1", 0.0), 12.0, places=4)
        self.assertAlmostEqual(voltages.get("2", 0.0), 8.0, places=4)

    def test_wheatstone_bridge_dual_solvers(self):
        netlist = """
        V1 1 0 10.0
        R1 1 2 100.0
        R2 2 0 100.0
        R3 1 3 100.0
        R4 3 0 120.0
        R_bridge 2 3 50.0
        """
        # Test Gaussian
        res_g = self.app.post('/api/circuit/solve', json={"netlist": netlist, "solver_type": "gaussian"}).get_json()
        # Test Sparse LU
        res_l = self.app.post('/api/circuit/solve', json={"netlist": netlist, "solver_type": "sparse_lu"}).get_json()

        self.assertTrue(res_g.get("success"))
        self.assertTrue(res_l.get("success"))
        vg2 = res_g["node_voltages"]["2"]
        vl2 = res_l["node_voltages"]["2"]
        self.assertAlmostEqual(vg2, vl2, places=6)

    def test_lint_advanced_diagnostics(self):
        # 1. Parallel identical voltage sources
        netlist_parallel = "V1 1 0 10.0\nV2 1 0 10.0\nR1 1 0 5.0\n"
        res_p = self.app.post('/api/circuit/lint', json={"netlist": netlist_parallel}).get_json()
        diags_p = res_p.get("diagnostics", [])
        self.assertTrue(any(d.get("code") == "ERR_PARALLEL_VOLTAGE_SOURCES" for d in diags_p))

        # 2. Parse syntax error: an element line with no value
        netlist_syntax = "V1 1 0 5\nR1 1 2"
        res_s = self.app.post('/api/circuit/lint', json={"netlist": netlist_syntax}).get_json()
        diags_s = res_s.get("diagnostics", [])
        self.assertTrue(any(d.get("code") == "ERR_PARSE" for d in diags_s))

    def test_socratic_professor_endpoint(self):
        payload = {
            "question": "Why is the voltage at node 2 18V instead of 33V?",
            "netlist": "I1 0 1 3\nR1 1 2 5\nR2 2 0 10",
            "node_voltages": {"1": 33.0, "2": 18.0, "0": 0.0}
        }
        response = self.app.post('/api/circuit/socratic', json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertIn("answer", data)
        self.assertIsInstance(data["answer"], str)
        self.assertGreater(len(data["answer"]), 20)

    def test_circuit_architect_endpoint(self):
        payload = {"prompt": "Design a 5V voltage divider"}
        response = self.app.post('/api/circuit/architect', json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertIn("netlist", data)
        self.assertIn("verification", data)
        self.assertTrue(data["verification"].get("success", False))

if __name__ == '__main__':
    unittest.main()
