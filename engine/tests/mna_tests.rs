use circuit_engine::{simulate_circuit, parse_netlist, lint_circuit};

#[test]
fn test_current_source_network_gaussian() {
    let netlist = r#"
        * Current source network
        I1 0 1 3
        R1 1 2 5
        R2 2 0 10
        R3 2 3 5
        R4 3 0 10
        .end
    "#;

    let res = simulate_circuit(netlist, false);
    assert!(res.success, "Simulation failed: {:?}", res.error_message);

    // Analytical: V(1) = 33 V, V(2) = 18 V, V(3) = 12 V
    let v1 = res.node_voltages.get("1").copied().unwrap();
    let v2 = res.node_voltages.get("2").copied().unwrap();
    let v3 = res.node_voltages.get("3").copied().unwrap();
    assert!((v1 - 33.0).abs() < 1e-6, "Expected V1=33.0V, got {}", v1);
    assert!((v2 - 18.0).abs() < 1e-6, "Expected V2=18.0V, got {}", v2);
    assert!((v3 - 12.0).abs() < 1e-6, "Expected V3=12.0V, got {}", v3);

    // R1: (33 − 18)/5 = 3 A, R2: 18/10 = 1.8 A, R3: (18 − 12)/5 = 1.2 A, R4: 12/10 = 1.2 A
    for (name, want) in [("R1", 3.0), ("R2", 1.8), ("R3", 1.2), ("R4", 1.2)] {
        let got = res.branch_currents.get(name).copied().unwrap();
        assert!((got - want).abs() < 1e-6, "Expected I({})={}A, got {}", name, want, got);
    }
    for eq in &res.kcl_equations {
        assert!(eq.evaluated_sum.abs() < 1e-4, "KCL violated at node {}: {}", eq.node, eq.evaluated_sum);
    }
}

#[test]
fn test_non_spice_lines_are_errors_not_silently_dropped() {
    // A mistyped or non-SPICE line must never vanish quietly: the answer would be wrong with no warning.
    for bad in ["V1 1 0 5\nres(1, 0, 10);", "V1 1 0 5\nR1 1 0", "V1 1 0 5\nZ1 1 0 10"] {
        let err = parse_netlist(bad).err().unwrap_or_else(|| panic!("accepted: {}", bad));
        assert!(!err.is_empty());
    }
    // SPICE: a first line that is not an element is the title.
    let c = parse_netlist("My divider\nV1 1 0 10\nR1 1 2 1k\nR2 2 0 1k").unwrap();
    assert_eq!(c.components.len(), 3);
    // Inline comments
    let c = parse_netlist("* t\nV1 1 0 10 ; supply\nR1 1 0 1k $ load").unwrap();
    assert_eq!(c.components.len(), 2);
}

#[test]
fn test_current_source_network_sparse_lu() {
    let netlist = r#"
        * Current source network
        I1 0 1 3
        R1 1 2 5
        R2 2 0 10
        R3 2 3 5
        R4 3 0 10
    "#;

    let res = simulate_circuit(netlist, true); // Test sparse LU
    assert!(res.success, "Simulation failed: {:?}", res.error_message);

    let v1 = res.node_voltages.get("1").copied().unwrap();
    let v2 = res.node_voltages.get("2").copied().unwrap();
    let v3 = res.node_voltages.get("3").copied().unwrap();

    assert!((v1 - 33.0).abs() < 1e-6);
    assert!((v2 - 18.0).abs() < 1e-6);
    assert!((v3 - 12.0).abs() < 1e-6);
}

#[test]
fn test_resistor_ladder_solvers_agree() {
    // 10 A source into a 6 Ω / 12 Ω ladder
    let netlist = r#"
        I1 0 1 10
        R1 1 0 6
        R2 1 2 6
        R3 2 0 12
        R4 2 3 6
        R5 3 0 12
    "#;

    let res_gauss = simulate_circuit(netlist, false);
    let res_lu = simulate_circuit(netlist, true);

    assert!(res_gauss.success);
    assert!(res_lu.success);

    // Verify Gaussian and Sparse LU match to 9 decimals
    for (node, v_gauss) in &res_gauss.node_voltages {
        let v_lu = res_lu.node_voltages.get(node).unwrap();
        assert!((v_gauss - v_lu).abs() < 1e-9, "Mismatch at node {}: {} vs {}", node, v_gauss, v_lu);
    }
}

#[test]
fn test_mna_voltage_source_auxiliary_stamp() {
    // Simple circuit: V1 between node 1 and 0 (10V), R1 between 1 and 2 (2Ω), R2 between 2 and 0 (3Ω)
    // Analytical: V1 = 10V, V2 = 6V, I = 10 / (2+3) = 2A
    let netlist = r#"
        V1 1 0 10
        R1 1 2 2
        R2 2 0 3
    "#;

    let res = simulate_circuit(netlist, false);
    assert!(res.success);

    let v1 = res.node_voltages.get("1").copied().unwrap();
    let v2 = res.node_voltages.get("2").copied().unwrap();
    assert!((v1 - 10.0).abs() < 1e-6);
    assert!((v2 - 6.0).abs() < 1e-6);

    let i_r1 = res.branch_currents.get("R1").copied().unwrap();
    assert!((i_r1 - 2.0).abs() < 1e-6);
}

