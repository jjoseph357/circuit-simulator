//! Milestone 2: capacitors, inductors, .ac and .tran, checked against closed-form solutions.
use circuit_engine::models::{Analysis, IntegrationMethod, SweepType, Waveform};
use circuit_engine::{lint_circuit, parse_netlist, simulate_circuit, simulate_circuit_with, SolverKind};

fn interp(time: &[f64], ys: &[f64], t: f64) -> f64 {
    let k = time.iter().position(|&x| x >= t).unwrap();
    if k == 0 || time[k] == t {
        return ys[k];
    }
    let u = (t - time[k - 1]) / (time[k] - time[k - 1]);
    ys[k - 1] + u * (ys[k] - ys[k - 1])
}

#[test]
fn test_parser_reads_dynamic_elements_sources_and_directives() {
    let c = parse_netlist(
        "V1 in 0 PULSE(0 5 1u 1n 1n 10u 20u) AC 1 90\n\
         I1 0 x SIN(0 1m 1k)\n\
         V2 y 0 PWL(0 0 1m 1 2m 1)\n\
         R1 in x 1k\nC1 x 0 1u\nL1 x y 10m\nR2 y 0 1k\n\
         .tran 1u 5m\n.ac dec 10 1 1meg\n.options method=euler",
    )
    .unwrap();
    assert_eq!(c.analyses.len(), 2);
    assert_eq!(c.analyses[1], Analysis::Ac { sweep: SweepType::Dec, points: 10, fstart: 1.0, fstop: 1e6 });
    assert_eq!(c.method, IntegrationMethod::BackwardEuler);
    let v1 = c.components.iter().find(|x| x.name == "V1").unwrap();
    let spec = v1.source.as_ref().unwrap();
    assert_eq!((spec.ac_mag, spec.ac_phase_deg), (1.0, 90.0));
    assert!(matches!(spec.waveform, Some(Waveform::Pulse { v2, .. }) if v2 == 5.0));
    // Inductor gets a branch-current unknown after the voltage sources before it in the netlist
    assert!(c.variable_names.contains(&"I(L1)".to_string()));
    assert_eq!(c.num_aux, 3);

}

#[test]
fn test_waveforms_and_breakpoints() {
    let p = Waveform::Pulse { v1: 0.0, v2: 1.0, td: 1.0, tr: 1.0, tf: 1.0, pw: 2.0, per: 10.0 };
    assert_eq!(p.value_at(0.5), 0.0);
    assert_eq!(p.value_at(1.5), 0.5);
    assert_eq!(p.value_at(3.0), 1.0);
    assert_eq!(p.value_at(4.5), 0.5);
    assert_eq!(p.value_at(12.0), 1.0 * 0.0 + 1.0); // second period, top of the ramp
    assert_eq!(p.breakpoints(12.0), vec![1.0, 2.0, 4.0, 5.0, 11.0, 12.0]);
    let pwl = Waveform::Pwl { points: vec![(0.0, 0.0), (2.0, 4.0)] };
    assert_eq!(pwl.value_at(1.0), 2.0);
    assert_eq!(pwl.value_at(5.0), 4.0);
}

#[test]
fn test_dc_operating_point_treats_c_as_open_and_l_as_wire() {
    let res = simulate_circuit("V1 1 0 10\nL1 1 2 1m\nR1 2 0 1k\nC1 2 0 1u", false);
    assert!(res.success, "{:?}", res.error_message);
    assert!((res.node_voltages["2"] - 10.0).abs() < 1e-12);
    assert!((res.branch_currents["L1"] - 0.01).abs() < 1e-12);
    assert_eq!(res.branch_currents["C1"], 0.0);
    assert!(!res.matrix_c.is_empty(), "C matrix is exported for the teaching view");
}

fn rc_step(method: &str) -> circuit_engine::dynamics::TransientResult {
    // τ = RC = 1 ms; step at t = 0 (1 ns rise)
    let net = format!("V1 1 0 PULSE(0 1 0 1n 1n 1 2)\nR1 1 2 1k\nC1 2 0 1u\n.tran 10u 5m\n.options method={}", method);
    let res = simulate_circuit(&net, true);
    assert!(res.success && res.analysis_errors.is_empty(), "{:?} {:?}", res.error_message, res.analysis_errors);
    res.transient.unwrap()
}

#[test]
fn test_rc_step_response_matches_exponential() {
    for (method, tol) in [("trap", 2e-3), ("euler", 5e-3)] {
        let tr = rc_step(method);
        let v = &tr.node_voltages["2"];
        for t in [0.5e-3, 1e-3, 2e-3, 4e-3] {
            let exact = 1.0 - (-t / 1e-3f64).exp();
            let got = interp(&tr.time, v, t);
            assert!((got - exact).abs() < tol, "{} at t={}: {} vs {}", method, t, got, exact);
        }
        // Capacitor current = (Vin − Vc)/R, from the solver's own discretization
        let k = tr.time.iter().position(|&t| t >= 1e-3).unwrap();
        let ic = tr.branch_currents["C1"][k];
        let ir = tr.branch_currents["R1"][k];
        assert!((ic - ir).abs() < 1e-6, "{}: KCL at node 2 violated: {} vs {}", method, ic, ir);
    }
}

