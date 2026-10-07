use std::collections::{HashMap, HashSet, VecDeque};
use crate::models::{AutoFix, Circuit, Component, ComponentType, Diagnostic};

/// Returns a component name not already used in the circuit (e.g. "R_fix_2", "R_fix_2_1").
fn unique_name(circuit: &Circuit, base: &str) -> String {
    let taken: HashSet<String> = circuit.components.iter().map(|c| c.name.to_ascii_uppercase()).collect();
    if !taken.contains(&base.to_ascii_uppercase()) {
        return base.to_string();
    }
    (1..)
        .map(|i| format!("{}_{}", base, i))
        .find(|n| !taken.contains(&n.to_ascii_uppercase()))
        .unwrap()
}

fn removal_fix(comp: &Component, why: &str) -> AutoFix {
    AutoFix {
        label: format!("Remove {}", comp.name),
        explanation: why.to_string(),
        append_lines: vec![],
        remove_lines: vec![comp.original_line.clone()],
    }
}

/// Weighted union-find over nodes joined by voltage sources. `offset[x]` is V(x) − V(parent(x)),
/// so two nodes already in the same set have a potential difference fixed by existing sources.
struct VoltageForest {
    parent: HashMap<String, String>,
    offset: HashMap<String, f64>,
}

impl VoltageForest {
    fn new() -> Self {
        VoltageForest { parent: HashMap::new(), offset: HashMap::new() }
    }

    /// Returns (root, V(x) − V(root)).
    fn find(&mut self, x: &str) -> (String, f64) {
        let p = match self.parent.get(x) {
            None => return (x.to_string(), 0.0),
            Some(p) => p.clone(),
        };
        let (root, parent_off) = self.find(&p);
        let off = self.offset[x] + parent_off;
        self.parent.insert(x.to_string(), root.clone());
        self.offset.insert(x.to_string(), off);
        (root, off)
    }

    /// Record V(a) − V(b) = v. Returns Some(existing difference) if a and b were already linked.
    fn union(&mut self, a: &str, b: &str, v: f64) -> Option<f64> {
        let (ra, oa) = self.find(a);
        let (rb, ob) = self.find(b);
        if ra == rb {
            return Some(oa - ob);
        }
        // V(ra) − V(rb) = (V(a) − oa) − (V(b) − ob) = v − oa + ob
        self.parent.insert(ra.clone(), rb);
        self.offset.insert(ra, v - oa + ob);
        None
    }
}

/// Voltage sources (other than `closing`) forming the path between a and b.
fn voltage_path(sources: &[&Component], a: &str, b: &str) -> Vec<String> {
    let mut adj: HashMap<&str, Vec<(&str, &str)>> = HashMap::new();
    for s in sources {
        adj.entry(s.node1.as_str()).or_default().push((s.node2.as_str(), s.name.as_str()));
        adj.entry(s.node2.as_str()).or_default().push((s.node1.as_str(), s.name.as_str()));
    }
    let mut prev: HashMap<&str, (&str, &str)> = HashMap::new();
    let mut queue = VecDeque::from([a]);
    let mut seen = HashSet::from([a]);
    while let Some(cur) = queue.pop_front() {
        if cur == b {
            break;
        }
        for &(next, via) in adj.get(cur).map(|v| v.as_slice()).unwrap_or(&[]) {
            if seen.insert(next) {
                prev.insert(next, (cur, via));
                queue.push_back(next);
            }
        }
    }
    let mut path = Vec::new();
    let mut cur = b;
    while let Some(&(p, via)) = prev.get(cur) {
        path.push(via.to_string());
        cur = p;
    }
    path.reverse();
    path
}

/// Nodes reachable from ground using only edges of the given kinds.
fn reachable_from_ground<'a>(circuit: &'a Circuit, conducts: impl Fn(&ComponentType) -> bool) -> HashSet<&'a str> {
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for c in &circuit.components {
        if conducts(&c.comp_type) {
            for (a, b) in c.dc_edges() {
                adj.entry(a).or_default().push(b);
                adj.entry(b).or_default().push(a);
            }
        }
    }
    let mut visited: HashSet<&str> = HashSet::from(["0"]);
    let mut queue = VecDeque::from(["0"]);
    while let Some(curr) = queue.pop_front() {
        for &neighbor in adj.get(curr).map(|v| v.as_slice()).unwrap_or(&[]) {
            if visited.insert(neighbor) {
                queue.push_back(neighbor);
            }
        }
    }
    visited
}

