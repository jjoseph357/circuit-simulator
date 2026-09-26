use circuit_engine::mna::EDUCATIONAL_DIM_LIMIT;
use circuit_engine::{lint_circuit, parse_netlist, simulate_circuit};

/// Series ladder: V1 drives node 1, n equal resistors in series down to ground.
/// V(k) = V * (n - k + 1) / n exactly, so any solver error is visible.
fn series_ladder(n: usize, volts: f64) -> String {
    let mut s = format!("V1 1 0 {}\n", volts);
    for k in 1..n {
        s.push_str(&format!("R{} {} {} 1k\n", k, k, k + 1));
    }
    s.push_str(&format!("R{} {} 0 1k\n", n, n));
    s
}

#[test]
fn test_large_ladder_uses_sparse_path_and_is_exact() {
    let n = 20_000;
    let res = simulate_circuit(&series_ladder(n, 10.0), true);
    assert!(res.success, "{:?}", res.error_message);
    assert_eq!(res.num_equations, n + 1);
    assert!(!res.educational_views, "dense snapshots must be skipped at this size");
    assert!(res.matrix_g.is_empty() && res.stamping_timeline.is_empty());
    assert!(res.residual_max_abs.unwrap() < 1e-9, "residual {:?}", res.residual_max_abs);
    // A tridiagonal ladder factors with essentially no fill-in under threshold pivoting.
    assert!(res.lu_fill_in.unwrap() <= n, "fill-in {:?}", res.lu_fill_in);
    for k in [1usize, 2, n / 2, n] {
        let expected = 10.0 * (n - k + 1) as f64 / n as f64;
        let got = res.node_voltages[&k.to_string()];
        assert!((got - expected).abs() < 1e-7, "node {}: {} vs {}", k, got, expected);
    }
}

#[test]
fn test_gaussian_request_on_large_circuit_falls_back_with_note() {
    let res = simulate_circuit(&series_ladder(EDUCATIONAL_DIM_LIMIT + 5, 5.0), false);
    assert!(res.success);
    assert_eq!(res.solver_used, "SparseLU");
    assert!(res.solver_note.is_some());
    assert!(res.gaussian_steps.is_empty());
}

#[test]
fn test_small_circuit_keeps_educational_views_and_small_residual() {
    let res = simulate_circuit("I1 0 1 3\nR1 1 2 5\nR2 2 0 10\nR3 2 3 5\nR4 3 0 10", false);
    assert!(res.success);
    assert!(res.educational_views);
    assert_eq!(res.stamping_timeline.len(), 5);
    assert!(!res.gaussian_steps.is_empty());
    assert!(res.residual_max_abs.unwrap() < 1e-12);
}

#[test]
fn test_sparse_and_gaussian_agree_with_voltage_sources_needing_pivoting() {
    // Aux rows of voltage sources have zero diagonals; pivoting must handle them.
    let net = "V1 1 0 9\nV2 3 2 2\nR1 1 2 3\nR2 2 0 6\nR3 3 0 4\nR4 1 3 12";
    let g = simulate_circuit(net, false);
    let l = simulate_circuit(net, true);
    assert!(g.success && l.success);
    for (node, vg) in &g.node_voltages {
        assert!((vg - l.node_voltages[node]).abs() < 1e-9, "node {}", node);
    }
    for (name, ig) in &g.branch_currents {
        assert!((ig - l.branch_currents[name]).abs() < 1e-9, "branch {}", name);
    }
}

#[test]
fn test_spice_dc_keyword_is_accepted() {
    let res = simulate_circuit("V1 1 0 DC 12\nR1 1 2 3\nR2 2 0 6", true);
    assert!(res.success, "{:?}", res.error_message);
    assert!((res.node_voltages["2"] - 8.0).abs() < 1e-9);
}

#[test]
fn test_unsupported_elements_are_reported_not_silently_dropped() {
    let err = parse_netlist("V1 1 0 5\nR1 1 2 1k\nJ1 2 0 1").unwrap_err();
    assert!(err.contains("JFET"), "{}", err);
    let res = simulate_circuit("V1 1 0 5\nR1 1 2 1k\nJ1 2 0 1", false);
    assert!(!res.success);
    assert_eq!(res.diagnostics[0].code, "ERR_PARSE");
    assert!(res.diagnostics[0].message.contains("JFET"));
}

#[test]
fn test_zero_ohm_resistor_is_rejected_with_guidance() {
    let err = parse_netlist("V1 1 0 5\nR1 1 2 0\nR2 2 0 1k").unwrap_err();
    assert!(err.contains("0 Ω"), "{}", err);
}

#[test]
fn test_duplicate_names_are_rejected() {
    let err = parse_netlist("V1 1 0 5\nR1 1 2 1k\nR1 2 0 1k").unwrap_err();
    assert!(err.contains("Duplicate"), "{}", err);
}

