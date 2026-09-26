//! Milestone 3: nonlinear devices (diode, BJT, MOSFET) solved by Newton–Raphson.
//!
//! Every device is linearized around the current guess into *branches*: a current from node p
//! to node q equal to  I0 + Σ g·(V(cp) − V(cn)).  Stamping those into the MNA matrix gives the
//! Jacobian system J·x = rhs whose solution is the next guess. The same branches, without I0,
//! are the small-signal model used by AC analysis.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::models::{Circuit, Component, ComponentType};
use crate::solvers::sparse_lu::{CsrMatrix, SparseLuFactors};

/// Thermal voltage kT/q at 300 K.
pub const VT: f64 = 0.025852;
/// Conductance SPICE places across every junction to keep the Jacobian nonsingular.
pub const GMIN_JUNCTION: f64 = 1e-12;
const MAX_ITER: usize = 150;
const RELTOL: f64 = 1e-6;
const VNTOL: f64 = 1e-9;
const ABSTOL: f64 = 1e-12;
const EXP_LIMIT: f64 = 80.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalCurrent {
    pub role: String,
    pub node: String,
    /// Current flowing from the node INTO the device at this terminal (A).
    pub current: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceOp {
    pub name: String,
    pub kind: String,
    pub region: String,
    /// Named quantities for display, e.g. ("Vd", 0.65), ("gm", 0.04).
    pub quantities: Vec<(String, f64)>,
    pub terminals: Vec<TerminalCurrent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewtonIteration {
    pub iteration: usize,
    /// Largest change of any unknown in this iteration.
    pub max_dx: f64,
    /// True if junction-voltage limiting clipped a step (the guess was not yet trustworthy).
    pub limited: bool,
    /// Solution after this iteration (educational-size systems only).
    pub x: Vec<f64>,
    /// Device linearization points used in this iteration (educational-size systems only).
    pub devices: Vec<DeviceOp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewtonLog {
    pub converged: bool,
    /// "newton", "gmin stepping" or "source stepping": what it took to converge.
    pub strategy: String,
    /// Iterations of the final (successful) Newton run.
    pub iterations: Vec<NewtonIteration>,
    /// All iterations including any gmin/source-stepping continuation.
    pub total_iterations: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DcSweepResult {
    pub source: String,
    pub values: Vec<f64>,
    pub node_voltages: HashMap<String, Vec<f64>>,
    pub branch_currents: HashMap<String, Vec<f64>>,
    pub newton_iterations: usize,
}

/// A linearized current from node p to node q: I0 + Σ g·(V(cp) − V(cn)). Node indices, 0 = ground.
#[derive(Debug, Clone)]
pub struct Branch {
    pub p: usize,
    pub q: usize,
    pub i0: f64,
    pub ctrls: Vec<(usize, usize, f64)>,
}

fn v_at(x: &[f64], node: usize) -> f64 {
    if node == 0 { 0.0 } else { x[node - 1] }
}

fn safe_exp(v: f64) -> f64 {
    v.min(EXP_LIMIT).exp()
}

/// SPICE `pnjlim`: stops a junction voltage from jumping so far up the exponential that the next
/// linearization is useless (or overflows). Returns (limited voltage, whether it was limited).
pub fn pnjlim(vnew: f64, vold: f64, nvt: f64, vcrit: f64) -> (f64, bool) {
    if vold.is_nan() {
        // First iteration: just keep the guess out of the far exponential.
        return if vnew > vcrit { (vcrit, true) } else { (vnew, false) };
    }
    if vnew > vcrit && (vnew - vold).abs() > 2.0 * nvt {
        if vold > 0.0 {
            let arg = 1.0 + (vnew - vold) / nvt;
            if arg > 0.0 { (vold + nvt * arg.ln(), true) } else { (vcrit, true) }
        } else {
            (nvt * (vnew / nvt).ln(), true)
        }
    } else {
        (vnew, false)
    }
}

/// Keeps a MOSFET gate drive from swinging more than 0.5 V per iteration once it has a history.
fn fetlim(vnew: f64, vold: f64) -> (f64, bool) {
    if vold.is_nan() || (vnew - vold).abs() <= 0.5 {
        (vnew, false)
    } else {
        (vold + 0.5 * (vnew - vold).signum(), true)
    }
}

pub fn device_indices(circuit: &Circuit) -> Vec<usize> {
    circuit.components.iter().enumerate().filter(|(_, c)| c.comp_type.is_nonlinear()).map(|(i, _)| i).collect()
}

/// Linearizes one device at `x`. `state` carries the previous (limited) junction voltages
/// between iterations; with `limit = false` the device is evaluated exactly at `x`.
pub fn linearize_device(circuit: &Circuit, comp: &Component, x: &[f64], state: &mut [f64; 2], limit: bool) -> (Vec<Branch>, DeviceOp, bool) {
    let idx = |n: &str| circuit.node_to_idx[n];
    match comp.comp_type {
        ComponentType::Diode { is, n } => {
            let (a, k) = (idx(&comp.node1), idx(&comp.node2));
            let nvt = n * VT;
            let vcrit = nvt * (nvt / (std::f64::consts::SQRT_2 * is)).ln();
            let vraw = v_at(x, a) - v_at(x, k);
            let (vd, limited) = if limit { pnjlim(vraw, state[0], nvt, vcrit) } else { (vraw, false) };
            state[0] = vd;
            let e = safe_exp(vd / nvt);
            let id = is * (e - 1.0) + GMIN_JUNCTION * vd;
            let g = is * e / nvt + GMIN_JUNCTION;
            let region = if id > 1e-6 { "forward (conducting)" } else if vd < 0.0 { "reverse (blocking)" } else { "off (below the knee)" };
            let op = DeviceOp {
                name: comp.name.clone(),
                kind: "diode".into(),
                region: region.into(),
                quantities: vec![("Vd".into(), vd), ("Id".into(), id), ("g".into(), g), ("rd".into(), 1.0 / g)],
                terminals: vec![
                    TerminalCurrent { role: "anode".into(), node: comp.node1.clone(), current: id },
                    TerminalCurrent { role: "cathode".into(), node: comp.node2.clone(), current: -id },
                ],
            };
            (vec![Branch { p: a, q: k, i0: id - g * vd, ctrls: vec![(a, k, g)] }], op, limited)
        }
        ComponentType::Bjt { is, bf, br, npn } => {
            let p = if npn { 1.0 } else { -1.0 };
            let (c, b, e) = (idx(&comp.node1), idx(&comp.node2), idx(&comp.extra_nodes[0]));
            let vcrit = VT * (VT / (std::f64::consts::SQRT_2 * is)).ln();
            let vbe_raw = p * (v_at(x, b) - v_at(x, e));
            let vbc_raw = p * (v_at(x, b) - v_at(x, c));
            let (vbe, l1) = if limit { pnjlim(vbe_raw, state[0], VT, vcrit) } else { (vbe_raw, false) };
            let (vbc, l2) = if limit { pnjlim(vbc_raw, state[1], VT, vcrit) } else { (vbc_raw, false) };
            state[0] = vbe;
            state[1] = vbc;
            let (ebe, ebc) = (safe_exp(vbe / VT), safe_exp(vbc / VT));
            // Transport model: collector transport current plus two junction (base) currents
            let i_be = is / bf * (ebe - 1.0) + GMIN_JUNCTION * vbe;
            let g_be = is / (bf * VT) * ebe + GMIN_JUNCTION;
            let i_bc = is / br * (ebc - 1.0) + GMIN_JUNCTION * vbc;
            let g_bc = is / (br * VT) * ebc + GMIN_JUNCTION;
            let i_cc = is * (ebe - ebc);
            let (gm_f, gm_r) = (is / VT * ebe, -is / VT * ebc);
            let ic = p * (i_cc - i_bc);
            let ib = p * (i_be + i_bc);
            let region = match (vbe > 0.5, vbc > 0.5) {
                (true, false) => "forward active (amplifying)",
                (true, true) => "saturation (switch on)",
                (false, false) => "cutoff (switch off)",
                (false, true) => "reverse active",
            };
            let op = DeviceOp {
                name: comp.name.clone(),
                kind: if npn { "npn" } else { "pnp" }.into(),
                region: region.into(),
                quantities: vec![
                    ("Vbe".into(), vbe), ("Vce".into(), vbe - vbc), ("Ic".into(), ic), ("Ib".into(), ib),
                    ("beta".into(), if ib.abs() > 1e-18 { ic / ib } else { 0.0 }), ("gm".into(), gm_f), ("rpi".into(), 1.0 / g_be),
                ],
                terminals: vec![
                    TerminalCurrent { role: "collector".into(), node: comp.node1.clone(), current: ic },
                    TerminalCurrent { role: "base".into(), node: comp.node2.clone(), current: ib },
                    TerminalCurrent { role: "emitter".into(), node: comp.extra_nodes[0].clone(), current: -(ic + ib) },
                ],
            };
            // Node orientation: currents × p; conductances unchanged (p² = 1).
            let branches = vec![
                Branch { p: b, q: e, i0: p * (i_be - g_be * vbe), ctrls: vec![(b, e, g_be)] },
                Branch { p: b, q: c, i0: p * (i_bc - g_bc * vbc), ctrls: vec![(b, c, g_bc)] },
                Branch { p: c, q: e, i0: p * (i_cc - gm_f * vbe - gm_r * vbc), ctrls: vec![(b, e, gm_f), (b, c, gm_r)] },
            ];
            (branches, op, l1 || l2)
        }
        ComponentType::Mosfet { vto, kp, lambda, w, l, nmos } => {
            let p = if nmos { 1.0 } else { -1.0 };
            let (d0, g, s0) = (idx(&comp.node1), idx(&comp.node2), idx(&comp.extra_nodes[0]));
            // The device is symmetric: whichever end is lower (for NMOS) acts as the source.
            let reversed = p * (v_at(x, d0) - v_at(x, s0)) < 0.0;
            let (d, s) = if reversed { (s0, d0) } else { (d0, s0) };
            let vgs_raw = p * (v_at(x, g) - v_at(x, s));
            let vds = p * (v_at(x, d) - v_at(x, s));
            let (vgs, limited) = if limit { fetlim(vgs_raw, state[0]) } else { (vgs_raw, false) };
            state[0] = vgs;
            let beta = kp * w / l;
            let vov = vgs - vto * p; // PMOS thresholds are written negative (VTO = −0.7)
            let (mut id, gm, mut gds, region) = if vov <= 0.0 {
                (0.0, 0.0, 0.0, "cutoff (off)")
            } else if vds < vov {
                let core = vov * vds - vds * vds / 2.0;
                (beta * core * (1.0 + lambda * vds), beta * vds * (1.0 + lambda * vds),
                 beta * (vov - vds) * (1.0 + lambda * vds) + beta * core * lambda, "triode (linear, like a resistor)")
            } else {
                (beta / 2.0 * vov * vov * (1.0 + lambda * vds), beta * vov * (1.0 + lambda * vds),
                 beta / 2.0 * vov * vov * lambda, "saturation (amplifying)")
            };
            id += GMIN_JUNCTION * vds;
            gds += GMIN_JUNCTION;
            let id_node = p * id; // current into the effective drain
            let (id_real_drain, id_real_source) = if reversed { (-id_node, id_node) } else { (id_node, -id_node) };
            let op = DeviceOp {
                name: comp.name.clone(),
                kind: if nmos { "nmos" } else { "pmos" }.into(),
                region: region.into(),
                quantities: vec![
                    ("Vgs".into(), vgs), ("Vds".into(), vds), ("Vov".into(), vov.max(0.0)), ("Id".into(), id_real_drain),
                    ("gm".into(), gm), ("gds".into(), gds),
                ],
                terminals: vec![
                    TerminalCurrent { role: "drain".into(), node: comp.node1.clone(), current: id_real_drain },
                    TerminalCurrent { role: "gate".into(), node: comp.node2.clone(), current: 0.0 },
                    TerminalCurrent { role: "source".into(), node: comp.extra_nodes[0].clone(), current: id_real_source },
                ],
            };
            let branches = vec![Branch { p: d, q: s, i0: p * (id - gm * vgs - gds * vds), ctrls: vec![(g, s, gm), (d, s, gds)] }];
            (branches, op, limited)
        }
        _ => (Vec::new(), DeviceOp { name: comp.name.clone(), kind: String::new(), region: String::new(), quantities: vec![], terminals: vec![] }, false),
    }
}

/// Adds a branch's Jacobian entries (and, with `rhs`, its companion current) to the system.
pub fn stamp_branch(br: &Branch, entries: &mut BTreeMap<(usize, usize), f64>, rhs: Option<&mut [f64]>) {
    let mut add = |r: usize, c: usize, v: f64| {
        if r > 0 && c > 0 {
            *entries.entry((r - 1, c - 1)).or_insert(0.0) += v;
        }
    };
    for &(cp, cn, gv) in &br.ctrls {
        add(br.p, cp, gv);
        add(br.p, cn, -gv);
        add(br.q, cp, -gv);
        add(br.q, cn, gv);
    }
    if let Some(rhs) = rhs {
        if br.p > 0 { rhs[br.p - 1] -= br.i0; }
        if br.q > 0 { rhs[br.q - 1] += br.i0; }
    }
}

fn entries_of(a: &CsrMatrix) -> BTreeMap<(usize, usize), f64> {
    let mut m = BTreeMap::new();
    for i in 0..a.dimension {
        for (c, v) in a.row(i) {
            m.insert((i, c), v);
        }
    }
    m
}

/// Jacobian and right-hand side linearized exactly at `x` (used for display and residuals).
pub fn linearized_system(circuit: &Circuit, a_lin: &CsrMatrix, b: &[f64], x: &[f64]) -> (BTreeMap<(usize, usize), f64>, Vec<f64>, Vec<(usize, Vec<Branch>, DeviceOp)>) {
    let mut entries = entries_of(a_lin);
    let mut rhs = b.to_vec();
    let mut per_device = Vec::new();
    for d in device_indices(circuit) {
        let mut st = [f64::NAN; 2];
        let (branches, op, _) = linearize_device(circuit, &circuit.components[d], x, &mut st, false);
        for br in &branches {
            stamp_branch(br, &mut entries, Some(&mut rhs));
        }
        per_device.push((d, branches, op));
    }
    (entries, rhs, per_device)
}

/// G plus every device's small-signal conductances at the operating point `x` (for AC).
pub fn small_signal_matrix(circuit: &Circuit, g: &CsrMatrix, x: &[f64]) -> CsrMatrix {
    let mut entries = entries_of(g);
    for d in device_indices(circuit) {
        let mut st = [f64::NAN; 2];
        let (branches, _, _) = linearize_device(circuit, &circuit.components[d], x, &mut st, false);
        for br in &branches {
            stamp_branch(br, &mut entries, None);
        }
    }
    CsrMatrix::from_sorted_triplets(g.dimension, entries.into_iter())
}

/// Device operating points evaluated exactly at `x`.
pub fn device_ops_at(circuit: &Circuit, x: &[f64]) -> Vec<DeviceOp> {
    device_indices(circuit)
        .into_iter()
        .map(|d| {
            let mut st = [f64::NAN; 2];
            linearize_device(circuit, &circuit.components[d], x, &mut st, false).1
        })
        .collect()
}

/// max |A_lin·x + (device currents) − b|: the true (nonlinear) KCL residual.
pub fn nonlinear_residual(circuit: &Circuit, a_lin: &CsrMatrix, b: &[f64], x: &[f64]) -> f64 {
    let mut r: Vec<f64> = a_lin.matvec(x).iter().zip(b).map(|(ax, bi)| ax - bi).collect();
    for op in device_ops_at(circuit, x) {
        for t in &op.terminals {
            let n = circuit.node_to_idx[&t.node];
            if n > 0 {
                r[n - 1] += t.current;
            }
        }
    }
    r.iter().fold(0.0, |m, v| m.max(v.abs()))
}

struct NewtonSettings {
    extra_gmin: f64,
    source_scale: f64,
    record: bool,
}

/// One Newton–Raphson run. Returns the solution, or the last iterate on failure.
fn newton(
    circuit: &Circuit,
    devices: &[usize],
    a_lin: &CsrMatrix,
    b: &[f64],
    x0: &[f64],
    settings: &NewtonSettings,
    log: &mut Vec<NewtonIteration>,
    count: &mut usize,
) -> Result<Vec<f64>, (String, Vec<f64>)> {
    let n = a_lin.dimension;
    let base = entries_of(a_lin);
    let mut x = x0.to_vec();
    let mut states = vec![[f64::NAN; 2]; devices.len()];

    for it in 1..=MAX_ITER {
        *count += 1;
        let mut entries = base.clone();
        let mut rhs: Vec<f64> = b.iter().map(|v| v * settings.source_scale).collect();
        if settings.extra_gmin > 0.0 {
            for i in 0..circuit.num_nodes {
                *entries.entry((i, i)).or_insert(0.0) += settings.extra_gmin;
            }
        }
        let mut limited = false;
        let mut ops = Vec::new();
        for (k, &d) in devices.iter().enumerate() {
            let (branches, op, lim) = linearize_device(circuit, &circuit.components[d], &x, &mut states[k], true);
            limited |= lim;
            for br in &branches {
                stamp_branch(br, &mut entries, Some(&mut rhs));
            }
            if settings.record {
                ops.push(op);
            }
        }
        let jac = CsrMatrix::from_sorted_triplets(n, entries.into_iter());
        let x_new = match SparseLuFactors::factor(&jac).and_then(|lu| lu.solve(&rhs)) {
            Ok(v) => v,
            Err(e) => return Err((format!("Newton iteration {} hit a singular Jacobian: {}", it, e), x)),
        };
        if x_new.iter().any(|v| !v.is_finite()) {
            return Err((format!("Newton iteration {} produced non-finite values", it), x));
        }
        let mut max_dx = 0.0f64;
        let mut converged = true;
        for i in 0..n {
            let dx = (x_new[i] - x[i]).abs();
            max_dx = max_dx.max(dx);
            let tol = RELTOL * x_new[i].abs().max(x[i].abs()) + if i < circuit.num_nodes { VNTOL } else { ABSTOL };
            if dx > tol {
                converged = false;
            }
        }
        if settings.record {
            log.push(NewtonIteration { iteration: it, max_dx, limited, x: x_new.clone(), devices: ops });
        }
        x = x_new;
        if converged && !limited && it > 1 {
            return Ok(x);
        }
    }
    Err((format!("Newton–Raphson did not converge in {} iterations", MAX_ITER), x))
}

/// Solves the nonlinear system A_lin·x + i_dev(x) = b. Tries plain Newton first, then the two
/// SPICE continuation strategies: gmin stepping (start with every node leaking heavily to ground
/// and tighten), then source stepping (ramp the sources up from zero).
pub fn solve_nonlinear(circuit: &Circuit, a_lin: &CsrMatrix, b: &[f64], x0: Option<&[f64]>, record: bool) -> Result<(Vec<f64>, NewtonLog), String> {
    let devices = device_indices(circuit);
    let start = x0.map(|v| v.to_vec()).unwrap_or_else(|| vec![0.0; a_lin.dimension]);
    let mut total = 0usize;
    let plain = NewtonSettings { extra_gmin: 0.0, source_scale: 1.0, record };

    let mut log = Vec::new();
    let first_err = match newton(circuit, &devices, a_lin, b, &start, &plain, &mut log, &mut total) {
        Ok(x) => return Ok((x, NewtonLog { converged: true, strategy: "newton".into(), iterations: log, total_iterations: total })),
        Err((e, _)) => e,
    };

    // gmin stepping
    let quiet = |g: f64, s: f64| NewtonSettings { extra_gmin: g, source_scale: s, record: false };
    let mut x = start.clone();
    let mut gmin = 1e-2;
    let mut ok = true;
    while gmin > 1e-13 {
        match newton(circuit, &devices, a_lin, b, &x, &quiet(gmin, 1.0), &mut Vec::new(), &mut total) {
            Ok(v) => { x = v; gmin /= 10.0; }
            Err(_) => { ok = false; break; }
        }
    }
    if ok {
        let mut log = Vec::new();
        if let Ok(v) = newton(circuit, &devices, a_lin, b, &x, &plain, &mut log, &mut total) {
            return Ok((v, NewtonLog { converged: true, strategy: "gmin stepping".into(), iterations: log, total_iterations: total }));
        }
    }

    // source stepping
    let mut x = vec![0.0; a_lin.dimension];
    for k in 0..=20 {
        let scale = k as f64 / 20.0;
        match newton(circuit, &devices, a_lin, b, &x, &quiet(0.0, scale), &mut Vec::new(), &mut total) {
            Ok(v) => x = v,
            Err(_) => {
                return Err(format!(
                    "{}. Gmin stepping and source stepping also failed (at {:.0}% of the sources). Check for devices with no DC path or unrealistic values.",
                    first_err, scale * 100.0
                ))
            }
        }
    }
    let mut log = Vec::new();
    match newton(circuit, &devices, a_lin, b, &x, &plain, &mut log, &mut total) {
        Ok(v) => Ok((v, NewtonLog { converged: true, strategy: "source stepping".into(), iterations: log, total_iterations: total })),
        Err((e, _)) => Err(e),
    }
}

/// Main current of each element for reporting (node1 → node2 for two-terminal elements,
/// collector/drain current for transistors).
pub fn element_currents_at(circuit: &Circuit, x: &[f64], ops: &[DeviceOp]) -> HashMap<String, f64> {
    let v = |node: &str| v_at(x, circuit.node_to_idx[node]);
    let dev: HashMap<&str, &DeviceOp> = ops.iter().map(|o| (o.name.as_str(), o)).collect();
    circuit
        .components
        .iter()
        .map(|c| {
            let i = match c.comp_type {
                ComponentType::Resistor { r_val } => (v(&c.node1) - v(&c.node2)) / r_val,
                ComponentType::CurrentSource { i_val } => i_val,
                ComponentType::VoltageSource { .. } | ComponentType::Inductor { .. } => x[circuit.aux_index[&c.name]],
                ComponentType::Capacitor { .. } => 0.0,
                _ => dev.get(c.name.as_str()).and_then(|o| o.terminals.first()).map(|t| t.current).unwrap_or(0.0),
            };
            (c.name.clone(), i)
        })
        .collect()
}

const MAX_SWEEP_POINTS: usize = 10_001;

/// `.dc SRC start stop step`: re-solves the operating point for each source value, starting each
/// Newton solve from the previous point's answer (continuation) so steep curves converge quickly.
pub fn dc_sweep(circuit: &Circuit, g: &CsrMatrix, source: &str, start: f64, stop: f64, step: f64) -> Result<DcSweepResult, String> {
    let k = circuit
        .components
        .iter()
        .position(|c| c.name.eq_ignore_ascii_case(source) && matches!(c.comp_type, ComponentType::VoltageSource { .. } | ComponentType::CurrentSource { .. }))
        .ok_or_else(|| format!(".dc sweeps a voltage or current source, but '{}' is not one in this circuit.", source))?;
    if step == 0.0 {
        return Err(".dc step must be non-zero.".into());
    }
    let n_points = ((stop - start) / step).floor() as i64 + 1;
    if n_points < 1 || n_points as usize > MAX_SWEEP_POINTS {
        return Err(format!(".dc {} {} {} {} gives {} points; use between 1 and {}.", source, start, stop, step, n_points, MAX_SWEEP_POINTS));
    }
    let nonlinear = circuit.components.iter().any(|c| c.comp_type.is_nonlinear());
    let linear_lu = if nonlinear { None } else { Some(SparseLuFactors::factor(g).map_err(|e| format!(".dc sweep: {}", e))?) };

    let mut sweep_circuit = circuit.clone();
    let mut values = Vec::with_capacity(n_points as usize);
    let mut node_voltages: HashMap<String, Vec<f64>> = HashMap::new();
    let mut branch_currents: HashMap<String, Vec<f64>> = HashMap::new();
    let mut x_prev: Option<Vec<f64>> = None;
    let mut iterations = 0;

    for i in 0..n_points as usize {
        let value = start + step * i as f64;
        match &mut sweep_circuit.components[k].comp_type {
            ComponentType::VoltageSource { v_val } => *v_val = value,
            ComponentType::CurrentSource { i_val } => *i_val = value,
            _ => unreachable!(),
        }
        let b = crate::mna::source_rhs(&sweep_circuit, None);
        let x = match &linear_lu {
            Some(lu) => lu.solve(&b)?,
            None => {
                let (x, log) = solve_nonlinear(&sweep_circuit, g, &b, x_prev.as_deref(), false)
                    .map_err(|e| format!(".dc sweep failed at {} = {}: {}", source, value, e))?;
                iterations += log.total_iterations;
                x
            }
        };
        let ops = if nonlinear { device_ops_at(&sweep_circuit, &x) } else { Vec::new() };
        for (idx, name) in circuit.node_names.iter().enumerate().skip(1) {
            node_voltages.entry(name.clone()).or_default().push(x[idx - 1]);
        }
        for (name, cur) in element_currents_at(&sweep_circuit, &x, &ops) {
            branch_currents.entry(name).or_default().push(cur);
        }
        values.push(value);
        x_prev = Some(x);
    }

    Ok(DcSweepResult { source: circuit.components[k].name.clone(), values, node_voltages, branch_currents, newton_iterations: iterations })
}
