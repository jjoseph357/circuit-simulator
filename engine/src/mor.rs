//! Model Order Reduction (MOR) module for interconnect and macromodeling (EE 898).
//!
//! Implements:
//! 1. Circuit Moments computation (Taylor expansion of (G + sC)^(-1) b)
//! 2. Elmore Delay estimation for RC/RLC interconnect networks (first moment)
//! 3. Arnoldi Process via Modified Gram-Schmidt on Krylov subspace K_q(G^(-1) C, G^(-1) b)
//! 4. PRIMA (Passive Reduced-order Interconnect Macromodeling Algorithm)
//! 5. Passivity-preserving reduced matrices G_tilde = V^T G V and C_tilde = V^T C V
//! 6. Reduced-order frequency response and pole extraction

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

use crate::models::Circuit;
use crate::mna::MnaSystem;
use crate::solvers::sparse_lu::{CsrMatrix, SparseLuFactors};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MorResult {
    pub order: usize,
    pub output_node: String,
    /// Low-order circuit moments [m0, m1, m2, ...] at output node
    pub moments: Vec<f64>,
    /// Elmore delay at nodes: tau = -m1 / m0 (seconds)
    pub elmore_delays: HashMap<String, f64>,
    /// Reduced model dimension (order k <= q)
    pub reduced_dimension: usize,
    /// Dominant poles of the reduced-order macromodel: (real, imag)
    pub poles: Vec<(f64, f64)>,
    /// Frequency points used for verification
    pub frequencies: Vec<f64>,
    pub original_magnitude: Vec<f64>,
    pub reduced_magnitude: Vec<f64>,
    pub error_max_rel: f64,
    /// Reduced passive matrices
    pub reduced_g: Vec<Vec<f64>>,
    pub reduced_c: Vec<Vec<f64>>,
}

/// Solves a small dense complex system (A_r + j A_i) x = (b_r + j b_i)
fn solve_small_complex_system(ar: &[Vec<f64>], ai: &[Vec<f64>], br: &[f64], bi: &[f64]) -> Result<(Vec<f64>, Vec<f64>), String> {
    let k = ar.len();
    let mut mat = vec![vec![0.0; 2 * k]; 2 * k];
    let mut rhs = vec![0.0; 2 * k];

    for i in 0..k {
        rhs[i] = br[i];
        rhs[i + k] = bi[i];
        for j in 0..k {
            mat[i][j] = ar[i][j];
            mat[i][j + k] = -ai[i][j];
            mat[i + k][j] = ai[i][j];
            mat[i + k][j + k] = ar[i][j];
        }
    }

    let n = 2 * k;
    for i in 0..n {
        let mut pivot = i;
        let mut max_val = mat[i][i].abs();
        for r in (i + 1)..n {
            if mat[r][i].abs() > max_val {
                max_val = mat[r][i].abs();
                pivot = r;
            }
        }
        if max_val < 1e-15 {
            return Err("Singular reduced system".to_string());
        }
        if pivot != i {
            mat.swap(i, pivot);
            rhs.swap(i, pivot);
        }
        let p_val = mat[i][i];
        for j in i..n {
            mat[i][j] /= p_val;
        }
        rhs[i] /= p_val;

        for r in 0..n {
            if r != i {
                let factor = mat[r][i];
                if factor != 0.0 {
                    for j in i..n {
                        mat[r][j] -= factor * mat[i][j];
                    }
                    rhs[r] -= factor * rhs[i];
                }
            }
        }
    }

    let xr = rhs[0..k].to_vec();
    let xi = rhs[k..2 * k].to_vec();
    Ok((xr, xi))
}

