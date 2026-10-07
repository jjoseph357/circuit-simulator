import type { CircuitSimulationResult, VisualCircuitComponent } from './types';
import type { GuideTarget } from './ui';

export type BottomTab = 'results' | 'graphs' | 'math' | 'tools';
export type MathTab = 'matrix' | 'gaussian' | 'kcl' | 'spy' | 'newton';

/** Everything a lesson step may look at to decide whether the student has done it. */
export interface LabSnapshot {
  comps: VisualCircuitComponent[];
  /** Latest result, only once the student has pressed Run. */
  result: CircuitSimulationResult | null;
  hasRun: boolean;
  bottomTab: BottomTab | null;
  mathTab: MathTab;
  timeIndex: number | null;
  /** Parts the matrix inspector is pointing at (non-empty = a cell was clicked). */
  inspecting: string[];
  netlistEdited: boolean;
}

export interface Quiz {
  question: string;
  options: string[];
  answer: number;
  /** Shown after any answer: why the right one is right. */
  explain: string;
}

export interface Step {
  id: string;
  /** What to do, as a short instruction. */
  title: string;
  /** One or two sentences of how or why. */
  detail?: string;
  /** UI element that pulses while this step is current. */
  target?: GuideTarget;
  /** Done automatically when this becomes true; steps without it (and without a quiz) have a "Done" button. */
  check?: (s: LabSnapshot) => boolean;
  quiz?: Quiz;
}

export interface Lesson {
  id: string;
  title: string;
  /** One sentence: what the student will learn. */
  goal: string;
  /** Preset to load, or null for an empty canvas. */
  preset: string | null;
  steps: Step[];
}

// ---------------- helpers for checks ----------------
const parts = (s: LabSnapshot, type: VisualCircuitComponent['type']) => s.comps.filter((c) => c.type === type);
const byName = (s: LabSnapshot, name: string) => s.comps.find((c) => c.name.toUpperCase() === name.toUpperCase());
const ran = (s: LabSnapshot) => s.hasRun && !!s.result?.success;
const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) <= Math.abs(b) * 1e-6 + 1e-12;
const hasDiag = (s: LabSnapshot, code: string) => !!s.result?.diagnostics?.some((d) => d.code === code);

/** V's + node is shared with some resistor pin, and that node is not ground. */
function sourceFeedsResistor(s: LabSnapshot): boolean {
  return parts(s, 'VoltageSource').some((v) => v.node1 !== '0' && parts(s, 'Resistor').some((r) => r.node1 === v.node1 || r.node2 === v.node1));
}
/** A complete loop: V from a node to ground, a resistor from that node to ground. */
function loopClosed(s: LabSnapshot): boolean {
  return parts(s, 'VoltageSource').some((v) => v.node2 === '0' && v.node1 !== '0' &&
    parts(s, 'Resistor').some((r) => (r.node1 === v.node1 && r.node2 === '0') || (r.node2 === v.node1 && r.node1 === '0'))) && parts(s, 'Ground').length > 0;
}

