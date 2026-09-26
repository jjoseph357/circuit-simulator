use crate::timing::Instant;

/// Compressed Sparse Row matrix. Rows are stored contiguously with column indices
/// sorted ascending, so a row can be walked or binary-searched without a dense copy.
#[derive(Debug, Clone)]
pub struct CsrMatrix {
    pub dimension: usize,
    pub values: Vec<f64>,
    pub col_indices: Vec<usize>,
    pub row_offsets: Vec<usize>,
}

impl CsrMatrix {
    pub fn from_dense(dense: &[Vec<f64>]) -> Self {
        let n = dense.len();
        let mut values = Vec::new();
        let mut col_indices = Vec::new();
        let mut row_offsets = vec![0; n + 1];

        for i in 0..n {
            row_offsets[i] = values.len();
            for j in 0..n {
                let v = dense[i][j];
                if v != 0.0 {
                    values.push(v);
                    col_indices.push(j);
                }
            }
        }
        row_offsets[n] = values.len();

        CsrMatrix { dimension: n, values, col_indices, row_offsets }
    }

    /// Build from (row, col, value) triplets already sorted by (row, col) with no duplicates,
    /// e.g. the iteration order of a `BTreeMap<(usize, usize), f64>`.
    pub fn from_sorted_triplets<I: IntoIterator<Item = ((usize, usize), f64)>>(dimension: usize, triplets: I) -> Self {
        let mut values = Vec::new();
        let mut col_indices = Vec::new();
        let mut row_offsets = vec![0; dimension + 1];

        for ((r, c), v) in triplets {
            if v == 0.0 {
                continue;
            }
            row_offsets[r + 1] += 1;
            values.push(v);
            col_indices.push(c);
        }
        for i in 0..dimension {
            row_offsets[i + 1] += row_offsets[i];
        }

        CsrMatrix { dimension, values, col_indices, row_offsets }
    }

    pub fn nnz(&self) -> usize {
        self.values.len()
    }

    pub fn row(&self, i: usize) -> impl Iterator<Item = (usize, f64)> + '_ {
        let (start, end) = (self.row_offsets[i], self.row_offsets[i + 1]);
        self.col_indices[start..end].iter().copied().zip(self.values[start..end].iter().copied())
    }

    pub fn get(&self, row: usize, col: usize) -> f64 {
        let (start, end) = (self.row_offsets[row], self.row_offsets[row + 1]);
        match self.col_indices[start..end].binary_search(&col) {
            Ok(idx) => self.values[start + idx],
            Err(_) => 0.0,
        }
    }

    pub fn to_dense(&self) -> Vec<Vec<f64>> {
        let mut dense = vec![vec![0.0; self.dimension]; self.dimension];
        for i in 0..self.dimension {
            for (c, v) in self.row(i) {
                dense[i][c] = v;
            }
        }
        dense
    }

    /// Multiply CSR matrix by vector: y = A * x
    pub fn matvec(&self, x: &[f64]) -> Vec<f64> {
        (0..self.dimension)
            .map(|i| self.row(i).map(|(c, v)| v * x[c]).sum())
            .collect()
    }
}

pub struct SparseLuResult {
    pub solution: Vec<f64>,
    pub duration_us: u64,
    pub nnz: usize,
    /// nnz(L) + nnz(U) - nnz(A): the extra entries elimination created.
    pub fill_in: usize,
}

/// A candidate pivot may be up to this factor smaller than the column's largest entry.
/// Within that band the shortest row wins (Markowitz-style), which limits fill-in while
/// keeping growth bounded — the same trade-off SPICE-family solvers make.
const PIVOT_THRESHOLD: f64 = 0.1;

fn lookup(row: &[(usize, f64)], col: usize) -> Option<f64> {
    row.binary_search_by_key(&col, |&(c, _)| c).ok().map(|idx| row[idx].1)
}

/// Stored P·A = L·U factors. Rows are indexed by ORIGINAL row id; perm[k] is the pivot row of step k.
pub struct SparseLuFactors {
    n: usize,
    rows: Vec<Vec<(usize, f64)>>,
    l_rows: Vec<Vec<(usize, f64)>>,
    perm: Vec<usize>,
    /// nnz(L) + nnz(U) − nnz(A)
    pub fill_in: usize,
}

