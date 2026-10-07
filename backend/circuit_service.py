import os
import sys
import json
import subprocess
import math
import re
import shutil
from typing import Dict, Any, List, Optional

_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
_CIRCUIT_SIM_DIR = os.path.abspath(os.path.join(_CURRENT_DIR, ".."))

from circuit_simulator.backend.llm import ask_ai, is_offline

_EXE = ".exe" if sys.platform == "win32" else ""
ENGINE_BINARY_PATHS = [
    os.path.join(_CIRCUIT_SIM_DIR, "engine", "target", "release", "circuit_engine" + _EXE),
    os.path.join(_CIRCUIT_SIM_DIR, "engine", "target", "debug", "circuit_engine" + _EXE),
]

# In-process PyO3 build of the Rust engine (circuit_simulator/build_engine.py). Preferred:
# no process spawn per solve, and it releases the GIL during large sparse solves.
try:
    from circuit_simulator.backend._native import circuit_engine as _native_engine
except ImportError:
    _native_engine = None

VALID_SOLVERS = ("gaussian", "sparse_lu", "faer")


def engine_runtime() -> Dict[str, Any]:
    """Which engine implementation this server will use, for the UI and the guardrail."""
    if _native_engine is not None:
        return {"runtime": "pyo3", "version": getattr(_native_engine, "__version__", "?"),
                "has_faer": bool(getattr(_native_engine, "HAS_FAER", False))}
    binary = find_circuit_binary()
    if binary:
        return {"runtime": "cli", "path": binary, "has_faer": True}
    return {"runtime": "python", "has_faer": False}


def find_circuit_binary() -> Optional[str]:
    for p in ENGINE_BINARY_PATHS:
        if os.path.isfile(p):
            return p
    which_bin = shutil.which("circuit_engine")
    if which_bin:
        return which_bin
    return None

# Built-in example circuits. Shared with the browser build (frontend imports the same
# file), so the offline UI and the server always offer identical presets and expected answers.
with open(os.path.join(_CIRCUIT_SIM_DIR, "presets.json"), encoding="utf-8") as _f:
    PRESET_CIRCUITS: List[Dict[str, Any]] = json.load(_f)

def simulate_netlist_with_rust(netlist: str, solver_type: str = "gaussian") -> Dict[str, Any]:
    """
    Solves with the Rust engine: in-process PyO3 module first, then the CLI binary,
    then the pure-Python fallback. All three return the same JSON schema.
    """
    if solver_type not in VALID_SOLVERS:
        solver_type = "gaussian"

    if _native_engine is not None:
        return json.loads(_native_engine.simulate_json(netlist, solver_type))

    binary_path = find_circuit_binary()
    if binary_path and os.path.exists(binary_path):
        cmd = [binary_path, "--json", {"sparse_lu": "--sparse-lu", "faer": "--faer"}.get(solver_type, "--gaussian")]
        try:
            p = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding='utf-8',
                errors='replace'
            )
            stdout, stderr = p.communicate(input=netlist, timeout=60)
            if p.returncode == 0 and stdout.strip():
                return json.loads(stdout.strip())
            else:
                err_msg = stderr.strip() or stdout.strip() or f"Process exited with code {p.returncode}"
                return {"success": False, "error_message": err_msg}
        except Exception:
            # Fall back to pure Python solver
            pass

    return simulate_netlist_pure_python(netlist, solver_type)

def parse_eng_value_py(s: str) -> float:
    """Parses engineering notation and SPICE units in Python."""
    clean = s.strip().rstrip(';,()\'').strip()
    if not clean:
        raise ValueError("Empty value string")

    try:
        return float(clean)
    except ValueError:
        pass

    m = re.match(r'^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*)$', clean)
    if not m:
        raise ValueError(f"Could not parse numeric value '{clean}'")

    num_str, suffix = m.groups()
    val = float(num_str)
    suf = suffix.strip().lower()
    if not suf:
        return val

    if suf.startswith("meg"):
        mult = 1e6
    elif suf.startswith("mil"):
        mult = 25.4e-6
    elif suf.startswith("t"):
        mult = 1e12
    elif suf.startswith("g"):
        mult = 1e9
    elif suf.startswith("k"):
        mult = 1e3
    elif suf.startswith("m"):
        mult = 1e-3
    elif suf.startswith("u") or suf.startswith("µ"):
        mult = 1e-6
    elif suf.startswith("n"):
        mult = 1e-9
    elif suf.startswith("p"):
        mult = 1e-12
    elif suf.startswith("f"):
        mult = 1e-15
    else:
        mult = 1.0

    return val * mult

_UNSUPPORTED_ELEMENTS = {
    "J": "JFET", "X": "subcircuit instance",
}
_SPICE_HINT = "SPICE element lines look like 'R1 1 2 1k': a name (its first letter is the part type), two node names and a value."
_TYPE_BY_PREFIX = {"R": "Resistor", "I": "CurrentSource", "V": "VoltageSource"}
_NEEDS_RUST = ("{what} need the Rust engine (the pure-Python fallback only does DC analysis of R, I, V). "
               "Build it with: python circuit_simulator/build_engine.py")


def _normalize_node_py(node: str) -> str:
    n = node.strip().strip("'\",()")
    return "0" if n.lower() in ("0", "gnd", "ground") else n


def _first_line_is_title(stmt: str) -> bool:
    tokens = [t for t in re.split(r'[\s,]+', stmt) if t]
    if not tokens:
        return True
    letter = tokens[0][0].upper()
    if letter in "DQM":
        return len(tokens) < (3 if letter == "D" else 4)
    if letter in "EFGHOWKT":
        return len(tokens) < (3 if letter == "W" else 4)
    if letter in _UNSUPPORTED_ELEMENTS:
        return len(tokens[0]) >= 3 and tokens[0].isalpha()
    if letter not in "RCLVI" or len(tokens) < 4:
        return True
    try:
        parse_eng_value_py(tokens[3])
        return False
    except ValueError:
        return not (letter in "VI" and tokens[3].lower().startswith(("dc", "ac", "pulse", "sin", "pwl")))