fn invert_small_matrix(m: &[Vec<f64>]) -> Option<Vec<Vec<f64>>> {
    let n = m.len();
    let mut a = vec![vec![0.0; 2 * n]; n];
    for i in 0..n {
        for j in 0..n {
            a[i][j] = m[i][j];
        }
        a[i][i + n] = 1.0;
    }
    for i in 0..n {
        let mut pivot = i;
        let mut max_val = a[i][i].abs();
        for r in (i + 1)..n {
            if a[r][i].abs() > max_val {
                max_val = a[r][i].abs();
                pivot = r;
            }
        }
        if max_val < 1e-15 {
            return None;
        }
        a.swap(i, pivot);
        let p_val = a[i][i];
        for j in i..(2 * n) {
            a[i][j] /= p_val;
        }
        for r in 0..n {
            if r != i {
                let factor = a[r][i];
                if factor.abs() > 1e-18 {
                    for j in i..(2 * n) {
                        a[r][j] -= factor * a[i][j];
                    }
                }
            }
        }
    }
    let mut inv = vec![vec![0.0; n]; n];
    for i in 0..n {
        for j in 0..n {
            inv[i][j] = a[i][j + n];
        }
    }
    Some(inv)
}

fn extract_reduced_poles(g_red: &[Vec<f64>], c_red: &[Vec<f64>]) -> Vec<(f64, f64)> {
    let k = g_red.len();
    if k == 0 {
        return Vec::new();
    }
    if k == 1 {
        if c_red[0][0].abs() > 1e-18 {
            return vec![(-g_red[0][0] / c_red[0][0], 0.0)];
        } else {
            return Vec::new();
        }
    }

    let c_inv = match invert_small_matrix(c_red) {
        Some(inv) => inv,
        None => {
            let mut reg_c = c_red.to_vec();
            for i in 0..k {
                reg_c[i][i] += 1e-12;
            }
            match invert_small_matrix(&reg_c) {
                Some(inv) => inv,
                None => return Vec::new(),
            }
        }
    };

    let mut a = vec![vec![0.0; k]; k];
    for i in 0..k {
        for j in 0..k {
            for m in 0..k {
                a[i][j] -= c_inv[i][m] * g_red[m][j];
            }
        }
    }

    // Modified Gram-Schmidt QR iterations
    for _ in 0..150 {
        let mut q = vec![vec![0.0; k]; k];
        let mut r = vec![vec![0.0; k]; k];

        for j in 0..k {
            let mut v: Vec<f64> = (0..k).map(|i| a[i][j]).collect();
            for i in 0..j {
                let dot: f64 = (0..k).map(|m| q[m][i] * v[m]).sum();
                r[i][j] = dot;
                for m in 0..k {
                    v[m] -= dot * q[m][i];
                }
            }
            let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
            r[j][j] = norm;
            if norm > 1e-15 {
                for m in 0..k {
                    q[m][j] = v[m] / norm;
                }
            }
        }

        for i in 0..k {
            for j in 0..k {
                let mut sum = 0.0;
                for m in 0..k {
                    sum += r[i][m] * q[m][j];
                }
                a[i][j] = sum;
            }
        }
    }

    let mut poles = Vec::new();
    let mut i = 0;
    while i < k {
        if i + 1 < k && a[i + 1][i].abs() > 1e-4 * (a[i][i].abs() + a[i + 1][i + 1].abs()).max(1.0) {
            let tr = a[i][i] + a[i + 1][i + 1];
            let det = a[i][i] * a[i + 1][i + 1] - a[i][i + 1] * a[i + 1][i];
            let disc = tr * tr - 4.0 * det;
            if disc >= 0.0 {
                poles.push(((tr + disc.sqrt()) / 2.0, 0.0));
                poles.push(((tr - disc.sqrt()) / 2.0, 0.0));
            } else {
                let re = tr / 2.0;
                let im = (-disc).sqrt() / 2.0;
                poles.push((re, im));
                poles.push((re, -im));
            }
            i += 2;
        } else {
            poles.push((a[i][i], 0.0));
            i += 1;
        }
    }

    poles.retain(|p| p.0 < 0.0);
    poles.sort_by(|a, b| a.0.hypot(a.1).partial_cmp(&b.0.hypot(b.1)).unwrap());
    poles
}

