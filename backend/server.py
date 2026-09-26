import os
import sys
from flask import Blueprint, request, jsonify, Flask, send_from_directory

SIM_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Allow `python circuit_simulator/backend/server.py` as well as `-m circuit_simulator.backend.server`
if os.path.dirname(SIM_DIR) not in sys.path:
    sys.path.insert(0, os.path.dirname(SIM_DIR))

from circuit_simulator.backend.circuit_service import (
    simulate_netlist_with_rust,
    lint_circuit_netlist,
    generate_circuit_architect,
    ask_socratic_professor,
    explain_diagnostics,
    engine_runtime,
    tune_netlist,
    PRESET_CIRCUITS
)
from circuit_simulator.backend.llm import load_settings, public_settings, save_settings

FRONTEND_DIST = os.path.join(SIM_DIR, "frontend", "dist")
DEFAULT_PORT = 5050


def get_settings():
    return load_settings()


circuit_bp = Blueprint('circuit', __name__)

@circuit_bp.route('/api/circuit/examples', methods=['GET'])
def get_circuit_examples():
    return jsonify(PRESET_CIRCUITS)

@circuit_bp.route('/api/circuit/settings', methods=['GET'])
def circuit_settings_get():
    return jsonify(public_settings())

@circuit_bp.route('/api/circuit/settings', methods=['POST'])
def circuit_settings_post():
    save_settings(request.json or {})
    return jsonify(public_settings())

@circuit_bp.route('/api/circuit/tune', methods=['POST'])
def circuit_tune_route():
    return jsonify(tune_netlist(request.json or {}))

@circuit_bp.route('/api/circuit/engine', methods=['GET'])
def circuit_engine_info():
    return jsonify(engine_runtime())

@circuit_bp.route('/api/circuit/solve', methods=['POST'])
def solve_circuit_route():
    data = request.json or {}
    netlist = data.get("netlist", "")
    solver_type = data.get("solver_type", "gaussian")
    result = simulate_netlist_with_rust(netlist, solver_type)
    return jsonify(result)

@circuit_bp.route('/api/circuit/lint', methods=['POST'])
def lint_circuit_route():
    data = request.json or {}
    netlist = data.get("netlist", "")
    diagnostics = lint_circuit_netlist(netlist)
    return jsonify({"diagnostics": diagnostics})

@circuit_bp.route('/api/circuit/doctor/explain', methods=['POST'])
def circuit_doctor_explain_route():
    data = request.json or {}
    netlist = data.get("netlist", "")
    diagnostics = data.get("diagnostics")
    return jsonify(explain_diagnostics(netlist, diagnostics, settings=get_settings()))

@circuit_bp.route('/api/circuit/architect', methods=['POST'])
def circuit_architect_route():
    data = request.json or {}
    prompt = data.get("prompt", "")
    settings = get_settings()
    res = generate_circuit_architect(prompt, settings=settings)
    return jsonify(res)

@circuit_bp.route('/api/circuit/socratic', methods=['POST'])
def circuit_socratic_route():
    data = request.json or {}
    question = data.get("question", "")
    netlist = data.get("netlist", "")
    node_voltages = data.get("node_voltages", {})
    branch_currents = data.get("branch_currents", {})
    settings = get_settings()
    answer = ask_socratic_professor(question, netlist, node_voltages, settings=settings, branch_currents=branch_currents)
    return jsonify({"answer": answer})

def create_standalone_app():
    """The Circuit Lab web app: API plus the compiled frontend (circuit_simulator/frontend/dist)."""
    app = Flask(__name__, static_folder=None)
    app.register_blueprint(circuit_bp)

    @app.route('/', defaults={'path': ''})
    @app.route('/<path:path>')
    def serve_ui(path):
        if path and os.path.isfile(os.path.join(FRONTEND_DIST, path)):
            return send_from_directory(FRONTEND_DIST, path)
        if os.path.isfile(os.path.join(FRONTEND_DIST, "index.html")):
            return send_from_directory(FRONTEND_DIST, "index.html")
        return jsonify({
            "status": "Circuit Lab API is running, but the UI has not been built.",
            "build_ui": "python circuit_simulator/start.py  (or: cd circuit_simulator/frontend && npm install && npm run build)",
        })

    return app


if __name__ == '__main__':
    port = int(os.environ.get("CIRCUIT_PORT", DEFAULT_PORT))
    print(f"Circuit Lab on http://localhost:{port}")
    create_standalone_app().run(host="127.0.0.1", port=port, debug=False)
