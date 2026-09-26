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
        'E' => Some("voltage-controlled voltage source"),
        'F' => Some("current-controlled current source"),
        'G' => Some("voltage-controlled current source"),
        'H' => Some("current-controlled voltage source"),
        'K' => Some("mutual inductance"),
        'X' => Some("subcircuit instance"),
        'T' => Some("transmission line"),
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
    let Some(letter) = tokens.first().and_then(|t| t.chars().next()).map(|c| c.to_ascii_uppercase()) else { return true };
    let numeric = |t: &str| parse_eng_value(t).is_ok();
    let names_model = |words: &[&str]| words.is_empty() || words.iter().any(|w| w.contains('=') || model_names.contains(&w.to_ascii_lowercase()));
    match letter {
        'R' | 'C' | 'L' => tokens.len() < 4 || !numeric(tokens[3]),
        'V' | 'I' => tokens.len() < 4 || !(numeric(tokens[3]) || SOURCE_KEYWORDS.iter().any(|k| tokens[3].to_ascii_lowercase().starts_with(k))),
        'D' => tokens.len() < 3 || !names_model(&tokens[3..]),
        'Q' | 'M' => tokens.len() < 4 || !names_model(&tokens[4..]),
        // Real (unsupported) SPICE elements (E1, X2 ...) get their own, clearer error; a plain word is a title.
        'J' | 'E' | 'F' | 'G' | 'H' | 'K' | 'X' | 'T' => tokens[0].len() >= 3 && tokens[0].chars().all(|c| c.is_ascii_alphabetic()),
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

/// Parses `.ac`, `.tran` and `.options`; other control cards are ignored.
fn parse_directive(trimmed: &str, analyses: &mut Vec<Analysis>, method: &mut IntegrationMethod) -> Result<(), String> {
    let lower = trimmed.to_ascii_lowercase();
    let tokens: Vec<&str> = lower.split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).collect();
    let num = |i: usize| -> Result<f64, String> {
        tokens.get(i).ok_or_else(|| format!("Missing argument in '{}'", trimmed)).and_then(|t| parse_eng_value(t).map_err(|e| format!("{} (in '{}')", e, trimmed)))
    };
    match tokens.first().copied() {
        Some(".ac") => {
            let sweep = match tokens.get(1).copied() {
                Some("dec") => SweepType::Dec,
                Some("oct") => SweepType::Oct,
                Some("lin") => SweepType::Lin,
                _ => return Err(format!("'.ac' needs a sweep type (dec, oct or lin): '{}'", trimmed)),
            };
            let points = num(2)?.round() as usize;
            let (fstart, fstop) = (num(3)?, num(4)?);
            if points == 0 || fstart <= 0.0 || fstop < fstart {
                return Err(format!("'.ac' needs points ≥ 1 and 0 < fstart ≤ fstop: '{}'", trimmed));
            }
            analyses.push(Analysis::Ac { sweep, points, fstart, fstop });
        }
        Some(".tran") => {
            let (tstep, tstop) = (num(1)?, num(2)?);
            let tstart = if tokens.len() > 3 && tokens[3] != "uic" { num(3)? } else { 0.0 };
            let tmax = if tokens.len() > 4 && tokens[4] != "uic" { Some(num(4)?) } else { None };
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
                    "euler" | "be" | "backward_euler" | "gear" => IntegrationMethod::BackwardEuler,
                    "trap" | "trapezoidal" => IntegrationMethod::Trapezoidal,
                    other => return Err(format!("Unknown integration method '{}' (use trap or euler)", other)),
                };
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

pub fn parse_netlist(input: &str) -> Result<Circuit, String> {
    let mut components = Vec::new();
    let mut analyses = Vec::new();
    let mut method = IntegrationMethod::Trapezoidal;
    let mut models: HashMap<String, ModelCard> = HashMap::new();
    let mut pending: Vec<PendingDevice> = Vec::new();

    // .model cards may come after the devices that use them.
    let model_names: HashSet<String> = input
        .lines()
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            (w.next()?.eq_ignore_ascii_case(".model")).then(|| w.next().map(|n| n.to_ascii_lowercase()))?
        })
        .collect();
    let mut first_content_line = true;
    for line in input.lines() {
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
                    parse_directive(trimmed, &mut analyses, &mut method)?;
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
                });
                continue;
            }

            if tokens.len() < 4 {
                return Err(format!("'{}' needs a name, two nodes and a value, e.g. R1 1 2 1k.", trimmed));
            }

            let name = tokens[0].to_string();
            let n1 = normalize_node(tokens[1]);
            let n2 = normalize_node(tokens[2]);
            let first_char = name.chars().next().unwrap().to_ascii_uppercase();

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
                                "'{}' is a {} ({}), which this engine does not simulate yet. Supported elements: R, C, L, V, I, D, Q and M.",
                                trimmed, kind, other
                            ))
                        }
                        None => {
                            return Err(format!(
                                "'{}': unknown element '{}'. The first letter of a name says what the part is: R, C, L, V, I, D, Q or M.",
                                trimmed, name
                            ))
                        }
                    }
                }
            };

            components.push(Component {
                name,
                comp_type,
                node1: n1,
                node2: n2,
                original_line: trimmed.to_string(),
                source,
                extra_nodes: Vec::new(),
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

    // Branch-current unknowns: one per voltage source and per inductor, in netlist order.
    let mut variable_names: Vec<String> = non_ground_nodes.iter().map(|n| format!("V({})", n)).collect();
    let mut aux_index = HashMap::new();
    let mut num_v_sources = 0;
    for c in &components {
        if matches!(c.comp_type, ComponentType::VoltageSource { .. } | ComponentType::Inductor { .. }) {
            if matches!(c.comp_type, ComponentType::VoltageSource { .. }) {
                num_v_sources += 1;
            }
            aux_index.insert(c.name.clone(), num_nodes + aux_index.len());
            variable_names.push(format!("I({})", c.name));
        }
    }
    let num_aux = aux_index.len();

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
    })
}
