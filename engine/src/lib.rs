pub mod models;
pub mod parser;
pub mod mna;
pub mod solvers;
pub mod linter;
pub mod dynamics;
pub mod nonlinear;
pub mod optimizer;
pub mod timing;
#[cfg(target_arch = "wasm32")]
pub mod wasm_api;
#[cfg(feature = "python")]
pub mod python;

use std::collections::HashMap;
use timing::Instant;

use models::{Analysis, ComponentType, Diagnostic, SimulationResult};
pub use parser::parse_netlist;
pub use mna::{build_mna_system, generate_kcl_equations};
pub use solvers::{solve_step_by_step_gaussian, solve_lu_sparse};
use solvers::sparse_lu::{CsrMatrix, SparseLuFactors};
pub use linter::lint_circuit;

const STORY_LIST_LIMIT: usize = 12;

pub fn generate_storybook_explanation(
    circuit: &models::Circuit,
    node_voltages: &HashMap<String, f64>,
    branch_currents: &HashMap<String, f64>,
    branch_powers: &HashMap<String, f64>,
    device_ops: &[nonlinear::DeviceOp],
) -> String {
    let mut story = Vec::new();
    story.push("### ⚡ Physical Storybook: How Electrical Charge Flows Through This Network\n".to_string());

    // 1. Overview of sources
    let sources: Vec<_> = circuit.components.iter().filter(|c| matches!(c.comp_type, ComponentType::CurrentSource { .. } | ComponentType::VoltageSource { .. })).collect();
    if sources.is_empty() {
        story.push("This is a passive unpowered resistive network. With no active energy sources, all potentials settle at Ground reference (0.0 V).".to_string());
    } else {
        story.push("**Active Energy Sources Driving Current:**".to_string());
        for s in &sources {
            match s.comp_type {
                ComponentType::CurrentSource { i_val } => {
                    story.push(format!(
                        "- **Current Pump `{}` ({:.2} A)**: Injects charge from Node {} into Node {}. It acts like a constant-flow hydraulic pump forcing {:.2} Coulombs of charge per second into the network.",
                        s.name, i_val, s.node1, s.node2, i_val
                    ));
                }
                ComponentType::VoltageSource { v_val } => {
                    story.push(format!(
                        "- **Voltage Generator `{}` ({:.2} V)**: Establishes a rigid potential difference of {:.2} V between Node {} (+) and Node {} (-), lifting electrons to higher electrical potential energy.",
                        s.name, v_val, v_val, s.node1, s.node2
                    ));
                }
                _ => {}
            }
        }
    }

    // 2. Potential Landscape
    let mut sorted_nodes: Vec<_> = node_voltages.iter().collect();
    sorted_nodes.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));

    story.push("\n**Potential Landscape (Voltage Relief):**".to_string());
    for (node, v) in sorted_nodes.iter().take(STORY_LIST_LIMIT) {
        let role = if *node == "0" {
            "Reference Datum / Ground sink (0.00 V)"
        } else if **v > 0.0 {
            "Positive electrical pressure"
        } else if **v < 0.0 {
            "Negative potential basin"
        } else {
            "Neutral potential"
        };
        story.push(format!("- **Node {}**: **{:.3} V** ({})", node, v, role));
    }
    if sorted_nodes.len() > STORY_LIST_LIMIT {
        story.push(format!("- … and {} more nodes", sorted_nodes.len() - STORY_LIST_LIMIT));
    }

    // 3. Current Pathways through Resistors
    let resistors: Vec<_> = circuit.components.iter().filter(|c| matches!(c.comp_type, ComponentType::Resistor { .. })).collect();
    if !resistors.is_empty() {
        story.push("\n**Branch Conduction & Flow Distribution:**".to_string());
        for r in resistors.iter().take(STORY_LIST_LIMIT) {
            let i = branch_currents.get(&r.name).copied().unwrap_or(0.0);
            let p = branch_powers.get(&r.name).copied().unwrap_or(0.0);
            let dir = if i.abs() < 1e-6 {
                "Equilibrium (no net current flow)".to_string()
            } else if i > 0.0 {
                format!("Flowing from Node {} ➔ Node {}", r.node1, r.node2)
            } else {
                format!("Flowing from Node {} ➔ Node {}", r.node2, r.node1)
            };
            story.push(format!(
                "- **Resistor `{}`**: Carries **{:.3} A** ({dir}), dissipating **{:.3} W** of heat.",
                r.name, i.abs(), p
            ));
        }
        if resistors.len() > STORY_LIST_LIMIT {
            story.push(format!("- … and {} more resistors", resistors.len() - STORY_LIST_LIMIT));
        }
    }

    // 3b. Energy-storage elements at the DC operating point
    let storage: Vec<_> = circuit.components.iter().filter(|c| matches!(c.comp_type, ComponentType::Capacitor { .. } | ComponentType::Inductor { .. })).collect();
    if !storage.is_empty() {
        story.push("\n**Energy Storage at Steady State (DC):**".to_string());
        for c in storage.iter().take(STORY_LIST_LIMIT) {
            let v = node_voltages.get(&c.node1).copied().unwrap_or(0.0) - node_voltages.get(&c.node2).copied().unwrap_or(0.0);
            match c.comp_type {
                ComponentType::Capacitor { c_val } => story.push(format!(
                    "- **Capacitor `{}`**: fully charged to **{:.3} V** and now blocks DC current, like a filled tank. It stores {:.3e} J (½·C·V²).",
                    c.name, v, 0.5 * c_val * v * v
                )),
                ComponentType::Inductor { l_val } => {
                    let i = branch_currents.get(&c.name).copied().unwrap_or(0.0);
                    story.push(format!(
                        "- **Inductor `{}`**: acts as a plain wire in steady DC, carrying **{:.3} A**. It stores {:.3e} J (½·L·I²) in its magnetic field.",
                        c.name, i, 0.5 * l_val * i * i
                    ));
                }
                _ => {}
            }
        }
        story.push("Add a `.tran` analysis to watch how they get there over time, or `.ac` to see how they react to different frequencies.".to_string());
    }

    // 3c. Semiconductor devices at their operating point
    if !device_ops.is_empty() {
        story.push("\n**Semiconductor Devices (found by Newton–Raphson):**".to_string());
        for op in device_ops.iter().take(STORY_LIST_LIMIT) {
            let q = |k: &str| op.quantities.iter().find(|(n, _)| n == k).map(|(_, v)| *v).unwrap_or(0.0);
            story.push(match op.kind.as_str() {
                "diode" => format!(
                    "- **Diode `{}`** is {}: {:.3} V across it, {:.4} mA through it. A diode is a one-way valve: almost no current until about 0.6–0.7 V, then the current rises steeply.",
                    op.name, op.region, q("Vd"), q("Id") * 1e3
                ),
                "npn" | "pnp" => format!(
                    "- **Transistor `{}`** ({}) is in **{}**: a base current of {:.4} mA controls a collector current of {:.4} mA (current gain β ≈ {:.0}).",
                    op.name, op.kind.to_uppercase(), op.region, q("Ib") * 1e3, q("Ic") * 1e3, q("beta")
                ),
                _ => format!(
                    "- **MOSFET `{}`** ({}) is in **{}**: the gate is {:.3} V above the source (threshold overdrive {:.3} V), letting {:.4} mA flow drain to source. The gate itself draws no current.",
                    op.name, op.kind.to_uppercase(), op.region, q("Vgs"), q("Vov"), q("Id") * 1e3
                ),
            });
        }
    }

    // 4. Energy Conservation Check
    let mut total_dissipated = 0.0;
    let mut total_supplied = 0.0;
    for (_name, p) in branch_powers {
        if *p > 0.0 {
            total_dissipated += *p;
        } else {
            total_supplied += -*p;
        }
    }

    story.push("\n**Tellegen's Theorem / Energy Conservation:**".to_string());
    story.push(format!(
        "Total active power supplied: **{:.3} W** | Total power dissipated: **{:.3} W** (Balance difference: {:.2e} W).",
        total_supplied, total_dissipated, (total_supplied - total_dissipated).abs()
    ));

    story.join("\n")
}