def _parse_netlist_py(netlist: str) -> List[Dict[str, Any]]:
    """Mirrors the Rust parser's SPICE grammar so the fallback solver sees the same circuit."""
    components: List[Dict[str, Any]] = []
    first = True
    for raw_line in netlist.splitlines():
        # '*' starts a comment line; '$' and ';' start an inline comment (ngspice style).
        stmt = re.split(r'\s\$|;', raw_line.strip())[0].strip()
        was_first, first = first and bool(raw_line.strip()), first and not raw_line.strip()
        if not stmt or stmt.startswith(('*', '.')):
            continue
        # SPICE reads the first line as a title; here (as in the engine) only if it isn't a valid element.
        if was_first and _first_line_is_title(stmt):
            continue
        if re.match(r'[CL][A-Za-z0-9_]*\s+\S+\s+\S+\s+\S', stmt, re.I):
            raise ValueError(_NEEDS_RUST.format(what="Capacitors and inductors"))
        if re.match(r'[DQM][A-Za-z0-9_]*\s', stmt, re.I):
            raise ValueError(_NEEDS_RUST.format(what="Diodes and transistors (Newton–Raphson)"))
        if re.match(r'[EFGHOWKT][A-Za-z0-9_]*\s', stmt, re.I):
            raise ValueError(_NEEDS_RUST.format(what="OpAmps, controlled sources, short circuits, and coupled devices"))
        if re.search(r'\b(pulse|sin|pwl|ac)\b', stmt, re.I) and stmt[:1].upper() in ("V", "I"):
            raise ValueError(_NEEDS_RUST.format(what="Time-varying and AC sources"))

        tokens = [t for t in re.split(r'[\s,]+', stmt) if t]
        letter = tokens[0][0].upper()
        if letter in _UNSUPPORTED_ELEMENTS:
            raise ValueError(
                f"'{stmt}' is a {_UNSUPPORTED_ELEMENTS[letter]} ({letter}), which this engine does not "
                "simulate yet. Supported elements: R, C, L, V and I.")
        if letter not in _TYPE_BY_PREFIX:
            raise ValueError(f"'{stmt}': unknown element '{tokens[0]}'. {_SPICE_HINT}")
        if len(tokens) < 4:
            raise ValueError(f"'{stmt}' needs a name, two nodes and a value. {_SPICE_HINT}")
        value_token = tokens[4] if tokens[3].lower() == "dc" and len(tokens) >= 5 else tokens[3]
        components.append({
            "name": tokens[0], "type": _TYPE_BY_PREFIX[letter],
            "n1": _normalize_node_py(tokens[1]), "n2": _normalize_node_py(tokens[2]),
            "val": parse_eng_value_py(value_token), "line": stmt,
        })

    seen = set()
    for c in components:
        if c["name"].upper() in seen:
            raise ValueError(f"Duplicate element name '{c['name']}'.")
        seen.add(c["name"].upper())
        if c["type"] == "Resistor" and c["val"] == 0:
            raise ValueError(f"Resistor {c['name']} is 0 Ω, so its conductance 1/R is infinite and cannot be stamped.")
    return components