/// Sparse LU factorization P·A = L·U with threshold partial pivoting, followed by
/// sparse forward/backward substitution. Work is proportional to the non-zeros touched,
/// not to N², so resistor ladders with 10⁵ nodes factor in milliseconds.
impl SparseLuFactors {
    /// Factorizes A once; `solve` can then be called for many right-hand sides (transient steps
    /// with an unchanged step size, or several sources) without refactoring.
    pub fn factor(a: &CsrMatrix) -> Result<SparseLuFactors, String> {
    let n = a.dimension;

    // Working rows indexed by ORIGINAL row id; rows are never physically swapped.
    let mut rows: Vec<Vec<(usize, f64)>> = (0..n).map(|i| a.row(i).collect()).collect();
    // For each column, rows that may hold a non-zero there (stale entries are filtered on use).
    let mut col_rows: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (i, row) in rows.iter().enumerate() {
        for &(c, _) in row {
            col_rows[c].push(i);
        }
    }

    // L multipliers per original row: (elimination step k, factor)
    let mut l_rows: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    let mut eliminated = vec![false; n];
    let mut perm: Vec<usize> = Vec::with_capacity(n); // perm[k] = original row used as pivot at step k
    let mut visited_at = vec![usize::MAX; n];

    let mut acc = vec![0.0; n];
    let mut marked = vec![false; n];
    let mut touched: Vec<usize> = Vec::new();
    let mut candidates: Vec<(usize, f64)> = Vec::new();

    for k in 0..n {
        candidates.clear();
        let mut max_abs = 0.0f64;
        for &r in &col_rows[k] {
            if eliminated[r] || visited_at[r] == k {
                continue;
            }
            visited_at[r] = k;
            if let Some(v) = lookup(&rows[r], k) {
                max_abs = max_abs.max(v.abs());
                candidates.push((r, v));
            }
        }
        col_rows[k] = Vec::new(); // column k is finished after this step

        if max_abs < 1e-12 {
            return Err(format!(
                "Singular or ill-conditioned matrix encountered at column {}. Circuit has ungrounded or indeterminate nodes.",
                k + 1
            ));
        }

        let (pivot_row, pivot_val) = candidates
            .iter()
            .copied()
            .filter(|&(_, v)| v.abs() >= PIVOT_THRESHOLD * max_abs)
            .min_by(|x, y| {
                rows[x.0]
                    .len()
                    .cmp(&rows[y.0].len())
                    .then(y.1.abs().partial_cmp(&x.1.abs()).unwrap_or(std::cmp::Ordering::Equal))
            })
            .expect("at least one candidate meets the threshold");

        eliminated[pivot_row] = true;
        perm.push(pivot_row);
        let prow = std::mem::take(&mut rows[pivot_row]);

        for &(r, v) in &candidates {
            if r == pivot_row {
                continue;
            }
            let factor = v / pivot_val;
            l_rows[r].push((k, factor));

            // row_r ← row_r − factor · row_pivot, over columns > k (column k is eliminated)
            touched.clear();
            for &(c, val) in &rows[r] {
                if c != k {
                    acc[c] = val;
                    marked[c] = true;
                    touched.push(c);
                }
            }
            for &(c, val) in &prow {
                if c > k {
                    if !marked[c] {
                        marked[c] = true;
                        acc[c] = 0.0;
                        touched.push(c);
                        col_rows[c].push(r); // fill-in: row r gains a non-zero in column c
                    }
                    acc[c] -= factor * val;
                }
            }
            touched.sort_unstable();
            let row_r = &mut rows[r];
            row_r.clear();
            for &c in &touched {
                if acc[c] != 0.0 {
                    row_r.push((c, acc[c]));
                }
                acc[c] = 0.0;
                marked[c] = false;
            }
        }
        rows[pivot_row] = prow;
    }

    let factor_nnz: usize = rows.iter().map(|r| r.len()).sum::<usize>() + l_rows.iter().map(|r| r.len()).sum::<usize>();
    let fill_in = factor_nnz.saturating_sub(a.nnz());
    Ok(SparseLuFactors { n, rows, l_rows, perm, fill_in })
    }

    /// Solves A·x = b with the stored factors: forward substitution L·y = P·b, then U·x = y.
    pub fn solve(&self, b_vector: &[f64]) -> Result<Vec<f64>, String> {
        let n = self.n;
        if b_vector.len() != n {
            return Err(format!("Dimension mismatch: matrix is {}×{} but b has {} entries.", n, n, b_vector.len()));
        }
        let mut y = vec![0.0; n];
        for i in 0..n {
            let r = self.perm[i];
            let sum: f64 = self.l_rows[r].iter().map(|&(k, f)| f * y[k]).sum();
            y[i] = b_vector[r] - sum;
        }

        // U's row for step k is the pivot row's remaining entries.
        let mut x = vec![0.0; n];
        for k in (0..n).rev() {
            let row = &self.rows[self.perm[k]];
            let mut diag = 0.0;
            let mut sum = 0.0;
            for &(c, v) in row {
                if c == k {
                    diag = v;
                } else if c > k {
                    sum += v * x[c];
                }
            }
            if diag.abs() < 1e-300 {
                return Err(format!("Zero diagonal encountered at U[{}, {}] during back substitution.", k + 1, k + 1));
            }
            x[k] = (y[k] - sum) / diag;
        }
        Ok(x)
    }
}

/// Factor + solve in one call (the DC operating point path).
pub fn solve_lu_sparse(a: &CsrMatrix, b_vector: &[f64]) -> Result<SparseLuResult, String> {
    let start = Instant::now();
    if b_vector.len() != a.dimension {
        return Err(format!("Dimension mismatch: matrix is {}×{} but b has {} entries.", a.dimension, a.dimension, b_vector.len()));
    }
    let factors = SparseLuFactors::factor(a)?;
    let solution = factors.solve(b_vector)?;
    Ok(SparseLuResult {
        solution,
        duration_us: (start.elapsed().as_micros() as u64).max(1),
        nnz: a.nnz(),
        fill_in: factors.fill_in,
    })
}
