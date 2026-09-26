use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum ComponentType {
    Resistor { r_val: f64 },
    CurrentSource { i_val: f64 }, // DC value; from node1 to node2 (leaves node1, enters node2)
    VoltageSource { v_val: f64 }, // DC value; node1 is (+), node2 is (-)
    /// Open circuit in DC; stamps C into the dynamic matrix.
    Capacitor { c_val: f64 },
    /// Short circuit in DC; adds a branch-current unknown and stamps −L into the dynamic matrix.
    Inductor { l_val: f64 },
    /// Junction diode, anode = node1, cathode = node2. Id = IS·(exp(Vd / (N·Vt)) − 1).
    Diode { is: f64, n: f64 },
    /// Bipolar transistor (Ebers–Moll transport model): collector = node1, base = node2,
    /// emitter = extra_nodes[0].
    Bjt { is: f64, bf: f64, br: f64, npn: bool },
    /// Level-1 (Shichman–Hodges) MOSFET: drain = node1, gate = node2, source = extra_nodes[0].
    /// No body effect; the bulk terminal, if written, is ignored.
    Mosfet { vto: f64, kp: f64, lambda: f64, w: f64, l: f64, nmos: bool },
}

impl ComponentType {
    pub fn is_nonlinear(&self) -> bool {
        matches!(self, ComponentType::Diode { .. } | ComponentType::Bjt { .. } | ComponentType::Mosfet { .. })
    }
}

/// Time-domain waveform of an independent source (SPICE PULSE / SIN / PWL).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum Waveform {
    Pulse { v1: f64, v2: f64, td: f64, tr: f64, tf: f64, pw: f64, per: f64 },
    Sin { vo: f64, va: f64, freq: f64, td: f64, theta: f64, phase_deg: f64 },
    Pwl { points: Vec<(f64, f64)> },
}

