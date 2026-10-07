// ----------------- Circuit Lab interfaces (mirror the Rust engine's JSON) -----------------
export interface VisualCircuitComponent {
  id: string;
  name: string;
  type: 'Resistor' | 'CurrentSource' | 'VoltageSource' | 'Capacitor' | 'Inductor' | 'Diode' | 'BJT' | 'MOSFET' | 'Ground' | 'OpAmp' | 'VCVS' | 'VCCS' | 'CCCS' | 'CCVS' | 'ShortCircuit';
  value: number;
  unit: string;
  node1: string;
  node2: string;
  x: number;
  y: number;
  rotation?: number; // 0, 90, 180, 270
  /** Transistors: drawn mirrored left-right (before rotating), e.g. a PMOS with its source on top and gate on the left. */
  mirror?: boolean;
  /** SPICE source spec for V/I when not plain DC, e.g. "PULSE(0 5 0 1n 1n 1m 2m)" or "DC 0 AC 1". */
  source?: string;
  /** Third terminal of a transistor or OpAmp/controlled source: node3. */
  node3?: string;
  /** Fourth terminal of an OpAmp or controlled source: node4. */
  node4?: string;
  /** Device line text after the terminal nodes: model name, MOSFET bulk node, W=/L=. */
  deviceArgs?: string;
  /** Polarity, from the device's .model card. */
  modelKind?: 'd' | 'npn' | 'pnp' | 'nmos' | 'pmos';
}

export interface StampingCell {
  row: number;
  col: number;
  delta: number;
  new_value: number;
}

export interface StampingStep {
  step_index: number;
  component_name: string;
  component_summary: string;
  affected_cells_g: StampingCell[];
  affected_cells_b: StampingCell[];
  matrix_g_snapshot: number[][];
  vector_b_snapshot: number[];
  explanation: string;
  affected_cells_c?: StampingCell[];
  matrix_c_snapshot?: number[][];
}

export interface GaussianStep {
  step_index: number;
  phase: 'init' | 'pivot_swap' | 'elimination' | 'back_substitution';
  description: string;
  latex_equation: string;
  matrix_snapshot: number[][];
  current_row?: number | null;
  target_row?: number | null;
  multiplier?: number | null;
}

export interface KclEquation {
  node: string;
  node_index: number;
  raw_equation: string;
  latex_equation: string;
  evaluated_sum: number;
}

export interface SpyPlotEntry {
  row: number;
  col: number;
  value: number;
  entry_type: 'conductance' | 'voltage_incidence' | 'capacitance' | 'inductance' | 'zero';
  description: string;
}

export interface SpyPlotData {
  dimension: number;
  non_zeros: number;
  sparsity_percentage: number;
  entries: SpyPlotEntry[];
  dynamic_entries?: SpyPlotEntry[];
}

/** Deterministic repair computed by the Rust Circuit Doctor. */
export interface AutoFix {
  label: string;
  explanation: string;
  append_lines: string[];
  remove_lines: string[];
}

export interface CircuitDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  title: string;
  message: string;
  nodes_affected: string[];
  components_affected: string[];
  suggestion: string;
  fix?: AutoFix | null;
}

export interface CircuitSimulationResult {
  success: boolean;
  error_message?: string | null;
  solver_used: string;
  num_equations: number;
  variable_names: string[];
  solution_vector: number[];
  node_voltages: Record<string, number>;
  branch_currents: Record<string, number>;
  branch_powers: Record<string, number>;
  matrix_g: number[][];
  vector_b: number[];
  stamping_timeline: StampingStep[];
  gaussian_steps: GaussianStep[];
  kcl_equations: KclEquation[];
  spy_plot: SpyPlotData;
  diagnostics: CircuitDiagnostic[];
  storybook_explanation: string;
  execution_time_us: number;
  /** Why the engine used a different solver than requested. */
  solver_note?: string | null;
  /** max |G·x − b|: independent check that the solution satisfies the MNA system. */
  residual_max_abs?: number | null;
  /** Extra non-zeros created by sparse LU (depends on node numbering). */
  lu_fill_in?: number | null;
  /** False for large systems: no dense matrices, snapshots, or KCL strings are sent. */
  educational_views?: boolean;
  /** Dynamic matrix C of G·x + C·dx/dt = b (empty without capacitors/inductors). */
  matrix_c?: number[][];
  ac?: AcResult | null;
  transient?: TransientResult | null;
  analysis_errors?: string[];
  newton?: NewtonLog | null;
  device_ops?: DeviceOp[];
  dc_sweep?: DcSweepResult | null;
}