#[test]
fn test_circuit_doctor_diagnostics() {
    // 1. Missing ground
    let bad_netlist_1 = r#"
        R1 1 2 10
        I1 1 2 1
    "#;
    let circ1 = parse_netlist(bad_netlist_1).unwrap();
    let diag1 = lint_circuit(&circ1);
    assert!(diag1.iter().any(|d| d.code == "ERR_NO_GROUND"));

    // 2. Floating node
    let bad_netlist_2 = r#"
        R1 1 0 10
        R2 1 2 5
        I1 0 1 1
    "#;
    let circ2 = parse_netlist(bad_netlist_2).unwrap();
    let diag2 = lint_circuit(&circ2);
    assert!(diag2.iter().any(|d| d.code == "WARN_FLOATING_NODE" && d.nodes_affected.contains(&"2".to_string())));

    // 3. Self short
    let bad_netlist_3 = r#"
        R1 1 1 10
        I1 0 1 1
    "#;
    let circ3 = parse_netlist(bad_netlist_3).unwrap();
    let diag3 = lint_circuit(&circ3);
    assert!(diag3.iter().any(|d| d.code == "WARN_SELF_SHORT"));

    // 4. Identical parallel voltage sources
    let bad_netlist_4 = r#"
        V1 1 0 10
        V2 1 0 10
        R1 1 0 5
    "#;
    let circ4 = parse_netlist(bad_netlist_4).unwrap();
    let diag4 = lint_circuit(&circ4);
    assert!(diag4.iter().any(|d| d.code == "ERR_PARALLEL_VOLTAGE_SOURCES"));

    // 5. Conflicting parallel voltage sources
    let bad_netlist_5 = r#"
        V1 1 0 10
        V2 1 0 5
        R1 1 0 5
    "#;
    let circ5 = parse_netlist(bad_netlist_5).unwrap();
    let diag5 = lint_circuit(&circ5);
    assert!(diag5.iter().any(|d| d.code == "ERR_KVL_VIOLATION"));

    // 6. Node connected only to current sources
    let bad_netlist_6 = r#"
        I1 0 1 2
        I2 1 0 2
    "#;
    let circ6 = parse_netlist(bad_netlist_6).unwrap();
    let diag6 = lint_circuit(&circ6);
    assert!(diag6.iter().any(|d| d.code == "ERR_CURRENT_ONLY_NODE"));
}

#[test]
fn test_parse_eng_value_comprehensive() {
    use circuit_engine::parser::parse_eng_value;

    assert_eq!(parse_eng_value("10").unwrap(), 10.0);
    assert_eq!(parse_eng_value("-5.5").unwrap(), -5.5);
    assert_eq!(parse_eng_value("5V").unwrap(), 5.0);
    assert_eq!(parse_eng_value("3A").unwrap(), 3.0);
    assert_eq!(parse_eng_value("10k").unwrap(), 10000.0);
    assert_eq!(parse_eng_value("10kohm").unwrap(), 10000.0);
    assert_eq!(parse_eng_value("10Meg").unwrap(), 10000000.0);
    assert_eq!(parse_eng_value("10megohm").unwrap(), 10000000.0);
    assert!((parse_eng_value("100mA").unwrap() - 0.1).abs() < 1e-12);
    assert!((parse_eng_value("100uA").unwrap() - 1e-4).abs() < 1e-12);
    assert!((parse_eng_value("1.5e-3").unwrap() - 0.0015).abs() < 1e-12);
    assert!((parse_eng_value("1.5e-3A").unwrap() - 0.0015).abs() < 1e-12);
    assert!((parse_eng_value("2.5E+03").unwrap() - 2500.0).abs() < 1e-12);
    assert!((parse_eng_value("100Ω").unwrap() - 100.0).abs() < 1e-12);
}

#[test]
fn test_sparse_lu_with_voltage_source() {
    let netlist = r#"
        V1 1 0 12V
        R1 1 2 3
        R2 2 0 6
    "#;

    let res = simulate_circuit(netlist, true);
    assert!(res.success);
    assert_eq!(res.solver_used, "SparseLU");

    let v1 = res.node_voltages.get("1").copied().unwrap();
    let v2 = res.node_voltages.get("2").copied().unwrap();
    assert!((v1 - 12.0).abs() < 1e-6);
    assert!((v2 - 8.0).abs() < 1e-6);

    let i_v1 = res.branch_currents.get("V1").copied().unwrap();
    // I = 12 / (3 + 6) = 1.3333 A leaving pos terminal
    assert!((i_v1.abs() - (12.0 / 9.0)).abs() < 1e-4);
}

#[test]
fn test_wheatstone_bridge_dual_solvers() {
    let netlist = r#"
        V1 1 0 10.0
        R1 1 2 100.0
        R2 2 0 100.0
        R3 1 3 100.0
        R4 3 0 120.0
        R_bridge 2 3 50.0
    "#;

    let res_gauss = simulate_circuit(netlist, false);
    let res_lu = simulate_circuit(netlist, true);

    assert!(res_gauss.success);
    assert!(res_lu.success);

    for (node, v_g) in &res_gauss.node_voltages {
        let v_l = res_lu.node_voltages.get(node).unwrap();
        assert!((v_g - v_l).abs() < 1e-9, "Mismatch at node {}: {} vs {}", node, v_g, v_l);
    }

    // Verify KCL equations don't contain "+ -" or "+ +"
    for eq in &res_gauss.kcl_equations {
        assert!(!eq.raw_equation.contains("+ -"), "Raw KCL has '+ -': {}", eq.raw_equation);
        assert!(!eq.raw_equation.contains("+ +"), "Raw KCL has '+ +': {}", eq.raw_equation);
        assert!(!eq.latex_equation.contains("+ -"), "LaTeX KCL has '+ -': {}", eq.latex_equation);
        assert!(!eq.latex_equation.contains("+ +"), "LaTeX KCL has '+ +': {}", eq.latex_equation);
    }
}
