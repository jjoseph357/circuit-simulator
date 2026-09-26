use std::collections::{BTreeMap, HashMap};

use crate::models::{
    Circuit, Component, ComponentType, KclEquation, SpyPlotData, SpyPlotEntry, StampingCell,
    StampingStep,
};
use crate::linter::dc_floating_nodes;
use crate::solvers::sparse_lu::CsrMatrix;

/// Systems up to this many unknowns get dense matrix snapshots, per-stamp logs and
/// step-by-step Gaussian elimination. Beyond it only the sparse path is used: dense
/// snapshots cost O(components * N^2) memory, which is exactly what sparse storage avoids.
pub const EDUCATIONAL_DIM_LIMIT: usize = 40;

/// Spy-plot entries are only serialized up to this dimension to keep responses small.
pub const SPY_PLOT_DIM_LIMIT: usize = 2000;

pub struct MnaSystem {
    pub dimension: usize,
    /// Static matrix G (conductances, ±1 incidence of branch currents, GMIN). Always assembled.
    pub matrix: CsrMatrix,
    /// Dynamic matrix C in G·x + C·dx/dt = b (capacitances; −L on inductor rows).
    pub c_matrix: CsrMatrix,
    /// Dense copies for display; empty when `dimension > EDUCATIONAL_DIM_LIMIT`.
    pub matrix_g: Vec<Vec<f64>>,
    pub matrix_c: Vec<Vec<f64>>,
    /// Right-hand side for the DC operating point.
    pub vector_b: Vec<f64>,
    pub stamping_timeline: Vec<StampingStep>,
    pub spy_plot: SpyPlotData,
    pub educational: bool,
}

/// GMIN conductance SPICE adds to nodes with no DC path to ground.
pub const GMIN: f64 = 1e-12;

/// Accumulates stamps sparsely and, for small systems, mirrors them into a dense matrix
/// so each stamping step can be snapshotted for the playhead animation.
struct StampAccumulator {
    entries: BTreeMap<(usize, usize), f64>,
    dense: Option<Vec<Vec<f64>>>,
}

impl StampAccumulator {
    fn new(dim: usize, educational: bool) -> Self {
        StampAccumulator { entries: BTreeMap::new(), dense: if educational { Some(vec![vec![0.0; dim]; dim]) } else { None } }
    }

    fn add(&mut self, row: usize, col: usize, delta: f64) -> f64 {
        let entry = self.entries.entry((row, col)).or_insert(0.0);
        *entry += delta;
        let value = *entry;
        if let Some(d) = self.dense.as_mut() {
            d[row][col] = value;
        }
        value
    }

    /// Two-terminal "admittance-like" stamp (+y on diagonals, −y off-diagonal), shared by
    /// resistors in G and capacitors in C.
    fn stamp_two_terminal(&mut self, n1: usize, n2: usize, y: f64, cells: &mut Vec<StampingCell>) {
        if n1 > 0 {
            let r = n1 - 1;
            let nv = self.add(r, r, y);
            cells.push(StampingCell { row: r, col: r, delta: y, new_value: nv });
        }
        if n2 > 0 {
            let r = n2 - 1;
            let nv = self.add(r, r, y);
            cells.push(StampingCell { row: r, col: r, delta: y, new_value: nv });
        }
        if n1 > 0 && n2 > 0 {
            let (r1, r2) = (n1 - 1, n2 - 1);
            let nv12 = self.add(r1, r2, -y);
            let nv21 = self.add(r2, r1, -y);
            cells.push(StampingCell { row: r1, col: r2, delta: -y, new_value: nv12 });
            cells.push(StampingCell { row: r2, col: r1, delta: -y, new_value: nv21 });
        }
    }

    /// Branch-current incidence: +1/−1 linking node rows/cols to the element's current unknown.
    fn stamp_incidence(&mut self, n1: usize, n2: usize, aux: usize, cells: &mut Vec<StampingCell>) {
        for (n, sign) in [(n1, 1.0), (n2, -1.0)] {
            if n > 0 {
                let r = n - 1;
                let nv_a = self.add(r, aux, sign);
                let nv_b = self.add(aux, r, sign);
                cells.push(StampingCell { row: r, col: aux, delta: sign, new_value: nv_a });
                cells.push(StampingCell { row: aux, col: r, delta: sign, new_value: nv_b });
            }
        }
    }
}