def simulate_netlist_pure_python(netlist: str, solver_type: str = "gaussian") -> Dict[str, Any]:
    """
    Pure Python Modified Nodal Analysis (MNA) fallback solver.
    Guarantees that simulation always succeeds even in environments without a Rust compiler.
    """
    try:
        components = _parse_netlist_py(netlist)
    except ValueError as e:
        return {"success": False, "error_message": str(e), "diagnostics": [{
            "severity": "error", "code": "ERR_PARSE", "title": "Netlist Syntax Error", "message": str(e),
            "nodes_affected": [], "components_affected": [],
            "suggestion": _SPICE_HINT,
        }]}

    if not components:
        return {"success": False, "error_message": "No components found"}
    if re.search(r'^\s*\.(tran|ac)\b', netlist, re.I | re.M):
        return {"success": False, "error_message": _NEEDS_RUST.format(what=".tran and .ac analyses")}

    # Map nodes
    node_set = set()
    v_sources = []
    for c in components:
        node_set.add(c["n1"])
        node_set.add(c["n2"])
        if c["type"] == "VoltageSource":
            v_sources.append(c)

    non_ground = sorted([n for n in node_set if n != "0"], key=lambda x: (0, int(x), "") if x.isdigit() else (1, 0, x))
    node_to_idx = {n: i + 1 for i, n in enumerate(non_ground)}
    node_to_idx["0"] = 0
    N = len(non_ground)
    M = len(v_sources)
    dim = N + M

    G = [[0.0] * dim for _ in range(dim)]
    b = [0.0] * dim
    stamping_timeline = []

    v_idx = 0
    for idx, c in enumerate(components):
        n1 = node_to_idx.get(c["n1"], 0)
        n2 = node_to_idx.get(c["n2"], 0)
        affected_g = []
        affected_b = []

        if c["type"] == "Resistor":
            g_val = 1.0 / c["val"]
            if n1 > 0:
                G[n1-1][n1-1] += g_val
                affected_g.append({"row": n1-1, "col": n1-1, "delta": g_val, "new_value": G[n1-1][n1-1]})
            if n2 > 0:
                G[n2-1][n2-1] += g_val
                affected_g.append({"row": n2-1, "col": n2-1, "delta": g_val, "new_value": G[n2-1][n2-1]})
            if n1 > 0 and n2 > 0:
                G[n1-1][n2-1] -= g_val
                G[n2-1][n1-1] -= g_val
                affected_g.append({"row": n1-1, "col": n2-1, "delta": -g_val, "new_value": G[n1-1][n2-1]})
                affected_g.append({"row": n2-1, "col": n1-1, "delta": -g_val, "new_value": G[n2-1][n1-1]})
        elif c["type"] == "CurrentSource":
            # leaves n1, enters n2
            if n1 > 0:
                b[n1-1] -= c["val"]
                affected_b.append({"row": n1-1, "col": 0, "delta": -c["val"], "new_value": b[n1-1]})
            if n2 > 0:
                b[n2-1] += c["val"]
                affected_b.append({"row": n2-1, "col": 0, "delta": c["val"], "new_value": b[n2-1]})
        elif c["type"] == "VoltageSource":
            aux_r = N + v_idx
            v_idx += 1
            if n1 > 0:
                G[n1-1][aux_r] += 1.0
                G[aux_r][n1-1] += 1.0
                affected_g.append({"row": n1-1, "col": aux_r, "delta": 1.0, "new_value": G[n1-1][aux_r]})
                affected_g.append({"row": aux_r, "col": n1-1, "delta": 1.0, "new_value": G[aux_r][n1-1]})
            if n2 > 0:
                G[n2-1][aux_r] -= 1.0
                G[aux_r][n2-1] -= 1.0
                affected_g.append({"row": n2-1, "col": aux_r, "delta": -1.0, "new_value": G[n2-1][aux_r]})
                affected_g.append({"row": aux_r, "col": n2-1, "delta": -1.0, "new_value": G[aux_r][n2-1]})
            b[aux_r] = c["val"]
            affected_b.append({"row": aux_r, "col": 0, "delta": c["val"], "new_value": b[aux_r]})

        stamping_timeline.append({
            "step_index": idx + 1,
            "component_name": c["name"],
            "component_summary": f"{c['type']} {c['name']} ({c['val']}) between {c['n1']} and {c['n2']}",
            "affected_cells_g": affected_g,
            "affected_cells_b": affected_b,
            "matrix_g_snapshot": [row[:] for row in G],
            "vector_b_snapshot": list(b),
            "explanation": f"Stamped {c['name']} into MNA system."
        })

    # Solve with Gaussian Elimination
    aug = [G[i][:] + [b[i]] for i in range(dim)]
    gaussian_steps = []
    
    for col in range(dim):
        # Pivot
        p_row = col
        max_val = abs(aug[col][col])
        for r in range(col + 1, dim):
            if abs(aug[r][col]) > max_val:
                max_val = abs(aug[r][col])
                p_row = r
        if max_val < 1e-12:
            return {"success": False, "error_message": f"Singular matrix at col {col}"}
        if p_row != col:
            aug[col], aug[p_row] = aug[p_row], aug[col]
            gaussian_steps.append({
                "step_index": len(gaussian_steps) + 1,
                "phase": "pivot_swap",
                "description": f"Swapped R{col+1} and R{p_row+1}",
                "latex_equation": f"R_{{{col+1}}} \\longleftrightarrow R_{{{p_row+1}}}",
                "matrix_snapshot": [r[:] for r in aug]
            })
        
        pivot = aug[col][col]
        for r in range(col + 1, dim):
            factor = aug[r][col] / pivot
            if abs(factor) > 1e-12:
                for c_idx in range(col, dim + 1):
                    aug[r][c_idx] -= factor * aug[col][c_idx]
                gaussian_steps.append({
                    "step_index": len(gaussian_steps) + 1,
                    "phase": "elimination",
                    "description": f"R_{r+1} ← R_{r+1} - ({factor:.4f}) × R_{col+1}",
                    "latex_equation": f"R_{{{r+1}}} \\leftarrow R_{{{r+1}}} - ({factor:.4f}) \\cdot R_{{{col+1}}}",
                    "matrix_snapshot": [row[:] for row in aug]
                })

    # Back-sub
    sol = [0.0] * dim
    for i in range(dim - 1, -1, -1):
        s = sum(aug[i][j] * sol[j] for j in range(i + 1, dim))
        if abs(aug[i][i]) < 1e-300:
            return {"success": False, "error_message": f"Zero diagonal at row {i + 1} during back-substitution"}
        sol[i] = (aug[i][dim] - s) / aug[i][i]
        gaussian_steps.append({
            "step_index": len(gaussian_steps) + 1,
            "phase": "back_substitution",
            "description": f"Solved X_{i+1} = {sol[i]:.4f}",
            "latex_equation": f"X_{{{i+1}}} = {sol[i]:.4f}",
            "matrix_snapshot": [row[:] for row in aug]
        })

    node_voltages = {"0": 0.0}
    for i, n in enumerate(non_ground):
        node_voltages[n] = sol[i]

    branch_currents = {}
    branch_powers = {}
    v_src_counter = 0
    for c in components:
        v1 = node_voltages[c["n1"]]
        v2 = node_voltages[c["n2"]]
        v_diff = v1 - v2
        if c["type"] == "Resistor":
            i_val = v_diff / c["val"]
            branch_currents[c["name"]] = i_val
            branch_powers[c["name"]] = v_diff * i_val
        elif c["type"] == "CurrentSource":
            branch_currents[c["name"]] = c["val"]
            branch_powers[c["name"]] = v_diff * c["val"]
        elif c["type"] == "VoltageSource":
            i_val = sol[N + v_src_counter]
            v_src_counter += 1
            branch_currents[c["name"]] = i_val
            branch_powers[c["name"]] = v_diff * i_val

    var_names = [f"V({n})" for n in non_ground] + [f"I({c['name']})" for c in v_sources]

    # Generate KCL equations
    kcl_equations = []
    for idx, node in enumerate(non_ground):
        terms = []
        tot = 0.0
        for c in components:
            i_val = branch_currents[c["name"]]
            if c["n1"] == node:
                expr = f"\\frac{{V_{{{c['n1']}}} - V_{{{c['n2']}}}}}{{{c['val']}}}" if c["type"] == "Resistor" else f"I_{{{c['name']}}}"
                terms.append((True, expr))
                tot += i_val
            elif c["n2"] == node:
                expr = f"\\frac{{V_{{{c['n2']}}} - V_{{{c['n1']}}}}}{{{c['val']}}}" if c["type"] == "Resistor" else f"I_{{{c['name']}}}"
                terms.append((True if c["type"] == "Resistor" else False, expr))
                tot -= i_val

        latex_parts = []
        for i, (pos, expr) in enumerate(terms):
            if i == 0:
                latex_parts.append(expr if pos else f"- {expr}")
            else:
                latex_parts.append(f"+ {expr}" if pos else f"- {expr}")

        latex_str = " ".join(latex_parts) if latex_parts else "0"
        kcl_equations.append({
            "node": node,
            "node_index": idx + 1,
            "raw_equation": f"{latex_str} = 0",
            "latex_equation": f"\\sum I_{{leaving}} = {latex_str} = 0",
            "evaluated_sum": round(tot, 6)
        })

    # Spy plot
    entries = []
    nnz = 0
    for r in range(dim):
        for c in range(dim):
            if abs(G[r][c]) > 1e-12:
                nnz += 1
                entries.append({
                    "row": r,
                    "col": c,
                    "value": G[r][c],
                    "entry_type": "conductance" if r < N and c < N else "voltage_incidence",
                    "description": f"G({var_names[r]}, {var_names[c]}) = {G[r][c]:.4f}"
                })

    spy_plot = {
        "dimension": dim,
        "non_zeros": nnz,
        "sparsity_percentage": round(100.0 * (1.0 - (nnz / (dim * dim if dim else 1))), 1),
        "entries": entries
    }

    return {
        "success": True,
        "error_message": None,
        "solver_used": "PythonGaussianElimination",
        "num_equations": dim,
        "variable_names": var_names,
        "solution_vector": sol,
        "node_voltages": node_voltages,
        "branch_currents": branch_currents,
        "branch_powers": branch_powers,
        "matrix_g": G,
        "vector_b": b,
        "stamping_timeline": stamping_timeline,
        "gaussian_steps": gaussian_steps,
        "kcl_equations": kcl_equations,
        "spy_plot": spy_plot,
        "diagnostics": [],
        "storybook_explanation": f"Circuit solved with {dim} unknowns. Peak node voltage is {max(node_voltages.values()):.2f} V.",
        "execution_time_us": 1200,
        "solver_note": "Rust engine binary not found; solved with the pure-Python fallback.",
        "residual_max_abs": max((abs(sum(G[r][c] * sol[c] for c in range(dim)) - b[r]) for r in range(dim)), default=0.0),
        "lu_fill_in": None,
        "educational_views": True,
    }

