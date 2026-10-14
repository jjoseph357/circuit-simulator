use circuit_engine::simulate_circuit;

#[test]
fn test_subcircuit_expansion_and_simulation() {
    let netlist = r#"
        * Hierarchical RC ladder using subcircuits
        .subckt RC_STAGE in out gnd
        R1 in out 1k
        C1 out gnd 1u
        .ends

        Vin 1 0 10
        X1 1 2 0 RC_STAGE
        X2 2 3 0 RC_STAGE
        .tran 10u 5m
        .end
    "#;

    let res = simulate_circuit(netlist, false);
    assert!(res.success, "{:?}", res.error_message);
    // At DC operating point, capacitors are open: V(1) = 10, V(2) = 10, V(3) = 10
    assert!((res.node_voltages["1"] - 10.0).abs() < 1e-4);
    assert!((res.node_voltages["2"] - 10.0).abs() < 1e-4);
    assert!((res.node_voltages["3"] - 10.0).abs() < 1e-4);

    let tran = res.transient.as_ref().expect("Transient result expected");
    assert!(!tran.time.is_empty());
    let v3_final = *tran.node_voltages["3"].last().unwrap();
    // In transient, starting from 0, it charges toward 10V
    assert!(v3_final > 9.0, "Expected V(3) to charge above 9V, got {}", v3_final);
}

#[test]
fn test_doc23_phasor_50hz_problem() {
    // EE 898 Doc 23 Phasor Question:
    // 50 Hz AC source V = 40 V peak, R = 4 ohm, C = 800 uF, XL = 4 ohm -> L = 4 / (2 * pi * 50) = 0.012732395 H
    // Series R-L-C circuit at 50 Hz:
    // XC = 1 / (2 * pi * 50 * 800e-6) = 3.97887 ohm
    // Z = R + j(XL - XC) = 4 + j(4 - 3.97887) = 4 + j 0.02113 ohm
    // |Z| ~ 4.000056 ohm, phase ~ 0.3026 deg
    // |I| = 40 / 4.000056 = 9.99986 A ~ 10 A
    let netlist = r#"
        * EE 898 Doc 23 50Hz Phasor problem
        V1 1 0 DC 0 AC 40 0
        R1 1 2 4
        L1 2 3 0.0127324
        C1 3 0 800u
        .ac 50
        .end
    "#;

    let res = simulate_circuit(netlist, false);
    assert!(res.success, "{:?}", res.error_message);
    let ac = res.ac.as_ref().expect("AC result expected");
    assert_eq!(ac.frequencies.len(), 1);
    assert!((ac.frequencies[0] - 50.0).abs() < 1e-6);

    // Current through V1: |I| ~ 10 A
    let i_mag = ac.branch_magnitude["V1"][0];
    assert!((i_mag - 10.0).abs() < 0.05, "Expected ~10 A, got {}", i_mag);

    // Voltage across C1: V(3) magnitude = |I| * XC = 10 * 3.97887 ~ 39.79 V
    let v3_mag = ac.node_magnitude["3"][0];
    assert!((v3_mag - 39.79).abs() < 0.1, "Expected V(3) ~ 39.79 V, got {}", v3_mag);
}

#[test]
fn test_model_order_reduction_prima_and_elmore() {
    // 4-stage RC interconnect ladder:
    // Each stage: R = 10 ohm, C = 100 fF
    // Total Elmore delay at node 4: tau = R1*C1 + (R1+R2)*C2 + (R1+R2+R3)*C3 + (R1+R2+R3+R4)*C4
    // = 10*100f + 20*100f + 30*100f + 40*100f = 100 * 10 * 100f = 1000 * 100f = 100 ps = 1e-10 s
    let netlist = r#"
        * Interconnect MOR Test
        Vin in 0 DC 1 AC 1
        R1 in 1 10
        C1 1 0 100f
        R2 1 2 10
        C2 2 0 100f
        R3 2 3 10
        C3 3 0 100f
        R4 3 4 10
        C4 4 0 100f
        .mor 3 4
        .end
    "#;

    let res = simulate_circuit(netlist, false);
    assert!(res.success, "{:?}", res.error_message);
    let mor = res.mor.as_ref().expect("MOR result expected");
    assert_eq!(mor.output_node, "4");
    assert_eq!(mor.order, 3);
    assert!(mor.reduced_dimension <= 3);

    // DC moment m0 at output node should be 1.0 (DC gain through RC ladder is 1)
    let m0 = mor.moments[0];
    assert!((m0 - 1.0).abs() < 1e-5, "Expected m0 = 1.0, got {}", m0);

    // Elmore delay at node 4: tau = 10*400f + 10*300f + 10*200f + 10*100f = 10 ps = 1e-11 s
    let elmore_4 = mor.elmore_delays["4"];
    assert!((elmore_4 - 1e-11).abs() < 1e-13, "Expected Elmore delay ~1e-11 s, got {}", elmore_4);

    // Error between original and reduced model should be small across the frequency sweep
    assert!(mor.error_max_rel < 0.1, "PRIMA reduced model relative error too high: {}", mor.error_max_rel);
}