fn empty_spy_plot() -> models::SpyPlotData {
    models::SpyPlotData { dimension: 0, non_zeros: 0, sparsity_percentage: 0.0, entries: Vec::new(), dynamic_entries: Vec::new() }
}

fn failed_result(solver_used: &str, error: String, diagnostics: Vec<Diagnostic>, start_time: Instant) -> SimulationResult {
    SimulationResult {
        success: false,
        error_message: Some(error),
        solver_used: solver_used.to_string(),
        num_equations: 0,
        variable_names: Vec::new(),
        solution_vector: Vec::new(),
        node_voltages: HashMap::new(),
        branch_currents: HashMap::new(),
        branch_powers: HashMap::new(),
        matrix_g: Vec::new(),
        vector_b: Vec::new(),
        stamping_timeline: Vec::new(),
        gaussian_steps: Vec::new(),
        kcl_equations: Vec::new(),
        spy_plot: empty_spy_plot(),
        diagnostics,
        storybook_explanation: String::new(),
        execution_time_us: start_time.elapsed().as_micros() as u64,
        solver_note: None,
        residual_max_abs: None,
        lu_fill_in: None,
        educational_views: false,
        matrix_c: Vec::new(),
        ac: None,
        transient: None,
        analysis_errors: Vec::new(),
        newton: None,
        device_ops: Vec::new(),
        dc_sweep: None,
    }
}

