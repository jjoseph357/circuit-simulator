//! Milestone 3: diodes, BJTs and MOSFETs solved by Newton–Raphson, checked against the device
//! equations themselves and against hand-solved bias points.
use circuit_engine::nonlinear::VT;
use circuit_engine::{lint_circuit, parse_netlist, simulate_circuit, simulate_circuit_with, SolverKind};

fn q(res: &circuit_engine::models::SimulationResult, dev: &str, key: &str) -> f64 {
    let op = res.device_ops.iter().find(|o| o.name == dev).expect("device op");
    op.quantities.iter().find(|(k, _)| k == key).map(|(_, v)| *v).expect("quantity")
}

#[test]
fn test_diode_resistor_satisfies_both_equations() {
    let res = simulate_circuit("V1 1 0 5\nR1 1 2 1k\nD1 2 0 DMOD\n.model DMOD D(IS=1e-14 N=1)", false);
    assert!(res.success, "{:?}", res.error_message);
    let vd = res.node_voltages["2"];
    let id_resistor = (5.0 - vd) / 1e3;
    let id_diode = 1e-14 * ((vd / VT).exp() - 1.0);
    assert!((0.6..0.75).contains(&vd), "Vd = {}", vd);
    assert!((id_resistor - id_diode).abs() < 1e-9, "resistor says {} A, diode says {} A", id_resistor, id_diode);
    assert!(res.residual_max_abs.unwrap() < 1e-9);
    let log = res.newton.as_ref().unwrap();
    assert!(log.converged && log.strategy == "newton" && log.iterations.len() < 30, "{} iterations via {}", log.iterations.len(), log.strategy);
    assert!(res.stamping_timeline.iter().any(|s| s.component_name == "D1"), "device stamp appears in the timeline");
    assert!(!res.gaussian_steps.is_empty(), "the final linearized system is shown step by step");
    assert_eq!(res.device_ops[0].region, "forward (conducting)");
}

#[test]
fn test_diode_iv_sweep_follows_shockley() {
    let res = simulate_circuit("V1 1 0 0\nD1 1 0 DX\n.model DX D(IS=2e-14 N=1.5)\n.dc V1 0 0.8 0.05", true);
    let sweep = res.dc_sweep.expect("sweep");
    assert_eq!(sweep.values.len(), 17);
    for (k, &v) in sweep.values.iter().enumerate() {
        let expected = 2e-14 * ((v / (1.5 * VT)).exp() - 1.0) + 1e-12 * v;
        let got = sweep.branch_currents["D1"][k];
        assert!((got - expected).abs() <= 1e-9 * expected.abs().max(1e-15), "V = {}: {} vs {}", v, got, expected);
    }
}

#[test]
fn test_npn_common_emitter_bias() {
    let net = "VCC c 0 10\nVBB bb 0 5\nRB bb b 430k\nRC c col 1k\nQ1 col b 0 QN\n.model QN NPN(IS=1e-16 BF=100)";
    let res = simulate_circuit(net, false);
    assert!(res.success, "{:?}", res.error_message);
    let (ic, ib) = (q(&res, "Q1", "Ic"), q(&res, "Q1", "Ib"));
    assert!((ic / ib - 100.0).abs() < 1.0, "beta = {}", ic / ib);
    assert!((ib - (5.0 - q(&res, "Q1", "Vbe")) / 430e3).abs() < 1e-12, "base current set by RB");
    assert!((res.node_voltages["col"] - (10.0 - 1e3 * ic)).abs() < 1e-9);
    assert!(res.device_ops[0].region.starts_with("forward active"));
    assert!(res.residual_max_abs.unwrap() < 1e-9);

    // The PNP mirror image (all voltages negated) gives the mirrored answer.
    let pnp = simulate_circuit("VCC c 0 -10\nVBB bb 0 -5\nRB bb b 430k\nRC c col 1k\nQ1 col b 0 QP\n.model QP PNP(IS=1e-16 BF=100)", false);
    assert!(pnp.success, "{:?}", pnp.error_message);
    assert!((pnp.node_voltages["col"] + res.node_voltages["col"]).abs() < 1e-9);
    assert!((q(&pnp, "Q1", "Ic") + ic).abs() < 1e-12);
}