#[test]
fn test_small_signal_tf() {
    let netlist = r#"
        * DC transfer function test
        Vin 1 0 10
        R1 1 2 1k
        R2 2 0 1k
        .tf V(2) Vin
        .end
    "#;

    let res = simulate_circuit(netlist, false);
    assert!(res.success, "{:?}", res.error_message);
    let tf = res.tf.as_ref().expect("TF result expected");
    // Gain V(2)/Vin = 0.5
    assert!((tf.transfer_function - 0.5).abs() < 1e-5, "Expected gain 0.5, got {}", tf.transfer_function);
    // Input resistance = R1 + R2 = 2k
    assert!((tf.input_resistance - 2000.0).abs() < 1.0, "Expected Rin 2000, got {}", tf.input_resistance);
    // Output resistance at node 2 = R1 // R2 = 500 ohm
    assert!((tf.output_resistance - 500.0).abs() < 1.0, "Expected Rout 500, got {}", tf.output_resistance);
}

#[test]
fn test_measurement_card_tran_and_ac() {
    let netlist = r#"
        * Measurement card test
        V1 1 0 SIN(0 5 1k)
        R1 1 2 1k
        C1 2 0 10u
        .tran 10u 5m
        .meas tran v_max MAX V(1)
        .meas tran v_min MIN V(1)
        .meas tran v_pp PP V(1)
        .end
    "#;

    let res = simulate_circuit(netlist, false);
    assert!(res.success, "{:?}", res.error_message);
    assert_eq!(res.measurements.len(), 3);

    let m_max = res.measurements.iter().find(|m| m.name == "v_max").unwrap();
    assert!((m_max.value - 5.0).abs() < 0.05, "Expected Vmax ~5.0, got {}", m_max.value);

    let m_min = res.measurements.iter().find(|m| m.name == "v_min").unwrap();
    assert!((m_min.value - (-5.0)).abs() < 0.05, "Expected Vmin ~ -5.0, got {}", m_min.value);

    let m_pp = res.measurements.iter().find(|m| m.name == "v_pp").unwrap();
    assert!((m_pp.value - 10.0).abs() < 0.1, "Expected Vpp ~10.0, got {}", m_pp.value);
}

#[test]
fn test_voltage_controlled_switch() {
    // When Vctrl is 5V (> Vt=2.5V), switch S1 is ON (Ron = 10 ohm)
    // When Vctrl is 0V (< Vt=2.5V), switch S1 is OFF (Roff = 100k ohm)
    let netlist_on = r#"
        * Switch ON test
        Vctrl 10 0 5
        Vin 1 0 10
        S1 1 2 10 0 ron=10 roff=100k vt=2.5
        Rload 2 0 1k
        .end
    "#;
    let res_on = simulate_circuit(netlist_on, false);
    assert!(res_on.success, "{:?}", res_on.error_message);
    // V(2) = 10 * 1000 / (1000 + 10) = 9.901 V
    let v2_on = res_on.node_voltages["2"];
    assert!((v2_on - 9.901).abs() < 0.01, "Expected ~9.901V, got {}", v2_on);

    let netlist_off = r#"
        * Switch OFF test
        Vctrl 10 0 0
        Vin 1 0 10
        S1 1 2 10 0 ron=10 roff=100k vt=2.5
        Rload 2 0 1k
        .end
    "#;
    let res_off = simulate_circuit(netlist_off, false);
    assert!(res_off.success, "{:?}", res_off.error_message);
    // V(2) = 10 * 1000 / (1000 + 100000) = 0.099 V
    let v2_off = res_off.node_voltages["2"];
    assert!((v2_off - 0.099).abs() < 0.01, "Expected ~0.099V, got {}", v2_off);
}

#[test]
fn test_gear_bdf2_integration_and_uic() {
    // RC circuit discharging from IC = 10V
    let netlist = r#"
        * RC discharge using Gear BDF2 with UIC
        .options method=gear
        R1 1 0 1k
        C1 1 0 1u IC=10
        .tran 10u 2m uic
        .end
    "#;

    let res = simulate_circuit(netlist, false);
    assert!(res.success, "{:?}", res.error_message);
    let tran = res.transient.as_ref().expect("Transient result expected");
    let v0 = tran.node_voltages["1"][0];
    assert!((v0 - 10.0).abs() < 1e-4, "Expected initial voltage 10.0V, got {}", v0);

    // At t = 1 ms (1 tau = 1k * 1u = 1 ms), V(1) should be 10 * exp(-1) ~ 3.6788 V
    let idx_1ms = tran.time.iter().position(|&t| (t - 1e-3).abs() < 1.5e-5).expect("1ms point exists");
    let v_1ms = tran.node_voltages["1"][idx_1ms];
    assert!((v_1ms - 3.6788).abs() < 0.1, "Expected ~3.6788V at 1ms with Gear BDF2, got {}", v_1ms);
}

