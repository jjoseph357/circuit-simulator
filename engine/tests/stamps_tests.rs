use circuit_engine::simulate_circuit;

#[test]
fn test_short_circuit_and_open_circuit() {
    // Voltage divider with a short circuit between nodes 2 and 3
    let net_sc = r#"
        * Short circuit divider
        V1 1 0 10
        R1 1 2 1k
        W1 2 3
        R2 3 0 1k
        .end
    "#;
    let res = simulate_circuit(net_sc, false);
    assert!(res.success, "{:?}", res.error_message);
    let v2 = res.node_voltages["2"];
    let v3 = res.node_voltages["3"];
    assert!((v2 - 5.0).abs() < 1e-6);
    assert!((v3 - 5.0).abs() < 1e-6);
    let iw = res.branch_currents["W1"];
    assert!((iw - 0.005).abs() < 1e-6, "Expected 5mA through W1, got {}", iw);

    // Test SC alias
    let net_sc_alias = r#"
        * SC alias
        V1 1 0 12
        R1 1 2 2k
        SC1 2 3
        R2 3 0 4k
        .end
    "#;
    let res_sc = simulate_circuit(net_sc_alias, true);
    assert!(res_sc.success, "{:?}", res_sc.error_message);
    assert!((res_sc.node_voltages["2"] - 8.0).abs() < 1e-6);
    assert!((res_sc.node_voltages["3"] - 8.0).abs() < 1e-6);

    // Open circuit: isolates node 3
    let net_open = r#"
        * Open circuit test
        V1 1 0 10
        R1 1 2 1k
        OPEN1 2 3
        R2 3 0 1k
        .end
    "#;
    let res_open = simulate_circuit(net_open, false);
    assert!(res_open.success, "{:?}", res_open.error_message);
    // Node 2 has no current through OPEN1, so no drop across R1 -> V(2) = 10V
    assert!((res_open.node_voltages["2"] - 10.0).abs() < 1e-6);
    // Node 3 is pulled to 0 through R2
    assert!((res_open.node_voltages["3"] - 0.0).abs() < 1e-6);
    assert_eq!(res_open.branch_currents.get("OPEN1").copied().unwrap_or(0.0), 0.0);
}

#[test]
fn test_vcvs_voltage_controlled_voltage_source() {
    let net = r#"
        * VCVS test
        V1 1 0 5
        R1 1 0 1k
        E1 2 0 1 0 3.0
        R2 2 0 1k
        .end
    "#;
    let res = simulate_circuit(net, false);
    assert!(res.success, "{:?}", res.error_message);
    assert!((res.node_voltages["1"] - 5.0).abs() < 1e-6);
    assert!((res.node_voltages["2"] - 15.0).abs() < 1e-6);
    // Output current through E1: 15V / 1k = 15mA delivered to R2
    let ie = res.branch_currents["E1"];
    assert!((ie.abs() - 0.015).abs() < 1e-6, "Expected 15mA magnitude, got {}", ie);
}

#[test]
fn test_vccs_voltage_controlled_current_source() {
    let net = r#"
        * VCCS test: current from 0 to 2 controlled by V(1, 0)
        V1 1 0 2
        R1 1 0 1k
        G1 0 2 1 0 0.005
        R2 2 0 1k
        .end
    "#;
    let res = simulate_circuit(net, false);
    assert!(res.success, "{:?}", res.error_message);
    assert!((res.node_voltages["1"] - 2.0).abs() < 1e-6);
    // G1 drives gm * V1 = 0.005 * 2 = 10mA into node 2, flowing down R2: V(2) = 10mA * 1k = 10V
    assert!((res.node_voltages["2"] - 10.0).abs() < 1e-6, "Got V(2) = {}", res.node_voltages["2"]);
    let ig = res.branch_currents["G1"];
    assert!((ig.abs() - 0.010).abs() < 1e-6, "Expected 10mA, got {}", ig);
}

#[test]
fn test_cccs_current_controlled_current_source() {
    // 1) 4-terminal syntax: controlling branch between 1 and 2
    let net_4t = r#"
        * CCCS 4-terminal
        V1 1 0 10
        F1 0 3 1 2 2.0
        R1 2 0 1k
        R2 3 0 1k
        .end
    "#;
    let res_4t = simulate_circuit(net_4t, false);
    assert!(res_4t.success, "{:?}", res_4t.error_message);
    // Controlling branch shorts 1 and 2 -> V(2) = 10V. Current I1 = 10V / 1k = 10mA.
    // F1 injects 2.0 * I1 = 20mA into node 3. V(3) = 20mA * 1k = 20V.
    assert!((res_4t.node_voltages["2"] - 10.0).abs() < 1e-6);
    assert!((res_4t.node_voltages["3"] - 20.0).abs() < 1e-6, "Got V(3) = {}", res_4t.node_voltages["3"]);

    // 2) 2-terminal syntax referencing a voltage source (SPICE convention:
    // current through V1 flows from + to -, so when V1 supplies current, I(V1) is negative).
    let net_2t = r#"
        * CCCS 2-terminal referencing V1 directly
        V1 1 0 5
        R1 1 0 1k
        F1 0 2 V1 4.0
        R2 2 0 1k
        .end
    "#;
    let res_2t = simulate_circuit(net_2t, false);
    assert!(res_2t.success, "{:?}", res_2t.error_message);
    // In SPICE, I(V1) from + to - is -5mA. F1 injects 4.0 * (-5mA) = -20mA into node 2 -> V(2) = -20V.
    assert!((res_2t.node_voltages["2"] - (-20.0)).abs() < 1e-6, "Got V(2) = {}", res_2t.node_voltages["2"]);

    // 3) Standard SPICE 0V sense ammeter in series:
    let net_sense = r#"
        * CCCS with 0V ammeter
        V1 1 0 5
        Vsense 1 1a 0
        R1 1a 0 1k
        F1 0 2 Vsense 4.0
        R2 2 0 1k
        .end
    "#;
    let res_sense = simulate_circuit(net_sense, false);
    assert!(res_sense.success, "{:?}", res_sense.error_message);
    // Current flows from 1 to 1a through Vsense (+ to -), so I(Vsense) = +5mA -> V(2) = +20V.
    assert!((res_sense.node_voltages["2"] - 20.0).abs() < 1e-6, "Got V(2) = {}", res_sense.node_voltages["2"]);
}

