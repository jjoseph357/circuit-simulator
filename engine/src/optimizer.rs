//! Milestone 3: automated netlist tuner.
//!
//! Adjusts chosen element values so the simulated circuit meets numeric goals, with Nelder–Mead
//! search (log-spaced for positive values, within the given bounds). Every evaluation is a full
//! engine simulation, so the numbers come from the same MNA solve students inspect. The AI
//! Architect proposes a topology; this tuner does the numeric part.

use serde::{Deserialize, Serialize};

use crate::models::{Analysis, Circuit, ComponentType, SweepType};
use crate::timing::Instant;
use crate::{parse_netlist, simulate_parsed, SimulationResult, SolverKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TuneParameter {
    /// Element whose primary value is tuned (R, C, L, or a DC source value).
    pub element: String,
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Goal {
    NodeVoltage { node: String, target: f64 },
    ElementCurrent { element: String, target: f64 },
    /// Frequency where the node's gain falls 3 dB below its passband.
    CutoffHz { node: String, target: f64 },
    /// Gain 20·log10|V(node)| at one frequency.
    GainDb { node: String, freq: f64, target: f64 },
}

#[derive(Debug, Clone, Deserialize)]
pub struct TuneRequest {
    pub netlist: String,
    pub parameters: Vec<TuneParameter>,
    pub goals: Vec<Goal>,
    #[serde(default)]
    pub max_evaluations: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GoalReport {
    pub label: String,
    pub target: f64,
    pub achieved: Option<f64>,
    pub met: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TuneStep {
    pub evaluation: usize,
    pub objective: f64,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TuneResult {
    pub success: bool,
    pub message: String,
    pub parameters: Vec<String>,
    pub initial_values: Vec<f64>,
    pub values: Vec<f64>,
    /// The input netlist with the tuned values written in.
    pub netlist: String,
    pub objective: f64,
    pub goals: Vec<GoalReport>,
    /// Best objective after each evaluation (monotone), for a convergence plot.
    pub history: Vec<TuneStep>,
    pub evaluations: usize,
    pub duration_us: u64,
}

const DEFAULT_MAX_EVALS: usize = 400;
const MAX_EVALS_LIMIT: usize = 5000;
const FAIL_PENALTY: f64 = 1e6;

fn goal_label(g: &Goal) -> String {
    match g {
        Goal::NodeVoltage { node, target } => format!("V({}) = {} V", node, crate::mna::fmt_num(*target)),
        Goal::ElementCurrent { element, target } => format!("I({}) = {} A", element, crate::mna::fmt_num(*target)),
        Goal::CutoffHz { node, target } => format!("−3 dB cutoff of V({}) = {} Hz", node, crate::mna::fmt_num(*target)),
        Goal::GainDb { node, freq, target } => format!("gain of V({}) at {} Hz = {} dB", node, crate::mna::fmt_num(*freq), crate::mna::fmt_num(*target)),
    }
}

/// −3 dB crossing of a magnitude response relative to its maximum (log-interpolated).
pub fn cutoff_frequency(freqs: &[f64], mags: &[f64]) -> Option<f64> {
    let db: Vec<f64> = mags.iter().map(|m| 20.0 * m.max(1e-300).log10()).collect();
    let reference = db.iter().cloned().fold(f64::MIN, f64::max) - 3.0;
    (1..db.len()).find_map(|k| {
        let (a, b) = (db[k - 1] - reference, db[k] - reference);
        (a * b < 0.0).then(|| {
            let u = a / (a - b);
            10f64.powf(freqs[k - 1].log10() + u * (freqs[k].log10() - freqs[k - 1].log10()))
        })
    })
}

fn measure(goal: &Goal, res: &SimulationResult) -> Option<f64> {
    if !res.success {
        return None;
    }
    match goal {
        Goal::NodeVoltage { node, .. } => res.node_voltages.get(node).copied(),
        Goal::ElementCurrent { element, .. } => res.branch_currents.get(element).copied(),
        Goal::CutoffHz { node, .. } => {
            let ac = res.ac.as_ref()?;
            cutoff_frequency(&ac.frequencies, ac.node_magnitude.get(node)?)
        }
        Goal::GainDb { node, freq, .. } => {
            let ac = res.ac.as_ref()?;
            let mags = ac.node_magnitude.get(node)?;
            let k = ac.frequencies.iter().position(|f| (f - freq).abs() <= 1e-9 * freq.abs().max(1.0))?;
            Some(20.0 * mags[k].max(1e-300).log10())
        }
    }
}

/// Measures a goal. Gain goals get their own single-frequency AC run so they never depend on
/// whether a sweep happens to include their exact frequency.
fn measure_goal(goal: &Goal, circuit: &Circuit, main: &SimulationResult) -> Option<f64> {
    if let Goal::GainDb { freq, .. } = goal {
        let mut single = circuit.clone();
        single.analyses = vec![Analysis::Ac { sweep: SweepType::Lin, points: 1, fstart: *freq, fstop: *freq }];
        measure(goal, &simulate_parsed(single, SolverKind::SparseLu, Instant::now()))
    } else {
        measure(goal, main)
    }
}

/// Dimensionless error of one goal (0 = met exactly).
fn goal_error(goal: &Goal, achieved: f64) -> f64 {
    match goal {
        Goal::NodeVoltage { target, .. } | Goal::ElementCurrent { target, .. } => {
            (achieved - target) / target.abs().max(1e-12).max(if matches!(goal, Goal::NodeVoltage { .. }) { 1e-3 } else { 1e-12 })
        }
        Goal::CutoffHz { target, .. } => (achieved / target).log10() / 0.02, // 1 unit ≈ 4.7 %
        Goal::GainDb { target, .. } => (achieved - target) / 0.5,          // 1 unit = 0.5 dB
    }
}

fn goal_met(goal: &Goal, achieved: f64) -> bool {
    match goal {
        Goal::NodeVoltage { target, .. } => (achieved - target).abs() <= 0.001 * target.abs() + 1e-6,
        Goal::ElementCurrent { target, .. } => (achieved - target).abs() <= 0.001 * target.abs() + 1e-12,
        Goal::CutoffHz { target, .. } => (achieved - target).abs() <= 0.01 * target,
        Goal::GainDb { target, .. } => (achieved - target).abs() <= 0.05,
    }
}

fn set_value(circuit: &mut Circuit, k: usize, v: f64) {
    match &mut circuit.components[k].comp_type {
        ComponentType::Resistor { r_val } => *r_val = v,
        ComponentType::Capacitor { c_val } => *c_val = v,
        ComponentType::Inductor { l_val } => *l_val = v,
        ComponentType::VoltageSource { v_val } => *v_val = v,
        ComponentType::CurrentSource { i_val } => *i_val = v,
        _ => {}
    }
}

fn value_of(t: &ComponentType) -> Option<f64> {
    match *t {
        ComponentType::Resistor { r_val } => Some(r_val),
        ComponentType::Capacitor { c_val } => Some(c_val),
        ComponentType::Inductor { l_val } => Some(l_val),
        ComponentType::VoltageSource { v_val } => Some(v_val),
        ComponentType::CurrentSource { i_val } => Some(i_val),
        _ => None,
    }
}

/// Writes `value` into the value field of a SPICE element line (after "DC" if present).
pub fn rewrite_line(line: &str, value: f64) -> String {
    let v = crate::mna::fmt_num(value);
    let mut tokens: Vec<String> = line.split_whitespace().map(String::from).collect();
    let idx = if tokens.get(3).map(|t| t.eq_ignore_ascii_case("dc")).unwrap_or(false) { 4 } else { 3 };
    if idx < tokens.len() {
        tokens[idx] = v;
    }
    tokens.join(" ")
}

pub fn tune(req: &TuneRequest) -> TuneResult {
    let start = Instant::now();
    let fail = |message: String| TuneResult {
        success: false, message, parameters: vec![], initial_values: vec![], values: vec![], netlist: req.netlist.clone(),
        objective: f64::INFINITY, goals: vec![], history: vec![], evaluations: 0, duration_us: 0,
    };

    let mut base = match parse_netlist(&req.netlist) {
        Ok(c) => c,
        Err(e) => return fail(format!("Netlist does not parse: {}", e)),
    };
    if req.parameters.is_empty() || req.goals.is_empty() {
        return fail("Choose at least one element to tune and one goal.".into());
    }

    // Resolve parameters
    let mut idx = Vec::new();
    let mut x0 = Vec::new();
    let mut log_space = Vec::new();
    for p in &req.parameters {
        let Some(k) = base.components.iter().position(|c| c.name.eq_ignore_ascii_case(&p.element)) else {
            return fail(format!("No element named '{}' to tune.", p.element));
        };
        let comp = &base.components[k];
        let Some(v) = value_of(&comp.comp_type) else {
            return fail(format!("{} is a device; tune resistors, capacitors, inductors or DC source values.", comp.name));
        };
        if comp.source.as_ref().and_then(|s| s.waveform.as_ref()).is_some() {
            return fail(format!("{} has a waveform; only its DC value could be tuned, which is not what drives it.", comp.name));
        }
        if !(p.min < p.max) {
            return fail(format!("Bounds for {} must satisfy min < max.", p.element));
        }
        let log = p.min > 0.0;
        let clamped = v.clamp(p.min, p.max);
        idx.push(k);
        log_space.push(log);
        x0.push(if log { clamped.log10() } else { clamped });
    }
    let lo: Vec<f64> = req.parameters.iter().zip(&log_space).map(|(p, &l)| if l { p.min.log10() } else { p.min }).collect();
    let hi: Vec<f64> = req.parameters.iter().zip(&log_space).map(|(p, &l)| if l { p.max.log10() } else { p.max }).collect();
    let to_value = |u: &[f64]| -> Vec<f64> { u.iter().zip(&log_space).map(|(&x, &l)| if l { 10f64.powf(x) } else { x }).collect() };

    // AC goals need a sweep that brackets their frequency; add one if the netlist has none.
    if req.goals.iter().any(|g| matches!(g, Goal::CutoffHz { .. } | Goal::GainDb { .. })) && !base.analyses.iter().any(|a| matches!(a, Analysis::Ac { .. })) {
        let f = req.goals.iter().find_map(|g| match g { Goal::CutoffHz { target, .. } => Some(*target), Goal::GainDb { freq, .. } => Some(*freq), _ => None }).unwrap();
        base.analyses.push(Analysis::Ac { sweep: SweepType::Dec, points: 50, fstart: f / 1000.0, fstop: f * 1000.0 });
    }
    base.analyses.retain(|a| !matches!(a, Analysis::Tran { .. } | Analysis::Dc { .. })); // not needed for these goals

    let max_evals = req.max_evaluations.unwrap_or(DEFAULT_MAX_EVALS).clamp(1, MAX_EVALS_LIMIT);
    let mut history: Vec<TuneStep> = Vec::new();
    let mut best = (f64::INFINITY, x0.clone());

    let evaluate = |u: &[f64], history: &mut Vec<TuneStep>, best: &mut (f64, Vec<f64>)| -> f64 {
        let u: Vec<f64> = u.iter().zip(lo.iter().zip(&hi)).map(|(&x, (&l, &h))| x.clamp(l, h)).collect();
        let mut c = base.clone();
        for (&k, v) in idx.iter().zip(to_value(&u)) {
            set_value(&mut c, k, v);
        }
        let res = simulate_parsed(c.clone(), SolverKind::SparseLu, Instant::now());
        let mut objective = 0.0;
        for g in &req.goals {
            let achieved = measure_goal(g, &c, &res);
            objective += match achieved { Some(a) => goal_error(g, a).powi(2), None => FAIL_PENALTY };
        }
        if objective < best.0 {
            *best = (objective, u.clone());
        }
        history.push(TuneStep { evaluation: history.len() + 1, objective: best.0, values: to_value(&best.1) });
        objective
    };

    // Nelder–Mead
    let n = x0.len();
    let mut simplex: Vec<(Vec<f64>, f64)> = Vec::with_capacity(n + 1);
    let f0 = evaluate(&x0, &mut history, &mut best);
    simplex.push((x0.clone(), f0));
    for i in 0..n {
        let mut p = x0.clone();
        let step = if log_space[i] { 0.3 } else { 0.1 * (hi[i] - lo[i]) };
        p[i] = if p[i] + step <= hi[i] { p[i] + step } else { p[i] - step };
        let f = evaluate(&p, &mut history, &mut best);
        simplex.push((p, f));
    }
    while history.len() < max_evals {
        simplex.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let spread = simplex.iter().map(|(p, _)| p.iter().zip(&simplex[0].0).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max)).fold(0.0, f64::max);
        if simplex[0].1 < 1e-12 || spread < 1e-9 {
            break;
        }
        let centroid: Vec<f64> = (0..n).map(|j| simplex[..n].iter().map(|(p, _)| p[j]).sum::<f64>() / n as f64).collect();
        let worst = simplex[n].clone();
        let along = |t: f64| -> Vec<f64> { (0..n).map(|j| centroid[j] + t * (worst.0[j] - centroid[j])).collect() };
        let xr = along(-1.0);
        let fr = evaluate(&xr, &mut history, &mut best);
        if fr < simplex[0].1 {
            let xe = along(-2.0);
            let fe = evaluate(&xe, &mut history, &mut best);
            simplex[n] = if fe < fr { (xe, fe) } else { (xr, fr) };
        } else if fr < simplex[n - 1].1 {
            simplex[n] = (xr, fr);
        } else {
            let xc = if fr < worst.1 { along(-0.5) } else { along(0.5) };
            let fc = evaluate(&xc, &mut history, &mut best);
            if fc < worst.1.min(fr) {
                simplex[n] = (xc, fc);
            } else {
                // shrink toward the best point
                let b0 = simplex[0].0.clone();
                for s in simplex.iter_mut().skip(1) {
                    let p: Vec<f64> = s.0.iter().zip(&b0).map(|(x, b)| b + 0.5 * (x - b)).collect();
                    let f = evaluate(&p, &mut history, &mut best);
                    *s = (p, f);
                }
            }
        }
    }

    // Report at the best point
    let evaluations = history.len();
    let (objective, best_u) = best;
    let values = to_value(&best_u.iter().zip(lo.iter().zip(&hi)).map(|(&x, (&l, &h))| x.clamp(l, h)).collect::<Vec<_>>());
    let mut c = base.clone();
    for (&k, &v) in idx.iter().zip(&values) {
        set_value(&mut c, k, v);
    }
    let res = simulate_parsed(c.clone(), SolverKind::SparseLu, Instant::now());
    let goals: Vec<GoalReport> = req
        .goals
        .iter()
        .map(|g| {
            let achieved = measure_goal(g, &c, &res);
            let target = match g { Goal::NodeVoltage { target, .. } | Goal::ElementCurrent { target, .. } | Goal::CutoffHz { target, .. } | Goal::GainDb { target, .. } => *target };
            GoalReport { label: goal_label(g), target, achieved, met: achieved.map(|a| goal_met(g, a)).unwrap_or(false) }
        })
        .collect();

    let mut netlist = req.netlist.clone();
    for (&k, &v) in idx.iter().zip(&values) {
        let original = &base.components[k].original_line;
        if let Some(pos) = netlist.find(original.as_str()) {
            netlist.replace_range(pos..pos + original.len(), &rewrite_line(original, v));
        }
    }
    let all_met = goals.iter().all(|g| g.met);
    let at_bound = values.iter().zip(&req.parameters).any(|(v, p)| (v - p.min).abs() <= 1e-9 * p.min.abs().max(1e-30) || (v - p.max).abs() <= 1e-9 * p.max.abs().max(1e-30));
    TuneResult {
        success: all_met,
        message: if all_met {
            format!("All goals met after {} simulations.", evaluations)
        } else if at_bound {
            "Not all goals could be met: a value hit its allowed limit. Widen the bounds or tune another element.".into()
        } else {
            "Not all goals could be met with these elements; the goals may conflict. The closest compromise is shown.".into()
        },
        parameters: req.parameters.iter().map(|p| p.element.clone()).collect(),
        initial_values: to_value(&x0),
        values,
        netlist,
        objective,
        goals,
        history,
        evaluations,
        duration_us: start.elapsed().as_micros() as u64,
    }
}

/// JSON-in/JSON-out wrapper shared by the CLI, Python and WebAssembly bindings.
pub fn tune_json(request: &str) -> String {
    let result = match serde_json::from_str::<TuneRequest>(request) {
        Ok(req) => tune(&req),
        Err(e) => TuneResult {
            success: false, message: format!("Bad tune request: {}", e), parameters: vec![], initial_values: vec![], values: vec![],
            netlist: String::new(), objective: f64::INFINITY, goals: vec![], history: vec![], evaluations: 0, duration_us: 0,
        },
    };
    serde_json::to_string(&result).unwrap_or_else(|e| format!("{{\"success\":false,\"message\":\"{}\"}}", e))
}