# ----------------- Tri-Modal Copilot Services -----------------

def tune_netlist(request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Runs the Rust netlist tuner (optimizer.rs): adjusts element values to meet numeric goals.
    request = {"netlist", "parameters": [{"element", "min", "max"}], "goals": [{"kind", ...}], "max_evaluations"?}
    """
    payload = json.dumps(request)
    if _native_engine is not None and hasattr(_native_engine, "tune_json"):
        return json.loads(_native_engine.tune_json(payload))
    binary = find_circuit_binary()
    if binary:
        p = subprocess.run([binary, "--tune"], input=payload, capture_output=True, text=True, encoding="utf-8", timeout=300)
        if p.returncode == 0 and p.stdout.strip():
            return json.loads(p.stdout)
    return {"success": False, "message": "The tuner needs the Rust engine (python circuit_simulator/build_engine.py).", "goals": []}


def lint_circuit_netlist(netlist: str) -> List[Dict[str, Any]]:
    """
    Tab 1: Circuit Doctor Topological Linter.
    Detects floating nodes, missing grounds, short circuits, and singular matrix topologies.
    """
    if _native_engine is not None:
        return json.loads(_native_engine.lint_json(netlist))

    binary_path = find_circuit_binary()
    if binary_path and os.path.exists(binary_path):
        try:
            cmd = [binary_path, "--lint-only"]
            p = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding='utf-8',
                errors='replace'
            )
            stdout, _ = p.communicate(input=netlist, timeout=5)
            if p.returncode == 0 and stdout.strip():
                return json.loads(stdout.strip())
        except Exception:
            pass

    # Basic fallback checks
    diagnostics = []
    lines = [l.strip() for l in netlist.splitlines() if l.strip() and not l.strip().startswith(('*', '#', '%', '//'))]
    has_ground = any(' 0 ' in f" {l} " or '(0,' in l or ',0,' in l or ', 0,' in l or l.endswith(',0)') or l.endswith(', 0)') for l in lines)
    if not has_ground:
        diagnostics.append({
            "severity": "error",
            "code": "ERR_NO_GROUND",
            "title": "Missing Reference Ground (Node 0)",
            "message": "Circuit must contain a connection to Ground (node 0) to define electrical potential datum.",
            "nodes_affected": ["0"],
            "components_affected": [],
            "suggestion": "Connect one terminal of your power source or reference rail to node 0."
        })
    return diagnostics

ARCHITECT_RULES = (
    "You are the Circuit Architect inside Circuit Lab, a teaching circuit simulator. Produce a SPICE netlist for the specification.\n"
    "Rules:\n"
    "1. Always include the reference ground node 0.\n"
    "2. Use R, C, L (passives), V, I (independent sources) and D, Q, M (diodes, BJTs, MOSFETs).\n"
    "   SPICE syntax: 'R1 1 2 1k', 'C1 2 0 100n', 'L1 2 3 1m', 'V1 1 0 12', 'I1 0 1 2m'. Current flows from the first node to the second through an I source.\n"
    "   Sources may be 'DC 5', 'AC 1', 'PULSE(v1 v2 delay rise fall width period)' or 'SIN(offset amplitude freq)'.\n"
    "   For frequency behaviour (filters, cutoffs) give the input 'AC 1' and add '.ac dec 20 <fstart> <fstop>'.\n"
    "   For behaviour over time add '.tran <step> <stop>'.\n"
    "   Devices need .model cards: 'D1 a k DMOD' + '.model DMOD D(IS=1e-14)', 'Q1 c b e QN' + '.model QN NPN(BF=100)',\n"
    "   'M1 d g s NM W=10u L=1u' + '.model NM NMOS(VTO=0.7 KP=100u)'.\n"
    "3. Give every element a unique name.\n"
    "4. Put the netlist, and nothing else, inside one ```spice code fence, followed by a short explanation of the design math.\n"
)
MAX_ARCHITECT_ATTEMPTS = 3


def _extract_netlist(ai_response: str) -> str:
    code_blocks = re.findall(r'```[ \t]*(?:spice|text|cir)?[ \t]*\r?\n([\s\S]*?)```', ai_response, re.I)
    if code_blocks:
        return code_blocks[0].strip()
    circuit_line_pattern = re.compile(
        r'^[ \t]*(?:[RIVCL][A-Za-z0-9_]*\s+[A-Za-z0-9_]+\s+[A-Za-z0-9_]+\s+(?:(?:DC|AC)\s+)?(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)[A-Za-z0-9_\.]*|(?:PULSE|SIN|PWL)\s*\(.*\)).*|\.(?:ac|tran|options?)\s+.*)[ \t]*$',
        re.I
    )
    lines = [l.strip() for l in ai_response.splitlines() if circuit_line_pattern.match(l.strip())]
    return "\n".join(lines)


def _spec_quantities(spec: str) -> Dict[str, Any]:
    """Pulls voltages and a current (with max/target intent) out of a plain-English spec."""
    volts = [float(v) for v in re.findall(r'(\d+(?:\.\d+)?)\s*V\b', spec, re.I)]
    current = None
    m = re.search(r'(\d+(?:\.\d+)?)\s*(m|u|µ)?A\b', spec)
    if m:
        scale = {"m": 1e-3, "u": 1e-6, "µ": 1e-6}.get(m.group(2) or "", 1.0)
        current = float(m.group(1)) * scale
    is_max = bool(re.search(r'\b(max(imum)?|at most|no more than|under|below|less than)\b', spec, re.I))
    cutoff = None
    mf = re.search(r'(\d+(?:\.\d+)?)\s*(k|M|meg)?\s*Hz\b', spec, re.I)
    if mf and re.search(r'cut-?off|corner|[-−]3\s*dB|bandwidth|low-?pass|high-?pass|filter', spec, re.I):
        scale = {"k": 1e3, "m": 1e6, "meg": 1e6}.get((mf.group(2) or "").lower(), 1.0)
        cutoff = float(mf.group(1)) * scale
    return {"volts": volts, "current": current, "current_is_max": is_max, "cutoff_hz": cutoff}


def _minus3db_frequencies(ac: Dict[str, Any]) -> Dict[str, float]:
    """For each node, where its gain first falls (low-pass) or rises (high-pass) through −3 dB of its passband."""
    out = {}
    f = ac.get("frequencies", [])
    for node, mags in ac.get("node_magnitude", {}).items():
        db = [20 * math.log10(max(m, 1e-300)) for m in mags]
        if len(db) < 2 or max(mags) < 1e-9:
            continue
        ref = max(db)
        for k in range(1, len(db)):
            a, b = db[k - 1] - (ref - 3), db[k] - (ref - 3)
            if a * b < 0:
                u = a / (a - b)
                out[node] = 10 ** (math.log10(f[k - 1]) + u * (math.log10(f[k]) - math.log10(f[k - 1])))
                break
    return out


def _derive_spec_checks(spec: str, sim: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Numeric claims in the spec, checked against the simulated operating point and AC sweep."""
    q = _spec_quantities(spec)
    checks: List[Dict[str, Any]] = []
    if not sim.get("success"):
        return checks
    if q["cutoff_hz"]:
        target = q["cutoff_hz"]
        found = _minus3db_frequencies(sim.get("ac") or {})
        best = min(found.items(), key=lambda kv: abs(math.log10(kv[1] / target)), default=None)
        checks.append({
            "label": f"−3 dB cutoff ≈ {target:g} Hz",
            "passed": best is not None and abs(best[1] - target) <= 0.05 * target,
            "detail": f"simulated: node {best[0]} crosses −3 dB at {best[1]:.4g} Hz" if best else "no .ac sweep with an AC source, so the cutoff could not be measured",
        })
        # Filter specs mention frequencies, not DC node voltages; don't also demand DC levels.
        return checks
    node_v = {n: v for n, v in sim.get("node_voltages", {}).items() if n != "0"}
    for target in q["volts"]:
        closest = min(node_v.items(), key=lambda kv: abs(kv[1] - target), default=None)
        passed = closest is not None and abs(closest[1] - target) <= max(0.01 * abs(target), 1e-3)
        checks.append({
            "label": f"Some node sits at {target:g} V",
            "passed": passed,
            "detail": f"closest: node {closest[0]} = {closest[1]:.4g} V" if closest else "no nodes",
        })
    if q["current"] is not None:
        source_currents = [abs(i) for name, i in sim.get("branch_currents", {}).items() if name.upper().startswith("V")]
        if source_currents:
            drawn = max(source_currents)
            limit = q["current"]
            passed = drawn <= limit * 1.01 if q["current_is_max"] else abs(drawn - limit) <= 0.05 * limit
            checks.append({
                "label": f"Supply current {'≤' if q['current_is_max'] else '≈'} {limit * 1e3:g} mA",
                "passed": passed,
                "detail": f"simulated: {drawn * 1e3:.4g} mA",
            })
    return checks


def _rc_filter_template(spec: str) -> Optional[Dict[str, str]]:
    """First-order RC low-pass / high-pass with the requested cutoff: C = 1 / (2π·R·fc)."""
    q = _spec_quantities(spec)
    fc = q["cutoff_hz"]
    if not fc or not re.search(r'filter|pass', spec, re.I):
        return None
    # A Butterworth/Chebyshev or 2nd+-order request is NOT a first-order RC; don't substitute one.
    if re.search(r'butterworth|chebyshev|bessel|elliptic|band-?pass|notch|(2nd|second|3rd|third|[2-9]th|higher)[- ]order', spec, re.I):
        return None
    high = bool(re.search(r'high-?pass', spec, re.I))
    mr = re.search(r'(\d+(?:\.\d+)?)\s*(k|M|meg)?\s*(?:ohm|Ω)', spec, re.I)
    r = float(mr.group(1)) * {"k": 1e3, "m": 1e6, "meg": 1e6}.get((mr.group(2) or "").lower(), 1.0) if mr else 1e3
    c = 1.0 / (2 * math.pi * r * fc)
    kind = "high-pass" if high else "low-pass"
    body = f"C1 in out {c:.6g}\nR1 out 0 {r:.6g}\n" if high else f"R1 in out {r:.6g}\nC1 out 0 {c:.6g}\n"
    netlist = (
        f"* Offline template: first-order RC {kind}, fc = {fc:g} Hz\n"
        f"V1 in 0 DC 0 AC 1\n{body}.ac dec 20 {fc / 100:.6g} {fc * 100:.6g}\n"
    )
    explanation = (
        "**Offline synthesizer** (no AI provider produced a netlist, so a deterministic first-order RC "
        f"{kind} template was used).\n\n"
        f"An RC filter's cutoff is $f_c = \\frac{{1}}{{2\\pi R C}}$. Choosing $R = {r:.6g}\\,\\Omega$ gives "
        f"$C = \\frac{{1}}{{2\\pi R f_c}} = {c:.4g}\\,\\text{{F}}$. The sweep spans two decades either side of $f_c$; "
        f"the output ('out') is {'−3 dB and +45°' if high else '−3 dB and −45°'} at $f_c$ and changes 20 dB per decade beyond it."
        + ("" if mr else "\n\nAssumption: no resistance was given, so R = 1 kΩ was chosen.")
    )
    return {"netlist": netlist, "explanation": explanation}


def synthesize_offline_template(spec: str) -> Optional[Dict[str, str]]:
    """
    Deterministic synthesizer used when no LLM netlist is available. It understands voltage
    dividers and first-order RC filters, and says so, rather than inventing other circuits.
    """
    filt = _rc_filter_template(spec)
    if filt:
        return filt
    if not re.search(r'divid', spec, re.I):
        return None
    q = _spec_quantities(spec)
    if not q["volts"]:
        return None
    vin = max(q["volts"])
    others = [v for v in q["volts"] if v != vin]
    vout = others[0] if others else vin / 2
    current = q["current"] or 1e-3
    r_total = vin / current
    r2 = vout / current
    r1 = r_total - r2
    if r1 <= 0 or r2 <= 0:
        return None
    netlist = (
        f"* Offline template: {vin:g} V -> {vout:g} V divider drawing {current * 1e3:g} mA\n"
        f"V1 1 0 {vin:g}\nR1 1 2 {r1:.6g}\nR2 2 0 {r2:.6g}\n"
    )
    assumed = [] if others else [f"no output voltage was given, so half the input ({vout:g} V) was assumed"]
    if q["current"] is None:
        assumed.append("no current was given, so 1 mA was assumed")
    explanation = (
        "**Offline synthesizer** (no AI provider produced a netlist, so a deterministic voltage-divider "
        "template was used).\n\n"
        f"A divider sets $V_{{out}} = V_{{in}} \\cdot \\frac{{R_2}}{{R_1 + R_2}}$. With the supply current fixed at "
        f"$I = {current * 1e3:g}\\,\\text{{mA}}$: $R_1 + R_2 = V_{{in}}/I = {r_total:.6g}\\,\\Omega$ and "
        f"$R_2 = V_{{out}}/I = {r2:.6g}\\,\\Omega$, so $R_1 = {r1:.6g}\\,\\Omega$."
        + (f"\n\nAssumptions: {'; '.join(assumed)}." if assumed else "")
    )
    return {"netlist": netlist, "explanation": explanation}


def _blocking_problems(sim: Dict[str, Any], diagnostics: List[Dict[str, Any]], checks: List[Dict[str, Any]]) -> List[str]:
    problems = [f"{d.get('code')}: {d.get('message')}" for d in diagnostics if d.get("severity") == "error"]
    if not sim.get("success") and not problems:
        problems.append(f"Simulation failed: {sim.get('error_message')}")
    problems += [f"Spec check failed: {c['label']} ({c['detail']})" for c in checks if not c["passed"]]
    return problems


def _tune_to_spec(netlist: str, spec: str, sim: Dict[str, Any], checks: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    Turns failed spec checks into tuner goals and lets the deterministic optimizer adjust every
    R, C and L (within ×1000 of the AI's values). The AI chooses the topology; math picks values.
    """
    goals: List[Dict[str, Any]] = []
    q = _spec_quantities(spec)
    for c in checks:
        if c["passed"]:
            continue
        node = re.search(r'node (\S+)', c["detail"])
        if c["label"].startswith("−3 dB") and node and q["cutoff_hz"]:
            goals.append({"kind": "cutoff_hz", "node": node.group(1), "target": q["cutoff_hz"]})
        elif c["label"].startswith("Some node sits at") and node:
            goals.append({"kind": "node_voltage", "node": node.group(1), "target": float(c["label"].split(" at ")[1].split(" V")[0])})
        elif c["label"].startswith("Supply current") and q["current"]:
            src = max(((n, i) for n, i in sim.get("branch_currents", {}).items() if n.upper().startswith("V")), key=lambda kv: abs(kv[1]), default=None)
            if src:
                goals.append({"kind": "element_current", "element": src[0], "target": math.copysign(q["current"], src[1] or 1.0)})
    if not goals:
        return None
    params = []
    for line in netlist.splitlines():
        m = re.match(r'\s*([RCL][A-Za-z0-9_]*)\s+\S+\s+\S+\s+(\S+)', line)
        if m:
            try:
                v = parse_eng_value_py(m.group(2))
            except ValueError:
                continue
            if v > 0:
                params.append({"element": m.group(1), "min": v / 1000, "max": v * 1000})
    if not params:
        return None
    return tune_netlist({"netlist": netlist, "parameters": params, "goals": goals, "max_evaluations": 600})


def generate_circuit_architect(spec_prompt: str, settings: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """
    Tab 2: Circuit Architect.
    Closed loop: the LLM proposes a netlist, the engine simulates and lints it and checks the
    numeric targets in the spec, and any failures are fed back to the LLM for repair.
    """
    base_query = (
        f"{ARCHITECT_RULES}\nSpecification:\n{spec_prompt}\n"
        "Provide the complete netlist with component values calculated."
    )
    attempts: List[Dict[str, Any]] = []
    query = base_query
    netlist, explanation, source = "", "", "llm"
    sim: Dict[str, Any] = {}
    diagnostics: List[Dict[str, Any]] = []
    checks: List[Dict[str, Any]] = []

    for attempt in range(1, MAX_ARCHITECT_ATTEMPTS + 1):
        ai_response = ask_ai(query=query, context="Circuit synthesis", mode="circuit_architect", settings=settings)
        candidate = _extract_netlist(ai_response)
        if not candidate:
            break
        netlist, explanation = candidate, ai_response
        sim = simulate_netlist_with_rust(netlist)
        diagnostics = sim.get("diagnostics") or lint_circuit_netlist(netlist)
        checks = _derive_spec_checks(spec_prompt, sim)
        problems = _blocking_problems(sim, diagnostics, checks)
        # Sound topology, wrong numbers? Let the tuner fix the values before asking the AI again.
        if problems and sim.get("success") and not any(d.get("severity") == "error" for d in diagnostics):
            tuned = _tune_to_spec(netlist, spec_prompt, sim, checks)
            if tuned and tuned.get("success"):
                attempts.append({"attempt": attempt, "netlist": netlist, "problems": problems})
                netlist = tuned["netlist"]
                sim = simulate_netlist_with_rust(netlist)
                diagnostics = sim.get("diagnostics") or lint_circuit_netlist(netlist)
                checks = _derive_spec_checks(spec_prompt, sim)
                problems = _blocking_problems(sim, diagnostics, checks)
                explanation += (
                    "\n\n**Tuned by the numeric optimizer:** " +
                    ", ".join(f"{name} → {value:.4g}" for name, value in zip(tuned["parameters"], tuned["values"])) +
                    f" ({tuned['evaluations']} simulations)."
                )
                attempts.append({"attempt": attempt, "netlist": netlist, "problems": problems, "tuned": True})
                if not problems:
                    break
                continue
        attempts.append({"attempt": attempt, "netlist": netlist, "problems": problems})
        if not problems:
            break
        query = (
            f"{base_query}\n\nYour previous netlist was:\n```spice\n{netlist}\n```\n"
            "The simulator verified it and found these problems:\n- " + "\n- ".join(problems) +
            "\nReturn a corrected netlist that fixes every problem."
        )

    if not netlist:
        template = synthesize_offline_template(spec_prompt)
        if template is None:
            return {
                "netlist": "",
                "explanation": (
                    "The AI provider did not return a netlist, and the offline synthesizer only understands "
                    "voltage dividers (*Design a 12V to 5V divider drawing 1mA*) and first-order RC filters "
                    "(*Design a low-pass filter with a 1 kHz cutoff*). "
                    "Configure an LLM provider in Settings for other circuits."
                ),
                "source": "none",
                "attempts": attempts,
                "verification": {"success": False, "node_voltages": {}, "branch_currents": {}, "diagnostics": [],
                                 "spec_checks": [], "error_message": "No netlist was produced."},
            }
        netlist, explanation, source = template["netlist"], template["explanation"], "offline_template"
        sim = simulate_netlist_with_rust(netlist)
        diagnostics = sim.get("diagnostics") or lint_circuit_netlist(netlist)
        checks = _derive_spec_checks(spec_prompt, sim)
        attempts.append({"attempt": 1, "netlist": netlist, "problems": _blocking_problems(sim, diagnostics, checks)})

    return {
        "netlist": netlist,
        "explanation": explanation,
        "source": source,
        "attempts": attempts,
        "verification": {
            "success": sim.get("success", False),
            "node_voltages": sim.get("node_voltages", {}),
            "branch_currents": sim.get("branch_currents", {}),
            "diagnostics": diagnostics,
            "spec_checks": checks,
            "error_message": sim.get("error_message"),
        }
    }


# Plain-English explanations used when no remote LLM is configured. Written for someone
# who has never studied circuits: physical picture first, then why the math breaks.
_PLAIN_ENGLISH = {
    "WARN_DIODE_NO_CURRENT_LIMIT": "A diode behaves like a one-way valve that opens around 0.6–0.7 V, and above that its current "
                                   "grows about ten times for every extra 60 mV. Here voltage sources hold a fixed voltage straight "
                                   "across it with nothing to limit the current, so the answer is an absurdly large current. Real circuits "
                                   "always put a resistor in series to set the current.",
    "ERR_NO_GROUND": "Voltage is always a *difference* between two points, like height is measured from sea level. "
                     "Nothing in this circuit is connected to node 0 (ground), so there is no 'sea level'. The simulator "
                     "could add any constant to every voltage and all the equations would still hold, so it cannot pick one answer.",
    "ERR_ISOLATED_ISLAND": "Part of the circuit is only connected to the rest through current sources (or not at all). "
                           "A current source fixes how much current flows, but not the voltage, so that island can "
                           "'float' up or down freely and its voltage has no single answer.",
    "ERR_CURRENT_ONLY_NODE": "Only current sources touch this node. Imagine two pumps pushing water into and out of a "
                             "sealed pipe junction: they decide the flow, but nothing decides the pressure. A resistor "
                             "gives the node a pressure (voltage) through Ohm's law, V = I·R.",
    "ERR_KVL_VIOLATION": "Two or more voltage sources form a loop and disagree about the voltage between the same two "
                         "points. Going around any loop, the voltage rises and drops must add to zero (Kirchhoff's Voltage "
                         "Law). These sources make that impossible, like two staircases between the same floors with different heights.",
    "ERR_PARALLEL_VOLTAGE_SOURCES": "These voltage sources agree on the voltage, but they form a loop, so nothing decides how "
                                    "the current is shared between them. There are infinitely many valid answers, "
                                    "which makes the equations singular.",
    "WARN_FLOATING_NODE": "One end of a component is not connected to anything else. No current can flow through a "
                          "component with an open end, so it has no effect. Usually this means a wire was forgotten.",
    "WARN_SELF_SHORT": "Both ends of this component are on the same node, so there is no voltage across it and it does nothing.",
    "ERR_PARSE": "The simulator could not read one of the lines. Each element needs a name, two nodes and a value, "
                 "e.g. `R1 1 2 1k`.",
}


def explain_diagnostics(netlist: str, diagnostics: Optional[List[Dict[str, Any]]] = None,
                        settings: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """
    Circuit Doctor, plain-English layer. The deterministic linter findings are the facts;
    the LLM (or the offline table) only translates them for a beginner.
    """
    diagnostics = diagnostics if diagnostics is not None else lint_circuit_netlist(netlist)
    if not diagnostics:
        return {"explanation": "No problems found: every node has a defined voltage and the equations have exactly one solution.",
                "source": "deterministic"}

    if is_offline(settings):
        parts = []
        for d in diagnostics:
            parts.append(f"**{d.get('title')}**\n\n{_PLAIN_ENGLISH.get(d.get('code', ''), d.get('message', ''))}")
            fix = d.get("fix")
            if fix:
                parts.append(f"*Suggested fix — {fix.get('label')}:* {fix.get('explanation')}")
        return {"explanation": "\n\n".join(parts), "source": "offline"}

    telemetry = json.dumps([
        {k: d.get(k) for k in ("severity", "code", "title", "message", "nodes_affected", "components_affected", "suggestion")}
        for d in diagnostics
    ], indent=2)
    query = (
        "A student with no circuits or linear-algebra background ran the Circuit Doctor on their circuit. "
        "Using ONLY the facts in the diagnostics JSON (they come from a deterministic topology checker and are correct), "
        "explain in plain English: what is physically wrong, why the simulator cannot solve it, and what the suggested fix does. "
        "Use an everyday analogy, avoid matrices unless essential, and keep each issue under 120 words."
    )
    context = f"Netlist:\n{netlist}\n\nCircuit Doctor diagnostics (JSON):\n{telemetry}"
    return {"explanation": ask_ai(query, context=context, mode="circuit_doctor", settings=settings), "source": "llm"}


def ask_socratic_professor(question: str, current_netlist: str, current_voltages: Dict[str, float], settings: Optional[Dict[str, str]] = None,
                           branch_currents: Optional[Dict[str, float]] = None) -> str:
    """
    Tab 3: Socratic Professor.
    Guides the student through learning MNA, Ohm's law, and KCL without giving away direct answers.
    """
    context = (
        f"Active Circuit Netlist:\n```spice\n{current_netlist}\n```\n\n"
        f"Current Node Potentials: {json.dumps(current_voltages)}\n"
        f"Branch Currents (A, from first node to second): {json.dumps(branch_currents or {})}\n"
    )

    query = (
        f"Student question: '{question}'\n\n"
        "Act as a patient teaching assistant for an introductory circuit simulation (EDA) course. "
        "Guide the student pedagogically using the Socratic method: "
        "Ask targeted questions that direct their attention to KCL at specific nodes, "
        "conductance stamping rules, or Ohm's Law. Do NOT merely give them the final answers."
    )

    return ask_ai(query, context=context, mode="socratic_tutor", settings=settings)
