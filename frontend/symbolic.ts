import type { CircuitSimulationResult, DeviceOp, StampingStep, VisualCircuitComponent } from './types';
import { formatQuantity } from './netlist.ts';

/**
 * Symbolic MNA: rebuilds each matrix entry as the sum of the symbols that produced it
 * (g₁ + g₂ + sC₁ − ...), from the engine's stamping log. The system shown is
 * (G + sC)·x = b, where s = jω; at DC (s = 0) only the G part remains.
 */

/** A symbol like g₁, sC₁, V₁, I_eq,D1 or the incidence constant 1. */
export interface Sym {
  /** Written before the base, e.g. "s" in sC₁. */
  pre?: string;
  base: string;
  sub?: string;
}

export interface Term {
  sign: 1 | -1;
  sym: Sym;
  /** The number this term adds to the entry (sign included). For s-terms, the coefficient of s. */
  value: number;
  /** Multiplies s (capacitor / inductor terms). */
  s: boolean;
  /** Index into the stamping timeline. */
  step: number;
  /** The part that stamped it. */
  part: string;
}

export interface SymbolDef {
  key: string;
  sym: Sym;
  part: string;
  /** Plain words and numbers, e.g. "1/R1 = 1/(5 Ω) = 0.2 S". */
  meaning: string;
  step: number;
}

export interface SymbolicSystem {
  /** Terms per "row,col" of G + sC. */
  Y: Map<string, Term[]>;
  /** Terms per row of b. */
  b: Map<number, Term[]>;
  defs: SymbolDef[];
  /** True if any entry has an s term (capacitors or inductors). */
  dynamic: boolean;
}

export const symKey = (s: Sym) => `${s.pre ?? ''}${s.base}_${s.sub ?? ''}`;

/** R1 → "1", RLOAD → "LOAD", R_bridge → "bridge": the part of the name after its type letter. */
function subOf(name: string): string {
  const rest = name.slice(1).replace(/^_/, '');
  return rest || name;
}

const q = (op: DeviceOp | undefined, k: string) => op?.quantities.find(([n]) => n === k)?.[1];
const near = (a: number, b: number | undefined) => b !== undefined && b !== 0 && Math.abs(Math.abs(a) - Math.abs(b)) <= 1e-9 * Math.abs(b);

