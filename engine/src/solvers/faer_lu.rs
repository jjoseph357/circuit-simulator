use faer::col::Col;
use faer::prelude::Solve;
use faer::sparse::{SparseColMat, Triplet};

use super::sparse_lu::CsrMatrix;

/// Solves A·x = b with faer's supernodal sparse LU (fill-reducing ordering + partial pivoting).
/// This is the "industrial" path: the same MNA system, handed to a production library.
pub fn solve_faer_lu(a: &CsrMatrix, b: &[f64]) -> Result<Vec<f64>, String> {
    let n = a.dimension;
    if b.len() != n {
        return Err(format!("Dimension mismatch: matrix is {}×{} but b has {} entries.", n, n, b.len()));
    }
    if n == 0 {
        return Ok(Vec::new());
    }

    let triplets: Vec<Triplet<usize, usize, f64>> = (0..n)
        .flat_map(|i| a.row(i).map(move |(c, v)| Triplet::new(i, c, v)))
        .collect();
    let mat = SparseColMat::<usize, f64>::try_new_from_triplets(n, n, &triplets)
        .map_err(|e| format!("Could not build sparse matrix: {:?}", e))?;
    let lu = mat
        .sp_lu()
        .map_err(|e| format!("Singular or ill-conditioned matrix (faer LU failed: {:?}). Circuit has ungrounded or indeterminate nodes.", e))?;
    let rhs = Col::from_fn(n, |i| b[i]);
    let x = lu.solve(&rhs);

    let solution: Vec<f64> = (0..n).map(|i| x[i]).collect();
    if solution.iter().any(|v| !v.is_finite()) {
        return Err("Singular or ill-conditioned matrix (faer LU produced non-finite values). Circuit has ungrounded or indeterminate nodes.".to_string());
    }
    Ok(solution)
}