#[test]
fn test_control_cards_are_ignored() {
    let res = simulate_circuit(".title divider\nV1 1 0 10\nR1 1 2 1k\nR2 2 0 1k\n.op\n.end", true);
    assert!(res.success, "{:?}", res.error_message);
}

#[test]
fn test_mixed_numeric_and_named_nodes_sort_without_panic() {
    let res = simulate_circuit("V1 in 0 10\nR1 in 10 1k\nR2 10 9 1k\nR3 9 1a 1k\nR4 1a 0 1k", false);
    assert!(res.success, "{:?}", res.error_message);
    assert_eq!(res.variable_names[0], "V(9)");
    assert!((res.node_voltages["10"] - 7.5).abs() < 1e-9);
}

#[test]
fn test_kcl_formatting_keeps_fractional_resistances() {
    let res = simulate_circuit("I1 0 1 1\nR1 1 0 0.25", false);
    assert!(res.success);
    assert!(res.kcl_equations[0].raw_equation.contains("/ 0.25"), "{}", res.kcl_equations[0].raw_equation);
}

#[test]
fn test_three_source_voltage_loop_is_detected() {
    // No two sources are in parallel, but V1, V2, V3 form a KVL loop 0→1→2→0.
    let consistent = lint_circuit(&parse_netlist("V1 1 0 5\nV2 2 1 3\nV3 2 0 8\nR1 2 0 1k").unwrap());
    let d = consistent.iter().find(|d| d.code == "ERR_PARALLEL_VOLTAGE_SOURCES").expect("loop not found");
    assert_eq!(d.components_affected.len(), 3);

    let conflicting = lint_circuit(&parse_netlist("V1 1 0 5\nV2 2 1 3\nV3 2 0 9\nR1 2 0 1k").unwrap());
    let d = conflicting.iter().find(|d| d.code == "ERR_KVL_VIOLATION").expect("KVL conflict not found");
    assert_eq!(d.fix.as_ref().unwrap().remove_lines, vec!["V3 2 0 9".to_string()]);
}

#[test]
fn test_island_fed_only_by_current_source_is_detected() {
    // Nodes 1-2 reach ground only through I1, so their common-mode voltage is undetermined.
    let diags = lint_circuit(&parse_netlist("I1 0 1 1\nR1 1 2 1k\nR2 2 1 2k\nR3 3 0 1k\nV1 3 0 1").unwrap());
    let island = diags.iter().find(|d| d.code == "ERR_ISOLATED_ISLAND").expect("island not found");
    assert!(island.nodes_affected.contains(&"1".to_string()));
    assert!(island.fix.is_some());
}

#[test]
fn test_autofixes_actually_repair_the_circuit() {
    let broken = "V1 1 2 10\nR1 1 2 1k\nR2 2 3 1k\nR3 3 1 1k";
    let diags = lint_circuit(&parse_netlist(broken).unwrap());
    let fix = diags.iter().find(|d| d.code == "ERR_NO_GROUND").and_then(|d| d.fix.clone()).expect("no ground fix");
    let repaired = format!("{}\n{}", broken, fix.append_lines.join("\n"));
    let res = simulate_circuit(&repaired, false);
    assert!(res.success, "{:?}", res.error_message);
    // The added reference carries no current, so V(1) − V(2) is still exactly the source value.
    assert!((res.node_voltages["1"] - res.node_voltages["2"] - 10.0).abs() < 1e-9);

    let current_only = "I1 0 1 2\nI2 1 0 2\nR1 2 0 5\nI3 0 2 1";
    let diags = lint_circuit(&parse_netlist(current_only).unwrap());
    let fix = diags.iter().find(|d| d.code == "ERR_CURRENT_ONLY_NODE").and_then(|d| d.fix.clone()).unwrap();
    let res = simulate_circuit(&format!("{}\n{}", current_only, fix.append_lines.join("\n")), true);
    assert!(res.success, "{:?}", res.error_message);
}

#[test]
fn test_singular_failure_message_names_the_doctor_finding() {
    let res = simulate_circuit("I1 0 1 2\nI2 1 0 2", false);
    assert!(!res.success);
    let msg = res.error_message.unwrap();
    assert!(msg.contains("Likely cause"), "{}", msg);
}

#[test]
fn test_storybook_text_is_correct_and_not_mojibake() {
    let res = simulate_circuit("V1 1 0 12\nR1 1 2 3\nR2 2 0 6", false);
    let story = &res.storybook_explanation;
    assert!(story.contains("12.00 V between Node 1 (+) and Node 0 (-)"), "{}", story);
    // A Windows-1252 round trip would turn ⚡ into "âš¡"
    assert!(story.contains('\u{26a1}') && !story.contains('\u{e2}'), "{}", story);
}
