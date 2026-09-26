# Circuit Lab

A standalone teaching circuit simulator that walks a student through EDA step by step: draw a schematic,
see it become a SPICE netlist, run it, read the results, and look under the hood at how Modified Nodal
Analysis (MNA) solves it. The engine is written in Rust and runs in the browser (WebAssembly), in-process
in Python (PyO3) and as a CLI. It is independent of the rest of this repository.

## Quick start
```bash
pip install -r circuit_simulator/requirements.txt      # flask, requests
python circuit_simulator/start.py                       # builds what's stale, serves http://localhost:5050
```
Needs Rust (with the `wasm32-unknown-unknown` target, added automatically) and Node.js the first time.
For UI development: `python circuit_simulator/backend/server.py` plus `cd circuit_simulator/frontend && npm run dev`
(http://localhost:5174, `/api` is proxied to :5050).

## Using it
- **Guide (left)**: eight lessons, from “Your first circuit” to a CMOS logic gate. The current step says what
  to do, the thing to click pulses blue, and steps tick themselves off when the student has done them (or ask a
  quick question). Problems the simulator finds appear here too, with a one-click fix when there is one.
- **Schematic (centre)**: pick a part in the parts bar and click to place it (R rotates, Esc cancels). Drag
  from one pin to another to connect them. Every node has its own colour and a name tag, which shows its
  voltage after a run. Hollow red pins are not connected yet. Hover a wire to highlight its whole node, click
  a wire and press Delete to cut it, click a node tag to rename the node, and hover a part for its current and
  power. Undo/redo, zoom, and “Tidy up” sit in the bottom-left corner.
- **Netlist (right)**: the same circuit as editable SPICE text. Node names are coloured like their wires. The
  line under the cursor is explained in plain English, mistakes are flagged per line, and “Update schematic”
  (Ctrl+Enter) applies edits while keeping the drawing where it can.
- **Run** (top right): the first Run shows results. After that they update live as the circuit changes.
- **Below the schematic**: *Results* (node voltages, current/voltage/power per part, energy balance),
  *Graphs* (over time, over frequency, source sweeps), *How it’s solved* (the matrix built one part at a
  time, Gaussian elimination, KCL check, sparsity, Newton’s method), and *Tools* (value tuner, AI tutor and
  designer).
- **Settings** (gear): solver (step-by-step Gaussian, sparse LU, or faer), current dots, AI provider.

## Netlist syntax (SPICE)
```
* Title: SPICE reads the first line as the circuit's name
V1 in 0 12            ; name  node+  node-  value
R1 in out 8k          $ inline comments with ; or $
R2 out 0 4k
.tran 10u 5m          ; control cards start with a dot
.end
```
- **Elements**: `R`, `C`, `L`, `V`, `I`, `D a k [model]`, `Q c b e [model]` (NPN/PNP, Ebers–Moll),
  `M d g s [bulk] [model] [W= L=]` (level-1 NMOS/PMOS), with `.model NAME D|NPN|PNP|NMOS|PMOS(IS= N= BF= BR= VTO= KP= LAMBDA=)`.
  Node `0` (or `gnd`) is ground. Values take SPICE prefixes: `4.7k`, `10m`, `100u`, `2Meg`.
- **Sources**: `DC 5`, `AC mag [phase]`, `PULSE(v1 v2 delay rise fall width period)`, `SIN(offset amplitude freq)`, `PWL(t1 v1 ...)`.
- **Analyses**: `.tran tstep tstop [tstart [tmax]]`, `.ac dec|oct|lin N fstart fstop`, `.dc SRC start stop step`,
  `.options method=trap|euler`.
- A line the simulator can’t read is an error, never silently dropped. A first line that isn’t a valid element is
  the title, as in SPICE.

## Layout
```
circuit_simulator/
├── start.py / run.py / verify.py / build_engine.py   # launcher, CLI runner, test guardrail, engine builds
├── presets.json               # example circuits (SPICE), shared by server and browser; some carry a hand-drawn layout
├── requirements.txt
├── engine/                    # Rust crate: parser, MNA, solvers, Newton–Raphson, .tran/.ac/.dc, tuner, Doctor
├── backend/                   # Flask server (server.py), service (circuit_service.py), LLM settings (llm.py)
├── frontend/                  # Vite + React + Tailwind app (own package.json), wasm/circuit_engine.wasm
│   ├── CircuitLab.tsx         #   app shell: state, Run, undo, lessons
│   ├── CircuitCanvas.tsx      #   schematic editor (Konva); symbols.tsx draws the parts
│   ├── NetlistPanel.tsx       #   SPICE editor with line explanations
│   ├── GuidePanel.tsx, lessons.ts   # guided lessons and their automatic checks
│   ├── ResultsPanel.tsx, AnalysisView.tsx, MathView.tsx, NewtonView.tsx, ToolsView.tsx
│   └── netlist.ts             #   parsing, layout, wiring, line explainer (tested in tests/netlist_logic.test.mts)
└── tests/                     # Python unittest suites, Node tests for the Wasm engine and schematic logic
```

## How the pieces fit
- **Engine (Rust)** assembles MNA stamps sparsely (`BTreeMap` → CSR) and solves with the step-by-step Gaussian
  solver, the hand-written sparse LU (threshold/Markowitz pivoting, reports fill-in) or the faer sparse LU.
  Systems up to 40 unknowns also get dense snapshots, per-stamp logs and KCL strings for the teaching views.
  Every result carries `residual_max_abs` = max |G·x − b| as an independent correctness check.
- **Circuit Doctor** (`engine/src/linter.rs`) finds missing ground, floating nodes, current-source-only nodes,
  islands with no DC path, loops of voltage sources/inductors, capacitor-isolated nodes, AC sweeps without an AC
  input, and diodes forced on with no current limit. Diagnostics carry deterministic fixes the UI applies in one click.
- **Schematic ↔ netlist**: wires are derived from node names, so the drawing can never disagree with the netlist.
  Each node's pins are joined by a minimum spanning tree; on a tree the current in every wire follows from the
  terminal currents, so the moving current dots obey KCL at every pin.
- **Dynamic circuits**: G·x + C·dx/dt = b. Transient uses Backward Euler/Trapezoidal companion models with an
  adaptive step that lands on every source edge; AC solves (G + jωC)·X = B as the real system [[G, −ωC], [ωC, G]].
- **Nonlinear devices** (`engine/src/nonlinear.rs`): Newton–Raphson with junction limiting, falling back to gmin
  and source stepping. The same linearization gives the small-signal model for `.ac`.
- **Tuner** (`engine/src/optimizer.rs`): Nelder–Mead over chosen values to meet node-voltage, current, cutoff or
  gain goals. Runs in the browser; also `POST /api/circuit/tune` and `circuit_engine --tune`.
- **AI helpers** (optional): the designer's netlists are simulated and checked before they are shown; the tutor
  answers with guiding questions. Simulation never needs AI.

## Three runtimes, one Rust engine
| Runtime | Built by | Used by |
|---|---|---|
| WebAssembly (`frontend/wasm/circuit_engine.wasm`) | `build_engine.py --only wasm` | The UI, by default: no server needed |
| PyO3 module (`backend/_native/circuit_engine.pyd`) | `build_engine.py --only python` | The Flask service, in-process (and the UI's faer solves) |
| CLI binary (`engine/target/release/circuit_engine`) | `build_engine.py --only native` | `run.py`, and the service's fallback |

faer is a native library, so the UI sends faer solves to the local server. If the server isn't reachable it
solves in the browser with the sparse LU instead and says so. The pure-Python fallback only does DC analysis of
R, I and V, and says so for anything else. The guardrail fails if a compiled copy is older than the Rust source.

## Commands
- **Start the app**: `python circuit_simulator/start.py` (`--rebuild` forces a full rebuild; `CIRCUIT_PORT` changes the port)
- **Build engines**: `python circuit_simulator/build_engine.py [--only native,python,wasm]`
- **CLI**: `python circuit_simulator/run.py my_circuit.cir [--solver gaussian|sparse_lu|faer] [--lint]`, or `--benchmark`
- **Guardrail**: `python -m circuit_simulator.verify` (Rust, Python, TypeScript, example circuits, PyO3/Wasm freshness
  and parity, frontend logic; `--rebuild` rebuilds the engines first)
- **AI settings**: the gear button in the app, or env vars `CIRCUIT_LLM_PROVIDER`, `CIRCUIT_LLM_MODEL`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_BASE_URL`
- **Deploy to GitHub Pages**: Pushes to `main` automatically deploy Circuit Lab via GitHub Actions (`.github/workflows/deploy-circuit.yml`). Enable in your repository: **Settings → Pages → Source: GitHub Actions**.
