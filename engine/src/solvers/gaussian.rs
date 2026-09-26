use crate::models::GaussianStep;

pub fn solve_step_by_step_gaussian(
    a_matrix: &[Vec<f64>],
    b_vector: &[f64],
    var_names: &[String],
) -> Result<(Vec<f64>, Vec<GaussianStep>), String> {
    let n = b_vector.len();
    if n == 0 {
        return Ok((Vec::new(), Vec::new()));
    }

    // Build augmented matrix [A | b]
    let mut aug = vec![vec![0.0; n + 1]; n];
    for i in 0..n {
        for j in 0..n {
            aug[i][j] = a_matrix[i][j];
        }
        aug[i][n] = b_vector[i];
    }

    let mut steps = Vec::new();
    let mut step_count = 0;

    // Initial state step
    step_count += 1;
    steps.push(GaussianStep {
        step_index: step_count,
        phase: "init".to_string(),
        description: "Initial Augmented Matrix [G | b]".to_string(),
        latex_equation: "\\left[\\begin{array}{ccc|c} G & b \\end{array}\\right]".to_string(),
        matrix_snapshot: aug.clone(),
        current_row: None,
        target_row: None,
        multiplier: None,
    });

    // Forward Elimination with Partial Pivoting
    for col in 0..n {
        // Find best pivot in column `col` from row `col` down to `n - 1`
        let mut pivot_row = col;
        let mut max_val = aug[col][col].abs();
        for r in (col + 1)..n {
            let val = aug[r][col].abs();
            if val > max_val {
                max_val = val;
                pivot_row = r;
            }
        }

        if max_val < 1e-12 {
            return Err(format!(
                "Singular matrix encountered at column {} ({}). The circuit has an ungrounded, floating, or singular node network.",
                col + 1,
                var_names.get(col).unwrap_or(&format!("X_{}", col + 1))
            ));
        }

        // Swap rows if necessary
        if pivot_row != col {
            aug.swap(col, pivot_row);
            step_count += 1;
            steps.push(GaussianStep {
                step_index: step_count,
                phase: "pivot_swap".to_string(),
                description: format!("Partial Pivoting: Swapped Row {} and Row {} for numerical stability (pivot magnitude {:.4})", col + 1, pivot_row + 1, max_val),
                latex_equation: format!("R_{{{}}} \\longleftrightarrow R_{{{}}}", col + 1, pivot_row + 1),
                matrix_snapshot: aug.clone(),
                current_row: Some(col),
                target_row: Some(pivot_row),
                multiplier: None,
            });
        }

        let pivot = aug[col][col];

        // Eliminate rows below pivot
        for r in (col + 1)..n {
            let factor = aug[r][col] / pivot;
            if factor.abs() > 1e-12 {
                for c in col..=n {
                    aug[r][c] -= factor * aug[col][c];
                    if aug[r][c].abs() < 1e-13 {
                        aug[r][c] = 0.0;
                    }
                }

                step_count += 1;
                steps.push(GaussianStep {
                    step_index: step_count,
                    phase: "elimination".to_string(),
                    description: format!(
                        "Eliminate column {} from Row {}: R_{} ← R_{} - ({:.4}) × R_{}",
                        col + 1, r + 1, r + 1, r + 1, factor, col + 1
                    ),
                    latex_equation: format!(
                        "R_{{{}}} \\leftarrow R_{{{}}} - ({:.4}) \\cdot R_{{{}}}",
                        r + 1, r + 1, factor, col + 1
                    ),
                    matrix_snapshot: aug.clone(),
                    current_row: Some(col),
                    target_row: Some(r),
                    multiplier: Some(factor),
                });
            }
        }
    }

    // Back-Substitution
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let mut sum = 0.0;
        let mut sum_terms = Vec::new();

        for j in (i + 1)..n {
            sum += aug[i][j] * x[j];
            sum_terms.push(format!("({:.4} \\cdot {:.4})", aug[i][j], x[j]));
        }

        let rhs = aug[i][n];
        let diag = aug[i][i];
        if diag.abs() < 1e-12 {
            return Err(format!("Zero diagonal at row {} during back-substitution.", i + 1));
        }

        x[i] = (rhs - sum) / diag;

        step_count += 1;
        let var_name = var_names.get(i).cloned().unwrap_or_else(|| format!("X_{}", i + 1));
        let latex = if sum_terms.is_empty() {
            format!("{} = \\frac{{{:.4}}}{{{:.4}}} = {:.4}", var_name, rhs, diag, x[i])
        } else {
            format!(
                "{} = \\frac{{{:.4} - [{}]}}{{{:.4}}} = {:.4}",
                var_name,
                rhs,
                sum_terms.join(" + "),
                diag,
                x[i]
            )
        };

        steps.push(GaussianStep {
            step_index: step_count,
            phase: "back_substitution".to_string(),
            description: format!("Back-substitution for {}: calculated as {:.4}", var_name, x[i]),
            latex_equation: latex,
            matrix_snapshot: aug.clone(),
            current_row: Some(i),
            target_row: None,
            multiplier: None,
        });
    }

    Ok((x, steps))
}