/// Right-hand side b for the DC operating point (`t = None`) or at time t (transient).
pub fn source_rhs(circuit: &Circuit, t: Option<f64>) -> Vec<f64> {
    let mut b = vec![0.0; circuit.num_nodes + circuit.num_aux];
    for comp in &circuit.components {
        let value_at = |dc: f64| match (t, comp.source.as_ref().and_then(|s| s.waveform.as_ref())) {
            (Some(t), Some(w)) => w.value_at(t),
            _ => dc,
        };
        match comp.comp_type {
            ComponentType::CurrentSource { i_val } => {
                let i = value_at(i_val);
                let n1 = circuit.node_to_idx[&comp.node1];
                let n2 = circuit.node_to_idx[&comp.node2];
                if n1 > 0 { b[n1 - 1] -= i; }
                if n2 > 0 { b[n2 - 1] += i; }
            }
            ComponentType::VoltageSource { v_val } => b[circuit.aux_index[&comp.name]] = value_at(v_val),
            _ => {}
        }
    }
    b
}

/// AC excitation phasors (real, imaginary) from each source's AC magnitude and phase.
pub fn ac_rhs(circuit: &Circuit) -> (Vec<f64>, Vec<f64>) {
    let dim = circuit.num_nodes + circuit.num_aux;
    let (mut re, mut im) = (vec![0.0; dim], vec![0.0; dim]);
    for comp in &circuit.components {
        let Some(spec) = comp.source.as_ref() else { continue };
        if spec.ac_mag == 0.0 {
            continue;
        }
        let (pr, pi) = (spec.ac_mag * spec.ac_phase_deg.to_radians().cos(), spec.ac_mag * spec.ac_phase_deg.to_radians().sin());
        match comp.comp_type {
            ComponentType::CurrentSource { .. } => {
                let n1 = circuit.node_to_idx[&comp.node1];
                let n2 = circuit.node_to_idx[&comp.node2];
                if n1 > 0 { re[n1 - 1] -= pr; im[n1 - 1] -= pi; }
                if n2 > 0 { re[n2 - 1] += pr; im[n2 - 1] += pi; }
            }
            ComponentType::VoltageSource { .. } => {
                let a = circuit.aux_index[&comp.name];
                re[a] = pr;
                im[a] = pi;
            }
            _ => {}
        }
    }
    (re, im)
}