export interface AcResult {
  sweep: 'Dec' | 'Oct' | 'Lin';
  frequencies: number[];
  node_magnitude: Record<string, number[]>;
  node_phase_deg: Record<string, number[]>;
  branch_magnitude: Record<string, number[]>;
  real_system_dimension: number;
}

export interface TransientResult {
  method: 'BackwardEuler' | 'Trapezoidal';
  time: number[];
  node_voltages: Record<string, number[]>;
  branch_currents: Record<string, number[]>;
  step_sizes: number[];
  accepted_steps: number;
  rejected_steps: number;
  factorizations: number;
  breakpoints: number[];
  tstop: number;
  decimated: boolean;
  /** Current into each device terminal, keyed "NAME:index" (terminal order). */
  terminal_currents?: Record<string, number[]>;
}

export interface TerminalCurrent {
  role: string;
  node: string;
  /** Current flowing from the node into the device at this terminal (A). */
  current: number;
}

export interface DeviceOp {
  name: string;
  kind: 'diode' | 'npn' | 'pnp' | 'nmos' | 'pmos';
  region: string;
  quantities: Array<[string, number]>;
  terminals: TerminalCurrent[];
}

export interface NewtonIteration {
  iteration: number;
  max_dx: number;
  limited: boolean;
  x: number[];
  devices: DeviceOp[];
}

export interface NewtonLog {
  converged: boolean;
  strategy: string;
  iterations: NewtonIteration[];
  total_iterations: number;
}

export interface DcSweepResult {
  source: string;
  values: number[];
  node_voltages: Record<string, number[]>;
  branch_currents: Record<string, number[]>;
  newton_iterations: number;
}

export type TuneGoal =
  | { kind: 'node_voltage'; node: string; target: number }
  | { kind: 'element_current'; element: string; target: number }
  | { kind: 'cutoff_hz'; node: string; target: number }
  | { kind: 'gain_db'; node: string; freq: number; target: number };

export interface TuneRequest {
  netlist: string;
  parameters: Array<{ element: string; min: number; max: number }>;
  goals: TuneGoal[];
  max_evaluations?: number;
}

export interface TuneResult {
  success: boolean;
  message: string;
  parameters: string[];
  initial_values: number[];
  values: number[];
  netlist: string;
  objective: number;
  goals: Array<{ label: string; target: number; achieved: number | null; met: boolean }>;
  history: Array<{ evaluation: number; objective: number; values: number[] }>;
  evaluations: number;
  duration_us: number;
}

export interface SpecCheck {
  label: string;
  passed: boolean;
  detail: string;
}

export interface ArchitectResult {
  netlist: string;
  explanation: string;
  source: 'llm' | 'offline_template' | 'none';
  attempts: Array<{ attempt: number; netlist: string; problems: string[] }>;
  verification: {
    success: boolean;
    node_voltages: Record<string, number>;
    branch_currents: Record<string, number>;
    diagnostics: CircuitDiagnostic[];
    spec_checks: SpecCheck[];
    error_message?: string | null;
  };
}

export interface PreloadedCircuit {
  id: string;
  title: string;
  description: string;
  /** SPICE netlist. */
  netlist: string;
  expected_voltages: Record<string, number>;
  /** Hand-drawn placement: element name → [x, y, rotation, mirrored?]. Ground symbols are added under grounded pins. */
  layout?: Record<string, [number, number, number, boolean?]>;
}