/// Which linear solver to run on the assembled MNA system.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolverKind {
    /// Hand-written dense elimination that logs every row operation (teaching).
    Gaussian,
    /// Hand-written CSR sparse LU with threshold pivoting (shows fill-in).
    SparseLu,
    /// Production sparse LU from the faer crate (native and Python builds only).
    Faer,
}

impl SolverKind {
    /// Accepts the names used by the CLI, the HTTP API and the Python/Wasm bindings.
    pub fn from_name(name: &str) -> SolverKind {
        match name.to_ascii_lowercase().replace('-', "_").as_str() {
            "sparse_lu" | "sparselu" | "lu" => SolverKind::SparseLu,
            "faer" | "industrial" => SolverKind::Faer,
            _ => SolverKind::Gaussian,
        }
    }

    fn label(self) -> &'static str {
        match self {
            SolverKind::Gaussian => "GaussianElimination",
            SolverKind::SparseLu => "SparseLU",
            SolverKind::Faer => "FaerSparseLU",
        }
    }
}

const SPICE_HINT: &str = "SPICE element lines look like 'R1 1 2 1k': a name (its first letter is the part type), two node names and a value.";

/// True when this build includes the faer solver.
pub const HAS_FAER: bool = cfg!(feature = "industrial");

/// Doctor diagnostics for a netlist, including a parse error as an ERR_PARSE diagnostic.
pub fn lint_netlist(netlist: &str) -> Vec<Diagnostic> {
    match parse_netlist(netlist) {
        Ok(circuit) => lint_circuit(&circuit),
        Err(e) => vec![Diagnostic {
            severity: "error".to_string(),
            code: "ERR_PARSE".to_string(),
            title: "Netlist Syntax Error".to_string(),
            message: e,
            nodes_affected: vec![],
            components_affected: vec![],
            suggestion: SPICE_HINT.to_string(),
            fix: None,
        }],
    }
}

pub fn simulate_circuit(netlist: &str, use_sparse_lu: bool) -> SimulationResult {
    simulate_circuit_with(netlist, if use_sparse_lu { SolverKind::SparseLu } else { SolverKind::Gaussian })
}

pub fn simulate_circuit_with(netlist: &str, solver: SolverKind) -> SimulationResult {
    let start_time = Instant::now();
    let requested_solver = solver.label();

    // 1. Parse netlist
    let circuit = match parse_netlist(netlist) {
        Ok(c) => c,
        Err(err) => {
            let diag = Diagnostic {
                severity: "error".to_string(),
                code: "ERR_PARSE".to_string(),
                title: "Netlist Syntax Error".to_string(),
                message: err.clone(),
                nodes_affected: Vec::new(),
                components_affected: Vec::new(),
                suggestion: SPICE_HINT.to_string(),
                fix: None,
            };
            return failed_result(requested_solver, err, vec![diag], start_time);
        }
    };
    simulate_parsed(circuit, solver, start_time)
}