pub fn build_mna_system(circuit: &Circuit) -> MnaSystem {
    let dim = circuit.num_nodes + circuit.num_aux;
    let educational = dim <= EDUCATIONAL_DIM_LIMIT;
    let mut g = StampAccumulator::new(dim, educational);
    let mut cm = StampAccumulator::new(dim, educational);
    let b = source_rhs(circuit, None);
    let mut b_running = vec![0.0; dim]; // b as it builds up, for the stamping animation
    let mut timeline = Vec::new();

    for (step_idx, comp) in circuit.components.iter().enumerate() {
        // Nonlinear devices have no fixed stamp: they are linearized at every Newton iteration
        // (see nonlinear.rs), and their final stamps are appended to the timeline afterwards.
        if comp.comp_type.is_nonlinear() {
            continue;
        }
        let n1_idx = *circuit.node_to_idx.get(&comp.node1).unwrap_or(&0);
        let n2_idx = *circuit.node_to_idx.get(&comp.node2).unwrap_or(&0);

        let mut affected_g = Vec::new();
        let mut affected_c = Vec::new();
        let mut affected_b = Vec::new();
        let summary: String;
        let explanation: String;

        match comp.comp_type {
            ComponentType::Resistor { r_val } => {
                let cond = 1.0 / r_val;
                summary = format!("Resistor {} ({} Ω) between {} and {}", comp.name, fmt_num(r_val), comp.node1, comp.node2);
                g.stamp_two_terminal(n1_idx, n2_idx, cond, &mut affected_g);
                explanation = format!(
                    "Ohm's Law conductance stamp: +1/R = {} S on the diagonal of each non-ground node{}",
                    fmt_num(cond),
                    if n1_idx > 0 && n2_idx > 0 { format!(", −{} S at G({},{}) and G({},{})", fmt_num(cond), comp.node1, comp.node2, comp.node2, comp.node1) } else { String::new() }
                );
            }
            ComponentType::Capacitor { c_val } => {
                summary = format!("Capacitor {} ({} F) between {} and {}", comp.name, fmt_num(c_val), comp.node1, comp.node2);
                cm.stamp_two_terminal(n1_idx, n2_idx, c_val, &mut affected_c);
                explanation = format!(
                    "Capacitor stamp into the dynamic matrix C (current = C·dV/dt): +{} F on the diagonals{}. Nothing goes into G: in DC a capacitor is an open circuit.",
                    fmt_num(c_val),
                    if n1_idx > 0 && n2_idx > 0 { format!(", −{} F off-diagonal", fmt_num(c_val)) } else { String::new() }
                );
            }
            ComponentType::Inductor { l_val } => {
                let aux = circuit.aux_index[&comp.name];
                summary = format!("Inductor {} ({} H) between {} and {}", comp.name, fmt_num(l_val), comp.node1, comp.node2);
                g.stamp_incidence(n1_idx, n2_idx, aux, &mut affected_g);
                let nv = cm.add(aux, aux, -l_val);
                affected_c.push(StampingCell { row: aux, col: aux, delta: -l_val, new_value: nv });
                explanation = format!(
                    "Inductor stamp: its current I({}) becomes an unknown (row/column {}), ±1 link it to its nodes in G, and −L = −{} H goes in C, giving V({}) − V({}) − L·dI/dt = 0. In DC this reads V({}) = V({}): a wire.",
                    comp.name, aux + 1, fmt_num(l_val), comp.node1, comp.node2, comp.node1, comp.node2
                );
            }
            ComponentType::CurrentSource { i_val } => {
                summary = format!("Current Source {} ({} A) from {} to {}", comp.name, fmt_num(i_val), comp.node1, comp.node2);
                let mut expl_parts = Vec::new();
                if n1_idx > 0 {
                    let r = n1_idx - 1;
                    b_running[r] -= i_val;
                    affected_b.push(StampingCell { row: r, col: 0, delta: -i_val, new_value: b_running[r] });
                    expl_parts.push(format!("Current leaving Node {} stamps -{} A into b({})", comp.node1, fmt_num(i_val), comp.node1));
                }
                if n2_idx > 0 {
                    let r = n2_idx - 1;
                    b_running[r] += i_val;
                    affected_b.push(StampingCell { row: r, col: 0, delta: i_val, new_value: b_running[r] });
                    expl_parts.push(format!("Current entering Node {} stamps +{} A into b({})", comp.node2, fmt_num(i_val), comp.node2));
                }
                explanation = format!("KCL current source stamp: {}", expl_parts.join("; "));
            }
            ComponentType::Diode { .. } | ComponentType::Bjt { .. } | ComponentType::Mosfet { .. } => unreachable!("skipped above"),
            ComponentType::VoltageSource { v_val } => {
                let aux_row = circuit.aux_index[&comp.name];
                summary = format!("Voltage Source {} ({} V) between {} (+) and {} (-)", comp.name, fmt_num(v_val), comp.node1, comp.node2);
                g.stamp_incidence(n1_idx, n2_idx, aux_row, &mut affected_g);
                b_running[aux_row] = v_val;
                affected_b.push(StampingCell { row: aux_row, col: 0, delta: v_val, new_value: v_val });
                explanation = format!(
                    "MNA auxiliary stamp (a voltage source adds one unknown current and one constraint row): ±1 in G link I({}) to its nodes; constraint V({}) − V({}) = {} V in row {}",
                    comp.name, comp.node1, comp.node2, fmt_num(v_val), aux_row + 1
                );
            }
        }

        if educational {
            timeline.push(StampingStep {
                step_index: step_idx + 1,
                component_name: comp.name.clone(),
                component_summary: summary,
                affected_cells_g: affected_g,
                affected_cells_b: affected_b,
                matrix_g_snapshot: g.dense.clone().unwrap_or_default(),
                vector_b_snapshot: b_running.clone(),
                explanation,
                affected_cells_c: affected_c,
                matrix_c_snapshot: cm.dense.clone().unwrap_or_default(),
            });
        }
    }

    // GMIN leaks for nodes that reach ground only through capacitors (see the Doctor warning).
    for node in dc_floating_nodes(circuit) {
        let r = circuit.node_to_idx[&node] - 1;
        let nv = g.add(r, r, GMIN);
        if educational {
            timeline.push(StampingStep {
                step_index: timeline.len() + 1,
                component_name: format!("GMIN_{}", node),
                component_summary: format!("GMIN leak ({} S) from node {} to ground", fmt_num(GMIN), node),
                affected_cells_g: vec![StampingCell { row: r, col: r, delta: GMIN, new_value: nv }],
                affected_cells_b: vec![],
                matrix_g_snapshot: g.dense.clone().unwrap_or_default(),
                vector_b_snapshot: b_running.clone(),
                explanation: format!("Node {} only connects to ground through capacitors, which are open in DC. Like SPICE, the simulator adds a tiny conductance so the DC equations have one solution.", node),
                affected_cells_c: vec![],
                matrix_c_snapshot: cm.dense.clone().unwrap_or_default(),
            });
        }
    }

    // Spy plot: G pattern, plus C pattern as dynamic entries
    let non_zeros = g.entries.values().filter(|v| **v != 0.0).count();
    let describe = |r: usize, c: usize, val: f64, what: &str| -> String {
        if educational { format!("{}({},{}) = {}", what, circuit.variable_names[r], circuit.variable_names[c], fmt_num(val)) } else { String::new() }
    };
    let mut entries = Vec::new();
    let mut dynamic_entries = Vec::new();
    if dim <= SPY_PLOT_DIM_LIMIT {
        for (&(r, c), &val) in &g.entries {
            if val == 0.0 {
                continue;
            }
            let is_conductance = r < circuit.num_nodes && c < circuit.num_nodes;
            entries.push(SpyPlotEntry {
                row: r,
                col: c,
                value: val,
                entry_type: if is_conductance { "conductance".to_string() } else { "voltage_incidence".to_string() },
                description: describe(r, c, val, if is_conductance { "G" } else { "Incidence" }),
            });
        }
        for (&(r, c), &val) in &cm.entries {
            if val == 0.0 {
                continue;
            }
            let is_cap = r < circuit.num_nodes;
            dynamic_entries.push(SpyPlotEntry {
                row: r,
                col: c,
                value: val,
                entry_type: if is_cap { "capacitance".to_string() } else { "inductance".to_string() },
                description: describe(r, c, val, "C"),
            });
        }
    }

    let total_cells = if dim > 0 { (dim as f64) * (dim as f64) } else { 1.0 };
    let sparsity_pct = 100.0 * (1.0 - (non_zeros as f64 / total_cells));

    let spy_plot = SpyPlotData {
        dimension: dim,
        non_zeros,
        sparsity_percentage: (sparsity_pct * 10.0).round() / 10.0,
        entries,
        dynamic_entries,
    };

    let has_dynamic = !cm.entries.is_empty();
    MnaSystem {
        dimension: dim,
        matrix: CsrMatrix::from_sorted_triplets(dim, g.entries.into_iter()),
        c_matrix: CsrMatrix::from_sorted_triplets(dim, cm.entries.into_iter()),
        matrix_g: g.dense.unwrap_or_default(),
        matrix_c: if has_dynamic { cm.dense.unwrap_or_default() } else { Vec::new() },
        vector_b: b,
        stamping_timeline: timeline,
        spy_plot,
        educational,
    }
}

