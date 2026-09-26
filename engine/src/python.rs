//! In-process Python bindings (PyO3). The Flask service imports this module first and only
//! falls back to spawning the CLI binary, then to pure Python, if it is missing.
//! Results are JSON strings with exactly the CLI's schema, so all three paths are interchangeable.

use pyo3::prelude::*;

use crate::{lint_netlist, simulate_circuit_with, SolverKind, HAS_FAER};
use crate::optimizer::tune_json as tune_request;

/// simulate_json(netlist, solver="gaussian") -> str
/// solver: "gaussian" | "sparse_lu" | "faer"
#[pyfunction]
#[pyo3(signature = (netlist, solver = "gaussian"))]
fn simulate_json(py: Python<'_>, netlist: &str, solver: &str) -> PyResult<String> {
    let kind = SolverKind::from_name(solver);
    let owned = netlist.to_string();
    // Release the GIL: large sparse solves shouldn't block other Flask threads.
    let result = py.detach(move || simulate_circuit_with(&owned, kind));
    serde_json::to_string(&result).map_err(|e| pyo3::exceptions::PyValueError::new_err(e.to_string()))
}

/// lint_json(netlist) -> str (JSON list of Circuit Doctor diagnostics)
#[pyfunction]
fn lint_json(netlist: &str) -> PyResult<String> {
    serde_json::to_string(&lint_netlist(netlist)).map_err(|e| pyo3::exceptions::PyValueError::new_err(e.to_string()))
}

/// tune_json(request_json) -> str: runs the netlist tuner (see optimizer.rs for the schema).
#[pyfunction]
fn tune_json(py: Python<'_>, request: &str) -> String {
    let owned = request.to_string();
    py.detach(move || tune_request(&owned))
}

#[pymodule]
fn circuit_engine(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(simulate_json, m)?)?;
    m.add_function(wrap_pyfunction!(lint_json, m)?)?;
    m.add_function(wrap_pyfunction!(tune_json, m)?)?;
    m.add("HAS_FAER", HAS_FAER)?;
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