#[test]
fn test_nmos_saturation_and_triode_match_hand_analysis() {
    // β = KP·W/L = 1 mA/V², Vov = 2 − 1 = 1 V → Id(sat) = β/2·Vov² = 0.5 mA exactly (λ = 0)
    let sat = simulate_circuit("VDD dd 0 5\nVG g 0 2\nRD dd d 5k\nM1 d g 0 0 NM W=10u L=1u\n.model NM NMOS(VTO=1 KP=100u)", false);
    assert!(sat.success, "{:?}", sat.error_message);
    // GMIN (1e-12 S) across drain–source shifts Vd by 5k·2.5·1e-12 ≈ 1.25e-8 V, exactly as in SPICE
    assert!((sat.node_voltages["d"] - 2.5).abs() < 1e-7, "Vd = {}", sat.node_voltages["d"]);
    assert!(sat.device_ops[0].region.starts_with("saturation"));

    // RD = 20k pushes it into triode: 10·Vds² − 21·Vds + 5 = 0 → Vds = (21 − √241)/20
    let tri = simulate_circuit("VDD dd 0 5\nVG g 0 2\nRD dd d 20k\nM1 d g 0 NM W=10u L=1u\n.model NM NMOS(VTO=1 KP=100u)", false);
    let expected = (21.0 - 241f64.sqrt()) / 20.0;
    assert!((tri.node_voltages["d"] - expected).abs() < 1e-8, "Vds = {} vs {}", tri.node_voltages["d"], expected);
    assert!(tri.device_ops[0].region.starts_with("triode"));

    // PMOS mirror: source at 0, drain load to −5 V, gate at −2 V
    let pmos = simulate_circuit("VDD dd 0 -5\nVG g 0 -2\nRD dd d 5k\nM1 d g 0 PM W=10u L=1u\n.model PM PMOS(VTO=-1 KP=100u)", false);
    assert!((pmos.node_voltages["d"] + 2.5).abs() < 1e-7, "PMOS Vd = {}", pmos.node_voltages["d"]);
}

#[test]
fn test_cmos_inverter_transfer_curve() {
    let net = "VDD vdd 0 5\nVIN in 0 0\nMP out in vdd PM W=20u L=1u\nMN out in 0 NM W=10u L=1u\n\
               .model NM NMOS(VTO=0.8 KP=100u LAMBDA=0.01)\n.model PM PMOS(VTO=-0.8 KP=50u LAMBDA=0.01)\n\
               RL out 0 100Meg\n.dc VIN 0 5 0.05";
    let res = simulate_circuit(net, true);
    assert!(res.success && res.analysis_errors.is_empty(), "{:?} {:?}", res.error_message, res.analysis_errors);
    let out = &res.dc_sweep.unwrap().node_voltages["out"];
    assert!(out[0] > 4.99 && *out.last().unwrap() < 0.01, "rails: {} … {}", out[0], out.last().unwrap());
    assert!(out.windows(2).all(|w| w[1] <= w[0] + 1e-9), "output must fall monotonically");
    // Matched β (KP·W/L equal) and |VTO| equal → switching point at VDD/2
    let mid = out.len() / 2;
    assert!((out[mid - 2] - out[mid + 2]).abs() > 1.0, "steep transition around 2.5 V");
}

#[test]
fn test_half_wave_rectifier_transient() {
    let net = "V1 in 0 SIN(0 5 1k)\nD1 in out DR\nR1 out 0 1k\n.model DR D(IS=1e-14)\n.tran 10u 2m";
    let res = simulate_circuit(net, true);
    assert!(res.success && res.analysis_errors.is_empty(), "{:?}", res.analysis_errors);
    let tr = res.transient.unwrap();
    let out = &tr.node_voltages["out"];
    let peak = out.iter().cloned().fold(f64::MIN, f64::max);
    let low = out.iter().cloned().fold(f64::MAX, f64::min);
    assert!((4.2..4.5).contains(&peak), "peak {} ≈ 5 V − one diode drop", peak);
    assert!(low > -1e-6, "blocks the negative half-cycle: min {}", low);
    // KCL: diode current equals resistor current at every stored point
    for k in 0..tr.time.len() {
        assert!((tr.branch_currents["D1"][k] - tr.branch_currents["R1"][k]).abs() < 1e-6);
    }
}