/// Compact human-readable number: 5 -> "5", 0.25 -> "0.25", 1e-9 -> "1e-9", 1/3 -> "0.3333".
pub fn fmt_num(v: f64) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    let a = v.abs();
    if !(1e-3..1e6).contains(&a) {
        let s = format!("{:.4e}", v);
        if let Some((mant, exp)) = s.split_once('e') {
            let mant = mant.trim_end_matches('0').trim_end_matches('.');
            return format!("{}e{}", mant, exp);
        }
        return s;
    }
    let s = format!("{:.4}", v);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

pub fn generate_kcl_equations(
    circuit: &Circuit,
    _node_voltages: &std::collections::HashMap<String, f64>,
    branch_currents: &std::collections::HashMap<String, f64>,
    device_ops: &[crate::nonlinear::DeviceOp],
) -> Vec<KclEquation> {
    let mut equations = Vec::new();

    // Node -> incident components, so the whole pass is O(components) rather than O(N * components).
    let mut incident: HashMap<&str, Vec<&Component>> = HashMap::new();
    for comp in &circuit.components {
        if comp.comp_type.is_nonlinear() {
            continue; // added from their terminal currents below
        }
        incident.entry(comp.node1.as_str()).or_default().push(comp);
        if comp.node2 != comp.node1 {
            incident.entry(comp.node2.as_str()).or_default().push(comp);
        }
    }

    for (idx, node_name) in circuit.node_names.iter().enumerate() {
        if node_name == "0" {
            continue; // Skip ground reference
        }

        let mut terms: Vec<(bool, String, String)> = Vec::new();
        let mut total_leaving = 0.0;

        for comp in incident.get(node_name.as_str()).map(|v| v.as_slice()).unwrap_or(&[]) {
            let current = *branch_currents.get(&comp.name).unwrap_or(&0.0);
            match comp.comp_type {
                ComponentType::Resistor { r_val } => {
                    if comp.node1 == *node_name {
                        // Current leaving node1 through R to node2
                        terms.push((
                            true,
                            format!("(V({}) - V({})) / {}", comp.node1, comp.node2, fmt_num(r_val)),
                            format!("\\frac{{V_{{{}}} - V_{{{}}}}}{{{}}}", comp.node1, comp.node2, fmt_num(r_val))
                        ));
                        total_leaving += current;
                    } else if comp.node2 == *node_name {
                        // Current leaving node2 through R to node1
                        terms.push((
                            true,
                            format!("(V({}) - V({})) / {}", comp.node2, comp.node1, fmt_num(r_val)),
                            format!("\\frac{{V_{{{}}} - V_{{{}}}}}{{{}}}", comp.node2, comp.node1, fmt_num(r_val))
                        ));
                        total_leaving -= current;
                    }
                }
                ComponentType::CurrentSource { i_val } => {
                    if comp.node1 == *node_name {
                        // Leaving node 1
                        terms.push((
                            true,
                            format!("{} A", fmt_num(i_val)),
                            fmt_num(i_val)
                        ));
                        total_leaving += i_val;
                    } else if comp.node2 == *node_name {
                        // Entering node 2
                        terms.push((
                            false,
                            format!("{} A", fmt_num(i_val)),
                            fmt_num(i_val)
                        ));
                        total_leaving -= i_val;
                    }
                }
                ComponentType::Capacitor { .. } => {
                    // Open circuit in DC: contributes no current to the operating-point KCL.
                }
                ComponentType::Diode { .. } | ComponentType::Bjt { .. } | ComponentType::Mosfet { .. } => {}
                ComponentType::VoltageSource { .. } | ComponentType::Inductor { .. } => {
                    if comp.node1 == *node_name {
                        terms.push((
                            true,
                            format!("I({})", comp.name),
                            format!("I_{{{}}}", comp.name)
                        ));
                        total_leaving += current;
                    } else if comp.node2 == *node_name {
                        terms.push((
                            false,
                            format!("I({})", comp.name),
                            format!("I_{{{}}}", comp.name)
                        ));
                        total_leaving -= current;
                    }
                }
            }
        }

        // Device terminals: the current flowing from this node into the device
        for op in device_ops {
            for t in op.terminals.iter().filter(|t| t.node == *node_name) {
                terms.push((true, format!("I({},{})", op.name, t.role), format!("I_{{{},\\text{{{}}}}}", op.name, t.role)));
                total_leaving += t.current;
            }
        }

        let mut raw = String::new();
        let mut latex_body = String::new();

        for (i, (pos, raw_term, latex_term)) in terms.iter().enumerate() {
            if i == 0 {
                if !*pos {
                    raw.push_str("- ");
                    latex_body.push_str("- ");
                }
            } else if *pos {
                raw.push_str(" + ");
                latex_body.push_str(" + ");
            } else {
                raw.push_str(" - ");
                latex_body.push_str(" - ");
            }
            raw.push_str(raw_term);
            latex_body.push_str(latex_term);
        }

        if terms.is_empty() {
            raw = "0".to_string();
            latex_body = "0".to_string();
        }

        raw.push_str(" = 0");
        let latex = format!("\\sum I_{{leaving}} = {} = 0", latex_body);

        equations.push(KclEquation {
            node: node_name.clone(),
            node_index: idx,
            raw_equation: raw,
            latex_equation: latex,
            evaluated_sum: (total_leaving * 1e6).round() / 1e6,
        });
    }

    equations
}
