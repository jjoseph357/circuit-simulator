"""
Circuit Simulator Backend Package
"""
from .circuit_service import (
    find_circuit_binary,
    engine_runtime,
    tune_netlist,
    ENGINE_BINARY_PATHS,
    PRESET_CIRCUITS,
    simulate_netlist_with_rust,
    simulate_netlist_pure_python,
    parse_eng_value_py,
    lint_circuit_netlist,
    generate_circuit_architect,
    ask_socratic_professor,
    explain_diagnostics,
    synthesize_offline_template,
)

__all__ = [
    "find_circuit_binary",
    "engine_runtime",
    "tune_netlist",
    "ENGINE_BINARY_PATHS",
    "PRESET_CIRCUITS",
    "simulate_netlist_with_rust",
    "simulate_netlist_pure_python",
    "parse_eng_value_py",
    "lint_circuit_netlist",
    "generate_circuit_architect",
    "ask_socratic_professor",
    "explain_diagnostics",
    "synthesize_offline_template",
]