pub fn mor_analysis(circuit: &Circuit, mna: &MnaSystem, order: usize, out_node_opt: Option<&str>) -> Result<MorResult, String> {
    let dim = mna.dimension;
    if dim == 0 {
        return Err("Circuit has no unknowns to reduce.".to_string());
    }
    if mna.c_matrix.nnz() == 0 {
        return Err("Model Order Reduction requires dynamic energy-storage elements (C or L).".to_string());
    }

    // Determine output node
    let (out_node, out_sol_idx) = match out_node_opt {
        Some(name) => {
            let idx = *circuit.node_to_idx.get(name).ok_or_else(|| format!("MOR output node '{}' not found", name))?;
            if idx == 0 {
                return Err("Output node cannot be ground (0).".to_string());
            }
            (name.to_string(), idx - 1)
        }
        None => {
            if circuit.num_nodes > 0 {
                let last_name = &circuit.node_names[circuit.node_names.len() - 1];
                let idx = circuit.node_to_idx[last_name];
                (last_name.clone(), idx - 1)
            } else {
                ("1".to_string(), 0)
            }
        }
    };

    // Factorize static matrix G
    let lu_g = SparseLuFactors::factor(&mna.matrix).map_err(|e| format!("MOR failed to factorize G: {}", e))?;

    // Initial moment m0 = G^(-1) b
    let m0 = lu_g.solve(&mna.vector_b).map_err(|e| format!("MOR failed to solve for m0: {}", e))?;
    if mna.vector_b.iter().all(|&v| v == 0.0) {
        return Err("Model Order Reduction requires active energy sources.".to_string());
    }

    let target_q = order.clamp(1, dim);

    // 1. Compute explicit circuit moments m_0, m_1, m_2, ...
    let mut all_moments: Vec<Vec<f64>> = vec![m0.clone()];
    let mut cur_m = m0.clone();
    for _ in 1..=target_q.min(5) {
        let cm = mna.c_matrix.matvec(&cur_m);
        let neg_cm: Vec<f64> = cm.into_iter().map(|v| -v).collect();
        if let Ok(next_m) = lu_g.solve(&neg_cm) {
            cur_m = next_m;
            all_moments.push(cur_m.clone());
        } else {
            break;
        }
    }

    // Output node moments
    let output_moments: Vec<f64> = all_moments.iter().map(|m| {
        if out_sol_idx < m.len() { m[out_sol_idx] } else { 0.0 }
    }).collect();

    // 2. Compute Elmore delay for every node: tau_Elmore = -m1 / m0
    let mut elmore_delays = HashMap::new();
    if all_moments.len() >= 2 {
        let m0_vec = &all_moments[0];
        let m1_vec = &all_moments[1];
        for (idx, name) in circuit.node_names.iter().enumerate().skip(1) {
            let s_idx = idx - 1;
            if s_idx < m0_vec.len() && s_idx < m1_vec.len() {
                let v0 = m0_vec[s_idx];
                let v1 = m1_vec[s_idx];
                if v0.abs() > 1e-12 {
                    let delay = -v1 / v0;
                    if delay > 0.0 && delay.is_finite() {
                        elmore_delays.insert(name.clone(), delay);
                    }
                }
            }
        }
    }

    // 3. Arnoldi Process via Modified Gram-Schmidt
    let mut v_basis: Vec<Vec<f64>> = Vec::new();
    let norm_m0 = m0.iter().map(|x| x * x).sum::<f64>().sqrt();
    if norm_m0 > 1e-15 {
        v_basis.push(m0.iter().map(|x| x / norm_m0).collect());
    } else {
        let mut v1 = vec![0.0; dim];
        v1[0] = 1.0;
        v_basis.push(v1);
    }

    for _ in 1..target_q {
        let v_last = &v_basis[v_basis.len() - 1];
        let cv = mna.c_matrix.matvec(v_last);
        let neg_cv: Vec<f64> = cv.into_iter().map(|x| -x).collect();
        let mut w = match lu_g.solve(&neg_cv) {
            Ok(res) => res,
            Err(_) => break,
        };

        // Modified Gram-Schmidt orthogonalization
        for vi in &v_basis {
            let h: f64 = vi.iter().zip(&w).map(|(a, b)| a * b).sum();
            for (wj, vij) in w.iter_mut().zip(vi.iter()) {
                *wj -= h * vij;
            }
        }

        let norm_w = w.iter().map(|x| x * x).sum::<f64>().sqrt();
        if norm_w < 1e-13 || !norm_w.is_finite() {
            break; // Krylov subspace invariant/breakdown
        }
        v_basis.push(w.iter().map(|x| x / norm_w).collect());
    }

    let k = v_basis.len();

    // 4. PRIMA projection: G_tilde = V^T G V, C_tilde = V^T C V, b_tilde = V^T b
    let mut g_red = vec![vec![0.0; k]; k];
    let mut c_red = vec![vec![0.0; k]; k];
    let mut b_red = vec![0.0; k];

    for i in 0..k {
        b_red[i] = v_basis[i].iter().zip(&mna.vector_b).map(|(vi, bi)| vi * bi).sum();
        let g_vi = mna.matrix.matvec(&v_basis[i]);
        let c_vi = mna.c_matrix.matvec(&v_basis[i]);
        for j in 0..k {
            g_red[j][i] = v_basis[j].iter().zip(&g_vi).map(|(vj, gv)| vj * gv).sum();
            c_red[j][i] = v_basis[j].iter().zip(&c_vi).map(|(vj, cv)| vj * cv).sum();
        }
    }

    // 5. Poles extraction for reduced order model
    let poles = extract_reduced_poles(&g_red, &c_red);

    // 6. Frequency sweep comparison between full and reduced models
    let freqs: Vec<f64> = (0..20).map(|i| 10.0f64.powf(i as f64 * 6.0 / 19.0)).collect();
    let mut orig_mag = Vec::new();
    let mut red_mag = Vec::new();
    let mut max_err = 0.0f64;

    for &f in &freqs {
        let w = 2.0 * std::f64::consts::PI * f;

        // Full model AC solve
        let full_sol = {
            let mut pattern: Vec<((usize, usize), f64)> = Vec::new();
            for i in 0..dim {
                for (c, v) in mna.matrix.row(i) {
                    pattern.push(((i, c), v));
                    pattern.push(((i + dim, c + dim), v));
                }
                for (c, v) in mna.c_matrix.row(i) {
                    pattern.push(((i, c + dim), -w * v));
                    pattern.push(((i + dim, c), w * v));
                }
            }
            pattern.sort_by_key(|e| e.0);
            let big_csr = CsrMatrix::from_sorted_triplets(2 * dim, pattern.into_iter());
            let mut big_rhs = vec![0.0; 2 * dim];
            for i in 0..dim {
                big_rhs[i] = mna.vector_b[i];
            }
            SparseLuFactors::factor(&big_csr)
                .and_then(|lu| lu.solve(&big_rhs))
                .map(|x| x[out_sol_idx].hypot(x[out_sol_idx + dim]))
                .unwrap_or(0.0)
        };
        orig_mag.push(full_sol);

        // Reduced model solve: (G_tilde + j w C_tilde) x_tilde = b_tilde
        let mut ar = vec![vec![0.0; k]; k];
        let mut ai = vec![vec![0.0; k]; k];
        for r in 0..k {
            for c in 0..k {
                ar[r][c] = g_red[r][c];
                ai[r][c] = w * c_red[r][c];
            }
        }
        let bi_zero = vec![0.0; k];
        let red_sol = match solve_small_complex_system(&ar, &ai, &b_red, &bi_zero) {
            Ok((xr, xi)) => {
                // Approximate full state: X_full = V * x_tilde
                let mut full_r = 0.0;
                let mut full_i = 0.0;
                for j in 0..k {
                    full_r += v_basis[j][out_sol_idx] * xr[j];
                    full_i += v_basis[j][out_sol_idx] * xi[j];
                }
                full_r.hypot(full_i)
            }
            Err(_) => 0.0,
        };
        red_mag.push(red_sol);

        let err = if full_sol > 1e-12 {
            (full_sol - red_sol).abs() / full_sol
        } else {
            (full_sol - red_sol).abs()
        };
        max_err = max_err.max(err);
    }

    Ok(MorResult {
        order: target_q,
        output_node: out_node,
        moments: output_moments,
        elmore_delays,
        reduced_dimension: k,
        poles,
        frequencies: freqs,
        original_magnitude: orig_mag,
        reduced_magnitude: red_mag,
        error_max_rel: max_err,
        reduced_g: g_red,
        reduced_c: c_red,
    })
}