/// Extra behaviour of an independent source beyond its DC value.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SourceSpec {
    /// Small-signal amplitude and phase used by .ac (0 = source is off in AC).
    pub ac_mag: f64,
    pub ac_phase_deg: f64,
    pub waveform: Option<Waveform>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum SweepType {
    Dec,
    Oct,
    Lin,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum IntegrationMethod {
    BackwardEuler,
    Trapezoidal,
}

/// Analyses requested by SPICE control cards. `.op` is always run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum Analysis {
    Ac { sweep: SweepType, points: usize, fstart: f64, fstop: f64 },
    Tran { tstep: f64, tstop: f64, tstart: f64, tmax: Option<f64> },
    /// `.dc SRC start stop step`: sweep a V or I source's DC value.
    Dc { source: String, start: f64, stop: f64, step: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Component {
    pub name: String,
    #[serde(flatten)]
    pub comp_type: ComponentType,
    pub node1: String,
    pub node2: String,
    #[serde(default)]
    pub original_line: String,
    /// AC / transient behaviour of V and I sources (None = pure DC).
    #[serde(default)]
    pub source: Option<SourceSpec>,
    /// Terminals beyond the first two (transistor emitter / source).
    #[serde(default)]
    pub extra_nodes: Vec<String>,
}

impl Component {
    /// All terminal nodes, in the element's own order (e.g. C, B, E for a BJT).
    pub fn nodes(&self) -> Vec<&str> {
        let mut v = vec![self.node1.as_str(), self.node2.as_str()];
        v.extend(self.extra_nodes.iter().map(|s| s.as_str()));
        v
    }

    /// Pairs of nodes this element connects with a DC conduction path (MOSFET gates don't conduct).
    pub fn dc_edges(&self) -> Vec<(&str, &str)> {
        match self.comp_type {
            ComponentType::Bjt { .. } => {
                let e = self.extra_nodes[0].as_str();
                vec![(self.node1.as_str(), e), (self.node2.as_str(), e)]
            }
            ComponentType::Mosfet { .. } => vec![(self.node1.as_str(), self.extra_nodes[0].as_str())],
            _ => vec![(self.node1.as_str(), self.node2.as_str())],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Circuit {
    pub components: Vec<Component>,
    pub node_names: Vec<String>, // Index 0 is "0" or "GND", 1..N are non-reference nodes
    pub node_to_idx: HashMap<String, usize>,
    pub num_nodes: usize,        // Number of non-reference nodes (N)
    pub num_v_sources: usize,    // Number of independent voltage sources (M)
    pub variable_names: Vec<String>, // [V(1), ..., V(N), I(V1), I(L1), ...]
    /// Row/column of each branch-current unknown (voltage sources and inductors), by element name.
    pub aux_index: HashMap<String, usize>,
    /// Number of branch-current unknowns; the MNA dimension is num_nodes + num_aux.
    pub num_aux: usize,
    pub analyses: Vec<Analysis>,
    pub method: IntegrationMethod,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StampingCell {
    pub row: usize,
    pub col: usize,
    pub delta: f64,
    pub new_value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StampingStep {
    pub step_index: usize,
    pub component_name: String,
    pub component_summary: String,
    pub affected_cells_g: Vec<StampingCell>,
    pub affected_cells_b: Vec<StampingCell>,
    pub matrix_g_snapshot: Vec<Vec<f64>>,
    pub vector_b_snapshot: Vec<f64>,
    pub explanation: String,
    /// Stamps into the dynamic matrix C (capacitors, inductors).
    #[serde(default)]
    pub affected_cells_c: Vec<StampingCell>,
    #[serde(default)]
    pub matrix_c_snapshot: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GaussianStep {
    pub step_index: usize,
    pub phase: String, // "pivot_swap", "elimination", "back_substitution"
    pub description: String,
    pub latex_equation: String,
    pub matrix_snapshot: Vec<Vec<f64>>, // Augmented [G | b]
    pub current_row: Option<usize>,
    pub target_row: Option<usize>,
    pub multiplier: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KclEquation {
    pub node: String,
    pub node_index: usize,
    pub raw_equation: String,
    pub latex_equation: String,
    pub evaluated_sum: f64, // Should evaluate to ~0.0 at solution
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpyPlotEntry {
    pub row: usize,
    pub col: usize,
    pub value: f64,
    pub entry_type: String, // "conductance", "voltage_incidence", "zero"
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpyPlotData {
    pub dimension: usize,
    pub non_zeros: usize,
    pub sparsity_percentage: f64,
    pub entries: Vec<SpyPlotEntry>,
    /// Non-zeros of the dynamic matrix C (entry_type "capacitance" / "inductance").
    #[serde(default)]
    pub dynamic_entries: Vec<SpyPlotEntry>,
}

/// A deterministic, machine-applicable repair for a diagnostic. Netlist lines in
/// `remove_lines` are matched against `Component::original_line`; `append_lines` are
/// SPICE element lines.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AutoFix {
    pub label: String,
    pub explanation: String,
    pub append_lines: Vec<String>,
    pub remove_lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: String, // "error", "warning", "info"
    pub code: String,
    pub title: String,
    pub message: String,
    pub nodes_affected: Vec<String>,
    pub components_affected: Vec<String>,
    pub suggestion: String,
    #[serde(default)]
    pub fix: Option<AutoFix>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationResult {
    pub success: bool,
    pub error_message: Option<String>,
    pub solver_used: String,
    pub num_equations: usize,
    pub variable_names: Vec<String>,
    pub solution_vector: Vec<f64>,
    pub node_voltages: HashMap<String, f64>,
    pub branch_currents: HashMap<String, f64>, // Current from node1 to node2
    pub branch_powers: HashMap<String, f64>,   // Power absorbed (W)
    pub matrix_g: Vec<Vec<f64>>,
    pub vector_b: Vec<f64>,
    pub stamping_timeline: Vec<StampingStep>,
    pub gaussian_steps: Vec<GaussianStep>,
    pub kcl_equations: Vec<KclEquation>,
    pub spy_plot: SpyPlotData,
    pub diagnostics: Vec<Diagnostic>,
    pub storybook_explanation: String,
    pub execution_time_us: u64,
    /// Why the engine deviated from the requested solver (e.g. circuit too large to log).
    pub solver_note: Option<String>,
    /// max_i |(A x - b)_i| — an independent check that the solution satisfies G x = b.
    pub residual_max_abs: Option<f64>,
    /// Extra non-zeros created by sparse LU factorization: nnz(L) + nnz(U) - nnz(A).
    pub lu_fill_in: Option<usize>,
    /// False when the system is too large for dense matrix snapshots and per-step logs.
    pub educational_views: bool,
    /// Dense dynamic matrix C (educational size and only if the circuit has C or L).
    #[serde(default)]
    pub matrix_c: Vec<Vec<f64>>,
    /// Results of `.ac` / `.tran` control cards, if present.
    #[serde(default)]
    pub ac: Option<crate::dynamics::AcResult>,
    #[serde(default)]
    pub transient: Option<crate::dynamics::TransientResult>,
    /// Failures of .ac / .tran (the DC operating point can still be valid).
    #[serde(default)]
    pub analysis_errors: Vec<String>,
    /// Newton–Raphson record of the DC operating point (circuits with diodes/transistors).
    #[serde(default)]
    pub newton: Option<crate::nonlinear::NewtonLog>,
    /// Operating point of each nonlinear device: region, voltages, currents, small-signal values.
    #[serde(default)]
    pub device_ops: Vec<crate::nonlinear::DeviceOp>,
    #[serde(default)]
    pub dc_sweep: Option<crate::nonlinear::DcSweepResult>,
}

impl Waveform {
    /// Source value at time t (SPICE semantics; t < td holds the initial value).
    pub fn value_at(&self, t: f64) -> f64 {
        match *self {
            Waveform::Pulse { v1, v2, td, tr, tf, pw, per } => {
                if t < td {
                    return v1;
                }
                let mut tp = t - td;
                if per.is_finite() && per > 0.0 {
                    tp %= per;
                }
                if tp < tr {
                    v1 + (v2 - v1) * tp / tr
                } else if tp < tr + pw {
                    v2
                } else if tp < tr + pw + tf {
                    v2 + (v1 - v2) * (tp - tr - pw) / tf
                } else {
                    v1
                }
            }
            Waveform::Sin { vo, va, freq, td, theta, phase_deg } => {
                let phase = phase_deg.to_radians();
                if t < td {
                    vo + va * phase.sin()
                } else {
                    let tt = t - td;
                    vo + va * (-tt * theta).exp() * (2.0 * std::f64::consts::PI * freq * tt + phase).sin()
                }
            }
            Waveform::Pwl { ref points } => {
                match points.iter().position(|&(pt, _)| pt > t) {
                    None => points.last().map(|p| p.1).unwrap_or(0.0),
                    Some(0) => points[0].1,
                    Some(k) => {
                        let (t0, v0) = points[k - 1];
                        let (t1, v1) = points[k];
                        if t1 == t0 { v1 } else { v0 + (v1 - v0) * (t - t0) / (t1 - t0) }
                    }
                }
            }
        }
    }

    /// Times in (0, tstop] where the waveform has a corner. The transient stepper lands on each
    /// exactly, so a sharp edge is never smeared across one large step.
    pub fn breakpoints(&self, tstop: f64) -> Vec<f64> {
        const MAX: usize = 100_000;
        let mut out = Vec::new();
        match *self {
            Waveform::Pulse { td, tr, tf, pw, per, .. } => {
                let periodic = per.is_finite() && per > 0.0;
                let mut base = td;
                while base <= tstop && out.len() < MAX {
                    for t in [base, base + tr, base + tr + pw, base + tr + pw + tf] {
                        if t.is_finite() && t > 0.0 && t <= tstop {
                            out.push(t);
                        }
                    }
                    if !periodic {
                        break;
                    }
                    base += per;
                }
            }
            Waveform::Sin { td, .. } => {
                if td > 0.0 && td <= tstop {
                    out.push(td);
                }
            }
            Waveform::Pwl { ref points } => out.extend(points.iter().map(|p| p.0).filter(|&t| t > 0.0 && t <= tstop)),
        }
        out
    }
}