export function buildSymbolic(result: CircuitSimulationResult, comps: VisualCircuitComponent[]): SymbolicSystem {
  const byName = new Map(comps.filter((c) => c.type !== 'Ground').map((c) => [c.name.toUpperCase(), c]));
  const ops = new Map((result.device_ops ?? []).map((o) => [o.name.toUpperCase(), o]));
  const Y = new Map<string, Term[]>();
  const b = new Map<number, Term[]>();
  const defs = new Map<string, SymbolDef>();
  let dynamic = false;

  const add = (map: Map<any, Term[]>, key: string | number, t: Term) => map.set(key, [...(map.get(key) ?? []), t]);
  const define = (sym: Sym, part: string, meaning: string, step: number) => {
    const key = symKey(sym);
    if (!defs.has(key)) defs.set(key, { key, sym, part, meaning, step });
  };
  const signOf = (delta: number, ref: number): 1 | -1 => ((ref === 0 ? delta : delta / ref) < 0 ? -1 : 1);

  (result.stamping_timeline ?? []).forEach((st: StampingStep, i) => {
    const name = st.component_name;
    const comp = byName.get(name.toUpperCase());
    const op = ops.get(name.toUpperCase());
    const term = (sym: Sym, value: number, ref: number, s = false): Term => ({ sign: signOf(value, ref), sym, value, s, step: i, part: name });

    if (name.startsWith('GMIN_')) {
      const sym = { base: 'g', sub: 'min' };
      for (const c of st.affected_cells_g) add(Y, `${c.row},${c.col}`, term(sym, c.delta, c.delta));
      define(sym, name, `a tiny ${formatQuantity(st.affected_cells_g[0]?.delta ?? 0, 'S')} leak so a node that only touches capacitors has a DC voltage`, i);
      return;
    }

    switch (comp?.type) {
      case 'Resistor': {
        const sym = { base: 'g', sub: subOf(name) };
        for (const c of st.affected_cells_g) add(Y, `${c.row},${c.col}`, term(sym, c.delta, 1 / comp.value));
        define(sym, name, `1/${name} = 1/(${formatQuantity(comp.value, 'Ω')}) = ${formatQuantity(1 / comp.value, 'S')}`, i);
        break;
      }
      case 'Capacitor': {
        const sym = { pre: 's', base: 'C', sub: subOf(name) };
        for (const c of st.affected_cells_c ?? []) { add(Y, `${c.row},${c.col}`, term(sym, c.delta, comp.value, true)); dynamic = true; }
        define(sym, name, `s times ${name} = ${formatQuantity(comp.value, 'F')}`, i);
        break;
      }
      case 'Inductor': {
        const one = { base: '1' };
        for (const c of st.affected_cells_g) add(Y, `${c.row},${c.col}`, term(one, c.delta, 1));
        const sym = { pre: 's', base: 'L', sub: subOf(name) };
        for (const c of st.affected_cells_c ?? []) { add(Y, `${c.row},${c.col}`, term(sym, c.delta, comp.value, true)); dynamic = true; }
        define(sym, name, `s times ${name} = ${formatQuantity(comp.value, 'H')}, on the row of ${name}'s own current`, i);
        break;
      }
      case 'VoltageSource': {
        const one = { base: '1' };
        for (const c of st.affected_cells_g) add(Y, `${c.row},${c.col}`, term(one, c.delta, 1));
        const sym = { base: 'V', sub: subOf(name) };
        for (const c of st.affected_cells_b) add(b, c.row, term(sym, c.delta, comp.value));
        define(sym, name, `the voltage of ${name} = ${formatQuantity(comp.value, 'V')}`, i);
        break;
      }
      case 'CurrentSource': {
        const sym = { base: 'I', sub: subOf(name) };
        for (const c of st.affected_cells_b) add(b, c.row, term(sym, c.delta, comp.value));
        define(sym, name, `the current of ${name} = ${formatQuantity(comp.value, 'A')}`, i);
        break;
      }
      case 'Diode': {
        const sym = { base: 'g', sub: name };
        for (const c of st.affected_cells_g) add(Y, `${c.row},${c.col}`, term(sym, c.delta, Math.abs(c.delta)));
        define(sym, name, `${name}'s slope dI/dV at its operating point = ${formatQuantity(q(op, 'g') ?? 0, 'S')} (like a ${formatQuantity(1 / (q(op, 'g') || 1), 'Ω')} resistor)`, i);
        const ieq = { base: 'I', sub: `eq,${name}` };
        for (const c of st.affected_cells_b) add(b, c.row, term(ieq, c.delta, Math.abs(c.delta)));
        if (st.affected_cells_b.length) define(ieq, name, `${name}'s companion current, the rest of its straight-line model = ${formatQuantity(Math.abs(st.affected_cells_b[0].delta), 'A')}`, i);
        break;
      }
      case 'BJT':
      case 'MOSFET': {
        const named: Array<[string, number | undefined, string]> = comp.type === 'BJT'
          ? [['m', q(op, 'gm'), 'transconductance: how much the collector current changes per volt of Vbe'],
             ['π', q(op, 'rpi') ? 1 / q(op, 'rpi')! : undefined, '1/rπ, the base–emitter conductance']]
          : [['m', q(op, 'gm'), 'transconductance: how much the drain current changes per volt of Vgs'],
             ['ds', q(op, 'gds'), 'output conductance between drain and source']];
        for (const c of st.affected_cells_g) {
          const hit = named.find(([, v]) => near(c.delta, v));
          const sym = hit ? { base: 'g', sub: `${hit[0]},${name}` } : { base: 'g', sub: name };
          add(Y, `${c.row},${c.col}`, term(sym, c.delta, Math.abs(c.delta)));
          define(sym, name, hit ? `${hit[2]} = ${formatQuantity(Math.abs(c.delta), 'S')}` : `a small conductance inside ${name} = ${formatQuantity(Math.abs(c.delta), 'S')}`, i);
        }
        const ieq = { base: 'I', sub: `eq,${name}` };
        for (const c of st.affected_cells_b) add(b, c.row, term(ieq, c.delta, Math.abs(c.delta)));
        if (st.affected_cells_b.length) define(ieq, name, `${name}'s companion currents, the rest of its straight-line model`, i);
        break;
      }
      case 'ShortCircuit': {
        const one = { base: '1' };
        for (const c of st.affected_cells_g) add(Y, `${c.row},${c.col}`, term(one, c.delta, 1));
        define(one, name, `connection constraint for ${name}`, i);
        break;
      }
      case 'OpAmp': {
        const one = { base: '1' };
        for (const c of st.affected_cells_g) {
          if (Math.abs(Math.abs(c.delta) - 1) < 1e-9) {
            add(Y, `${c.row},${c.col}`, term(one, c.delta, 1));
          } else {
            const sym = { base: 'A', sub: subOf(name) };
            add(Y, `${c.row},${c.col}`, term(sym, c.delta, comp?.value || Math.abs(c.delta)));
            define(sym, name, `gain A of ${name}`, i);
          }
        }
        define(one, name, `virtual short / output constraint for ${name}`, i);
        break;
      }
      case 'VCVS': {
        const one = { base: '1' };
        for (const c of st.affected_cells_g) {
          if (Math.abs(Math.abs(c.delta) - 1) < 1e-9) {
            add(Y, `${c.row},${c.col}`, term(one, c.delta, 1));
          } else {
            const sym = { base: 'E', sub: subOf(name) };
            add(Y, `${c.row},${c.col}`, term(sym, c.delta, comp?.value || Math.abs(c.delta)));
            define(sym, name, `voltage gain E of ${name}`, i);
          }
        }
        define(one, name, `output branch coupling for ${name}`, i);
        break;
      }
      case 'VCCS': {
        const sym = { base: 'g', sub: `m,${subOf(name)}` };
        for (const c of st.affected_cells_g) add(Y, `${c.row},${c.col}`, term(sym, c.delta, comp?.value || Math.abs(c.delta)));
        define(sym, name, `transconductance gm of ${name}`, i);
        break;
      }
      case 'CCCS':
      case 'CCVS': {
        const one = { base: '1' };
        for (const c of st.affected_cells_g) {
          if (Math.abs(Math.abs(c.delta) - 1) < 1e-9) {
            add(Y, `${c.row},${c.col}`, term(one, c.delta, 1));
          } else {
            const sym = { base: comp?.type === 'CCCS' ? 'F' : 'r', sub: subOf(name) };
            add(Y, `${c.row},${c.col}`, term(sym, c.delta, comp?.value || Math.abs(c.delta)));
            define(sym, name, `${comp?.type} factor of ${name}`, i);
          }
        }
        define(one, name, `branch coupling for ${name}`, i);
        break;
      }
      default: {
        const one = { base: '1' };
        for (const c of st.affected_cells_g) add(Y, `${c.row},${c.col}`, term(one, c.delta, 1));
        break;
      }
    }
  });
  return { Y, b, defs: [...defs.values()], dynamic };
}

/** Numbers for an entry's terms: "0.3", "1µ·s", "0.2 − 1m·s". */
export function numericOf(terms: Term[], fmt: (v: number) => string): string {
  const g = terms.filter((t) => !t.s).reduce((s, t) => s + t.value, 0);
  const c = terms.filter((t) => t.s).reduce((s, t) => s + t.value, 0);
  if (c === 0) return fmt(g);
  const cs = `${fmt(Math.abs(c))}·s`;
  if (g === 0) return c < 0 ? `−${cs}` : cs;
  return `${fmt(g)} ${c < 0 ? '−' : '+'} ${cs}`;
}
