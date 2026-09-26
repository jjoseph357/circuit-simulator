use std::env;
use std::fs;
use std::io::{self, Read};
use circuit_engine::{lint_netlist, simulate_circuit_with, SolverKind};

fn print_usage() {
    eprintln!(
        r#"Circuit Lab engine
Usage:
    circuit_engine [OPTIONS] [FILE]

Options:
    --netlist <STRING>    Pass netlist string directly
    --sparse-lu           Use the hand-written CSR sparse LU solver (reports fill-in)
    --faer                Use the industrial faer sparse LU solver
    --gaussian            Use educational step-by-step Gaussian Elimination solver (default)
    --lint-only           Only run topological Doctor linter
    --tune                Input is a JSON tune request; prints the tuner result as JSON
    --json                Output full machine-readable JSON (default)
    --pretty              Output human-readable formatted summary
    -h, --help            Show this help message

Netlist syntax (SPICE):
    * title line
    R1 1 2 5
    I1 0 1 3
    V1 1 0 10
    .tran 10u 5m
    .end
"#
    );
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        print_usage();
        return;
    }

    let mut netlist_content = String::new();
    let mut solver = SolverKind::Gaussian;
    let mut lint_only = false;
    let mut tune = false;
    let mut pretty_output = false;
    let mut i = 1;

    while i < args.len() {
        match args[i].as_str() {
            "--netlist" => {
                if i + 1 < args.len() {
                    netlist_content = args[i + 1].clone();
                    i += 1;
                }
            }
            "--sparse-lu" => solver = SolverKind::SparseLu,
            "--faer" => solver = SolverKind::Faer,
            "--gaussian" => solver = SolverKind::Gaussian,
            "--lint-only" => lint_only = true,
            "--tune" => tune = true,
            "--json" => pretty_output = false,
            "--pretty" => pretty_output = true,
            arg if !arg.starts_with('-') => {
                if let Ok(content) = fs::read_to_string(arg) {
                    netlist_content = content;
                } else {
                    eprintln!("Error: Could not read file {}", arg);
                    std::process::exit(1);
                }
            }
            _ => {}
        }
        i += 1;
    }

    if netlist_content.trim().is_empty() {
        // Try reading from stdin
        let mut buffer = String::new();
        if io::stdin().read_to_string(&mut buffer).is_ok() && !buffer.trim().is_empty() {
            netlist_content = buffer;
        } else {
            eprintln!("Error: No netlist input provided.");
            print_usage();
            std::process::exit(1);
        }
    }

    if tune {
        println!("{}", circuit_engine::optimizer::tune_json(&netlist_content));
        return;
    }

    if lint_only {
        println!("{}", serde_json::to_string_pretty(&lint_netlist(&netlist_content)).unwrap());
        return;
    }

    let result = simulate_circuit_with(&netlist_content, solver);

    if pretty_output {
        println!("=== Circuit Lab result ===");
        println!("Success: {}", result.success);
        println!("Solver: {}", result.solver_used);
        println!("Elapsed: {} µs", result.execution_time_us);
        println!("\nNode Voltages:");
        let mut nodes: Vec<_> = result.node_voltages.iter().collect();
        nodes.sort_by(|a, b| a.0.cmp(b.0));
        for (node, v) in nodes {
            println!("  Node {}: {:.4} V", node, v);
        }
        println!("\nBranch Currents:");
        let mut currents: Vec<_> = result.branch_currents.iter().collect();
        currents.sort_by(|a, b| a.0.cmp(b.0));
        for (comp, current) in currents {
            println!("  {}: {:.4} A", comp, current);
        }
    } else {
        match serde_json::to_string(&result) {
            Ok(json) => println!("{}", json),
            Err(e) => eprintln!("Serialization error: {}", e),
        }
    }
}