export const LESSONS: Lesson[] = [
  {
    id: 'first-circuit',
    title: 'Your first circuit',
    goal: 'Build a battery-and-resistor circuit, simulate it, and check Ohm’s law.',
    preset: null,
    steps: [
      { id: 'v', title: 'Add a voltage source', detail: 'Click “Voltage source” in the parts bar, then click on the canvas to drop it. It works like a battery.', target: 'part:VoltageSource', check: (s) => parts(s, 'VoltageSource').length > 0 },
      { id: 'r', title: 'Add a resistor', detail: 'Place it a little to the right of the source.', target: 'part:Resistor', check: (s) => parts(s, 'Resistor').length > 0 },
      { id: 'g', title: 'Add a ground', detail: 'Ground is the 0 V reference: every voltage is measured from it. Every SPICE circuit needs one. Put it below the source.', target: 'part:Ground', check: (s) => parts(s, 'Ground').length > 0 },
      { id: 'w1', title: 'Wire the + end of V1 to the resistor', detail: 'Press on the pin at the + end of V1 and drag to one end of R1. Unconnected pins show as hollow red circles.', target: 'canvas', check: sourceFeedsResistor },
      { id: 'w2', title: 'Wire the other ends to ground', detail: 'Connect the − end of V1 and the free end of R1 to the ground symbol. Current needs a complete loop to flow.', target: 'canvas', check: loopClosed },
      { id: 'run', title: 'Press Run', detail: 'The simulator turns your drawing into equations and solves them.', target: 'run', check: ran },
      {
        id: 'q1', title: 'Predict the current',
        quiz: {
          question: 'V1 is 5 V and R1 is 1 kΩ. How much current flows through R1?',
          options: ['5 A', '5 mA', '0.2 mA', '1 mA'], answer: 1,
          explain: 'Ohm’s law: I = V / R = 5 V / 1000 Ω = 0.005 A = 5 mA. Hover over R1 to see that the simulator agrees.',
        },
      },
      { id: 'edit', title: 'Change R1 to 2k', detail: 'Click R1 and type 2k in the value box (k means ×1000). The results update by themselves. Did the current halve?', target: 'canvas', check: (s) => parts(s, 'Resistor').some((r) => near(r.value, 2000)) },
      { id: 'netlist', title: 'Find your circuit in the netlist', detail: 'The panel on the right is the same circuit written in SPICE, the text format every circuit simulator reads. Each line is one part: its name, the two nodes it connects, and its value.', target: 'netlist' },
    ],
  },
  {
    id: 'netlist',
    title: 'Reading and editing a netlist',
    goal: 'Learn what each part of a SPICE line means, and edit a circuit as text.',
    preset: 'voltage_divider',
    steps: [
      { id: 'read', title: 'Click the line starting with R1', detail: 'The box under the netlist explains the line in words. Nodes have names (here “in” and “out”), and their colours match the wires.', target: 'netlist' },
      { id: 'run', title: 'Press Run', target: 'run', check: ran },
      {
        id: 'q', title: 'Predict the output',
        quiz: {
          question: 'R1 = 8 kΩ is on top and R2 = 4 kΩ is on the bottom of a 12 V supply. What is the voltage at node out?',
          options: ['12 V', '8 V', '4 V', '6 V'], answer: 2,
          explain: 'This is a voltage divider: V(out) = 12 V × R2 / (R1 + R2) = 12 × 4k / 12k = 4 V. The node tag on the schematic shows the simulated value.',
        },
      },
      { id: 'edit', title: 'Change R2 to 8k by editing the text', detail: 'In the netlist, change “R2 out 0 4k” to “R2 out 0 8k”, then press “Update schematic”.', target: 'netlist:update', check: (s) => near(byName(s, 'R2')?.value, 8000) },
      {
        id: 'q2', title: 'Predict again',
        quiz: {
          question: 'Now R1 = R2 = 8 kΩ. What is V(out)?',
          options: ['4 V', '6 V', '8 V', '12 V'], answer: 1,
          explain: 'Equal resistors split the voltage in half: 12 V × 8k / 16k = 6 V.',
        },
      },
      { id: 'rename', title: 'Try renaming a node', detail: 'Click the “out” tag on the schematic and give it a new name. The netlist changes to match: the schematic and the text always describe the same circuit.', target: 'canvas' },
    ],
  },
  {
    id: 'ground',
    title: 'Nodes and ground',
    goal: 'See what a node is, and why the simulator refuses to solve a circuit without ground.',
    preset: 'ohms_law',
    steps: [
      { id: 'hover', title: 'Hover over a wire', detail: 'The whole node lights up. Everything drawn in one colour is one node, and a node has a single voltage.', target: 'canvas' },
      { id: 'run', title: 'Press Run', target: 'run', check: ran },
      { id: 'del', title: 'Delete the ground symbol', detail: 'Click the ground symbol, then press Delete. Watch what happens to the results.', target: 'canvas', check: (s) => s.hasRun && parts(s, 'Ground').length === 0 && hasDiag(s, 'ERR_NO_GROUND') },
      {
        id: 'q', title: 'Why did it fail?',
        quiz: {
          question: 'Why can’t the simulator solve the circuit without ground?',
          options: ['The battery has nowhere to send current', 'Voltages are differences, so without a 0 V reference every node voltage could shift by the same amount', 'SPICE needs at least three parts'],
          answer: 1,
          explain: 'Only differences in voltage matter physically. Ground pins one node to 0 V so every other voltage has a single answer. Without it the equations have infinitely many solutions.',
        },
      },
      { id: 'fix', title: 'Put ground back', detail: 'Use Undo (Ctrl+Z), add a new ground and wire it to the − end of V1, or press “Fix it” under the problem.', target: 'part:Ground', check: (s) => ran(s) && !hasDiag(s, 'ERR_NO_GROUND') },
    ],
  },
  {
    id: 'mna',
    title: 'How the simulator solves a circuit',
    goal: 'Watch the circuit turn into a matrix equation G·x = b, and see where every number comes from.',
    preset: 'current_source_network',
    steps: [
      { id: 'run', title: 'Press Run', target: 'run', check: ran },
      { id: 'open', title: 'Open “How it’s solved”', detail: 'It is the third tab under the schematic.', target: 'tab:math', check: (s) => s.bottomTab === 'math' },
      { id: 'play', title: 'Press play and watch the matrix fill in', detail: 'Each part adds its numbers (its “stamp”) only to the rows and columns of the nodes it touches. This is Modified Nodal Analysis, what SPICE does.', target: 'math:play' },
      { id: 'cell', title: 'Click any number in the G matrix', detail: 'The parts that put it there light up on the schematic.', target: 'tab:math', check: (s) => s.inspecting.length > 0 },
      {
        id: 'q', title: 'Check your understanding',
        quiz: {
          question: 'R1 (5 Ω) connects nodes 1 and 2. What does it add to the matrix?',
          options: ['+0.2 on the diagonal at (1,1) and (2,2), and −0.2 at (1,2) and (2,1)', '+5 at (1,2) only', '0.2 into the b vector'],
          answer: 0,
          explain: 'A resistor stamps its conductance 1/R = 0.2 S: positive on the diagonals of both of its nodes, negative on the two entries linking them.',
        },
      },
      { id: 'kcl', title: 'Open “Check KCL”', detail: 'Each row of G·x = b says the currents leaving a node add up to zero (Kirchhoff’s current law). Plugging the answer back in gives zero, up to rounding.', target: 'math:kcl', check: (s) => s.bottomTab === 'math' && s.mathTab === 'kcl' },
    ],
  },
  {
    id: 'transient',
    title: 'Capacitors over time',
    goal: 'Run a transient analysis and watch a capacitor charge.',
    preset: 'rc_charging',
    steps: [
      { id: 'tran', title: 'Find the .tran line in the netlist', detail: 'Lines starting with a dot are control cards. “.tran 10u 5m” asks for a simulation over time, from 0 to 5 ms.', target: 'netlist' },
      { id: 'run', title: 'Press Run', target: 'run', check: ran },
      { id: 'graphs', title: 'Open the Graphs tab', target: 'tab:graphs', check: (s) => s.bottomTab === 'graphs' },
      { id: 'play', title: 'Press play', detail: 'The schematic follows the time cursor: node voltages and the moving current dots show that instant.', target: 'graphs:play', check: (s) => s.timeIndex !== null },
      {
        id: 'q', title: 'Read the graph',
        quiz: {
          question: 'R = 1 kΩ and C = 1 µF, so τ = RC = 1 ms. What is V(2) at t = 1 ms?',
          options: ['5 V', 'About 3.2 V (63 %)', '2.5 V (50 %)', '0 V'], answer: 1,
          explain: 'A capacitor charging through a resistor reaches 1 − e⁻¹ ≈ 63 % of the final voltage after one time constant: 0.63 × 5 V ≈ 3.2 V.',
        },
      },
      { id: 'c', title: 'Change C1 to 2u', detail: 'Double the capacitance and look at the graph again. It now takes twice as long to charge.', target: 'canvas', check: (s) => near(byName(s, 'C1')?.value, 2e-6) },
    ],
  },
  {
    id: 'ac',
    title: 'Frequency response',
    goal: 'Use an AC sweep to draw a Bode plot and find a filter’s cutoff frequency.',
    preset: 'rc_lowpass_bode',
    steps: [
      { id: 'ac', title: 'Find the AC input', detail: 'V1 is marked “AC 1” in the netlist: it is the input the AC analysis wiggles. “.ac dec 20 10 100k” sweeps from 10 Hz to 100 kHz.', target: 'netlist' },
      { id: 'run', title: 'Press Run', target: 'run', check: ran },
      { id: 'graphs', title: 'Open the Graphs tab', target: 'tab:graphs', check: (s) => s.bottomTab === 'graphs' },
      {
        id: 'q', title: 'Read the Bode plot',
        quiz: {
          question: 'Where is the −3 dB point (the cutoff) of V(out)?',
          options: ['About 100 Hz', 'About 1 kHz', 'About 10 kHz'], answer: 1,
          explain: 'f = 1 / (2π·R·C) = 1 / (2π × 1k × 159n) ≈ 1 kHz. Below it the output follows the input; above it the gain falls 20 dB per decade.',
        },
      },
      { id: 'r', title: 'Change R1 to 2k', detail: 'The cutoff moves to about 500 Hz: a bigger R (or C) makes a slower filter.', target: 'canvas', check: (s) => near(byName(s, 'R1')?.value, 2000) },
    ],
  },
  {
    id: 'diode',
    title: 'Diodes and Newton’s method',
    goal: 'See how a simulator handles a part whose current is not proportional to its voltage.',
    preset: 'led',
    steps: [
      { id: 'run', title: 'Press Run', target: 'run', check: ran },
      {
        id: 'q', title: 'Estimate the LED current',
        quiz: {
          question: 'The LED drops about 1.8 V. With 5 V and 330 Ω, roughly what current flows?',
          options: ['15 mA', '10 mA', '5 mA'], answer: 1,
          explain: 'The resistor sees 5 − 1.8 = 3.2 V, so I = 3.2 V / 330 Ω ≈ 9.7 mA. Hover over D1 to compare.',
        },
      },
      { id: 'math', title: 'Open “How it’s solved”', target: 'tab:math', check: (s) => s.bottomTab === 'math' },
      { id: 'newton', title: 'Open the Newton’s method tab', detail: 'A diode’s current grows exponentially with voltage, so the simulator guesses, replaces the diode by a straight-line model, solves, and repeats until the guesses stop changing.', target: 'math:newton', check: (s) => s.bottomTab === 'math' && s.mathTab === 'newton' },
    ],
  },
  {
    id: 'cmos',
    title: 'A logic gate: the CMOS inverter',
    goal: 'Sweep an input voltage and watch two transistors make a digital NOT gate.',
    preset: 'cmos_inverter',
    steps: [
      { id: 'dc', title: 'Find the .dc line', detail: '“.dc VIN 0 5 0.02” re-solves the circuit for every input voltage from 0 to 5 V.', target: 'netlist' },
      { id: 'run', title: 'Press Run', target: 'run', check: ran },
      { id: 'graphs', title: 'Open the Graphs tab', target: 'tab:graphs', check: (s) => s.bottomTab === 'graphs' },
      {
        id: 'q', title: 'Read the transfer curve',
        quiz: {
          question: 'When VIN is 0 V (logic 0), what is V(out)?',
          options: ['0 V', 'About 2.5 V', 'About 5 V'], answer: 2,
          explain: 'With the input low, the PMOS is on and the NMOS is off, so the output is pulled up to 5 V: a NOT gate.',
        },
      },
    ],
  },
  {
    id: 'opamp',
    title: 'Operational Amplifiers and Virtual Ground',
    goal: 'Understand how negative feedback forces differential inputs equal and sets closed-loop gain.',
    preset: 'opamp_inverting',
    steps: [
      { id: 'run', title: 'Press Run', target: 'run', check: ran },
      {
        id: 'q1', title: 'Examine the inverting node',
        quiz: {
          question: 'In an inverting amplifier with negative feedback, what is the voltage at the inverting input (node inv)?',
          options: ['-4 V', '0 V (Virtual Ground)', '2 V'], answer: 1,
          explain: 'Because the non-inverting (+) input is grounded and open-loop gain is enormous, negative feedback drives the differential input (V+ - V-) to 0 V, creating a virtual ground.',
        },
      },
      { id: 'results', title: 'Inspect the output voltage', detail: 'Notice V(out) is -4 V for an input of +2 V, giving an inverting gain of -2 (-RF / R1 = -20k / 10k).', target: 'tab:results', check: (s) => s.bottomTab === 'results' },
      { id: 'math', title: 'Check the MNA stamp in the Math tab', detail: 'The OpAmp stamps an auxiliary row enforcing V+ - V- = 0 (ideal virtual short) and adds its output current Io.', target: 'tab:math', check: (s) => s.bottomTab === 'math' },
    ],
  },
  {
    id: 'dependent_sources',
    title: 'Controlled Sources: VCVS and VCCS',
    goal: 'See how dependent sources model active components and amplification stages.',
    preset: 'vcvs_buffer',
    steps: [
      { id: 'run', title: 'Press Run', target: 'run', check: ran },
      {
        id: 'q1', title: 'Calculate VCVS output',
        quiz: {
          question: 'With V(in) = 4 V and VCVS gain E1 = 3, what is V(out)?',
          options: ['1.33 V', '7 V', '12 V'], answer: 2,
          explain: 'A voltage-controlled voltage source multiplies the differential control voltage by its gain: V(out) = 3 · 4 V = 12 V.',
        },
      },
      { id: 'inspect', title: 'Check branch current', detail: 'The VCVS supplies all 12 mA into the 1 kΩ load resistor while drawing zero current from its control terminals.', target: 'tab:results', check: (s) => s.bottomTab === 'results' },
    ],
  },
];

const PROGRESS_KEY = 'circuitlab.lessons.v1';

export function loadProgress(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}') ?? {}; } catch { return {}; }
}
export function saveProgress(p: Record<string, string[]>) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}
