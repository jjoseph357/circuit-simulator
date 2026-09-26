use circuit_engine::{simulate_circuit_with, SolverKind, HAS_FAER};

const CIRCUITS: &[&str] = &[
    "I1 0 1 3\nR1 1 2 5\nR2 2 0 10\nR3 2 3 5\nR4 3 0 10",
    "V1 1 0 10\nR1 1 2 100\nR2 2 0 100\nR3 1 3 100\nR4 3 0 120\nR5 2 3 50",
    "V1 1 0 9\nV2 3 2 2\nR1 1 2 3\nR2 2 0 6\nR3 3 0 4\nR4 1 3 12",
];

#[test]
fn test_solver_names_map_to_kinds() {
    assert_eq!(SolverKind::from_name("sparse_lu"), SolverKind::SparseLu);
    assert_eq!(SolverKind::from_name("faer"), SolverKind::Faer);
    assert_eq!(SolverKind::from_name("anything-else"), SolverKind::Gaussian);
}

#[test]
fn test_all_three_solvers_agree() {
    assert!(HAS_FAER, "native builds include the faer solver by default");
    for net in CIRCUITS {
        let g = simulate_circuit_with(net, SolverKind::Gaussian);
        let l = simulate_circuit_with(net, SolverKind::SparseLu);
        let f = simulate_circuit_with(net, SolverKind::Faer);
        assert!(g.success && l.success && f.success, "{:?}", f.error_message);
        assert_eq!(f.solver_used, "FaerSparseLU");
        assert!(f.residual_max_abs.unwrap() < 1e-10);
        for (node, v) in &g.node_voltages {
            assert!((v - l.node_voltages[node]).abs() < 1e-9 && (v - f.node_voltages[node]).abs() < 1e-9, "node {}", node);
        }
        for (name, i) in &g.branch_currents {
            assert!((i - f.branch_currents[name]).abs() < 1e-9, "branch {}", name);
        }
    }
}

#[test]
fn test_faer_scales_and_reports_singular_circuits() {
    let n = 50_000;
    let mut net = String::from("V1 1 0 10\n");
    for k in 1..n {
        net.push_str(&format!("R{} {} {} 1k\n", k, k, k + 1));
    }
    net.push_str(&format!("R{} {} 0 1k\n", n, n));
    let res = simulate_circuit_with(&net, SolverKind::Faer);
    assert!(res.success, "{:?}", res.error_message);
    assert!((res.node_voltages[&(n / 2).to_string()] - 10.0 * (n - n / 2 + 1) as f64 / n as f64).abs() < 1e-7);

    let singular = simulate_circuit_with("I1 0 1 2\nI2 1 0 2", SolverKind::Faer);
    assert!(!singular.success);
}
