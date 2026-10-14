use std::collections::{HashMap, HashSet};
use crate::models::{Analysis, Circuit, Component, ComponentType, IntegrationMethod, SourceSpec, SweepType, Waveform};

pub fn parse_eng_value(s: &str) -> Result<f64, String> {
    let clean = s.trim().trim_end_matches([';', ',', ')', '(', '\'']).trim();
    if clean.is_empty() {
        return Err("Empty value string".to_string());
    }

    // Direct float parse check first
    if let Ok(val) = clean.parse::<f64>() {
        return Ok(val);
    }

    // Separate numeric prefix from unit/scale suffix
    let bytes = clean.as_bytes();
    let mut num_end = 0;
    let mut in_exponent = false;

    for (i, &b) in bytes.iter().enumerate() {
        if (b == b'+' || b == b'-') && (i == 0 || in_exponent) {
            num_end = i + 1;
            in_exponent = false;
        } else if b.is_ascii_digit() || b == b'.' {
            num_end = i + 1;
            in_exponent = false;
        } else if (b == b'e' || b == b'E') && i > 0 && bytes[i - 1].is_ascii_digit() {
            let rest = clean[i..].to_lowercase();
            if rest.starts_with("meg") {
                break;
            }
            if i + 1 < bytes.len() && (bytes[i + 1].is_ascii_digit() || bytes[i + 1] == b'+' || bytes[i + 1] == b'-') {
                num_end = i + 1;
                in_exponent = true;
            } else {
                break;
            }
        } else {
            break;
        }
    }

    if num_end == 0 {
        return Err(format!("Invalid number '{}': no numeric prefix found", clean));
    }

    let num_str = &clean[..num_end];
    let num_val = num_str.parse::<f64>().map_err(|e| format!("Invalid numeric part '{}': {}", num_str, e))?;

    let suffix = clean[num_end..].trim().to_lowercase();
    if suffix.is_empty() {
        return Ok(num_val);
    }

    // Determine scale factor from standard SPICE prefix
    let mult = if suffix.starts_with("meg") {
        1e6
    } else if suffix.starts_with('t') {
        1e12
    } else if suffix.starts_with('g') {
        1e9
    } else if suffix.starts_with('k') {
        1e3
    } else if suffix.starts_with("mil") {
        25.4e-6
    } else if suffix.starts_with('m') {
        1e-3
    } else if suffix.starts_with('u') || suffix.starts_with('µ') {
        1e-6
    } else if suffix.starts_with('n') {
        1e-9
    } else if suffix.starts_with('p') {
        1e-12
    } else if suffix.starts_with('f') {
        1e-15
    } else {
        // Plain unit without scale factor (e.g. "V", "A", "ohm", "w", "hz", "s")
        1.0
    };

    Ok(num_val * mult)
}

/// SPICE element letters that are real devices but are not part of Milestone 1.
fn unsupported_element_kind(letter: char) -> Option<&'static str> {
    match letter {
        'J' => Some("JFET"),
        _ => None,
    }
}