#[test]
fn test_switch_divider_control() {
    let netlist = r#"
        * Switch controlled by divider node
        Vin 1 0 10
        R1 1 ctrl 1k
        R2 ctrl 0 1k
        * ctrl is at 5V, Vt = 2.5V -> switch ON
        Vsupply 10 0 10
        S1 10 out ctrl 0 ron=10 roff=100k vt=2.5
        Rload out 0 1k
        .end
    "#;
    let res = simulate_circuit(netlist, false);
    assert!(res.success, "{:?}", res.error_message);
    let v_out = res.node_voltages["out"];
    assert!((v_out - 9.901).abs() < 0.05, "Expected switch to be ON (Vout ~9.901V), got {}", v_out);
}

#[test]
fn test_switch_transient_switching() {
    let netlist = r#"
        * Switch turning ON during transient
        Vpulse ctrl 0 PULSE(0 5 1m 1u 1u 2m 5m)
        Vin in 0 10
        S1 in out ctrl 0 ron=10 roff=100k vt=2.5
        Rload out 0 1k
        .tran 100u 3m
        .end
    "#;
    let res = simulate_circuit(netlist, false);
    assert!(res.success, "{:?}", res.error_message);
    let tran = res.transient.as_ref().expect("Transient result expected");
    // At t = 0.5ms (before pulse rises), V(out) should be ~0.099V (switch OFF)
    let idx_0_5ms = tran.time.iter().position(|&t| (t - 0.5e-3).abs() < 5e-5).unwrap();
    let v_early = tran.node_voltages["out"][idx_0_5ms];
    assert!(v_early < 0.5, "Expected switch OFF initially, got {}", v_early);
    // At t = 2.0ms (during pulse high), V(out) should be ~9.9V (switch ON)
    let idx_2ms = tran.time.iter().position(|&t| (t - 2.0e-3).abs() < 5e-5).unwrap();
    let v_late = tran.node_voltages["out"][idx_2ms];
    assert!(v_late > 9.0, "Expected switch ON after pulse rise, got {}", v_late);
}

#[test]
fn test_bjt_amplifier_small_signal_tf() {
    let netlist = r#"
        * NPN common-emitter amplifier .tf
        .model NPN_MOD NPN (IS=1e-16 BF=100)
        Vcc 1 0 12
        Vin in 0 0.72
        Rc 1 out 2k
        Q1 out in 0 NPN_MOD
        .tf V(out) Vin
        .end
    "#;
    let res = simulate_circuit(netlist, false);
    assert!(res.success, "{:?}", res.error_message);
    let tf = res.tf.as_ref().expect("TF result expected");
    // In CE amplifier, gain is negative and substantial (-gm * Rc ~ -9.64)
    assert!((tf.transfer_function - (-9.64)).abs() < 0.5, "Expected inverting CE gain ~ -9.64, got {}", tf.transfer_function);
}

#[test]
fn test_mor_order_4_poles() {
    let netlist = r#"
        * 4-pole RC ladder
        Vin in 0 DC 1 AC 1
        R1 in 1 10
        C1 1 0 100f
        R2 1 2 10
        C2 2 0 100f
        R3 2 3 10
        C3 3 0 100f
        R4 3 4 10
        C4 4 0 100f
        .mor 4 4
        .end
    "#;
    let res = simulate_circuit(netlist, false);
    assert!(res.success, "{:?}", res.error_message);
    let mor = res.mor.as_ref().expect("MOR result expected");
    assert!(!mor.poles.is_empty(), "Expected physical poles for order 4 macromodel");
    for (re, _) in &mor.poles {
        assert!(*re < 0.0, "All macromodel poles must be in LHP (stable), got re = {}", re);
    }
}

#[test]
fn test_meas_dc_sweep() {
    let netlist = r#"
        * DC sweep measurement
        Vin 1 0 0
        R1 1 2 1k
        R2 2 0 1k
        .dc Vin 0 10 1
        .meas dc max_v MAX V(2)
        .end
    "#;
    let res = simulate_circuit(netlist, false);
    assert!(res.success, "{:?}", res.error_message);
    let m = res.measurements.iter().find(|m| m.name == "max_v").expect("max_v measurement found");
    assert!((m.value - 5.0).abs() < 0.05, "Expected max_v ~ 5.0, got {}", m.value);
}

#[test]
fn test_nested_subcircuit_with_controlled_sources_and_mutual_coupling() {
    let netlist = r#"
        * Nested subcircuit with internal mutual inductor and current-controlled source
        .subckt COUPLER in1 in2 out1 out2
        L1 in1 in2 10m
        L2 out1 out2 10m
        K1 L1 L2 0.99
        .ends

        .subckt STAGE_WRAPPER p1 p2 p3 p4
        Xcoup p1 p2 mid1 p4 COUPLER
        Vsens mid1 p3 0
        F1 p4 0 Vsens 2.0
        .ends

        Vin 1 0 10
        Rin 1 2 50
        Xstage1 2 0 3 0 STAGE_WRAPPER
        Rload 3 0 50
        .end
    "#;
    let res = simulate_circuit(netlist, false);
    assert!(res.success, "{:?}", res.error_message);
    // At DC, inductors are short circuits (0 resistance), so mid1 is connected to 0, p3 (node 3) is connected to 0 through Vsens.
    assert!(res.node_voltages.contains_key("3"));
}


