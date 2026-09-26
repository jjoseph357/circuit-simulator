//! Milestone 3: the netlist tuner, checked against values solvable by hand.
use circuit_engine::optimizer::{rewrite_line, tune, Goal, TuneParameter, TuneRequest};
use circuit_engine::simulate_circuit;

fn param(element: &str, min: f64, max: f64) -> TuneParameter {
    TuneParameter { element: element.into(), min, max }
}

#[test]
fn test_divider_tuned_to_exact_ratio() {
    let req = TuneRequest {
        netlist: "* divider\nV1 1 0 10\nR1 1 2 1k\nR2 2 0 1k\n".into(),
        parameters: vec![param("R2", 100.0, 100e3)],
        goals: vec![Goal::NodeVoltage { node: "2".into(), target: 3.3 }],
        max_evaluations: None,
    };
    let r = tune(&req);
    assert!(r.success, "{}", r.message);
    let exact = 3.3 * 1e3 / (10.0 - 3.3); // 492.54 Ω
    assert!((r.values[0] - exact).abs() / exact < 1e-3, "R2 = {} vs {}", r.values[0], exact);
    // The rewritten netlist really contains the new value and simulates to the goal
    let v = simulate_circuit(&r.netlist, true).node_voltages["2"];
    assert!((v - 3.3).abs() < 3.3e-3, "rewritten netlist gives {} V:\n{}", v, r.netlist);
    assert!(r.netlist.starts_with("* divider"));
    assert!(r.history.windows(2).all(|w| w[1].objective <= w[0].objective), "best-so-far is monotone");
}

#[test]
fn test_rc_cutoff_tuned_to_1khz() {
    let req = TuneRequest {
        netlist: "V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u".into(),
        parameters: vec![param("C1", 1e-9, 10e-6)],
        goals: vec![Goal::CutoffHz { node: "out".into(), target: 1000.0 }],
        max_evaluations: None,
    };
    let r = tune(&req);
    assert!(r.success, "{}", r.message);
    let exact = 1.0 / (2.0 * std::f64::consts::PI * 1e3 * 1e3);
    assert!((r.values[0] - exact).abs() / exact < 0.01, "C1 = {} vs {}", r.values[0], exact);
}

#[test]
fn test_transistor_bias_tuned_through_newton_raphson() {
    // Choose RB so the collector current is 1 mA
    let req = TuneRequest {
        netlist: "VCC c 0 10\nRB c b 470k\nRC c col 4.7k\nQ1 col b 0 QN\n.model QN NPN(IS=1e-15 BF=150)".into(),
        parameters: vec![param("RB", 10e3, 10e6)],
        goals: vec![Goal::ElementCurrent { element: "Q1".into(), target: 1e-3 }],
        max_evaluations: None,
    };
    let r = tune(&req);
    assert!(r.success, "{}", r.message);
    let res = simulate_circuit(&r.netlist, true);
    assert!((res.branch_currents["Q1"] - 1e-3).abs() < 2e-6, "Ic = {}", res.branch_currents["Q1"]);
}

#[test]
fn test_gain_goal_on_amplifier() {
    // |Av| = gm·RC; tune RC for 20 dB with a fixed bias
    let req = TuneRequest {
        netlist: "VCC vcc 0 10\nVB b 0 DC 0.6 AC 1\nRC vcc c 1k\nQ1 c b 0 QN\n.model QN NPN(IS=1e-15 BF=150)".into(),
        parameters: vec![param("RC", 10.0, 1e6)],
        goals: vec![Goal::GainDb { node: "c".into(), freq: 1000.0, target: 20.0 }],
        max_evaluations: None,
    };
    let r = tune(&req);
    assert!(r.success, "{} {:?}", r.message, r.goals);
    assert!((r.goals[0].achieved.unwrap() - 20.0).abs() < 0.05);
}

#[test]
fn test_conflicting_goals_are_reported_honestly() {
    let req = TuneRequest {
        netlist: "V1 1 0 10\nR1 1 2 1k\nR2 2 0 1k".into(),
        parameters: vec![param("R2", 100.0, 100e3)],
        goals: vec![Goal::NodeVoltage { node: "2".into(), target: 3.0 }, Goal::NodeVoltage { node: "2".into(), target: 7.0 }],
        max_evaluations: Some(200),
    };
    let r = tune(&req);
    assert!(!r.success);
    assert!(r.goals.iter().any(|g| !g.met));
}

#[test]
fn test_bad_requests_fail_cleanly() {
    let base = |p: Vec<TuneParameter>| TuneRequest { netlist: "V1 1 0 PULSE(0 1 0)\nR1 1 0 1k\nD1 1 0".into(), parameters: p, goals: vec![Goal::NodeVoltage { node: "1".into(), target: 1.0 }], max_evaluations: None };
    assert!(tune(&base(vec![param("R9", 1.0, 2.0)])).message.contains("No element"));
    assert!(tune(&base(vec![param("D1", 1.0, 2.0)])).message.contains("device"));
    assert!(tune(&base(vec![param("V1", 1.0, 2.0)])).message.contains("waveform"));
    assert!(tune(&base(vec![param("R1", 2.0, 1.0)])).message.contains("min < max"));
}

#[test]
fn test_rewrite_line_sets_the_value_field() {
    assert_eq!(rewrite_line("R2 2 0 1k", 492.5), "R2 2 0 492.5");
    assert_eq!(rewrite_line("V1 1 0 DC 5 AC 1", 3.0), "V1 1 0 DC 3 AC 1");
    assert_eq!(rewrite_line("C1 out 0 1u", 1.5e-7), "C1 out 0 1.5e-7");
}