/// Simulates an already-parsed circuit (used by the tuner, which edits values between runs).
pub fn simulate_parsed(circuit: models::Circuit, solver: SolverKind, start_time: Instant) -> SimulationResult {
    // 2. Lint circuit
    let diagnostics = lint_circuit(&circuit);

    // 3. Assemble MNA system
    let mna = build_mna_system(&circuit);

    // 4. Solve system. Step-by-step logging is only meaningful (and affordable) for small systems.
    let mut solver_note = None;
    let mut solver = solver;
    if solver == SolverKind::Gaussian && !mna.educational {
        solver = SolverKind::SparseLu;
        solver_note = Some(format!(
            "This circuit has {} unknowns, more than the {} the step-by-step Gaussian log can display, so the sparse LU solver was used instead.",
            mna.dimension, mna::EDUCATIONAL_DIM_LIMIT
        ));
    }
    if solver == SolverKind::Faer && !HAS_FAER {
        solver = SolverKind::SparseLu;
        solver_note = Some("This build (e.g. the in-browser WebAssembly engine) does not include the faer solver, so the hand-written sparse LU was used.".to_string());
    }
    let has_devices = circuit.components.iter().any(|c| c.comp_type.is_nonlinear());
    let solver_used = if has_devices { "NewtonRaphson" } else { solver.label() };

    let mut gaussian_steps = Vec::new();
    let mut lu_fill_in = None;
    let mut newton = None;
    // What the matrix views show: G·x = b, or for nonlinear circuits the final linearized J·x = rhs.
    let mut display_g = mna.matrix_g.clone();
    let mut display_b = mna.vector_b.clone();
    let mut timeline = mna.stamping_timeline.clone();

    let solve_outcome = if has_devices {
        nonlinear::solve_nonlinear(&circuit, &mna.matrix, &mna.vector_b, None, mna.educational).map(|(x, log)| {
            let (entries, rhs, per_device) = nonlinear::linearized_system(&circuit, &mna.matrix, &mna.vector_b, &x);
            let jac = CsrMatrix::from_sorted_triplets(mna.dimension, entries.into_iter());
            if mna.educational {
                append_device_stamps(&circuit, &per_device, &mut display_g, &mut display_b, &mut timeline, &mna.matrix_c);
                display_g = jac.to_dense();
                display_b = rhs.clone();
                if solver == SolverKind::Gaussian {
                    if let Ok((_, steps)) = solve_step_by_step_gaussian(&display_g, &display_b, &circuit.variable_names) {
                        gaussian_steps = steps;
                    }
                }
            }
            if solver == SolverKind::SparseLu {
                lu_fill_in = SparseLuFactors::factor(&jac).ok().map(|f| f.fill_in);
            }
            solver_note = Some(format!(
                "Diodes and transistors are nonlinear, so the operating point was found by Newton–Raphson ({} iteration{}{}). The matrix shown is the final linearized system J·x = rhs.",
                log.iterations.len().max(1),
                if log.iterations.len() == 1 { "" } else { "s" },
                if log.strategy == "newton" { String::new() } else { format!(", after {} to get started", log.strategy) }
            ));
            newton = Some(log);
            x
        })
    } else {
        match solver {
            SolverKind::SparseLu => solve_lu_sparse(&mna.matrix, &mna.vector_b).map(|res| {
                lu_fill_in = Some(res.fill_in);
                res.solution
            }),
            #[cfg(feature = "industrial")]
            SolverKind::Faer => solvers::faer_lu::solve_faer_lu(&mna.matrix, &mna.vector_b),
            #[cfg(not(feature = "industrial"))]
            SolverKind::Faer => unreachable!("downgraded above"),
            SolverKind::Gaussian => solve_step_by_step_gaussian(&mna.matrix_g, &mna.vector_b, &circuit.variable_names).map(|(sol, steps)| {
                gaussian_steps = steps;
                sol
            }),
        }
    };

    let solution_vector = match solve_outcome {
        Ok(sol) => sol,
        Err(err) => {
            // Point the student at the topological cause the Doctor already found.
            let err = match diagnostics.iter().find(|d| d.severity == "error") {
                Some(d) => format!("{} Likely cause: {}.", err, d.title),
                None => err,
            };
            let mut res = failed_result(solver_used, err, diagnostics, start_time);
            res.num_equations = mna.dimension;
            res.variable_names = circuit.variable_names;
            res.matrix_g = mna.matrix_g;
            res.vector_b = mna.vector_b;
            res.stamping_timeline = mna.stamping_timeline;
            res.spy_plot = mna.spy_plot;
            res.solver_note = solver_note;
            res.educational_views = mna.educational;
            res.matrix_c = mna.matrix_c;
            return res;
        }
    };

    // Independent verification: how well does x satisfy the circuit equations (with devices, the
    // true nonlinear KCL, not just the last linearization)?
    let residual_max_abs = if has_devices {
        nonlinear::nonlinear_residual(&circuit, &mna.matrix, &mna.vector_b, &solution_vector)
    } else {
        mna.matrix
            .matvec(&solution_vector)
            .iter()
            .zip(&mna.vector_b)
            .map(|(ax, b)| (ax - b).abs())
            .fold(0.0, f64::max)
    };

    // 5. Extract node voltages
    let mut node_voltages = HashMap::new();
    node_voltages.insert("0".to_string(), 0.0);
    for (i, name) in circuit.node_names.iter().enumerate() {
        if name == "0" {
            continue;
        }
        let sol_idx = i - 1;
        if sol_idx < solution_vector.len() {
            node_voltages.insert(name.clone(), solution_vector[sol_idx]);
        }
    }

    // 6. Branch currents and powers (DC: capacitors carry no current, inductors are wires;
    //    devices report their main current: anode, collector or drain)
    let device_ops = if has_devices { nonlinear::device_ops_at(&circuit, &solution_vector) } else { Vec::new() };
    let branch_currents = nonlinear::element_currents_at(&circuit, &solution_vector, &device_ops);
    let mut branch_powers = HashMap::new();
    for comp in &circuit.components {
        let v = |n: &str| *node_voltages.get(n).unwrap_or(&0.0);
        let power = match device_ops.iter().find(|o| o.name == comp.name) {
            Some(op) => op.terminals.iter().map(|t| v(&t.node) * t.current).sum(),
            None => (v(&comp.node1) - v(&comp.node2)) * branch_currents[&comp.name],
        };
        branch_powers.insert(comp.name.clone(), power);
    }

    // 7. Generate KCL equations (symbolic strings are only useful at teaching scale)
    let kcl_equations = if mna.educational {
        generate_kcl_equations(&circuit, &node_voltages, &branch_currents, &device_ops)
    } else {
        Vec::new()
    };

    // 8. Further analyses requested by .ac / .tran / .dc control cards
    let mut ac = None;
    let mut transient = None;
    let mut dc_sweep = None;
    let mut analysis_errors = Vec::new();
    for analysis in &circuit.analyses {
        match analysis {
            Analysis::Ac { sweep, points, fstart, fstop } => {
                let freqs = dynamics::ac_frequencies(*sweep, *points, *fstart, *fstop);
                // Devices enter AC as their small-signal model at the operating point.
                let g_ac = if has_devices { nonlinear::small_signal_matrix(&circuit, &mna.matrix, &solution_vector) } else { mna.matrix.clone() };
                match dynamics::ac_analysis(&circuit, &mna, &g_ac, *sweep, &freqs) {
                    Ok(r) => ac = Some(r),
                    Err(e) => analysis_errors.push(e),
                }
            }
            Analysis::Tran { tstep, tstop, tstart, tmax } => {
                let settings = dynamics::TransientSettings { tstep: *tstep, tstop: *tstop, tstart: *tstart, tmax: *tmax, method: circuit.method };
                match dynamics::transient_analysis(&circuit, &mna, &settings) {
                    Ok(r) => transient = Some(r),
                    Err(e) => analysis_errors.push(e),
                }
            }
            Analysis::Dc { source, start, stop, step } => match nonlinear::dc_sweep(&circuit, &mna.matrix, source, *start, *stop, *step) {
                Ok(r) => dc_sweep = Some(r),
                Err(e) => analysis_errors.push(e),
            },
        }
    }

    // 9. Generate physical storybook explanation
    let storybook_explanation = generate_storybook_explanation(&circuit, &node_voltages, &branch_currents, &branch_powers, &device_ops);

    SimulationResult {
        success: true,
        error_message: None,
        solver_used: solver_used.to_string(),
        num_equations: mna.dimension,
        variable_names: circuit.variable_names,
        solution_vector,
        node_voltages,
        branch_currents,
        branch_powers,
        matrix_g: display_g,
        vector_b: display_b,
        stamping_timeline: timeline,
        gaussian_steps,
        kcl_equations,
        spy_plot: mna.spy_plot,
        diagnostics,
        storybook_explanation,
        execution_time_us: start_time.elapsed().as_micros() as u64,
        solver_note,
        residual_max_abs: Some(residual_max_abs),
        lu_fill_in,
        educational_views: mna.educational,
        matrix_c: mna.matrix_c,
        ac,
        transient,
        analysis_errors,
        newton,
        device_ops,
        dc_sweep,
    }
}