#[test]
fn test_ccvs_current_controlled_voltage_source() {
    // 1) 4-terminal syntax: controlling branch between 1 and 2
    let net_4t = r#"
        * CCVS 4-terminal
        V1 1 0 10
        H1 3 0 1 2 500
        R1 2 0 1k
        R2 3 0 1k
        .end
    "#;
    let res_4t = simulate_circuit(net_4t, false);
    assert!(res_4t.success, "{:?}", res_4t.error_message);
    // I_ctrl = 10mA. H1 sets V(3) = 500 * 10mA = 5V.
    assert!((res_4t.node_voltages["3"] - 5.0).abs() < 1e-6, "Got V(3) = {}", res_4t.node_voltages["3"]);

    // 2) 2-terminal syntax referencing a voltage source directly
    let net_2t = r#"
        * CCVS 2-terminal referencing V1
        V1 1 0 4
        R1 1 0 2k
        H1 2 0 V1 1000
        R2 2 0 1k
        .end
    "#;
    let res_2t = simulate_circuit(net_2t, false);
    assert!(res_2t.success, "{:?}", res_2t.error_message);
    // Current through V1 from + to - is -2mA. H1 sets V(2) = 1000 * (-2mA) = -2V.
    assert!((res_2t.node_voltages["2"] - (-2.0)).abs() < 1e-6, "Got V(2) = {}", res_2t.node_voltages["2"]);

    // 3) 2-terminal syntax with 0V sense ammeter
    let net_sense = r#"
        * CCVS with 0V ammeter
        V1 1 0 4
        Vsense 1 1a 0
        R1 1a 0 2k
        H1 2 0 Vsense 1000
        R2 2 0 1k
        .end
    "#;
    let res_sense = simulate_circuit(net_sense, false);
    assert!(res_sense.success, "{:?}", res_sense.error_message);
    // I(Vsense) = +2mA. H1 sets V(2) = 1000 * 2mA = +2V.
    assert!((res_sense.node_voltages["2"] - 2.0).abs() < 1e-6, "Got V(2) = {}", res_sense.node_voltages["2"]);
}

#[test]
fn test_opamp_ideal_inverting_amplifier() {
    let net = r#"
        * Ideal OpAmp inverting amplifier with Gain = -10
        V1 in 0 1.5
        R1 in inv 1k
        R2 inv out 10k
        O1 out 0 0 inv
        Rload out 0 5k
        .end
    "#;
    let res = simulate_circuit(net, false);
    assert!(res.success, "{:?}", res.error_message);
    // Ideal opamp holds virtual ground: V(inv) = 0V
    assert!(res.node_voltages["inv"].abs() < 1e-6, "Got V(inv) = {}", res.node_voltages["inv"]);
    // V(out) = - (R2 / R1) * V(in) = -10 * 1.5 = -15V
    assert!((res.node_voltages["out"] - (-15.0)).abs() < 1e-5, "Got V(out) = {}", res.node_voltages["out"]);
}

#[test]
fn test_opamp_non_ideal_finite_gain() {
    let net = r#"
        * Non-ideal OpAmp inverting amplifier with Gain A = 100
        V1 in 0 2.0
        R1 in inv 1k
        R2 inv out 10k
        O1 out 0 0 inv 100
        .end
    "#;
    let res = simulate_circuit(net, false);
    assert!(res.success, "{:?}", res.error_message);
    // Theoretical: V(out) = -20 / 1.11 = -18.018018 V
    let exp_out = -20.0 / 1.11;
    assert!((res.node_voltages["out"] - exp_out).abs() < 1e-4, "Got V(out) = {}, exp {}", res.node_voltages["out"], exp_out);
}

#[test]
fn test_transformer_and_coupled_inductors() {
    // 1) 4-terminal Transformer in transient analysis
    let net_tf = r#"
        * Transformer transient step response
        V1 1 0 PULSE(0 10 0 1u 1u 10m 20m)
        R1 1 2 10
        T1 2 0 3 0 10m 40m 18m
        R2 3 0 100
        .tran 10u 1m
        .end
    "#;
    let res_tf = simulate_circuit(net_tf, true);
    assert!(res_tf.success, "{:?}", res_tf.error_message);
    assert!(res_tf.transient.is_some());

    // 2) Coupled Inductors K card
    let net_k = r#"
        * Coupled inductors K card
        V1 1 0 PULSE(0 10 0 1u 1u 10m 20m)
        R1 1 2 10
        L1 2 0 10m
        L2 3 0 40m
        K1 L1 L2 0.9
        R2 3 0 100
        .tran 10u 1m
        .end
    "#;
    let res_k = simulate_circuit(net_k, true);
    assert!(res_k.success, "{:?}", res_k.error_message);
    assert!(res_k.transient.is_some());

    // Compare transient traces at t = 0.5 ms
    let t_data = res_k.transient.unwrap();
    assert!(!t_data.time.is_empty());
}