/// Elements that fix a node's DC voltage relative to its neighbours (capacitors are open in DC,
/// current sources set currents, not voltages).
fn conducts_dc(t: &ComponentType) -> bool {
    matches!(
        t,
        ComponentType::Resistor { .. }
            | ComponentType::VoltageSource { .. }
            | ComponentType::Inductor { .. }
            | ComponentType::ShortCircuit
            | ComponentType::Vcvs { .. }
            | ComponentType::Ccvs { .. }
            | ComponentType::OpAmp { .. }
            | ComponentType::Transformer { .. }
    ) || t.is_nonlinear()
}

/// Nodes whose only path to ground runs through capacitors. They have no DC operating point,
/// so (like SPICE) the DC solve adds a tiny GMIN conductance from each to ground.
pub fn dc_floating_nodes(circuit: &Circuit) -> Vec<String> {
    let dc = reachable_from_ground(circuit, conducts_dc);
    let with_caps = reachable_from_ground(circuit, |t| conducts_dc(t) || matches!(t, ComponentType::Capacitor { .. }));
    circuit.node_names.iter().filter(|n| *n != "0" && with_caps.contains(n.as_str()) && !dc.contains(n.as_str())).cloned().collect()
}

pub fn lint_circuit(circuit: &Circuit) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

    // 1. Ground Existence Check
    let has_ground = circuit.components.iter().any(|c| c.nodes().contains(&"0"));
    if !has_ground {
        // A single connection to ground carries no current, so voltage differences are unchanged.
        let anchor = circuit
            .components
            .iter()
            .find(|c| matches!(c.comp_type, ComponentType::VoltageSource { .. }))
            .map(|c| c.node2.clone())
            .or_else(|| circuit.node_names.iter().find(|n| *n != "0").cloned())
            .unwrap_or_else(|| "1".to_string());
        let fix_name = unique_name(circuit, &format!("R_gnd_{}", anchor));
        diagnostics.push(Diagnostic {
            severity: "error".to_string(),
            code: "ERR_NO_GROUND".to_string(),
            title: "Missing Reference Ground (Node 0)".to_string(),
            message: "SPICE / MNA formulation requires a reference datum node (node 0 / GND) with potential V = 0V. Without a ground reference, the conductance matrix is singular with an arbitrary floating offset.".to_string(),
            nodes_affected: vec!["0".to_string()],
            components_affected: vec![],
            suggestion: format!("Designate one node as Ground ('0'), for example the negative terminal of your supply (node {}).", anchor),
            fix: Some(AutoFix {
                label: format!("Reference node {} to ground", anchor),
                explanation: "Adds one resistor from this node to ground. Because it is the only path to ground, no current flows through it, so every voltage difference in the circuit stays the same.".to_string(),
                append_lines: vec![format!("{} {} 0 1Meg", fix_name, anchor)],
                remove_lines: vec![],
            }),
        });
    }

    // 2. Component Self-Shorts
    for c in circuit.components.iter().filter(|c| c.extra_nodes.is_empty()) {
        if c.node1 == c.node2 {
            if let ComponentType::VoltageSource { v_val } = c.comp_type {
                if v_val.abs() > 1e-6 {
                    diagnostics.push(Diagnostic {
                        severity: "error".to_string(),
                        code: "ERR_KVL_VIOLATION".to_string(),
                        title: format!("Self-Shorted Voltage Source: {}", c.name),
                        message: format!("Voltage source {} ({:.3}V) is connected from node '{}' to itself, directly violating Kirchhoff's Voltage Law (V - V = 0 != {:.3}V).", c.name, v_val, c.node1, v_val),
                        nodes_affected: vec![c.node1.clone()],
                        components_affected: vec![c.name.clone()],
                        suggestion: format!("Connect the negative terminal of {} to Ground or another circuit node.", c.name),
                        fix: Some(removal_fix(c, "Both terminals are on the same node, so this source cannot do anything except make the equations contradictory.")),
                    });
                    continue;
                }
            }

            diagnostics.push(Diagnostic {
                severity: "warning".to_string(),
                code: "WARN_SELF_SHORT".to_string(),
                title: format!("Self-Shorted Element: {}", c.name),
                message: format!("Component {} has both terminals connected to node '{}'. It will carry zero current or create a redundant connection.", c.name, c.node1),
                nodes_affected: vec![c.node1.clone()],
                components_affected: vec![c.name.clone()],
                suggestion: format!("Reconnect one pin of {} to a distinct circuit node.", c.name),
                fix: Some(removal_fix(c, "An element with both ends on one node has zero voltage across it and does nothing.")),
            });
        }
    }

    // 3. Node Degree / Floating Node Check & Current-only nodes
    let mut node_connections: HashMap<String, Vec<&Component>> = HashMap::new();
    for c in &circuit.components {
        for n in c.nodes() {
            node_connections.entry(n.to_string()).or_default().push(c);
        }
    }

    let mut current_only_nodes: HashSet<String> = HashSet::new();
    let mut sorted_nodes: Vec<&String> = node_connections.keys().collect();
    sorted_nodes.sort();
    for node in sorted_nodes {
        let comps = &node_connections[node];
        if node == "0" {
            continue;
        }
        let names: Vec<String> = comps.iter().map(|c| c.name.clone()).collect();
        if comps.len() < 2 {
            diagnostics.push(Diagnostic {
                severity: "warning".to_string(),
                code: "WARN_FLOATING_NODE".to_string(),
                title: format!("Dangling / Floating Node: {}", node),
                message: format!("Node '{}' has only 1 terminal connected (from component {}). In DC steady-state, no complete current loop can pass through this node.", node, names[0]),
                nodes_affected: vec![node.clone()],
                components_affected: names.clone(),
                suggestion: format!("Connect node '{}' to another circuit branch or remove the dangling component.", node),
                fix: Some(removal_fix(comps[0], "A component with one unconnected end cannot carry current.")),
            });
        } else if comps.iter().all(|c| matches!(c.comp_type, ComponentType::CurrentSource { .. })) {
            // If degree >= 2 but ALL connections are current sources, the potential is indeterminate
            current_only_nodes.insert(node.clone());
            let fix_name = unique_name(circuit, &format!("R_fix_{}", node));
            diagnostics.push(Diagnostic {
                severity: "error".to_string(),
                code: "ERR_CURRENT_ONLY_NODE".to_string(),
                title: format!("Indeterminate Potential at Node '{}'", node),
                message: format!("Node '{}' is connected exclusively to current sources [{}]. Without any resistive conductance or fixed voltage source to Ground, its node potential is indeterminate, yielding a singular MNA system.", node, names.join(", ")),
                nodes_affected: vec![node.clone()],
                components_affected: names,
                suggestion: format!("Add a conductive path (e.g., resistor to ground or another node) to fix the potential of Node '{}'.", node),
                fix: Some(AutoFix {
                    label: format!("Add a 1 kΩ resistor from node {} to ground", node),
                    explanation: "Current sources decide how much current flows but not the voltage. A resistor gives the node a voltage (Ohm's law: V = I·R).".to_string(),
                    append_lines: vec![format!("{} {} 0 1k", fix_name, node)],
                    remove_lines: vec![],
                }),
            });
        }
    }

    // 4. Reachability from Ground through elements that fix potentials (R and V).
    // Current sources set currents, not voltages, so a subcircuit reached only through
    // current sources still has an undetermined potential and a singular matrix.
    if has_ground {
        // Capacitor-only isolation is reported separately below (it is fine outside DC).
        let visited = reachable_from_ground(circuit, |t| !matches!(t, ComponentType::CurrentSource { .. } | ComponentType::Vccs { .. }));

        let unvisited_nodes: Vec<String> = circuit
            .node_names
            .iter()
            .filter(|n| *n != "0" && !visited.contains(n.as_str()) && !current_only_nodes.contains(*n))
            .cloned()
            .collect();

        if !unvisited_nodes.is_empty() {
            let anchor = unvisited_nodes[0].clone();
            let fix_name = unique_name(circuit, &format!("R_fix_{}", anchor));
            diagnostics.push(Diagnostic {
                severity: "error".to_string(),
                code: "ERR_ISOLATED_ISLAND".to_string(),
                title: "Isolated Subcircuit Island".to_string(),
                message: format!("The following nodes have no resistive or voltage-source path to Ground (Node 0): [{}]. Current sources alone cannot set a voltage, so the linear system is underdetermined.", unvisited_nodes.join(", ")),
                nodes_affected: unvisited_nodes,
                components_affected: vec![],
                suggestion: "Add a high-impedance path (e.g. 1 MΩ resistor) or tie the isolated subcircuit to ground.".to_string(),
                fix: Some(AutoFix {
                    label: format!("Tie node {} to ground through 1 MΩ", anchor),
                    explanation: "Gives the island a voltage reference. If a current source feeds the island, that current now returns through this resistor, so check the result makes physical sense.".to_string(),
                    append_lines: vec![format!("{} {} 0 1Meg", fix_name, anchor)],
                    remove_lines: vec![],
                }),
            });
        }
    }

    // 4b. Nodes that only reach ground through capacitors: fine for AC/transient, floating in DC.
    let cap_floating = if has_ground { dc_floating_nodes(circuit) } else { Vec::new() };
    if !cap_floating.is_empty() {
        let anchor = cap_floating[0].clone();
        let fix_name = unique_name(circuit, &format!("R_leak_{}", anchor));
        diagnostics.push(Diagnostic {
            severity: "warning".to_string(),
            code: "WARN_DC_FLOATING_CAP_NODE".to_string(),
            title: "Nodes Isolated by Capacitors in DC".to_string(),
            message: format!(
                "Capacitors block DC current, so nodes [{}] have no DC path to ground and no single DC voltage. The simulator adds a tiny 1e-12 S leak (GMIN) from each to ground, as SPICE does, so the operating point exists. AC and transient results are practically unaffected.",
                cap_floating.join(", ")
            ),
            nodes_affected: cap_floating,
            components_affected: vec![],
            suggestion: "Real capacitors always leak a little: add a large resistor to ground to make this node's DC voltage explicit.".to_string(),
            fix: Some(AutoFix {
                label: format!("Add a 10 MΩ bleed resistor from node {} to ground", anchor),
                explanation: "Gives the capacitor-isolated node an explicit DC path (it settles to the voltage the resistor pulls it to) instead of relying on GMIN.".to_string(),
                append_lines: vec![format!("{} {} 0 10Meg", fix_name, anchor)],
                remove_lines: vec![],
            }),
        });
    }

    // 4c. An AC sweep with no AC source produces all-zero responses.
    let has_ac_analysis = circuit.analyses.iter().any(|a| matches!(a, crate::models::Analysis::Ac { .. }));
    let has_ac_source = circuit.components.iter().any(|c| c.source.as_ref().map(|s| s.ac_mag != 0.0).unwrap_or(false));
    if has_ac_analysis && !has_ac_source {
        diagnostics.push(Diagnostic {
            severity: "warning".to_string(),
            code: "WARN_NO_AC_SOURCE".to_string(),
            title: "AC Sweep Without an AC Source".to_string(),
            message: "The .ac analysis measures the response to sources given an AC amplitude, and none has one, so every response will be zero.".to_string(),
            nodes_affected: vec![],
            components_affected: vec![],
            suggestion: "Give the input source an AC amplitude, for example: V1 in 0 DC 0 AC 1".to_string(),
            fix: None,
        });
    }

    // 5. Loops of voltage sources (parallel pairs are the two-source special case).
    let mut forest = VoltageForest::new();
    let mut placed: Vec<&Component> = Vec::new();
    for c in &circuit.components {
        // Inductors are short circuits (0 V sources) in DC, so they close such loops too.
        let v_val = match c.comp_type {
            ComponentType::VoltageSource { v_val } if c.node1 != c.node2 => v_val,
            ComponentType::Inductor { .. } if c.node1 != c.node2 => 0.0,
            _ => continue,
        };
        if let Some(existing) = forest.union(&c.node1, &c.node2, v_val) {
            let mut loop_members = voltage_path(&placed, &c.node1, &c.node2);
            loop_members.push(c.name.clone());
            let is_parallel = loop_members.len() == 2;
            let shape = if is_parallel { "in parallel" } else { "in a closed loop" };
            let conflict = (existing - v_val).abs() > 1e-6;
            let why_remove = format!(
                "The other sources already fix V({}) − V({}) = {:.3} V, so {} is redundant.",
                c.node1, c.node2, existing, c.name
            );
            if conflict {
                diagnostics.push(Diagnostic {
                    severity: "error".to_string(),
                    code: "ERR_KVL_VIOLATION".to_string(),
                    title: format!("Voltage Sources {} Disagree (KVL Violation)", if is_parallel { "in Parallel" } else { "in a Loop" }),
                    message: format!(
                        "Voltage sources [{}] are connected {} between nodes '{}' and '{}'. The loop demands V({}) − V({}) = {:.3} V and {:.3} V at the same time, which violates Kirchhoff's Voltage Law.",
                        loop_members.join(", "), shape, c.node1, c.node2, c.node1, c.node2, existing, v_val
                    ),
                    nodes_affected: vec![c.node1.clone(), c.node2.clone()],
                    components_affected: loop_members,
                    suggestion: "Remove one of the conflicting voltage sources or insert series resistance.".to_string(),
                    fix: Some(removal_fix(c, &why_remove)),
                });
            } else {
                diagnostics.push(Diagnostic {
                    severity: "error".to_string(),
                    code: "ERR_PARALLEL_VOLTAGE_SOURCES".to_string(),
                    title: format!("Redundant Voltage Sources {} (Indeterminate Currents)", if is_parallel { "in Parallel" } else { "in a Loop" }),
                    message: format!(
                        "Voltage sources [{}] are connected {} between nodes '{}' and '{}' and agree on {:.3} V. Ideal sources in a loop can share current in infinitely many ways, so the MNA matrix is singular.",
                        loop_members.join(", "), shape, c.node1, c.node2, v_val.abs()
                    ),
                    nodes_affected: vec![c.node1.clone(), c.node2.clone()],
                    components_affected: loop_members,
                    suggestion: "Combine parallel voltage sources into a single source or insert series internal resistance.".to_string(),
                    fix: Some(removal_fix(c, &why_remove)),
                });
            }
        } else {
            placed.push(c);
        }
    }

    // 6. A diode whose two ends are pinned by voltage sources alone gets no current limiting:
    //    I = IS·e^(V/Vt) explodes for anything above ~0.8 V.
    for c in &circuit.components {
        if let ComponentType::Diode { .. } = c.comp_type {
            let (ra, oa) = forest.find(&c.node1);
            let (rk, ok) = forest.find(&c.node2);
            if ra == rk && oa - ok > 0.8 {
                diagnostics.push(Diagnostic {
                    severity: "warning".to_string(),
                    code: "WARN_DIODE_NO_CURRENT_LIMIT".to_string(),
                    title: format!("Diode {} Forced On With No Resistor", c.name),
                    message: format!(
                        "Voltage sources hold {:.2} V directly across {}. A diode's current grows about 10× for every 60 mV above its knee, so with nothing to limit it the current is astronomically large (a real diode would burn out).",
                        oa - ok, c.name
                    ),
                    nodes_affected: vec![c.node1.clone(), c.node2.clone()],
                    components_affected: vec![c.name.clone()],
                    suggestion: "Put a series resistor between the source and the diode to set the current, e.g. (V − 0.7 V)/R.".to_string(),
                    fix: None,
                });
            }
        }
    }

    diagnostics
}