pub fn normalize_node(node: &str) -> String {
    let trimmed = node.trim().trim_matches(['\'', '"', ',', '(', ')']);
    if trimmed == "0" || trimmed.eq_ignore_ascii_case("gnd") || trimmed.eq_ignore_ascii_case("ground") {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

const SOURCE_KEYWORDS: &[&str] = &["dc", "ac", "pulse", "sin", "pwl"];

/// SPICE reads the first line as the circuit's title. Many hand-written netlists start straight
/// with an element instead, so the first line counts as a title only if it is not a valid element.
fn first_line_is_title(line: &str, model_names: &HashSet<String>) -> bool {
    let tokens: Vec<&str> = line.split(|c: char| c.is_whitespace() || c == ',').filter(|t| !t.is_empty()).collect();
    let Some(first_tok) = tokens.first() else { return true };
    let is_plain_word = first_tok.len() >= 3 && first_tok.chars().all(|c| c.is_ascii_alphabetic());
    let name_up = first_tok.to_ascii_uppercase();
    if name_up.starts_with("SC") || name_up.starts_with("OPEN") {
        return tokens.len() < 3 || is_plain_word;
    }
    if name_up.starts_with("OP") {
        return tokens.len() < 4 || is_plain_word;
    }
    let letter = first_tok.chars().next().unwrap().to_ascii_uppercase();
    let numeric = |t: &str| parse_eng_value(t).is_ok();
    let names_model = |words: &[&str]| words.is_empty() || words.iter().any(|w| w.contains('=') || model_names.contains(&w.to_ascii_lowercase()));
    match letter {
        'R' | 'C' | 'L' => tokens.len() < 4 || !numeric(tokens[3]),
        'V' | 'I' => tokens.len() < 4 || !(numeric(tokens[3]) || SOURCE_KEYWORDS.iter().any(|k| tokens[3].to_ascii_lowercase().starts_with(k))),
        'D' => tokens.len() < 3 || !names_model(&tokens[3..]),
        'Q' | 'M' => tokens.len() < 4 || !names_model(&tokens[4..]),
        'E' | 'G' => tokens.len() < 6 || !numeric(tokens[5]) || is_plain_word,
        'F' | 'H' => tokens.len() < 5 || !numeric(tokens[tokens.len() - 1]) || is_plain_word,
        'O' => tokens.len() < 4 || is_plain_word,
        'T' => tokens.len() < 8 || !numeric(tokens[5]) || !numeric(tokens[6]) || !numeric(tokens[7]) || is_plain_word,
        'K' => tokens.len() < 4 || !numeric(tokens[3]) || is_plain_word,
        'W' => tokens.len() < 3 || is_plain_word,
        'S' => tokens.len() < 5 || is_plain_word,
        'X' => tokens.len() < 3 || is_plain_word,
        // Real (unsupported) SPICE elements (J1 ...) get their own, clearer error; a plain word is a title.
        'J' => is_plain_word,
        _ => true,
    }
}

/// Parses everything after the two nodes of a V or I source:
/// `5`, `DC 5`, `AC 1 [phase]`, `PULSE(v1 v2 td tr tf pw per)`, `SIN(vo va f td theta phase)`,
/// `PWL(t1 v1 t2 v2 ...)`, in any combination. Returns (DC value, extra behaviour).
fn parse_source_spec(rest: &str, line: &str) -> Result<(f64, Option<SourceSpec>), String> {
    let cleaned = rest.replace(['(', ')', ','], " ").replace('=', " ");
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();
    let is_kw = |t: &str| SOURCE_KEYWORDS.contains(&t.to_ascii_lowercase().as_str());
    let num = |t: &str| parse_eng_value(t).map_err(|e| format!("{} (in '{}')", e, line));

    let mut dc: Option<f64> = None;
    let mut spec = SourceSpec::default();
    let mut has_spec = false;
    let mut i = 0;
    while i < tokens.len() {
        let kw = tokens[i].to_ascii_lowercase();
        // Numbers following a keyword, up to the next keyword
        let mut args = Vec::new();
        let mut j = i + 1;
        if is_kw(&kw) {
            while j < tokens.len() && !is_kw(tokens[j]) {
                args.push(num(tokens[j])?);
                j += 1;
            }
        }
        let arg = |k: usize, default: f64| args.get(k).copied().unwrap_or(default);
        match kw.as_str() {
            "dc" => dc = Some(arg(0, 0.0)),
            "ac" => {
                spec.ac_mag = arg(0, 1.0);
                spec.ac_phase_deg = arg(1, 0.0);
                has_spec = true;
            }
            "pulse" => {
                if args.len() < 2 {
                    return Err(format!("PULSE needs at least v1 and v2 in '{}'", line));
                }
                spec.waveform = Some(Waveform::Pulse {
                    v1: arg(0, 0.0), v2: arg(1, 0.0), td: arg(2, 0.0), tr: arg(3, 0.0), tf: arg(4, 0.0),
                    pw: arg(5, f64::INFINITY), per: arg(6, f64::INFINITY),
                });
                has_spec = true;
            }
            "sin" => {
                if args.len() < 3 {
                    return Err(format!("SIN needs offset, amplitude and frequency in '{}'", line));
                }
                spec.waveform = Some(Waveform::Sin {
                    vo: arg(0, 0.0), va: arg(1, 0.0), freq: arg(2, 0.0), td: arg(3, 0.0), theta: arg(4, 0.0), phase_deg: arg(5, 0.0),
                });
                has_spec = true;
            }
            "pwl" => {
                if args.len() < 2 || args.len() % 2 != 0 {
                    return Err(format!("PWL needs time/value pairs in '{}'", line));
                }
                let points: Vec<(f64, f64)> = args.chunks(2).map(|p| (p[0], p[1])).collect();
                if points.windows(2).any(|w| w[1].0 < w[0].0) {
                    return Err(format!("PWL times must be increasing in '{}'", line));
                }
                spec.waveform = Some(Waveform::Pwl { points });
                has_spec = true;
            }
            _ => {
                // A bare number is the DC value (SPICE: "V1 1 0 5")
                if dc.is_none() {
                    dc = Some(num(tokens[i])?);
                } else {
                    return Err(format!("Unexpected token '{}' in '{}'", tokens[i], line));
                }
            }
        }
        i = if is_kw(&kw) { j } else { i + 1 };
    }

    // SPICE: without an explicit DC value, the operating point uses the waveform's value at t = 0.
    let dc_value = dc.unwrap_or_else(|| spec.waveform.as_ref().map(|w| w.value_at(0.0)).unwrap_or(0.0));
    Ok((dc_value, if has_spec { Some(spec) } else { None }))
}

/// Parses SPICE control directives: `.ac`, `.tran`, `.dc`, `.options`, `.mor`, `.tf`, `.meas`, `.ic`.
fn parse_directive(
    trimmed: &str,
    analyses: &mut Vec<Analysis>,
    method: &mut IntegrationMethod,
    uic: &mut bool,
    initial_node_voltages: &mut HashMap<String, f64>,
) -> Result<(), String> {
    let lower = trimmed.to_ascii_lowercase();
    let tokens: Vec<&str> = lower.split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).collect();
    let num = |i: usize| -> Result<f64, String> {
        tokens.get(i).ok_or_else(|| format!("Missing argument in '{}'", trimmed)).and_then(|t| parse_eng_value(t).map_err(|e| format!("{} (in '{}')", e, trimmed)))
    };
    match tokens.first().copied() {
        Some(".ac") => {
            if tokens.len() == 2 {
                let f = parse_eng_value(tokens[1]).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                if f <= 0.0 {
                    return Err(format!("'.ac' frequency must be > 0: '{}'", trimmed));
                }
                analyses.push(Analysis::Ac { sweep: SweepType::Lin, points: 1, fstart: f, fstop: f });
            } else {
                let sweep = match tokens.get(1).copied() {
                    Some("dec") => SweepType::Dec,
                    Some("oct") => SweepType::Oct,
                    Some("lin") => SweepType::Lin,
                    _ => return Err(format!("'.ac' needs a sweep type (dec, oct or lin) or single frequency: '{}'", trimmed)),
                };
                let points = num(2)?.round() as usize;
                let (fstart, fstop) = (num(3)?, num(4)?);
                if points == 0 || fstart <= 0.0 || fstop < fstart {
                    return Err(format!("'.ac' needs points ≥ 1 and 0 < fstart ≤ fstop: '{}'", trimmed));
                }
                analyses.push(Analysis::Ac { sweep, points, fstart, fstop });
            }
        }
        Some(".tran") => {
            let (tstep, tstop) = (num(1)?, num(2)?);
            let tstart = if tokens.len() > 3 && tokens[3] != "uic" { num(3)? } else { 0.0 };
            let tmax = if tokens.len() > 4 && tokens[4] != "uic" { Some(num(4)?) } else { None };
            if tokens.iter().any(|&t| t == "uic") {
                *uic = true;
            }
            if tstep <= 0.0 || tstop <= 0.0 || tstart < 0.0 || tstart >= tstop {
                return Err(format!("'.tran' needs tstep > 0 and 0 ≤ tstart < tstop: '{}'", trimmed));
            }
            analyses.push(Analysis::Tran { tstep, tstop, tstart, tmax });
        }
        Some(".dc") => {
            let source = tokens.get(1).ok_or_else(|| format!("'.dc' needs a source name: '{}'", trimmed))?.to_string();
            let (start, stop, step) = (num(2)?, num(3)?, num(4)?);
            if step == 0.0 || (stop - start) * step < 0.0 {
                return Err(format!("'.dc' step must move from start towards stop: '{}'", trimmed));
            }
            // Keep the user's capitalization of the source name
            let original = trimmed.split_whitespace().nth(1).unwrap_or(&source).to_string();
            analyses.push(Analysis::Dc { source: original, start, stop, step });
        }
        Some(".options") | Some(".option") => {
            if let Some(m) = tokens.iter().position(|t| t.starts_with("method")) {
                let value = tokens[m].split('=').nth(1).filter(|v| !v.is_empty()).or_else(|| tokens.get(m + 1).copied()).unwrap_or("");
                *method = match value.trim_start_matches('=') {
                    "euler" | "be" | "backward_euler" => IntegrationMethod::BackwardEuler,
                    "trap" | "trapezoidal" => IntegrationMethod::Trapezoidal,
                    "gear" | "bdf2" | "gear2" => IntegrationMethod::Gear,
                    other => return Err(format!("Unknown integration method '{}' (use trap, euler, or gear)", other)),
                };
            }
        }
        Some(".mor") => {
            let order = if tokens.len() > 1 {
                tokens[1].parse::<usize>().unwrap_or(4)
            } else {
                4
            };
            let output_node = if tokens.len() > 2 {
                let n = tokens[2].trim_start_matches("v(").trim_end_matches(')');
                Some(normalize_node(n))
            } else {
                None
            };
            analyses.push(Analysis::Mor { order, output_node });
        }
        Some(".tf") => {
            if tokens.len() < 3 {
                return Err(format!("'.tf' needs output variable and input source: '{}'", trimmed));
            }
            let out_var = tokens[1].to_string();
            let in_src = tokens[2].to_string();
            analyses.push(Analysis::Tf { out_var, in_src });
        }
        Some(".meas") | Some(".measure") => {
            let (target_analysis, name, metric, variable) = if tokens.len() >= 5 && (tokens[1] == "tran" || tokens[1] == "ac" || tokens[1] == "dc") {
                (tokens[1].to_uppercase(), tokens[2].to_string(), tokens[3].to_uppercase(), tokens[4].to_string())
            } else if tokens.len() >= 4 {
                ("TRAN".to_string(), tokens[1].to_string(), tokens[2].to_uppercase(), tokens[3].to_string())
            } else {
                return Err(format!("'.meas' requires name, metric (MAX, MIN, PP, AVG, RMS), and variable in '{}'", trimmed));
            };
            analyses.push(Analysis::Measure { target_analysis, name, metric, variable });
        }
        Some(".ic") => {
            *uic = true;
            let cleaned = trimmed.replace(" = ", "=").replace(" =", "=").replace("= ", "=");
            let parts: Vec<&str> = cleaned.split_whitespace().collect();
            for t in &parts[1..] {
                if let Some((k, v)) = t.split_once('=') {
                    let n = k.trim_start_matches("v(").trim_start_matches("V(").trim_end_matches(')');
                    let val = parse_eng_value(v).map_err(|e| format!("{} in .ic", e))?;
                    initial_node_voltages.insert(normalize_node(n), val);
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// A `.model NAME TYPE(PARAM=VALUE ...)` card.
#[derive(Debug, Clone)]
struct ModelCard {
    kind: String,
    params: HashMap<String, f64>,
}

fn parse_model_card(trimmed: &str) -> Result<(String, ModelCard), String> {
    let cleaned = trimmed.replace(['(', ')', ','], " ");
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ").replace(" = ", "=").replace(" =", "=").replace("= ", "=");
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();
    if tokens.len() < 3 {
        return Err(format!("'.model' needs a name and a type (D, NPN, PNP, NMOS, PMOS): '{}'", trimmed));
    }
    let kind = tokens[2].to_ascii_uppercase();
    if !["D", "NPN", "PNP", "NMOS", "PMOS"].contains(&kind.as_str()) {
        return Err(format!("Unsupported model type '{}' in '{}' (use D, NPN, PNP, NMOS or PMOS).", tokens[2], trimmed));
    }
    let mut params = HashMap::new();
    for t in &tokens[3..] {
        let (k, v) = t.split_once('=').ok_or_else(|| format!("Expected PARAM=VALUE, got '{}' in '{}'", t, trimmed))?;
        params.insert(k.to_ascii_uppercase(), parse_eng_value(v).map_err(|e| format!("{} (in '{}')", e, trimmed))?);
    }
    Ok((tokens[1].to_ascii_lowercase(), ModelCard { kind, params }))
}

/// A device line waiting for its `.model` (cards may appear anywhere in the netlist).
struct PendingDevice {
    component: usize,
    letter: char,
    /// Tokens after the terminal nodes that are not PARAM=VALUE (model name, MOSFET bulk node).
    words: Vec<String>,
    /// Instance parameters such as W=10u L=1u.
    instance: HashMap<String, f64>,
}

struct PendingCoupling {
    name: String,
    l1: String,
    l2: String,
    val: f64,
}

fn resolve_device(pd: &PendingDevice, models: &HashMap<String, ModelCard>, line: &str) -> Result<ComponentType, String> {
    // The model is the last word that names a .model card; for a MOSFET an earlier word is the bulk node.
    let named = pd.words.iter().rev().find(|w| models.contains_key(&w.to_ascii_lowercase()));
    if named.is_none() && pd.words.len() > if pd.letter == 'M' { 1 } else { 0 } {
        return Err(format!("No .model card named '{}' for '{}'.", pd.words.last().unwrap(), line));
    }
    let card = named.map(|w| &models[&w.to_ascii_lowercase()]);
    let get = |k: &str, default: f64| card.and_then(|c| c.params.get(k).copied()).unwrap_or(default);
    let kind = card.map(|c| c.kind.as_str());
    let mismatch = |want: &str| format!("'{}' needs a {} model, but its .model card is type {}.", line, want, kind.unwrap_or("?"));
    Ok(match pd.letter {
        'D' => {
            if kind.map(|k| k != "D").unwrap_or(false) { return Err(mismatch("D")); }
            ComponentType::Diode { is: get("IS", 1e-14), n: get("N", 1.0) }
        }
        'Q' => {
            if kind.map(|k| k != "NPN" && k != "PNP").unwrap_or(false) { return Err(mismatch("NPN or PNP")); }
            ComponentType::Bjt { is: get("IS", 1e-16), bf: get("BF", 100.0), br: get("BR", 1.0), npn: kind != Some("PNP") }
        }
        _ => {
            if kind.map(|k| k != "NMOS" && k != "PMOS").unwrap_or(false) { return Err(mismatch("NMOS or PMOS")); }
            let nmos = kind != Some("PMOS");
            ComponentType::Mosfet {
                vto: get("VTO", if nmos { 0.7 } else { -0.7 }),
                kp: get("KP", 2e-5),
                lambda: get("LAMBDA", 0.0),
                w: pd.instance.get("W").copied().unwrap_or(1e-4),
                l: pd.instance.get("L").copied().unwrap_or(1e-4),
                nmos,
            }
        }
    })
}

struct SubcktDef {
    ports: Vec<String>,
    lines: Vec<String>,
}

fn map_subckt_node(node: &str, port_map: &HashMap<String, String>, inst: &str) -> String {
    let norm = normalize_node(node);
    if norm == "0" {
        return "0".to_string();
    }
    if let Some(mapped) = port_map.get(&node.to_ascii_uppercase()) {
        return mapped.clone();
    }
    format!("{}_{}", inst, node)
}

fn rewrite_subckt_element(
    tokens: &[&str],
    new_name: &str,
    port_map: &HashMap<String, String>,
    inst_name: &str,
    sub_elements: &HashSet<String>,
) -> String {
    let first_char = tokens[0].chars().next().unwrap().to_ascii_uppercase();
    let mut out_tokens = Vec::new();
    out_tokens.push(new_name.to_string());

    match first_char {
        'R' | 'C' | 'L' | 'V' | 'I' | 'D' | 'W' => {
            if tokens.len() > 1 { out_tokens.push(map_subckt_node(tokens[1], port_map, inst_name)); }
            if tokens.len() > 2 { out_tokens.push(map_subckt_node(tokens[2], port_map, inst_name)); }
            for t in &tokens[3..] { out_tokens.push(t.to_string()); }
        }
        'Q' => {
            for i in 1..=3.min(tokens.len() - 1) {
                out_tokens.push(map_subckt_node(tokens[i], port_map, inst_name));
            }
            for t in &tokens[4..] { out_tokens.push(t.to_string()); }
        }
        'M' => {
            let max_nodes = if tokens.len() >= 6 && !tokens[4].contains('=') && !tokens[5].contains('=') { 4 } else { 3 };
            for i in 1..=max_nodes.min(tokens.len() - 1) {
                out_tokens.push(map_subckt_node(tokens[i], port_map, inst_name));
            }
            for t in &tokens[max_nodes + 1..] { out_tokens.push(t.to_string()); }
        }
        'S' => {
            for i in 1..=4.min(tokens.len() - 1) {
                out_tokens.push(map_subckt_node(tokens[i], port_map, inst_name));
            }
            for t in &tokens[5..] { out_tokens.push(t.to_string()); }
        }
        'E' | 'G' => {
            for i in 1..=4.min(tokens.len() - 1) {
                out_tokens.push(map_subckt_node(tokens[i], port_map, inst_name));
            }
            for t in &tokens[5..] { out_tokens.push(t.to_string()); }
        }
        'F' | 'H' => {
            if tokens.len() >= 6 {
                for i in 1..=4 {
                    out_tokens.push(map_subckt_node(tokens[i], port_map, inst_name));
                }
                for t in &tokens[5..] { out_tokens.push(t.to_string()); }
            } else if tokens.len() >= 5 {
                out_tokens.push(map_subckt_node(tokens[1], port_map, inst_name));
                out_tokens.push(map_subckt_node(tokens[2], port_map, inst_name));
                let v_ctrl = tokens[3];
                if sub_elements.contains(&v_ctrl.to_ascii_uppercase()) {
                    out_tokens.push(format!("{}_{}", v_ctrl, inst_name));
                } else {
                    out_tokens.push(v_ctrl.to_string());
                }
                for t in &tokens[4..] { out_tokens.push(t.to_string()); }
            } else {
                for t in &tokens[1..] { out_tokens.push(t.to_string()); }
            }
        }
        'K' => {
            if tokens.len() >= 4 {
                let l1 = tokens[1];
                let l2 = tokens[2];
                if sub_elements.contains(&l1.to_ascii_uppercase()) {
                    out_tokens.push(format!("{}_{}", l1, inst_name));
                } else {
                    out_tokens.push(l1.to_string());
                }
                if sub_elements.contains(&l2.to_ascii_uppercase()) {
                    out_tokens.push(format!("{}_{}", l2, inst_name));
                } else {
                    out_tokens.push(l2.to_string());
                }
                for t in &tokens[3..] { out_tokens.push(t.to_string()); }
            } else {
                for t in &tokens[1..] { out_tokens.push(t.to_string()); }
            }
        }
        'T' => {
            for i in 1..=4.min(tokens.len() - 1) {
                out_tokens.push(map_subckt_node(tokens[i], port_map, inst_name));
            }
            for t in &tokens[5..] { out_tokens.push(t.to_string()); }
        }
        'O' => {
            if tokens.len() >= 5 {
                for i in 1..=4 {
                    out_tokens.push(map_subckt_node(tokens[i], port_map, inst_name));
                }
                for t in &tokens[5..] { out_tokens.push(t.to_string()); }
            } else if tokens.len() == 4 {
                for i in 1..=3 {
                    out_tokens.push(map_subckt_node(tokens[i], port_map, inst_name));
                }
            } else {
                for t in &tokens[1..] { out_tokens.push(t.to_string()); }
            }
        }
        _ => {
            for t in &tokens[1..] { out_tokens.push(t.to_string()); }
        }
    }
    out_tokens.join(" ")
}

fn expand_instance(
    inst_name: &str,
    subckt_name: &str,
    args: &[String],
    subckts: &HashMap<String, SubcktDef>,
    depth: usize,
) -> Result<Vec<String>, String> {
    if depth > 50 {
        return Err("Maximum subcircuit recursion depth exceeded (circular subcircuit dependency?)".to_string());
    }
    let def = subckts.get(&subckt_name.to_ascii_uppercase())
        .ok_or_else(|| format!("Unknown subcircuit '{}'", subckt_name))?;
    if def.ports.len() != args.len() {
        return Err(format!("Subcircuit '{}' expects {} ports, but got {} in instance '{}'", subckt_name, def.ports.len(), args.len(), inst_name));
    }
    let mut port_map = HashMap::new();
    for (port, arg) in def.ports.iter().zip(args.iter()) {
        port_map.insert(port.to_ascii_uppercase(), arg.clone());
    }

    let mut sub_elements = HashSet::new();
    for line in &def.lines {
        let t = line.trim();
        if !t.is_empty() && !t.starts_with('*') && !t.starts_with('.') {
            if let Some(first) = t.split_whitespace().next() {
                sub_elements.insert(first.to_ascii_uppercase());
            }
        }
    }

    let mut result_lines = Vec::new();
    for line in &def.lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('*') {
            continue;
        }
        if trimmed.starts_with('.') {
            result_lines.push(trimmed.to_string());
            continue;
        }
        let tokens: Vec<&str> = trimmed.split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).collect();
        if tokens.is_empty() {
            continue;
        }
        let first_char = tokens[0].chars().next().unwrap().to_ascii_uppercase();
        if first_char == 'X' {
            let nested_inst = format!("{}_{}", tokens[0], inst_name);
            let nested_sub = tokens.last().unwrap();
            let nested_args: Vec<String> = tokens[1..tokens.len()-1].iter().map(|t| map_subckt_node(t, &port_map, inst_name)).collect();
            let expanded = expand_instance(&nested_inst, nested_sub, &nested_args, subckts, depth + 1)?;
            result_lines.extend(expanded);
            continue;
        }

        let new_name = format!("{}_{}", tokens[0], inst_name);
        let rewritten = rewrite_subckt_element(&tokens, &new_name, &port_map, inst_name, &sub_elements);
        result_lines.push(rewritten);
    }
    Ok(result_lines)
}

pub fn expand_subcircuits(input: &str) -> Result<String, String> {
    if !input.lines().any(|l| l.trim().to_ascii_lowercase().starts_with(".subckt")) {
        return Ok(input.to_string());
    }

    let mut subckts: HashMap<String, SubcktDef> = HashMap::new();
    let mut current_subckt: Option<(String, SubcktDef)> = None;
    let mut top_lines: Vec<String> = Vec::new();

    for line in input.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with(".subckt") {
            if current_subckt.is_some() {
                return Err("Nested .subckt definitions are not supported (define them consecutively)".to_string());
            }
            let tokens: Vec<&str> = trimmed.split_whitespace().collect();
            if tokens.len() < 2 {
                return Err(format!("Invalid .subckt directive: '{}'", trimmed));
            }
            let name = tokens[1].to_ascii_uppercase();
            let ports: Vec<String> = tokens[2..].iter().map(|s| s.to_string()).collect();
            current_subckt = Some((name, SubcktDef { ports, lines: Vec::new() }));
        } else if lower.starts_with(".ends") {
            if let Some((name, def)) = current_subckt.take() {
                subckts.insert(name, def);
            } else {
                return Err(format!("Unexpected .ends without matching .subckt: '{}'", trimmed));
            }
        } else if let Some((_, ref mut def)) = current_subckt {
            def.lines.push(line.to_string());
        } else {
            top_lines.push(line.to_string());
        }
    }

    if current_subckt.is_some() {
        return Err("Unclosed .subckt block (missing .ends)".to_string());
    }

    let mut final_lines = Vec::new();
    for line in top_lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('*') || trimmed.starts_with('.') {
            final_lines.push(line);
            continue;
        }
        let tokens: Vec<&str> = trimmed.split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).collect();
        if tokens.is_empty() {
            final_lines.push(line);
            continue;
        }
        let first_char = tokens[0].chars().next().unwrap().to_ascii_uppercase();
        if first_char == 'X' {
            let inst_name = tokens[0];
            let sub_name = tokens.last().unwrap();
            let args: Vec<String> = tokens[1..tokens.len()-1].iter().map(|s| s.to_string()).collect();
            let expanded = expand_instance(inst_name, sub_name, &args, &subckts, 0)?;
            final_lines.extend(expanded);
        } else {
            final_lines.push(line);
        }
    }

    Ok(final_lines.join("\n"))
}

pub fn parse_netlist(input: &str) -> Result<Circuit, String> {
    let expanded = expand_subcircuits(input)?;
    let mut components = Vec::new();
    let mut analyses = Vec::new();
    let mut method = IntegrationMethod::Trapezoidal;
    let mut uic = false;
    let mut initial_node_voltages = HashMap::new();
    let mut models: HashMap<String, ModelCard> = HashMap::new();
    let mut pending: Vec<PendingDevice> = Vec::new();
    let mut pending_couplings: Vec<PendingCoupling> = Vec::new();

    // .model cards may come after the devices that use them.
    let model_names: HashSet<String> = expanded
        .lines()
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            (w.next()?.eq_ignore_ascii_case(".model")).then(|| w.next().map(|n| n.to_ascii_lowercase()))?
        })
        .collect();
    let mut first_content_line = true;
    for line in expanded.lines() {
        let line_trimmed = line.trim();
        if line_trimmed.is_empty() {
            continue;
        }
        let is_first_line = std::mem::replace(&mut first_content_line, false);
        if line_trimmed.starts_with('*') {
            continue;
        }
        // Inline comments: ';' anywhere, or '$' after whitespace (ngspice style).
        let mut stripped_line = line_trimmed;
        if let Some(idx) = stripped_line.find(';') {
            stripped_line = &stripped_line[..idx];
        }
        if let Some(idx) = stripped_line.find(" $").or_else(|| stripped_line.find("\t$")) {
            stripped_line = &stripped_line[..idx];
        }

        {
            let trimmed = stripped_line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let lower = trimmed.to_lowercase();
            if lower.starts_with('.') {
                if lower.starts_with(".model") {
                    let (name, card) = parse_model_card(trimmed)?;
                    models.insert(name, card);
                } else {
                    parse_directive(trimmed, &mut analyses, &mut method, &mut uic, &mut initial_node_voltages)?;
                }
                continue;
            }
            if is_first_line && first_line_is_title(trimmed, &model_names) {
                continue;
            }

            // SPICE element lines: R1 n1 n2 5, I1 0 1 3, V1 1 0 10 (space or comma delimiters)
            let tokens: Vec<&str> = trimmed
                .split(|c: char| c.is_whitespace() || c == ',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            // Diodes (D a k [model]) and transistors (Q c b e [model], M d g s [b] [model] [W= L=])
            let letter = tokens.first().and_then(|t| t.chars().next()).map(|c| c.to_ascii_uppercase());
            if let Some(letter @ ('D' | 'Q' | 'M')) = letter {
                let n_terms = if letter == 'D' { 2 } else { 3 };
                if tokens.len() < 1 + n_terms {
                    return Err(format!("'{}' needs {} terminal nodes.", trimmed, n_terms));
                }
                let spaced = trimmed.replace(" = ", "=").replace(" =", "=").replace("= ", "=");
                let all: Vec<&str> = spaced.split(|c: char| c.is_whitespace() || c == ',').filter(|t| !t.is_empty()).collect();
                let mut words = Vec::new();
                let mut instance = HashMap::new();
                for t in &all[1 + n_terms..] {
                    match t.split_once('=') {
                        Some((k, v)) => { instance.insert(k.to_ascii_uppercase(), parse_eng_value(v).map_err(|e| format!("{} (in '{}')", e, trimmed))?); }
                        None => words.push(t.to_string()),
                    }
                }
                let nodes: Vec<String> = all[1..1 + n_terms].iter().map(|t| normalize_node(t)).collect();
                pending.push(PendingDevice { component: components.len(), letter, words, instance });
                components.push(Component {
                    name: all[0].to_string(),
                    comp_type: ComponentType::Diode { is: 0.0, n: 1.0 }, // replaced once models are known
                    node1: nodes[0].clone(),
                    node2: nodes[1].clone(),
                    original_line: trimmed.to_string(),
                    source: None,
                    extra_nodes: nodes[2..].to_vec(),
                    initial_condition: None,
                });
                continue;
            }

            let name = tokens[0].to_string();
            let first_char = name.chars().next().unwrap().to_ascii_uppercase();

            if first_char == 'K' {
                if tokens.len() < 4 {
                    return Err(format!("'{}' needs a name, two inductors and coupling factor or mutual inductance, e.g. K1 L1 L2 0.95.", trimmed));
                }
                pending_couplings.push(PendingCoupling {
                    name: tokens[0].to_string(),
                    l1: tokens[1].to_string(),
                    l2: tokens[2].to_string(),
                    val: parse_eng_value(tokens[3]).map_err(|e| format!("{} (in '{}')", e, trimmed))?,
                });
                continue;
            }

            if first_char == 'W' || name.to_ascii_uppercase().starts_with("SC") {
                if tokens.len() < 3 {
                    return Err(format!("'{}' needs a name and two nodes, e.g. W1 1 2.", trimmed));
                }
                components.push(Component {
                    name,
                    comp_type: ComponentType::ShortCircuit,
                    node1: normalize_node(tokens[1]),
                    node2: normalize_node(tokens[2]),
                    original_line: trimmed.to_string(),
                    source: None,
                    extra_nodes: Vec::new(),
                    initial_condition: None,
                });
                continue;
            }

            if name.to_ascii_uppercase().starts_with("OPEN") {
                if tokens.len() < 3 {
                    return Err(format!("'{}' needs a name and two nodes, e.g. OPEN1 1 2.", trimmed));
                }
                components.push(Component {
                    name,
                    comp_type: ComponentType::OpenCircuit,
                    node1: normalize_node(tokens[1]),
                    node2: normalize_node(tokens[2]),
                    original_line: trimmed.to_string(),
                    source: None,
                    extra_nodes: Vec::new(),
                    initial_condition: None,
                });
                continue;
            }

            if first_char == 'E' {
                if tokens.len() < 6 {
                    return Err(format!("'{}' needs a name, two output nodes, two control nodes and a gain, e.g. E1 3 0 1 2 2.0.", trimmed));
                }
                let n1 = normalize_node(tokens[1]);
                let n2 = normalize_node(tokens[2]);
                let nc1 = normalize_node(tokens[3]);
                let nc2 = normalize_node(tokens[4]);
                let comp_type = if tokens[5].eq_ignore_ascii_case("opamp") {
                    let gain = tokens.get(6).and_then(|t| parse_eng_value(t).ok());
                    ComponentType::OpAmp { gain }
                } else {
                    let gain = parse_eng_value(tokens[5]).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                    ComponentType::Vcvs { gain }
                };
                components.push(Component {
                    name,
                    comp_type,
                    node1: n1,
                    node2: n2,
                    original_line: trimmed.to_string(),
                    source: None,
                    extra_nodes: vec![nc1, nc2],
                    initial_condition: None,
                });
                continue;
            }

            if first_char == 'G' {
                if tokens.len() < 6 {
                    return Err(format!("'{}' needs a name, two output nodes, two control nodes and transconductance gm, e.g. G1 3 0 1 2 5m.", trimmed));
                }
                let n1 = normalize_node(tokens[1]);
                let n2 = normalize_node(tokens[2]);
                let nc1 = normalize_node(tokens[3]);
                let nc2 = normalize_node(tokens[4]);
                let gm = parse_eng_value(tokens[5]).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                components.push(Component {
                    name,
                    comp_type: ComponentType::Vccs { gm },
                    node1: n1,
                    node2: n2,
                    original_line: trimmed.to_string(),
                    source: None,
                    extra_nodes: vec![nc1, nc2],
                    initial_condition: None,
                });
                continue;
            }

            if first_char == 'F' {
                if tokens.len() >= 6 {
                    let n1 = normalize_node(tokens[1]);
                    let n2 = normalize_node(tokens[2]);
                    let nc1 = normalize_node(tokens[3]);
                    let nc2 = normalize_node(tokens[4]);
                    let gain = parse_eng_value(tokens[5]).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                    components.push(Component {
                        name,
                        comp_type: ComponentType::Cccs { gain, v_ctrl: None },
                        node1: n1,
                        node2: n2,
                        original_line: trimmed.to_string(),
                        source: None,
                        extra_nodes: vec![nc1, nc2],
                        initial_condition: None,
                    });
                    continue;
                } else if tokens.len() >= 5 {
                    let n1 = normalize_node(tokens[1]);
                    let n2 = normalize_node(tokens[2]);
                    let v_ctrl = tokens[3].to_string();
                    let gain = parse_eng_value(tokens[4]).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                    components.push(Component {
                        name,
                        comp_type: ComponentType::Cccs { gain, v_ctrl: Some(v_ctrl) },
                        node1: n1,
                        node2: n2,
                        original_line: trimmed.to_string(),
                        source: None,
                        extra_nodes: vec![],
                        initial_condition: None,
                    });
                    continue;
                } else {
                    return Err(format!("'{}' needs at least 5 tokens, e.g. F1 3 0 V1 10 or F1 3 0 1 2 10.", trimmed));
                }
            }

            if first_char == 'H' {
                if tokens.len() >= 6 {
                    let n1 = normalize_node(tokens[1]);
                    let n2 = normalize_node(tokens[2]);
                    let nc1 = normalize_node(tokens[3]);
                    let nc2 = normalize_node(tokens[4]);
                    let r_val = parse_eng_value(tokens[5]).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                    components.push(Component {
                        name,
                        comp_type: ComponentType::Ccvs { r_val, v_ctrl: None },
                        node1: n1,
                        node2: n2,
                        original_line: trimmed.to_string(),
                        source: None,
                        extra_nodes: vec![nc1, nc2],
                        initial_condition: None,
                    });
                    continue;
                } else if tokens.len() >= 5 {
                    let n1 = normalize_node(tokens[1]);
                    let n2 = normalize_node(tokens[2]);
                    let v_ctrl = tokens[3].to_string();
                    let r_val = parse_eng_value(tokens[4]).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                    components.push(Component {
                        name,
                        comp_type: ComponentType::Ccvs { r_val, v_ctrl: Some(v_ctrl) },
                        node1: n1,
                        node2: n2,
                        original_line: trimmed.to_string(),
                        source: None,
                        extra_nodes: vec![],
                        initial_condition: None,
                    });
                    continue;
                } else {
                    return Err(format!("'{}' needs at least 5 tokens, e.g. H1 3 0 V1 1k or H1 3 0 1 2 1k.", trimmed));
                }
            }

            if first_char == 'O' || name.to_ascii_uppercase().starts_with("OP") {
                let (n1, n2, nc1, nc2, gain) = if tokens.len() >= 5 {
                    let n1 = normalize_node(tokens[1]);
                    let n2 = normalize_node(tokens[2]);
                    let nc1 = normalize_node(tokens[3]);
                    let nc2 = normalize_node(tokens[4]);
                    let gain = tokens.get(5).and_then(|t| parse_eng_value(t).ok());
                    (n1, n2, nc1, nc2, gain)
                } else if tokens.len() == 4 {
                    let n1 = normalize_node(tokens[1]);
                    let n2 = "0".to_string();
                    let nc1 = normalize_node(tokens[2]);
                    let nc2 = normalize_node(tokens[3]);
                    (n1, n2, nc1, nc2, None)
                } else {
                    return Err(format!("'{}' needs OpAmp output node(s) and input nodes, e.g. O1 out 0 in+ in- or O1 out in+ in-.", trimmed));
                };
                components.push(Component {
                    name,
                    comp_type: ComponentType::OpAmp { gain },
                    node1: n1,
                    node2: n2,
                    original_line: trimmed.to_string(),
                    source: None,
                    extra_nodes: vec![nc1, nc2],
                    initial_condition: None,
                });
                continue;
            }

            if first_char == 'T' {
                if tokens.len() < 7 {
                    return Err(format!("'{}' needs a transformer name, 4 nodes (p+ p- s+ s-) and inductances L1 L2 [M], e.g. T1 1 0 2 0 10m 10m 9m.", trimmed));
                }
                let n1 = normalize_node(tokens[1]);
                let n2 = normalize_node(tokens[2]);
                let ns1 = normalize_node(tokens[3]);
                let ns2 = normalize_node(tokens[4]);
                let l1 = parse_eng_value(tokens[5]).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                let l2 = parse_eng_value(tokens[6]).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                let m = if let Some(m_tok) = tokens.get(7) {
                    if m_tok.to_ascii_lowercase().starts_with("k=") {
                        let k = parse_eng_value(&m_tok[2..]).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                        k * (l1 * l2).sqrt()
                    } else {
                        let v = parse_eng_value(m_tok).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                        if v.abs() <= 1.0 && v != 0.0 && v != 1.0 {
                            v * (l1 * l2).sqrt()
                        } else {
                            v
                        }
                    }
                } else {
                    0.999 * (l1 * l2).sqrt()
                };
                components.push(Component {
                    name,
                    comp_type: ComponentType::Transformer { l1, l2, m },
                    node1: n1,
                    node2: n2,
                    original_line: trimmed.to_string(),
                    source: None,
                    extra_nodes: vec![ns1, ns2],
                    initial_condition: None,
                });
                continue;
            }

            if first_char == 'S' {
                if tokens.len() < 5 {
                    return Err(format!("'{}' needs switch name, two switch terminals, and two control terminals, e.g. S1 1 2 3 4.", trimmed));
                }
                let n1 = normalize_node(tokens[1]);
                let n2 = normalize_node(tokens[2]);
                let nc1 = normalize_node(tokens[3]);
                let nc2 = normalize_node(tokens[4]);
                let mut ron = 1.0;
                let mut roff = 1e6;
                let mut vt = 0.0;
                for tok in &tokens[5..] {
                    let tok_lower = tok.to_ascii_lowercase();
                    if let Some((k, v)) = tok_lower.split_once('=') {
                        match k {
                            "ron" => if let Ok(val) = parse_eng_value(v) { ron = val; },
                            "roff" => if let Ok(val) = parse_eng_value(v) { roff = val; },
                            "vt" => if let Ok(val) = parse_eng_value(v) { vt = val; },
                            _ => {}
                        }
                    } else if let Ok(val) = parse_eng_value(tok) {
                        if ron == 1.0 { ron = val; }
                        else if roff == 1e6 { roff = val; }
                        else { vt = val; }
                    }
                }
                components.push(Component {
                    name,
                    comp_type: ComponentType::Switch { ron, roff, vt },
                    node1: n1,
                    node2: n2,
                    original_line: trimmed.to_string(),
                    source: None,
                    extra_nodes: vec![nc1, nc2],
                    initial_condition: None,
                });
                continue;
            }

            if tokens.len() < 4 {
                return Err(format!("'{}' needs a name, two nodes and a value, e.g. R1 1 2 1k.", trimmed));
            }

            let n1 = normalize_node(tokens[1]);
            let n2 = normalize_node(tokens[2]);

            let (comp_type, source) = match first_char {
                'V' | 'I' => {
                    // Everything after the two node names, located in the original text so
                    // parentheses like PULSE(0 5 ...) survive.
                    let after_nodes = {
                        let mut rest = trimmed;
                        for t in &tokens[..3] {
                            let pos = rest.find(t).unwrap_or(0) + t.len();
                            rest = &rest[pos..];
                        }
                        rest.trim_start_matches([',', ' ', '\t'])
                    };
                    let (dc, source) = parse_source_spec(after_nodes, trimmed)?;
                    let ct = if first_char == 'V' {
                        ComponentType::VoltageSource { v_val: dc }
                    } else {
                        ComponentType::CurrentSource { i_val: dc }
                    };
                    (ct, source)
                }
                'R' | 'C' | 'L' => {
                    let val = parse_eng_value(tokens[3]).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                    let ct = match first_char {
                        'R' => ComponentType::Resistor { r_val: val },
                        'C' => ComponentType::Capacitor { c_val: val },
                        _ => ComponentType::Inductor { l_val: val },
                    };
                    (ct, None)
                }
                other => {
                    // Silently dropping a device would give a wrong answer with no warning.
                    parse_eng_value(tokens[3]).map_err(|e| format!("{} (in '{}')", e, trimmed))?;
                    match unsupported_element_kind(other) {
                        Some(kind) => {
                            return Err(format!(
                                "'{}' is a {} ({}), which this engine does not simulate yet. Supported elements: R, C, L, V, I, D, Q, M, E, G, F, H, O, T, K, W, S, X.",
                                trimmed, kind, other
                            ))
                        }
                        None => {
                            return Err(format!(
                                "'{}': unknown element '{}'. Supported elements: R, C, L, V, I, D, Q, M, E, G, F, H, O, T, K, W, S, X.",
                                trimmed, name
                            ))
                        }
                    }
                }
            };

            let mut initial_condition = None;
            if first_char == 'C' || first_char == 'L' {
                let cleaned = trimmed.replace(" = ", "=").replace(" =", "=").replace("= ", "=");
                for tok in cleaned.split_whitespace().skip(4) {
                    if let Some((k, v)) = tok.split_once('=') {
                        if k.eq_ignore_ascii_case("ic") {
                            if let Ok(v_ic) = parse_eng_value(v) {
                                initial_condition = Some(v_ic);
                            }
                        }
                    }
                }
            }

            components.push(Component {
                name,
                comp_type,
                node1: n1,
                node2: n2,
                original_line: trimmed.to_string(),
                source,
                extra_nodes: Vec::new(),
                initial_condition,
            });
        }
    }

    if components.is_empty() {
        return Err("No valid circuit elements found in netlist.".to_string());
    }

    for pd in &pending {
        let line = components[pd.component].original_line.clone();
        components[pd.component].comp_type = resolve_device(pd, &models, &line)?;
    }

    let mut mutual_couplings = Vec::new();
    for pc in pending_couplings {
        let l1 = components.iter().find(|c| c.name.eq_ignore_ascii_case(&pc.l1))
            .ok_or_else(|| format!("Mutual coupling '{}' references unknown inductor '{}'.", pc.name, pc.l1))?;
        let l2 = components.iter().find(|c| c.name.eq_ignore_ascii_case(&pc.l2))
            .ok_or_else(|| format!("Mutual coupling '{}' references unknown inductor '{}'.", pc.name, pc.l2))?;
        let (val1, val2) = match (&l1.comp_type, &l2.comp_type) {
            (ComponentType::Inductor { l_val: v1 }, ComponentType::Inductor { l_val: v2 }) => (*v1, *v2),
            _ => return Err(format!("'{}' and '{}' must both be inductors in mutual coupling '{}'.", pc.l1, pc.l2, pc.name)),
        };
        let m = if pc.val.abs() <= 1.0 {
            pc.val * (val1 * val2).sqrt()
        } else {
            pc.val
        };
        mutual_couplings.push(crate::models::MutualCoupling {
            name: pc.name,
            l1_name: l1.name.clone(),
            l2_name: l2.name.clone(),
            m,
        });
    }

    for c in &components {
        let v_ctrl_opt = match &c.comp_type {
            ComponentType::Cccs { v_ctrl, .. } => v_ctrl.as_ref(),
            ComponentType::Ccvs { v_ctrl, .. } => v_ctrl.as_ref(),
            _ => None,
        };
        if let Some(v_name) = v_ctrl_opt {
            if !components.iter().any(|other| other.name.eq_ignore_ascii_case(v_name) && matches!(other.comp_type, ComponentType::VoltageSource { .. })) {
                return Err(format!("Controlled source '{}' references unknown voltage source '{}'.", c.name, v_name));
            }
        }
    }

    let mut seen_names = HashSet::new();
    for c in &components {
        if !seen_names.insert(c.name.to_ascii_uppercase()) {
            return Err(format!(
                "Duplicate element name '{}'. Every SPICE element needs a unique name (e.g. R1, R2).",
                c.name
            ));
        }
        let value = match c.comp_type {
            ComponentType::Resistor { r_val } => r_val,
            ComponentType::CurrentSource { i_val } => i_val,
            ComponentType::VoltageSource { v_val } => v_val,
            ComponentType::Capacitor { c_val } => c_val,
            ComponentType::Inductor { l_val } => l_val,
            ComponentType::Diode { is, n } => is * n,
            ComponentType::Bjt { is, bf, br, .. } => is * bf * br,
            ComponentType::Mosfet { kp, w, l, .. } => kp * w / l,
            ComponentType::ShortCircuit | ComponentType::OpenCircuit => 0.0,
            ComponentType::Vccs { gm } => gm,
            ComponentType::Vcvs { gain } => gain,
            ComponentType::Cccs { gain, .. } => gain,
            ComponentType::Ccvs { r_val, .. } => r_val,
            ComponentType::OpAmp { gain } => gain.unwrap_or(1e6),
            ComponentType::Transformer { l1, l2, m } => l1 * l2 * m,
            ComponentType::Switch { ron, .. } => ron,
        };
        if !value.is_finite() {
            return Err(format!("Element {} has a non-finite value in '{}'.", c.name, c.original_line));
        }
        match c.comp_type {
            ComponentType::Resistor { r_val } if r_val == 0.0 => {
                return Err(format!(
                    "Resistor {} is 0 Ω, so its conductance 1/R is infinite and cannot be stamped. Merge nodes {} and {} into one node, or use a 0 V voltage source if you want to measure the current through a wire.",
                    c.name, c.node1, c.node2
                ));
            }
            ComponentType::Capacitor { c_val } if c_val < 0.0 => {
                return Err(format!("Capacitor {} has a negative value ({} F).", c.name, c_val));
            }
            ComponentType::Inductor { l_val } if l_val < 0.0 => {
                return Err(format!("Inductor {} has a negative value ({} H).", c.name, l_val));
            }
            _ => {}
        }
    }

    // Build unique nodes and mapping
    let mut node_set = HashSet::new();
    for c in &components {
        for n in c.nodes() {
            node_set.insert(n.to_string());
        }
    }

    let mut non_ground_nodes: Vec<String> = node_set
        .into_iter()
        .filter(|n| n != "0")
        .collect();

    // Numeric node names first in numeric order, then named nodes alphabetically.
    // (A mixed numeric/lexicographic comparator is not a total order and can panic in sort.)
    non_ground_nodes.sort_by_key(|n| match n.parse::<i64>() {
        Ok(v) => (0u8, v, String::new()),
        Err(_) => (1u8, 0, n.clone()),
    });

    let mut node_names = vec!["0".to_string()];
    node_names.extend(non_ground_nodes.clone());

    let mut node_to_idx = HashMap::new();
    for (idx, name) in node_names.iter().enumerate() {
        node_to_idx.insert(name.clone(), idx);
    }

    let num_nodes = non_ground_nodes.len();

    // Branch-current unknowns:
    let mut variable_names: Vec<String> = non_ground_nodes.iter().map(|n| format!("V({})", n)).collect();
    let mut aux_index = HashMap::new();
    let mut num_v_sources = 0;
    for c in &components {
        match c.comp_type {
            ComponentType::VoltageSource { .. } => {
                num_v_sources += 1;
                let idx = variable_names.len();
                aux_index.insert(c.name.clone(), idx);
                variable_names.push(format!("I({})", c.name));
            }
            ComponentType::Inductor { .. } => {
                let idx = variable_names.len();
                aux_index.insert(c.name.clone(), idx);
                variable_names.push(format!("I({})", c.name));
            }
            ComponentType::ShortCircuit => {
                let idx = variable_names.len();
                aux_index.insert(c.name.clone(), idx);
                variable_names.push(format!("I({})", c.name));
            }
            ComponentType::Vcvs { .. } => {
                let idx = variable_names.len();
                aux_index.insert(c.name.clone(), idx);
                variable_names.push(format!("I({})", c.name));
            }
            ComponentType::OpAmp { .. } => {
                let idx = variable_names.len();
                aux_index.insert(c.name.clone(), idx);
                variable_names.push(format!("I({})", c.name));
            }
            ComponentType::Cccs { ref v_ctrl, .. } => {
                if v_ctrl.is_none() {
                    let idx = variable_names.len();
                    aux_index.insert(c.name.clone(), idx);
                    variable_names.push(format!("I({})", c.name));
                }
            }
            ComponentType::Ccvs { ref v_ctrl, .. } => {
                if v_ctrl.is_none() {
                    let idx1 = variable_names.len();
                    aux_index.insert(format!("{}:ctrl", c.name), idx1);
                    variable_names.push(format!("I1({})", c.name));

                    let idx2 = variable_names.len();
                    aux_index.insert(c.name.clone(), idx2);
                    aux_index.insert(format!("{}:2", c.name), idx2);
                    variable_names.push(format!("I2({})", c.name));
                } else {
                    let idx = variable_names.len();
                    aux_index.insert(c.name.clone(), idx);
                    variable_names.push(format!("I({})", c.name));
                }
            }
            ComponentType::Transformer { .. } => {
                let idx1 = variable_names.len();
                aux_index.insert(c.name.clone(), idx1);
                aux_index.insert(format!("{}:1", c.name), idx1);
                variable_names.push(format!("I1({})", c.name));

                let idx2 = variable_names.len();
                aux_index.insert(format!("{}:2", c.name), idx2);
                variable_names.push(format!("I2({})", c.name));
            }
            _ => {}
        }
    }
    let num_aux = variable_names.len() - num_nodes;

    Ok(Circuit {
        components,
        node_names,
        node_to_idx,
        num_nodes,
        num_v_sources,
        variable_names,
        aux_index,
        num_aux,
        analyses,
        method,
        mutual_couplings,
        uic,
        initial_node_voltages,
    })
}