#[test]
fn test_bjt_small_signal_gain_is_minus_gm_rc() {
    let net = "VCC vcc 0 10\nVB b 0 DC 0.65 AC 1m\nRC vcc c 2k\nQ1 c b 0 QN\n.model QN NPN(IS=1e-15 BF=150)\n.ac lin 1 1k 1k";
    let res = simulate_circuit(net, false);
    assert!(res.success, "{:?}", res.error_message);
    let gm = q(&res, "Q1", "gm");
    let ac = res.ac.unwrap();
    let gain = ac.node_magnitude["c"][0] / 1e-3;
    assert!((gain - gm * 2e3).abs() / (gm * 2e3) < 1e-6, "|Av| = {} vs gm·RC = {}", gain, gm * 2e3);
    assert!((ac.node_phase_deg["c"][0].abs() - 180.0).abs() < 1e-6, "inverting amplifier");
}

#[test]
fn test_sparse_and_gaussian_agree_for_devices() {
    let net = "VCC vcc 0 12\nR1 vcc b 47k\nR2 b 0 10k\nRC vcc c 2.2k\nRE e 0 1k\nQ1 c b e QN\n.model QN NPN(BF=120)";
    let g = simulate_circuit_with(net, SolverKind::Gaussian);
    let l = simulate_circuit_with(net, SolverKind::SparseLu);
    assert!(g.success && l.success);
    for (n, v) in &g.node_voltages {
        assert!((v - l.node_voltages[n]).abs() < 1e-9, "node {}", n);
    }
}

#[test]
fn test_parser_models_and_errors() {
    let c = parse_netlist("M1 d g s 0 NX W=2u L=0.5u\nR1 d 0 1k\nV1 g 0 1\nR2 s 0 1\n.model NX NMOS(VTO=0.5 KP=50u LAMBDA=0.02)").unwrap();
    let m = &c.components[0];
    assert_eq!(m.extra_nodes, vec!["s".to_string()]);
    assert!(matches!(m.comp_type, circuit_engine::models::ComponentType::Mosfet { w, l, lambda, .. } if w == 2e-6 && l == 0.5e-6 && lambda == 0.02));
    assert!(parse_netlist("V1 1 0 5\nD1 1 0 NOPE").unwrap_err().contains("No .model card named"));
    assert!(parse_netlist("V1 1 0 5\nQ1 1 1 0 DM\n.model DM D").unwrap_err().contains("needs a NPN or PNP model"));
    assert!(parse_netlist(".model X JFET(IS=1)\nR1 1 0 1").unwrap_err().contains("Unsupported model type"));
    // Default model when none is given
    assert!(simulate_circuit("V1 1 0 5\nR1 1 2 1k\nD1 2 0", false).success);
}

#[test]
fn test_doctor_catches_device_mistakes() {
    let d = lint_circuit(&parse_netlist("V1 1 0 5\nD1 1 0").unwrap());
    assert!(d.iter().any(|x| x.code == "WARN_DIODE_NO_CURRENT_LIMIT"));
    // A gate draws no current: a node touching only a gate has no DC voltage
    let d = lint_circuit(&parse_netlist("VDD d 0 5\nR1 d x 1k\nM1 x g 0 NM\nC1 g 0 1p\n.model NM NMOS").unwrap());
    assert!(d.iter().any(|x| x.code == "WARN_DC_FLOATING_CAP_NODE" || x.code == "ERR_ISOLATED_ISLAND"), "{:?}", d.iter().map(|x| &x.code).collect::<Vec<_>>());
}