#[test]
fn test_series_rlc_underdamped_step() {
    // α = R/2L = 5000 /s, ω0 = 1/√(LC) ≈ 31623 rad/s
    let net = "V1 1 0 PULSE(0 1 0 1n 1n 1 2)\nR1 1 2 10\nL1 2 3 1m\nC1 3 0 1u\n.tran 1u 1m";
    let res = simulate_circuit(net, true);
    let tr = res.transient.expect("transient result");
    let (a, w0): (f64, f64) = (5000.0, 1.0 / (1e-3f64 * 1e-6).sqrt());
    let wd = (w0 * w0 - a * a).sqrt();
    for t in [50e-6, 100e-6, 200e-6, 500e-6] {
        let exact = 1.0 - (-a * t).exp() * ((wd * t).cos() + a / wd * (wd * t).sin());
        let got = interp(&tr.time, &tr.node_voltages["3"], t);
        assert!((got - exact).abs() < 5e-3, "t={}: {} vs {}", t, got, exact);
    }
}

#[test]
fn test_stepper_lands_on_breakpoints_and_reuses_factorizations() {
    let net = "V1 1 0 PULSE(0 1 1m 10u 10u 2m 5m)\nR1 1 2 1k\nC1 2 0 100n\n.tran 10u 12m";
    let tr = simulate_circuit(net, true).transient.unwrap();
    for bp in [1e-3, 1.01e-3, 3.01e-3, 3.02e-3, 6e-3, 11e-3] {
        assert!(tr.time.iter().any(|&t| (t - bp).abs() < 1e-12), "missed breakpoint {}", bp);
    }
    assert!(tr.factorizations < tr.accepted_steps, "{} factorizations for {} steps", tr.factorizations, tr.accepted_steps);
    assert!((tr.time.last().unwrap() - 12e-3).abs() < 1e-12);
}

#[test]
fn test_ac_rc_lowpass_and_rl_highpass() {
    let fc = 1.0 / (2.0 * std::f64::consts::PI * 1e3 * 1e-6);
    let res = simulate_circuit(&format!("V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac lin 3 {} {}", fc, 10.0 * fc), false);
    let ac = res.ac.expect("ac result");
    let (mag, ph) = (&ac.node_magnitude["out"], &ac.node_phase_deg["out"]);
    assert!((mag[0] - 1.0 / 2f64.sqrt()).abs() < 1e-9, "|H(fc)| = {}", mag[0]);
    assert!((ph[0] + 45.0).abs() < 1e-7, "phase(fc) = {}", ph[0]);
    assert!((mag[2] - 1.0 / 101f64.sqrt()).abs() < 1e-9);
    assert_eq!(ac.real_system_dimension, 2 * res.num_equations);

    // RL high-pass across R: |H| = R / √(R² + (ωL)²); the inductor row carries −jωL
    let res = simulate_circuit("V1 in 0 AC 2\nL1 in out 10m\nR1 out 0 100\n.ac dec 5 10 100k", true);
    let ac = res.ac.unwrap();
    for (k, &f) in ac.frequencies.iter().enumerate() {
        let wl = 2.0 * std::f64::consts::PI * f * 10e-3;
        let exact = 2.0 * 100.0 / (100.0f64.powi(2) + wl * wl).sqrt();
        assert!((ac.node_magnitude["out"][k] - exact).abs() < 1e-9 * exact.max(1.0), "f={}", f);
    }
    assert_eq!(ac.frequencies.len(), 21); // 4 decades × 5 points + 1
}

#[test]
fn test_capacitive_divider_uses_gmin_and_divides_in_transient() {
    let net = "V1 1 0 PULSE(0 2 1u 1n 1n 1 2)\nC1 1 2 1u\nC2 2 0 1u\n.tran 1u 10u";
    let diags = lint_circuit(&parse_netlist(net).unwrap());
    assert!(diags.iter().any(|d| d.code == "WARN_DC_FLOATING_CAP_NODE"));
    let res = simulate_circuit(net, false);
    assert!(res.success, "{:?}", res.error_message);
    assert!(res.stamping_timeline.iter().any(|s| s.component_name == "GMIN_2"));
    let tr = res.transient.unwrap();
    assert!((tr.node_voltages["2"].last().unwrap() - 1.0).abs() < 1e-6, "C1:C2 = 1:1 halves the step");
}

#[test]
fn test_doctor_flags_inductor_across_voltage_source_and_missing_ac_source() {
    let d = lint_circuit(&parse_netlist("V1 1 0 5\nL1 1 0 1m\nR1 1 0 1k").unwrap());
    assert!(d.iter().any(|x| x.code == "ERR_KVL_VIOLATION"), "inductor is a DC short across V1");
    let d = lint_circuit(&parse_netlist("V1 1 0 5\nR1 1 2 1k\nC1 2 0 1u\n.ac dec 10 1 1k").unwrap());
    assert!(d.iter().any(|x| x.code == "WARN_NO_AC_SOURCE"));
}

#[test]
fn test_large_rc_ladder_transient_scales() {
    let n = 2000;
    let mut net = String::from("V1 1 0 PULSE(0 1 0 1n 1n 1 2)\n");
    for k in 1..=n {
        net.push_str(&format!("R{} {} {} 10\nC{} {} 0 1n\n", k, k, k + 1, k, k + 1));
    }
    net.push_str(".tran 1u 20u");
    let res = simulate_circuit_with(&net, SolverKind::SparseLu);
    assert!(res.success && res.analysis_errors.is_empty(), "{:?}", res.analysis_errors);
    let tr = res.transient.unwrap();
    let first = tr.node_voltages["2"].last().copied().unwrap();
    let last = tr.node_voltages[&(n + 1).to_string()].last().copied().unwrap();
    assert!(first > last && first > 0.5, "signal decays along the line: {} → {}", first, last);
}