/// Adds one stamping-timeline step per device: its final Newton linearization (small-signal
/// conductances into G, companion current into b), so the playhead shows where J comes from.
fn append_device_stamps(
    circuit: &models::Circuit,
    per_device: &[(usize, Vec<nonlinear::Branch>, nonlinear::DeviceOp)],
    g: &mut [Vec<f64>],
    b: &mut [f64],
    timeline: &mut Vec<models::StampingStep>,
    matrix_c: &[Vec<f64>],
) {
    use models::StampingCell;
    for (d, branches, op) in per_device {
        let comp = &circuit.components[*d];
        let mut cells_g: Vec<StampingCell> = Vec::new();
        let mut cells_b: Vec<StampingCell> = Vec::new();
        for br in branches {
            let mut add_g = |r: usize, c: usize, v: f64| {
                if r > 0 && c > 0 && v != 0.0 {
                    g[r - 1][c - 1] += v;
                    cells_g.push(StampingCell { row: r - 1, col: c - 1, delta: v, new_value: g[r - 1][c - 1] });
                }
            };
            for &(cp, cn, gv) in &br.ctrls {
                add_g(br.p, cp, gv);
                add_g(br.p, cn, -gv);
                add_g(br.q, cp, -gv);
                add_g(br.q, cn, gv);
            }
            for (n, sign) in [(br.p, -1.0), (br.q, 1.0)] {
                if n > 0 && br.i0 != 0.0 {
                    b[n - 1] += sign * br.i0;
                    cells_b.push(StampingCell { row: n - 1, col: 0, delta: sign * br.i0, new_value: b[n - 1] });
                }
            }
        }
        let q = |k: &str| op.quantities.iter().find(|(n, _)| n == k).map(|(_, v)| *v).unwrap_or(0.0);
        let explanation = match op.kind.as_str() {
            "diode" => format!(
                "Newton–Raphson replaces the exponential diode with its tangent line at Vd = {:.4} V: a conductance g = dI/dV = {} S (like a {} Ω resistor) in G, plus a companion current Id − g·Vd = {} A in b. Where the tangent and the curve agree, the iteration has converged.",
                q("Vd"), mna::fmt_num(q("g")), mna::fmt_num(1.0 / q("g")), mna::fmt_num(q("Id") - q("g") * q("Vd"))
            ),
            "npn" | "pnp" => format!(
                "Transistor linearized at Vbe = {:.4} V, Vce = {:.4} V ({}): base–emitter conductance 1/rπ = {} S, transconductance gm = {} S (collector current controlled by Vbe), plus companion currents in b.",
                q("Vbe"), q("Vce"), op.region, mna::fmt_num(1.0 / q("rpi")), mna::fmt_num(q("gm"))
            ),
            _ => format!(
                "MOSFET linearized at Vgs = {:.4} V, Vds = {:.4} V ({}): transconductance gm = {} S from the gate voltage and output conductance gds = {} S, plus a companion current in b. The gate row gets nothing: no current flows into a gate.",
                q("Vgs"), q("Vds"), op.region, mna::fmt_num(q("gm")), mna::fmt_num(q("gds"))
            ),
        };
        timeline.push(models::StampingStep {
            step_index: timeline.len() + 1,
            component_name: comp.name.clone(),
            component_summary: format!("{} {} linearized at the operating point ({})", op.kind.to_uppercase(), comp.name, op.region),
            affected_cells_g: cells_g,
            affected_cells_b: cells_b,
            matrix_g_snapshot: g.to_vec(),
            vector_b_snapshot: b.to_vec(),
            explanation,
            affected_cells_c: vec![],
            matrix_c_snapshot: matrix_c.to_vec(),
        });
    }
}
