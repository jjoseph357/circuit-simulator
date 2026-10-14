//! Milestone 2: frequency-domain (.ac) and time-domain (.tran) analysis of
//!     G·x(t) + C·dx/dt = b(t)
//! built by `mna::build_mna_system` (G static, C dynamic).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::mna::{ac_rhs, source_rhs, MnaSystem};
use crate::models::{Circuit, ComponentType, IntegrationMethod, SweepType};
use crate::nonlinear::DcSweepResult;
use crate::solvers::sparse_lu::{CsrMatrix, SparseLuFactors};

const MAX_AC_POINTS: usize = 10_000;
const MAX_TRANSIENT_STEPS: usize = 2_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcResult {
    pub sweep: SweepType,
    pub frequencies: Vec<f64>,
    /// |V(node)| per frequency (V per unit of AC excitation).
    pub node_magnitude: HashMap<String, Vec<f64>>,
    pub node_phase_deg: HashMap<String, Vec<f64>>,
    /// |I| of branch-current unknowns (voltage sources, inductors).
    pub branch_magnitude: HashMap<String, Vec<f64>>,
    /// Dimension of the real-equivalent system solved at each frequency (2N).
    pub real_system_dimension: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransientResult {
    pub method: IntegrationMethod,
    pub time: Vec<f64>,
    pub node_voltages: HashMap<String, Vec<f64>>,
    /// Current through each element, node1 → node2 (empty for very large circuits).
    pub branch_currents: HashMap<String, Vec<f64>>,
    /// Step size h that produced each stored point (0 for the initial point).
    pub step_sizes: Vec<f64>,
    pub accepted_steps: usize,
    pub rejected_steps: usize,
    /// How many times G + αC was LU-factorized (reused while h stays constant).
    pub factorizations: usize,
    pub breakpoints: Vec<f64>,
    pub tstop: f64,
    /// True if stored points were thinned to keep the response small.
    pub decimated: bool,
    /// Current into each nonlinear device terminal, keyed "NAME:index" in terminal order
    /// (e.g. Q1:0 collector, Q1:1 base, Q1:2 emitter), so the schematic can replay them.
    #[serde(default)]
    pub terminal_currents: HashMap<String, Vec<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TfResult {
    pub output_variable: String,
    pub input_source: String,
    pub transfer_function: f64,
    pub input_resistance: f64,
    pub output_resistance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeasResult {
    pub name: String,
    pub analysis: String,
    pub metric: String,
    pub variable: String,
    pub value: f64,
}

// ---------------------------------------------------------------- AC

pub fn ac_frequencies(sweep: SweepType, points: usize, fstart: f64, fstop: f64) -> Vec<f64> {
    let mut f = Vec::new();
    match sweep {
        SweepType::Lin => {
            if points <= 1 || fstop == fstart {
                f.push(fstart);
            } else {
                f.extend((0..points).map(|k| fstart + (fstop - fstart) * k as f64 / (points - 1) as f64));
            }
        }
        SweepType::Dec | SweepType::Oct => {
            let base: f64 = if sweep == SweepType::Dec { 10.0 } else { 2.0 };
            let mut k = 0;
            loop {
                let v = fstart * base.powf(k as f64 / points as f64);
                if v > fstop * (1.0 + 1e-9) || f.len() >= MAX_AC_POINTS {
                    break;
                }
                f.push(v);
                k += 1;
            }
        }
    }
    f.truncate(MAX_AC_POINTS);
    f
}

/// Solves (G + jωC)·X = B at each frequency via the equivalent real system
///     [ G  −ωC ] [Xr]   [Br]
///     [ ωC   G ] [Xi] = [Bi]
/// so the same sparse LU used for DC does the work.
pub fn ac_analysis(circuit: &Circuit, mna: &MnaSystem, g: &CsrMatrix, sweep: SweepType, freqs: &[f64]) -> Result<AcResult, String> {
    let n = mna.dimension;
    let (br, bi) = ac_rhs(circuit);
    let rhs: Vec<f64> = br.iter().chain(bi.iter()).copied().collect();

    // Pattern of the 2N system, sorted once; values depend on ω.
    // kind 0: G entry, 1: +ω·C entry, 2: −ω·C entry
    let mut pattern: Vec<((usize, usize), u8, f64)> = Vec::new();
    for i in 0..n {
        for (c, v) in g.row(i) {
            pattern.push(((i, c), 0, v));
            pattern.push(((i + n, c + n), 0, v));
        }
        for (c, v) in mna.c_matrix.row(i) {
            pattern.push(((i, c + n), 2, v));
            pattern.push(((i + n, c), 1, v));
        }
    }
    pattern.sort_by_key(|e| e.0);

    let mut node_magnitude: HashMap<String, Vec<f64>> = HashMap::new();
    let mut node_phase_deg: HashMap<String, Vec<f64>> = HashMap::new();
    let mut branch_magnitude: HashMap<String, Vec<f64>> = HashMap::new();

    for &f in freqs {
        let w = 2.0 * std::f64::consts::PI * f;
        let a = CsrMatrix::from_sorted_triplets(
            2 * n,
            pattern.iter().map(|&(rc, kind, v)| (rc, match kind { 0 => v, 1 => w * v, _ => -w * v })),
        );
        let x = SparseLuFactors::factor(&a)
            .and_then(|lu| lu.solve(&rhs))
            .map_err(|e| format!("AC analysis failed at {} Hz: {}", f, e))?;
        for (idx, name) in circuit.node_names.iter().enumerate().skip(1) {
            let (re, im) = (x[idx - 1], x[idx - 1 + n]);
            node_magnitude.entry(name.clone()).or_default().push(re.hypot(im));
            node_phase_deg.entry(name.clone()).or_default().push(im.atan2(re).to_degrees());
        }
        for (name, &aux) in &circuit.aux_index {
            branch_magnitude.entry(name.clone()).or_default().push(x[aux].hypot(x[aux + n]));
        }
    }

    Ok(AcResult {
        sweep,
        frequencies: freqs.to_vec(),
        node_magnitude,
        node_phase_deg,
        branch_magnitude,
        real_system_dimension: 2 * n,
    })
}

// ---------------------------------------------------------------- Transient

/// Error control: a step is accepted when the solver's answer stays within
/// RELTOL·|x| + ABSTOL of a straight-line extrapolation of the last two points.
const RELTOL: f64 = 1e-3;
const VNTOL: f64 = 1e-6; // V
const ABSTOL: f64 = 1e-9; // A

pub struct TransientSettings {
    pub tstep: f64,
    pub tstop: f64,
    pub tstart: f64,
    pub tmax: Option<f64>,
    pub method: IntegrationMethod,
    pub uic: bool,
}

/// Element currents (node1 → node2) at one accepted time point.
fn element_currents(
    circuit: &Circuit,
    x: &[f64],
    x_prev: &[f64],
    x_prev2: Option<&[f64]>,
    t: f64,
    h: f64,
    used_be: bool,
    used_gear: bool,
    gear_r: f64,
    cap_current: &mut HashMap<String, f64>,
    device_ops: &[crate::nonlinear::DeviceOp],
) -> Vec<(String, f64)> {
    let v = |node: &str| -> f64 {
        let idx = circuit.node_to_idx[node];
        if idx == 0 { 0.0 } else { x[idx - 1] }
    };
    let v_prev = |node: &str| -> f64 {
        let idx = circuit.node_to_idx[node];
        if idx == 0 { 0.0 } else { x_prev[idx - 1] }
    };
    circuit
        .components
        .iter()
        .map(|c| {
            let i = match c.comp_type {
                ComponentType::Resistor { r_val } => (v(&c.node1) - v(&c.node2)) / r_val,
                ComponentType::VoltageSource { .. }
                | ComponentType::Inductor { .. }
                | ComponentType::ShortCircuit
                | ComponentType::Vcvs { .. }
                | ComponentType::OpAmp { .. } => x[circuit.aux_index[&c.name]],
                ComponentType::OpenCircuit => 0.0,
                ComponentType::Vccs { gm } => gm * (v(&c.extra_nodes[0]) - v(&c.extra_nodes[1])),
                ComponentType::Cccs { gain, ref v_ctrl } => {
                    let i_in = match v_ctrl {
                        Some(v_name) => x[circuit.aux_index[v_name]],
                        None => x[circuit.aux_index[&c.name]],
                    };
                    gain * i_in
                }
                ComponentType::Ccvs { .. } => x[circuit.aux_index[&c.name]],
                ComponentType::Transformer { .. } => x[circuit.aux_index[&c.name]],
                ComponentType::CurrentSource { i_val } => match c.source.as_ref().and_then(|s| s.waveform.as_ref()) {
                    Some(w) => w.value_at(t),
                    None => i_val,
                },
                ComponentType::Capacitor { c_val } => {
                    let vc = v(&c.node1) - v(&c.node2);
                    let vc_prev = v_prev(&c.node1) - v_prev(&c.node2);
                    let dv = vc - vc_prev;
                    // Same discretization the solver used, so KCL holds exactly at each step.
                    let i = if used_be {
                        c_val * dv / h
                    } else if used_gear {
                        let vc_prev2 = if let Some(xp2) = x_prev2 {
                            let idx1 = circuit.node_to_idx[&c.node1];
                            let idx2 = circuit.node_to_idx[&c.node2];
                            let v1 = if idx1 == 0 { 0.0 } else { xp2[idx1 - 1] };
                            let v2 = if idx2 == 0 { 0.0 } else { xp2[idx2 - 1] };
                            v1 - v2
                        } else {
                            vc_prev
                        };
                        let alpha0 = (2.0 * gear_r + 1.0) / (gear_r + 1.0) / h;
                        let alpha1 = -(gear_r + 1.0) / h;
                        let alpha2 = (gear_r * gear_r) / ((gear_r + 1.0) * h);
                        c_val * (alpha0 * vc + alpha1 * vc_prev + alpha2 * vc_prev2)
                    } else {
                        2.0 * c_val * dv / h - cap_current.get(&c.name).copied().unwrap_or(0.0)
                    };
                    cap_current.insert(c.name.clone(), i);
                    i
                }
                ComponentType::Switch { ron, roff, vt } => {
                    let vc = if c.extra_nodes.len() >= 2 { v(&c.extra_nodes[0]) - v(&c.extra_nodes[1]) } else { 0.0 };
                    let r = if vc >= vt { ron } else { roff };
                    (v(&c.node1) - v(&c.node2)) / r
                }
                _ => device_ops.iter().find(|o| o.name == c.name).and_then(|o| o.terminals.first()).map(|t| t.current).unwrap_or(0.0),
            };
            (c.name.clone(), i)
        })
        .collect()
}

pub fn transient_analysis(circuit: &Circuit, mna: &MnaSystem, s: &TransientSettings) -> Result<TransientResult, String> {
    let n = mna.dimension;
    let g = &mna.matrix;
    let cm = &mna.c_matrix;
    let tstop = s.tstop;
    let hmax = s.tmax.unwrap_or_else(|| s.tstep.min(tstop / 50.0)).max(tstop * 1e-9);
    let hmin = (tstop * 1e-12).max(1e-18);

    // Source corners the stepper must land on exactly
    let mut breakpoints: Vec<f64> = circuit
        .components
        .iter()
        .filter_map(|c| c.source.as_ref().and_then(|s| s.waveform.as_ref()))
        .flat_map(|w| w.breakpoints(tstop))
        .chain(std::iter::once(tstop))
        .chain((s.tstart > 0.0).then_some(s.tstart))
        .collect();
    breakpoints.sort_by(|a, b| a.partial_cmp(b).unwrap());
    breakpoints.dedup_by(|a, b| (*a - *b).abs() <= hmin * 10.0);

    // Union pattern of G and C, so A = G + α·C only needs new values per α.
    let mut pattern: Vec<((usize, usize), f64, f64)> = Vec::new();
    {
        let mut map: std::collections::BTreeMap<(usize, usize), (f64, f64)> = std::collections::BTreeMap::new();
        for i in 0..n {
            for (c, v) in g.row(i) { map.entry((i, c)).or_default().0 += v; }
            for (c, v) in cm.row(i) { map.entry((i, c)).or_default().1 += v; }
        }
        pattern.extend(map.into_iter().map(|(k, (gv, cv))| (k, gv, cv)));
    }
    let companion = |alpha: f64| CsrMatrix::from_sorted_triplets(n, pattern.iter().map(|&(k, gv, cv)| (k, gv + alpha * cv)));

    // Initial condition: DC operating point with sources at their t = 0 values, or UIC if requested.
    let b0 = source_rhs(circuit, Some(0.0));
    let nonlinear = circuit.components.iter().any(|c| c.comp_type.is_nonlinear());
    let ops_at = |x: &[f64]| if nonlinear { crate::nonlinear::device_ops_at(circuit, x) } else { Vec::new() };
    let x0 = if s.uic || circuit.uic {
        let mut init_x = vec![0.0; n];
        for (node, &v) in &circuit.initial_node_voltages {
            if let Some(&k) = circuit.node_to_idx.get(node) {
                if k > 0 {
                    init_x[k - 1] = v;
                }
            }
        }
        for comp in &circuit.components {
            if let Some(ic) = comp.initial_condition {
                match comp.comp_type {
                    ComponentType::Capacitor { .. } => {
                        let k1 = *circuit.node_to_idx.get(&comp.node1).unwrap_or(&0);
                        let k2 = *circuit.node_to_idx.get(&comp.node2).unwrap_or(&0);
                        if k1 > 0 && k2 == 0 {
                            init_x[k1 - 1] = ic;
                        } else if k1 == 0 && k2 > 0 {
                            init_x[k2 - 1] = -ic;
                        } else if k1 > 0 && k2 > 0 {
                            init_x[k1 - 1] = init_x[k2 - 1] + ic;
                        }
                    }
                    ComponentType::Inductor { .. } => {
                        if let Some(&aux) = circuit.aux_index.get(&comp.name) {
                            init_x[aux] = ic;
                        }
                    }
                    _ => {}
                }
            }
        }
        init_x
    } else if nonlinear {
        crate::nonlinear::solve_nonlinear(circuit, g, &b0, None, false).map(|(x, _)| x)
            .map_err(|e| format!("Transient initial operating point failed: {}", e))?
    } else {
        SparseLuFactors::factor(g).and_then(|lu| lu.solve(&b0))
            .map_err(|e| format!("Transient initial operating point failed: {}", e))?
    };

    let state_vars: Vec<usize> = (0..n).filter(|&i| cm.get(i, i) != 0.0).collect();
    let dynamic_row: Vec<bool> = (0..n).map(|i| cm.row(i).next().is_some()).collect();
    // Current each row sends into nonlinear devices at a given state (zero for linear circuits).
    let device_kcl = |x: &[f64]| -> Vec<f64> {
        let mut r = vec![0.0; n];
        for op in ops_at(x) {
            for t in &op.terminals {
                let k = circuit.node_to_idx[&t.node];
                if k > 0 {
                    r[k - 1] += t.current;
                }
            }
        }
        r
    };
    let store_currents = circuit.components.len() <= 500;
    let mut time = vec![0.0];
    let mut states: Vec<Vec<f64>> = vec![x0.clone()];
    let mut currents: Vec<Vec<(String, f64)>> = Vec::new();
    let mut terminals: Vec<Vec<(String, f64)>> = Vec::new();
    let terminal_row = |ops: &[crate::nonlinear::DeviceOp]| -> Vec<(String, f64)> {
        ops.iter().flat_map(|o| o.terminals.iter().enumerate().map(move |(k, t)| (format!("{}:{}", o.name, k), t.current))).collect()
    };
    let mut cap_current: HashMap<String, f64> = HashMap::new();
    if store_currents {
        let ops0 = ops_at(&x0);
        terminals.push(terminal_row(&ops0));
        currents.push(element_currents(circuit, &x0, &x0, None, 0.0, 1.0, true, false, 1.0, &mut HashMap::new(), &ops0));
    }
    let mut step_sizes = vec![0.0];

    let mut t = 0.0;
    let mut x = x0;
    let mut b_n = b0;
    let mut prev: Option<(Vec<f64>, f64)> = None; // (x_{n-1}, h_{n-1}) for the error predictor
    let mut after_breakpoint = true; // start with Backward Euler, like SPICE
    let mut h = (s.tstep / 10.0).min(hmax).min(breakpoints[0]);
    let mut bp_idx = 0;
    let (mut accepted, mut rejected, mut factorizations) = (0usize, 0usize, 0usize);
    let mut cached: Option<(f64, SparseLuFactors)> = None;

    while t < tstop - hmin {
        if accepted + rejected > MAX_TRANSIENT_STEPS {
            return Err(format!("Transient analysis gave up after {} steps (t = {:.3e} s). The circuit may be too stiff for this time range.", MAX_TRANSIENT_STEPS, t));
        }
        while bp_idx < breakpoints.len() && breakpoints[bp_idx] <= t + hmin {
            bp_idx += 1;
        }
        let next_bp = breakpoints.get(bp_idx).copied().unwrap_or(tstop);
        h = h.min(hmax).min(next_bp - t).max(hmin.min(next_bp - t));
        let lands_on_bp = (t + h - next_bp).abs() <= hmin;

        let use_gear = s.method == IntegrationMethod::Gear && !after_breakpoint && prev.is_some();
        let use_be = after_breakpoint || s.method == IntegrationMethod::BackwardEuler;
        let (alpha, gear_r) = if use_be {
            (1.0 / h, 1.0)
        } else if use_gear {
            let hp = prev.as_ref().unwrap().1;
            let r = h / hp;
            ((2.0 * r + 1.0) / (r + 1.0) / h, r)
        } else {
            (2.0 / h, 1.0)
        };
        if !nonlinear && cached.as_ref().map(|(a, _)| *a != alpha).unwrap_or(true) {
            let lu = SparseLuFactors::factor(&companion(alpha)).map_err(|e| format!("Transient step at t = {:.3e} s failed: {}", t, e))?;
            factorizations += 1;
            cached = Some((alpha, lu));
        }

        let t_next = if lands_on_bp { next_bp } else { t + h };
        let b_next = source_rhs(circuit, Some(t_next));
        let cx = cm.matvec(&x);
        let rhs: Vec<f64> = if use_be {
            // (G + C/h)·x₁ = b₁ + (C/h)·x₀
            (0..n).map(|i| b_next[i] + alpha * cx[i]).collect()
        } else if use_gear {
            let xp = &prev.as_ref().unwrap().0;
            let cx_prev = cm.matvec(xp);
            let c1 = (gear_r + 1.0) / h;
            let c2 = (gear_r * gear_r) / ((gear_r + 1.0) * h);
            (0..n)
                .map(|i| {
                    if dynamic_row[i] {
                        b_next[i] + c1 * cx[i] - c2 * cx_prev[i]
                    } else {
                        b_next[i]
                    }
                })
                .collect()
        } else {
            // Rows with reactive elements: (G + 2C/h)·x₁ + i(x₁) = b₁ + (2C/h)·x₀ + [b₀ − G·x₀ − i(x₀)],
            // where the bracket is C·dx/dt at t₀. Purely resistive rows (no C entry) are solved
            // exactly at t₁ instead of being averaged, as SPICE does.
            let gx = g.matvec(&x);
            let idev = device_kcl(&x);
            (0..n)
                .map(|i| if dynamic_row[i] { b_next[i] + alpha * cx[i] + b_n[i] - gx[i] - idev[i] } else { b_next[i] })
                .collect()
        };
        let x_next = if nonlinear {
            // Devices: Newton–Raphson on the companion system, starting from the last time point.
            factorizations += 1;
            match crate::nonlinear::solve_nonlinear(circuit, &companion(alpha), &rhs, Some(&x), false) {
                Ok((v, _)) => v,
                Err(_) if h > hmin * 10.0 => {
                    rejected += 1;
                    h *= 0.25;
                    continue;
                }
                Err(e) => return Err(format!("Transient step at t = {:.3e} s failed: {}", t, e)),
            }
        } else {
            cached.as_ref().unwrap().1.solve(&rhs).map_err(|e| format!("Transient step at t = {:.3e} s failed: {}", t, e))?
        };

        // Local error estimate against linear extrapolation of the previous two points, over
        // state variables only (capacitor nodes, inductor currents). Algebraic unknowns such as a
        // source's current may jump at an edge without the integration being inaccurate.
        let err = match &prev {
            Some((xp, hp)) => state_vars
                .iter()
                .map(|&i| {
                    let pred = x[i] + (h / hp) * (x[i] - xp[i]);
                    let tol = RELTOL * x_next[i].abs().max(x[i].abs()) + if i < circuit.num_nodes { VNTOL } else { ABSTOL };
                    (x_next[i] - pred).abs() / tol
                })
                .fold(0.0, f64::max),
            None => 0.0,
        };

        if err > 1.0 && h > hmin * 10.0 {
            rejected += 1;
            h *= (0.9 / err.sqrt()).clamp(0.1, 0.5);
            continue;
        }

        accepted += 1;
        if store_currents {
            let ops = ops_at(&x_next);
            terminals.push(terminal_row(&ops));
            currents.push(element_currents(circuit, &x_next, &x, prev.as_ref().map(|p| p.0.as_slice()), t_next, t_next - t, use_be, use_gear, gear_r, &mut cap_current, &ops));
        }
        step_sizes.push(t_next - t);
        prev = Some((std::mem::replace(&mut x, x_next), t_next - t));
        t = t_next;
        b_n = b_next;
        time.push(t);
        states.push(x.clone());

        if lands_on_bp {
            // A source corner: restart the predictor, take a small Backward Euler step next.
            after_breakpoint = true;
            prev = None;
            h = h.min(hmax * 0.1).max(hmin);
        } else if err > 1.0 {
            // Accepted only because h hit the floor: start growing again rather than stall.
            after_breakpoint = false;
            h *= 2.0;
        } else {
            after_breakpoint = false;
            let grow = if err > 0.0 { (0.9 / err.sqrt()).clamp(0.2, 2.0) } else { 2.0 };
            // Only change h for a worthwhile gain: an unchanged h reuses the cached LU factors.
            if !(0.8..1.5).contains(&grow) {
                h *= grow;
            }
        }
    }

    // Keep only t ≥ tstart, then thin out if the response would be huge.
    let first = time.iter().position(|&tt| tt >= s.tstart - hmin).unwrap_or(0);
    let columns = circuit.num_nodes + if store_currents { circuit.components.len() } else { 0 };
    let max_points = (2_000_000 / columns.max(1)).clamp(200, 5000);
    let kept: Vec<usize> = {
        let idx: Vec<usize> = (first..time.len()).collect();
        if idx.len() <= max_points {
            idx
        } else {
            let stride = (idx.len() as f64 / max_points as f64).ceil() as usize;
            let mut k: Vec<usize> = idx.iter().copied().step_by(stride).collect();
            if k.last() != idx.last() {
                k.push(*idx.last().unwrap());
            }
            k
        }
    };
    let decimated = kept.len() < time.len() - first;

    let mut node_voltages: HashMap<String, Vec<f64>> = HashMap::new();
    for (idx, name) in circuit.node_names.iter().enumerate().skip(1) {
        node_voltages.insert(name.clone(), kept.iter().map(|&k| states[k][idx - 1]).collect());
    }
    let mut terminal_currents: HashMap<String, Vec<f64>> = HashMap::new();
    if store_currents {
        for (col, (key, _)) in terminals.first().map(|r| r.as_slice()).unwrap_or(&[]).iter().enumerate() {
            terminal_currents.insert(key.clone(), kept.iter().map(|&k| terminals[k][col].1).collect());
        }
    }
    let mut branch_currents: HashMap<String, Vec<f64>> = HashMap::new();
    if store_currents {
        for (ci, c) in circuit.components.iter().enumerate() {
            branch_currents.insert(c.name.clone(), kept.iter().map(|&k| currents[k][ci].1).collect());
        }
    }

    Ok(TransientResult {
        method: s.method,
        time: kept.iter().map(|&k| time[k]).collect(),
        node_voltages,
        branch_currents,
        step_sizes: kept.iter().map(|&k| step_sizes[k]).collect(),
        accepted_steps: accepted,
        rejected_steps: rejected,
        factorizations,
        breakpoints: breakpoints.into_iter().filter(|&b| b < tstop).collect(),
        tstop,
        decimated,
        terminal_currents,
    })
}

// ---------------------------------------------------------------- Transfer Function (.tf)

pub fn tf_analysis(circuit: &Circuit, mna: &MnaSystem, g_matrix: &CsrMatrix, out_var: &str, in_src: &str) -> Result<TfResult, String> {
    let aux_in = circuit
        .aux_index
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(in_src))
        .map(|(_, &idx)| idx)
        .ok_or_else(|| format!("Transfer function input source '{}' not found (must be a voltage source)", in_src))?;

    let lu_g = SparseLuFactors::factor(g_matrix)
        .map_err(|e| format!("TF failed to factorize G: {}", e))?;

    // Differentiate G x = b with respect to Vin
    let mut rhs_in = vec![0.0; mna.dimension];
    rhs_in[aux_in] = 1.0;
    let dx_dvin = lu_g.solve(&rhs_in)
        .map_err(|e| format!("TF failed to solve for sensitivity: {}", e))?;

    // Parse output variable: e.g. "V(out)", "V(1)", or "out"
    let clean_node = out_var.trim()
        .trim_start_matches("V(")
        .trim_start_matches("v(")
        .trim_end_matches(')')
        .trim();
    let out_node_idx = circuit
        .node_to_idx
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(clean_node))
        .map(|(_, &idx)| idx)
        .ok_or_else(|| format!("TF output node '{}' not found", clean_node))?;

    let tf_gain = if out_node_idx > 0 { dx_dvin[out_node_idx - 1] } else { 0.0 };

    // Input resistance Rin = dVin / |dIin|
    let di_dvin = dx_dvin[aux_in].abs();
    let rin = if di_dvin > 1e-18 { 1.0 / di_dvin } else { f64::INFINITY };

    // Output resistance Rout: apply test current 1A at out_node with all sources killed
    let rout = if out_node_idx > 0 {
        let mut rhs_out = vec![0.0; mna.dimension];
        rhs_out[out_node_idx - 1] = 1.0;
        lu_g.solve(&rhs_out).map(|x| x[out_node_idx - 1].abs()).unwrap_or(0.0)
    } else {
        0.0
    };

    Ok(TfResult {
        output_variable: out_var.to_string(),
        input_source: in_src.to_string(),
        transfer_function: tf_gain,
        input_resistance: rin,
        output_resistance: rout,
    })
}

// ---------------------------------------------------------------- Measurements (.meas)

pub fn evaluate_measurements(
    circuit: &Circuit,
    transient: Option<&TransientResult>,
    ac: Option<&AcResult>,
    dc: Option<&DcSweepResult>,
) -> Vec<MeasResult> {
    let mut results = Vec::new();
    for analysis in &circuit.analyses {
        if let crate::models::Analysis::Measure { target_analysis, name, metric, variable } = analysis {
            let metric_up = metric.to_ascii_uppercase();
            let clean_var = variable.trim()
                .trim_start_matches("V(")
                .trim_start_matches("v(")
                .trim_end_matches(')')
                .trim();

            if target_analysis.eq_ignore_ascii_case("tran") {
                if let Some(tr) = transient {
                    if let Some(waveform) = tr.node_voltages.get(clean_var) {
                        if !waveform.is_empty() {
                            let val = match metric_up.as_str() {
                                "MAX" => waveform.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b)),
                                "MIN" => waveform.iter().fold(f64::INFINITY, |a, &b| a.min(b)),
                                "PP" | "PKPK" => {
                                    let mx = waveform.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b));
                                    let mn = waveform.iter().fold(f64::INFINITY, |a, &b| a.min(b));
                                    mx - mn
                                }
                                "AVG" => waveform.iter().sum::<f64>() / waveform.len() as f64,
                                "RMS" => (waveform.iter().map(|v| v * v).sum::<f64>() / waveform.len() as f64).sqrt(),
                                _ => 0.0,
                            };
                            results.push(MeasResult {
                                name: name.clone(),
                                analysis: "tran".to_string(),
                                metric: metric.clone(),
                                variable: variable.clone(),
                                value: val,
                            });
                        }
                    }
                }
            } else if target_analysis.eq_ignore_ascii_case("ac") {
                if let Some(ac_res) = ac {
                    if let Some(mags) = ac_res.node_magnitude.get(clean_var) {
                        if !mags.is_empty() {
                            let val = match metric_up.as_str() {
                                "MAX" => mags.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b)),
                                "MIN" => mags.iter().fold(f64::INFINITY, |a, &b| a.min(b)),
                                "AVG" => mags.iter().sum::<f64>() / mags.len() as f64,
                                _ => mags[0],
                            };
                            results.push(MeasResult {
                                name: name.clone(),
                                analysis: "ac".to_string(),
                                metric: metric.clone(),
                                variable: variable.clone(),
                                value: val,
                            });
                        }
                    }
                }
            } else if target_analysis.eq_ignore_ascii_case("dc") {
                if let Some(dc_res) = dc {
                    if let Some(waveform) = dc_res.node_voltages.get(clean_var) {
                        if !waveform.is_empty() {
                            let val = match metric_up.as_str() {
                                "MAX" => waveform.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b)),
                                "MIN" => waveform.iter().fold(f64::INFINITY, |a, &b| a.min(b)),
                                "PP" | "PKPK" => {
                                    let mx = waveform.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b));
                                    let mn = waveform.iter().fold(f64::INFINITY, |a, &b| a.min(b));
                                    mx - mn
                                }
                                "AVG" => waveform.iter().sum::<f64>() / waveform.len() as f64,
                                "RMS" => (waveform.iter().map(|v| v * v).sum::<f64>() / waveform.len() as f64).sqrt(),
                                _ => waveform[0],
                            };
                            results.push(MeasResult {
                                name: name.clone(),
                                analysis: "dc".to_string(),
                                metric: metric.clone(),
                                variable: variable.clone(),
                                value: val,
                            });
                        }
                    }
                }
            }
        }
    }
    results
}
