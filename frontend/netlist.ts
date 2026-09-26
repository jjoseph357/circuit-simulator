import type { AutoFix, VisualCircuitComponent } from './types';

export type ElementType = 'Resistor' | 'CurrentSource' | 'VoltageSource' | 'Capacitor' | 'Inductor' | 'Diode' | 'BJT' | 'MOSFET';
export type PartType = VisualCircuitComponent['type'];
export type ModelKind = 'd' | 'npn' | 'pnp' | 'nmos' | 'pmos';
export const DEVICE_TYPES: ReadonlyArray<PartType> = ['Diode', 'BJT', 'MOSFET'];
export const isDevice = (t: PartType) => DEVICE_TYPES.includes(t);

export interface ParsedElement {
  name: string;
  type: ElementType;
  value: number;
  node1: string;
  node2: string;
  /** V/I sources only: SPICE spec when not plain DC (PULSE/SIN/PWL/AC). */
  source?: string;
  /** Transistors: emitter / source node. */
  node3?: string;
  /** Devices: text after the terminal nodes (model name, bulk node, W=/L=). */
  deviceArgs?: string;
  modelKind?: ModelKind;
}

export const PREFIX: Record<ElementType, string> = { Resistor: 'R', CurrentSource: 'I', VoltageSource: 'V', Capacitor: 'C', Inductor: 'L', Diode: 'D', BJT: 'Q', MOSFET: 'M' };
const TYPE_BY_LETTER: Record<string, ElementType> = { R: 'Resistor', I: 'CurrentSource', V: 'VoltageSource', C: 'Capacitor', L: 'Inductor', D: 'Diode', Q: 'BJT', M: 'MOSFET' };
export const UNIT: Record<PartType, string> = {
  Resistor: 'Ω', CurrentSource: 'A', VoltageSource: 'V', Capacitor: 'F', Inductor: 'H', Diode: '', BJT: '', MOSFET: '', Ground: '',
};
/** Everyday names, used everywhere a student reads about a part. */
export const PART_NAME: Record<PartType, string> = {
  Resistor: 'resistor', CurrentSource: 'current source', VoltageSource: 'voltage source', Capacitor: 'capacitor',
  Inductor: 'inductor', Diode: 'diode', BJT: 'transistor (BJT)', MOSFET: 'transistor (MOSFET)', Ground: 'ground',
};

/** `.model NAME KIND(...)` cards in a netlist → lower-case name → device kind. */
export function modelKinds(text: string): Map<string, ModelKind> {
  const kinds = new Map<string, ModelKind>();
  for (const m of text.matchAll(/^\s*\.model\s+(\S+)\s+(D|NPN|PNP|NMOS|PMOS)\b/gim)) kinds.set(m[1].toLowerCase(), m[2].toLowerCase() as ModelKind);
  return kinds;
}

const DEFAULT_KIND: Record<string, ModelKind> = { D: 'd', Q: 'npn', M: 'nmos' };
/** Model name the canvas uses for a polarity when no model card was chosen. */
export const defaultModelName = (kind: ModelKind) => `DEFAULT_${kind.toUpperCase()}`;

const SOURCE_KEYWORDS = ['dc', 'ac', 'pulse', 'sin', 'pwl'];

/** True if a V/I spec is just a DC value ("5", "DC 5"). */
export function isPlainDc(spec: string): boolean {
  return /^\s*(dc\s+)?[+-]?(\d|\.\d)[^\s(]*\s*$/i.test(spec);
}

/** The DC / t = 0 value of a source spec, mirroring the engine (explicit DC, else waveform at t = 0). */
export function dcValueOfSpec(spec: string): number {
  const toks = spec.replace(/[(),=]/g, ' ').split(/\s+/).filter(Boolean);
  const dcIdx = toks.findIndex((t) => t.toLowerCase() === 'dc');
  if (dcIdx >= 0) return parseEngValue(toks[dcIdx + 1] ?? '0') ?? 0;
  if (toks.length && !SOURCE_KEYWORDS.includes(toks[0].toLowerCase())) return parseEngValue(toks[0]) ?? 0;
  const w = toks.findIndex((t) => ['pulse', 'sin', 'pwl'].includes(t.toLowerCase()));
  if (w < 0) return 0;
  const kind = toks[w].toLowerCase();
  const a = toks.slice(w + 1).map((t) => parseEngValue(t) ?? 0);
  if (kind === 'sin') return a[0] ?? 0; // offset (phase 0 assumed for display)
  return a[kind === 'pwl' ? 1 : 0] ?? 0;
}

/** Short human label for a source spec, e.g. "step 0→5V", "sine 1V @ 1kHz", "AC 1V". */
export function sourceLabel(spec: string, unit: string): string {
  const toks = spec.replace(/[(),=]/g, ' ').split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  const nums = (i: number) => toks.slice(i + 1).filter((t) => !SOURCE_KEYWORDS.includes(t)).map((t) => parseEngValue(t) ?? 0);
  const parts: string[] = [];
  const p = toks.indexOf('pulse');
  if (p >= 0) {
    const [v1, v2, , , , , per] = nums(p);
    parts.push(per !== undefined && isFinite(per) ? `square ${formatEng(v1 ?? 0)}↔${formatEng(v2 ?? 0)}${unit}` : `step ${formatEng(v1 ?? 0)}→${formatEng(v2 ?? 0)}${unit}`);
  }
  const s = toks.indexOf('sin');
  if (s >= 0) {
    const [vo, va, f] = nums(s);
    parts.push(`sine ${formatEng(va ?? 0)}${unit} @ ${formatEng(f ?? 0)}Hz${vo ? ` + ${formatEng(vo)}${unit}` : ''}`);
  }
  if (toks.includes('pwl')) parts.push('piecewise-linear');
  const a = toks.indexOf('ac');
  if (a >= 0) parts.push(`AC ${formatEng(nums(a)[0] ?? 1)}${unit}`);
  if (!parts.length || (toks.includes('dc') && p < 0 && s < 0)) parts.unshift(`${formatEng(dcValueOfSpec(spec))}${unit} DC`);
  return parts.join(' · ');
}

/** SPICE control cards (.tran, .ac, .model …) in a netlist, excluding .end. */
export function extractDirectives(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('.') && !/^\.end\b/i.test(l));
}

/** The title comment on the first line, if there is one. */
export function extractTitle(text: string): string | null {
  const first = text.split(/\r?\n/).find((l) => l.trim());
  const m = first?.trim().match(/^\*\s*(.+)$/);
  return m ? m[1].trim() : null;
}

/** SPICE engineering notation, mirroring the Rust parser: 5k, 1Meg, 100mA, 2.5e3, 10V. */
export function parseEngValue(text: string): number | null {
  const m = text.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-zµΩ]*)/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const suf = m[2].toLowerCase();
  let mult = 1;
  if (suf.startsWith('meg')) mult = 1e6;
  else if (suf.startsWith('mil')) mult = 25.4e-6;
  else if (suf.startsWith('t')) mult = 1e12;
  else if (suf.startsWith('g')) mult = 1e9;
  else if (suf.startsWith('k')) mult = 1e3;
  else if (suf.startsWith('m')) mult = 1e-3;
  else if (suf.startsWith('u') || suf.startsWith('µ')) mult = 1e-6;
  else if (suf.startsWith('n')) mult = 1e-9;
  else if (suf.startsWith('p')) mult = 1e-12;
  else if (suf.startsWith('f')) mult = 1e-15;
  return num * mult;
}

/** 4700 → "4.7k", 0.0033 → "3.3m", 2e6 → "2Meg". Valid SPICE and readable on the canvas. */
export function formatEng(v: number, digits = 3): string {
  if (!isFinite(v)) return String(v);
  if (v === 0) return '0';
  const scales: Array<[number, string]> = [
    [1e12, 'T'], [1e9, 'G'], [1e6, 'Meg'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p'],
  ];
  const a = Math.abs(v);
  const [scale, suffix] = scales.find(([s]) => a >= s * 0.9995) ?? scales[scales.length - 1];
  return `${parseFloat((v / scale).toPrecision(digits))}${suffix}`;
}

/** Human display with µ and unit, e.g. formatQuantity(0.0012, 'A') → "1.2 mA". */
export function formatQuantity(v: number, unit: string, digits = 3): string {
  const e = formatEng(v, digits).replace(/u$/, 'µ').replace(/Meg$/, 'M');
  const m = e.match(/^(-?[\d.e+-]+)([a-zA-Zµ]*)$/);
  return m ? `${m[1]} ${m[2]}${unit}` : `${e} ${unit}`;
}

export const normalizeNode = (n: string) => {
  const t = n.trim().replace(/^['"(,]+|['"),]+$/g, '');
  return ['0', 'gnd', 'ground'].includes(t.toLowerCase()) ? '0' : t;
};

/** Removes '$' and ';' inline comments, as the engine does. */
function stripInlineComment(line: string): string {
  return line.split(/\s\$/)[0].split(';')[0];
}

/**
 * SPICE reads the first line as the circuit's title. Many hand-written netlists start straight
 * with an element, so (like the engine) the first line is a title only if it isn't a valid element.
 */
export function isTitleLine(line: string, models: Map<string, ModelKind>): boolean {
  const t = line.trim().split(/[\s,]+/).filter(Boolean);
  const letter = t[0]?.[0]?.toUpperCase();
  if (!letter) return true;
  const numeric = (x: string | undefined) => x !== undefined && parseEngValue(x) !== null;
  const namesModel = (words: string[]) => words.length === 0 || words.some((w) => w.includes('=') || models.has(w.toLowerCase()) || /^DEFAULT_/i.test(w));
  if ('RCL'.includes(letter)) return t.length < 4 || !numeric(t[3]);
  if ('VI'.includes(letter)) return t.length < 4 || !(numeric(t[3]) || SOURCE_KEYWORDS.some((k) => t[3].toLowerCase().startsWith(k)));
  if (letter === 'D') return t.length < 3 || !namesModel(t.slice(3));
  if ('QM'.includes(letter)) return t.length < 4 || !namesModel(t.slice(4));
  return !'JEFGHKXT'.includes(letter) || /^[A-Za-z]{3,}$/.test(t[0]);
}

/** Element lines of a SPICE netlist, parsed with the same rules as the Rust engine. */
export function parseNetlistElements(text: string): ParsedElement[] {
  const out: ParsedElement[] = [];
  const kinds = modelKinds(text);
  let first = true;
  for (const raw of text.split(/\r?\n/)) {
    const stmt = stripInlineComment(raw.trim()).trim();
    const wasFirst = first && raw.trim() !== '';
    if (raw.trim()) first = false;
    if (!stmt || stmt.startsWith('*') || stmt.startsWith('.')) continue;
    if (wasFirst && isTitleLine(stmt, kinds)) continue;
    const tokens = stmt.split(/[\s,]+/).filter(Boolean);
    const letter = tokens[0]?.[0]?.toUpperCase();
    if (letter === 'D' || letter === 'Q' || letter === 'M') {
      const nTerms = letter === 'D' ? 2 : 3;
      if (tokens.length < 1 + nTerms) continue;
      const args = tokens.slice(1 + nTerms);
      const named = args.find((a) => !a.includes('=') && (kinds.has(a.toLowerCase()) || /^DEFAULT_(D|NPN|PNP|NMOS|PMOS)$/i.test(a)));
      const kind = named ? (kinds.get(named.toLowerCase()) ?? (named.slice(8).toLowerCase() as ModelKind)) : DEFAULT_KIND[letter];
      out.push({
        name: tokens[0], type: TYPE_BY_LETTER[letter], value: 0, node1: normalizeNode(tokens[1]), node2: normalizeNode(tokens[2]),
        ...(nTerms === 3 ? { node3: normalizeNode(tokens[3]) } : {}),
        ...(args.length ? { deviceArgs: args.join(' ') } : {}),
        modelKind: kind,
      });
      continue;
    }
    if (tokens.length < 4) continue;
    const type = TYPE_BY_LETTER[letter];
    if (!type) continue;
    if (type === 'VoltageSource' || type === 'CurrentSource') {
      // Everything after the two nodes, taken from the raw text so PULSE(...) survives.
      let rest = stmt;
      for (const t of tokens.slice(0, 3)) rest = rest.slice(rest.indexOf(t) + t.length);
      const spec = rest.replace(/^[\s,]+/, '').trim();
      out.push({
        name: tokens[0], type, value: dcValueOfSpec(spec), node1: normalizeNode(tokens[1]), node2: normalizeNode(tokens[2]),
        ...(isPlainDc(spec) ? {} : { source: spec }),
      });
      continue;
    }
    const value = parseEngValue(tokens[3]);
    if (value === null) continue;
    out.push({ name: tokens[0], type, value, node1: normalizeNode(tokens[1]), node2: normalizeNode(tokens[2]) });
  }
  return out;
}

export function sortNodes(nodes: Iterable<string>): string[] {
  return [...new Set(nodes)].filter((n) => n !== '0').sort((a, b) => {
    const na = /^-?\d+$/.test(a), nb = /^-?\d+$/.test(b);
    if (na && nb) return parseInt(a) - parseInt(b);
    if (na !== nb) return na ? -1 : 1;
    return a.localeCompare(b);
  });
}

export const nodesOf = (c: Pick<VisualCircuitComponent, 'type' | 'node1' | 'node2' | 'node3'>) =>
  c.type === 'Ground' ? ['0'] : [c.node1, c.node2, ...(c.node3 !== undefined ? [c.node3] : [])];

// ------------------------------- Line explainer -------------------------------

export type TokenRole = 'name' | 'node' | 'value' | 'keyword' | 'directive' | 'comment' | 'model' | 'plain';
export interface LineToken { text: string; role: TokenRole; start: number }
export interface LineInfo {
  /** One plain-English sentence about the line. */
  text: string;
  error?: string;
  tokens: LineToken[];
  /** Element name, for element lines. */
  element?: string;
}

const LETTER_HELP = 'The first letter says what the part is: R resistor, C capacitor, L inductor, V voltage source, I current source, D diode, Q BJT, M MOSFET.';

function tokenize(line: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  const re = /[^\s,()]+|\(|\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ text: m[0], start: m.index });
  return out;
}

const nodeWord = (n: string) => (normalizeNode(n) === '0' ? 'ground (node 0)' : `node ${n}`);

/** Explains one netlist line in plain English and splits it into coloured tokens. */
export function explainLine(raw: string, isFirstLine = false, models: Map<string, ModelKind> = new Map()): LineInfo {
  const line = raw.replace(/\s+$/, '');
  const trimmed = line.trim();
  if (!trimmed) return { text: '', tokens: [] };
  if (isFirstLine && !trimmed.startsWith('*') && !trimmed.startsWith('.') && isTitleLine(trimmed, models)) {
    return { text: 'Title line. SPICE treats the first line as the circuit’s name. Starting it with * makes that clear.', tokens: [{ text: line, role: 'comment', start: 0 }] };
  }
  if (trimmed.startsWith('*')) {
    return { text: isFirstLine ? 'Title line. SPICE treats the first line as the circuit\'s name.' : 'Comment. Lines starting with * are notes for people; the simulator skips them.', tokens: [{ text: line, role: 'comment', start: 0 }] };
  }
  const toks = tokenize(line);
  const commentAt = line.search(/\s\$|;/);
  const main = toks.filter((t) => commentAt < 0 || t.start < commentAt);
  const tail: LineToken[] = commentAt >= 0 ? [{ text: line.slice(commentAt), role: 'comment', start: commentAt }] : [];
  const words = main.filter((t) => t.text !== '(' && t.text !== ')');
  const mark = (roles: Map<number, TokenRole>, fallback: TokenRole = 'plain'): LineToken[] =>
    [...main.map((t) => ({ ...t, role: roles.get(t.start) ?? (t.text === '(' || t.text === ')' ? 'plain' : fallback) })), ...tail];

  const head = words[0].text;
  if (head.startsWith('.')) {
    const card = head.toLowerCase();
    const roles = new Map<number, TokenRole>([[words[0].start, 'directive']]);
    const w = words.map((t) => t.text);
    let text = `Control card ${head}.`;
    let error: string | undefined;
    if (card === '.end') text = '.end marks the end of the netlist.';
    else if (card === '.op') text = '.op asks for the DC operating point: every node voltage with sources held steady.';
    else if (card === '.tran') {
      text = `.tran runs a transient analysis: simulate the circuit over time from 0 to ${w[2] ?? '?'} s, reporting every ${w[1] ?? '?'} s.`;
      if (w.length < 3 || parseEngValue(w[1]) === null || parseEngValue(w[2]) === null) error = 'Write it as .tran <step> <stop time>, e.g. .tran 10u 5m';
    } else if (card === '.ac') {
      text = `.ac sweeps the input frequency from ${w[3] ?? '?'} Hz to ${w[4] ?? '?'} Hz (${w[2] ?? '?'} points per ${w[1] === 'lin' ? 'sweep' : w[1] === 'oct' ? 'octave' : 'decade'}) to draw a Bode plot.`;
      if (w.length < 5 || !/^(dec|oct|lin)$/i.test(w[1])) error = 'Write it as .ac dec <points> <start> <stop>, e.g. .ac dec 20 10 100k';
      if (w[1]) roles.set(words[1].start, 'keyword');
    } else if (card === '.dc') {
      text = `.dc sweeps source ${w[1] ?? '?'} from ${w[2] ?? '?'} to ${w[3] ?? '?'} in steps of ${w[4] ?? '?'}, solving the circuit at each value.`;
      if (w.length < 5) error = 'Write it as .dc <source> <start> <stop> <step>, e.g. .dc V1 0 5 0.1';
      if (words[1]) roles.set(words[1].start, 'name');
    } else if (card === '.model') {
      text = `.model defines device parameters named ${w[1] ?? '?'} (type ${w[2] ?? '?'}), used by diodes and transistors.`;
      if (words[1]) roles.set(words[1].start, 'model');
      if (words[2]) roles.set(words[2].start, 'keyword');
    } else if (card === '.options' || card === '.option') text = '.options changes simulator settings, e.g. method=trap or method=euler for transient runs.';
    for (const t of words.slice(1)) if (!roles.has(t.start) && parseEngValue(t.text) !== null) roles.set(t.start, 'value');
    return { text, error, tokens: mark(roles) };
  }

  const letter = head[0].toUpperCase();
  const type = TYPE_BY_LETTER[letter];
  const roles = new Map<number, TokenRole>([[words[0].start, 'name']]);
  if (!type) {
    return { text: `Unknown part "${head}".`, error: LETTER_HELP, tokens: mark(roles) };
  }
  const nTerms = letter === 'Q' || letter === 'M' ? 3 : 2;
  const nodes = words.slice(1, 1 + nTerms);
  nodes.forEach((t) => roles.set(t.start, 'node'));
  if (nodes.length < nTerms) {
    return { text: `${PART_NAME[type]} ${head}`, error: `A ${PART_NAME[type]} needs ${nTerms} node names after its name.`, tokens: mark(roles), element: head };
  }
  const n = nodes.map((t) => t.text);
  const rest = words.slice(1 + nTerms);

  if (type === 'Diode' || type === 'BJT' || type === 'MOSFET') {
    for (const t of rest) roles.set(t.start, t.text.includes('=') ? 'value' : 'model');
    const model = rest.find((t) => !t.text.includes('='))?.text;
    const text = type === 'Diode'
      ? `Diode ${head}: current can flow from ${nodeWord(n[0])} (anode) to ${nodeWord(n[1])} (cathode)${model ? `, using model ${model}` : ''}.`
      : type === 'BJT'
      ? `BJT ${head}: collector on ${nodeWord(n[0])}, base on ${nodeWord(n[1])}, emitter on ${nodeWord(n[2])}${model ? `, model ${model}` : ''}.`
      : `MOSFET ${head}: drain on ${nodeWord(n[0])}, gate on ${nodeWord(n[1])}, source on ${nodeWord(n[2])}${model ? `, model ${model}` : ''}.`;
    return { text, tokens: mark(roles), element: head };
  }

  if (rest.length === 0) {
    return { text: `${PART_NAME[type]} ${head}`, error: `Add a value after the nodes, e.g. ${head} ${n[0]} ${n[1]} ${type === 'Resistor' ? '1k' : type === 'Capacitor' ? '1u' : type === 'Inductor' ? '1m' : '5'}`, tokens: mark(roles), element: head };
  }
  if (type === 'VoltageSource' || type === 'CurrentSource') {
    for (const t of rest) roles.set(t.start, SOURCE_KEYWORDS.includes(t.text.toLowerCase()) ? 'keyword' : 'value');
    const specStart = rest[0].start;
    const spec = line.slice(specStart, commentAt >= 0 ? commentAt : undefined).trim();
    const unit = type === 'VoltageSource' ? 'V' : 'A';
    const what = isPlainDc(spec) ? formatQuantity(dcValueOfSpec(spec), unit) : sourceLabel(spec, unit);
    const text = type === 'VoltageSource'
      ? `Voltage source ${head} (${what}): holds ${nodeWord(n[0])} (+) above ${nodeWord(n[1])} (−).`
      : `Current source ${head} (${what}): drives current from ${nodeWord(n[0])} through the source into ${nodeWord(n[1])}.`;
    return { text, tokens: mark(roles), element: head };
  }
  const v = parseEngValue(rest[0].text);
  roles.set(rest[0].start, 'value');
  if (v === null) return { text: `${PART_NAME[type]} ${head}`, error: `"${rest[0].text}" is not a number. Use values like 100, 4.7k, 10u, 2Meg.`, tokens: mark(roles), element: head };
  if (type === 'Resistor' && v === 0) return { text: `Resistor ${head}`, error: 'A 0 Ω resistor is just a wire. Give both ends the same node name instead.', tokens: mark(roles), element: head };
  return { text: `${PART_NAME[type][0].toUpperCase()}${PART_NAME[type].slice(1)} ${head} of ${formatQuantity(v, UNIT[type])} between ${nodeWord(n[0])} and ${nodeWord(n[1])}.`, tokens: mark(roles), element: head };
}

/** Problems a student can fix before simulating: one entry per bad line (1-based). */
export function validateNetlist(text: string): Array<{ line: number; message: string }> {
  const problems: Array<{ line: number; message: string }> = [];
  const seen = new Map<string, number>();
  const models = modelKinds(text);
  let first = true;
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const info = explainLine(raw, first, models);
    first = false;
    if (info.error) problems.push({ line: i + 1, message: info.error });
    if (info.element) {
      const key = info.element.toUpperCase();
      if (seen.has(key)) problems.push({ line: i + 1, message: `The name ${info.element} is already used on line ${seen.get(key)}. Every part needs its own name.` });
      else seen.set(key, i + 1);
    }
  });
  return problems;
}

// ------------------------------- Auto layout -------------------------------

const COL = 180;   // horizontal distance between node columns
const RAIL_Y = 120; // y of the main node rail
const X0 = 100;

/**
 * Classic textbook layout: non-ground nodes sit left→right on a rail, elements between two
 * nodes lie on (or arc above) the rail, elements to ground hang below their node with a
 * ground symbol each. Deterministic, so the same netlist always looks the same.
 */
export function autoLayout(elements: ParsedElement[]): VisualCircuitComponent[] {
  const nodes = sortNodes(elements.flatMap((e) => [e.node1, e.node2, ...(e.node3 ? [e.node3] : [])]));
  const col = new Map(nodes.map((n, i) => [n, i]));
  const shuntsAt = new Map<string, ParsedElement[]>();
  const comps: VisualCircuitComponent[] = [];
  let strayIdx = 0;
  const stamp = Date.now();

  for (const e of elements) {
    if (e.node3 !== undefined) continue; // transistors get their own row
    const g1 = e.node1 === '0', g2 = e.node2 === '0';
    if (g1 !== g2) {
      const node = g1 ? e.node2 : e.node1;
      shuntsAt.set(node, [...(shuntsAt.get(node) ?? []), e]);
    }
  }

  // Elements between two non-ground nodes are stacked in levels above the rail. Two elements
  // share a level only if their column spans don't overlap, so no pins ever touch by accident.
  // Level 0 is the rail itself, reserved for neighbours (a longer span would sit on a node).
  const levelOf = new Map<ParsedElement, number>();
  const occupied: Array<Array<[number, number]>> = [];
  const series = elements
    .filter((e) => e.node3 === undefined && e.node1 !== '0' && e.node2 !== '0' && e.node1 !== e.node2)
    .map((e) => { const a = col.get(e.node1)!, b = col.get(e.node2)!; return { e, lo: Math.min(a, b), hi: Math.max(a, b) }; })
    .sort((x, y) => (x.hi - x.lo) - (y.hi - y.lo));
  for (const { e, lo, hi } of series) {
    let level = hi - lo > 1 ? 1 : 0;
    while ((occupied[level] ?? []).some(([a, b]) => Math.max(a, lo) < Math.min(b, hi))) level++;
    (occupied[level] ??= []).push([lo, hi]);
    levelOf.set(e, level);
  }

  const usedDeviceX = new Set<number>();
  elements.forEach((e, idx) => {
    const base = {
      id: `c_${stamp}_${idx}`, name: e.name, type: e.type, value: e.value, unit: UNIT[e.type], node1: e.node1, node2: e.node2,
      ...(e.source ? { source: e.source } : {}), ...(e.node3 !== undefined ? { node3: e.node3 } : {}),
      ...(e.deviceArgs ? { deviceArgs: e.deviceArgs } : {}), ...(e.modelKind ? { modelKind: e.modelKind } : {}),
    };
    const g1 = e.node1 === '0', g2 = e.node2 === '0';
    const ground = (x: number, y: number) => comps.push({ id: `g_${stamp}_${idx}`, name: `GND${idx}`, type: 'Ground', value: 0, unit: '', node1: '0', node2: '0', x, y, rotation: 0 });

    if (e.node3 !== undefined) {
      // Transistor: collector/drain up, base/gate left, emitter/source down; below its nodes' columns.
      const cols = [e.node1, e.node2, e.node3].filter((n) => n !== '0').map((n) => col.get(n)!);
      let x = X0 + (cols.length ? Math.round(((Math.max(...cols) + Math.min(...cols)) / 2) * 2) / 2 : 0) * COL + COL / 2;
      while (usedDeviceX.has(x)) x += COL / 2;
      usedDeviceX.add(x);
      const y = RAIL_Y + 160;
      comps.push({ ...base, x, y, rotation: 0 });
      if (e.node3 === '0') ground(x, y + 80);
      return;
    }

    if (g1 !== g2) {
      const node = g1 ? e.node2 : e.node1;
      const list = shuntsAt.get(node)!;
      const k = list.indexOf(e);
      const x = X0 + col.get(node)! * COL + (k - (list.length - 1) / 2) * 80;
      const y = RAIL_Y + 100;
      comps.push({ ...base, x, y, rotation: g1 ? 270 : 90 });
      ground(x, y + 80);
    } else if (!g1 && e.node1 !== e.node2) {
      const [c1, c2] = [col.get(e.node1)!, col.get(e.node2)!];
      const x = X0 + ((c1 + c2) / 2) * COL;
      comps.push({ ...base, x, y: RAIL_Y - levelOf.get(e)! * 80, rotation: c1 <= c2 ? 0 : 180 });
    } else {
      comps.push({ ...base, x: X0 + strayIdx++ * 120, y: RAIL_Y + 300, rotation: 0 });
    }
  });
  return ensureGroundSymbol(comps);
}

/** On the canvas, node 0 exists only where a ground symbol is drawn: add one if node 0 is used without one. */
export function ensureGroundSymbol(comps: VisualCircuitComponent[]): VisualCircuitComponent[] {
  if (comps.some((c) => c.type === 'Ground')) return comps;
  const pin = comps.flatMap(terminalsOf).find((t) => t.node === '0');
  if (!pin) return comps;
  const x = pin.pos.x + pin.out.x * 40, y = Math.max(pin.pos.y, pin.pos.y + pin.out.y * 40) + 40;
  return [...comps, { id: `g_${Date.now()}`, name: 'GND0', type: 'Ground', value: 0, unit: '', node1: '0', node2: '0', x: Math.round(x / 20) * 20, y: Math.round(y / 20) * 20, rotation: 0 }];
}

/**
 * Re-derives the schematic from edited netlist text while keeping the student's drawing:
 * parts that still exist keep their place (their wires re-route to the new nodes), new parts
 * are placed next to a pin of one of their nodes, and parts that were removed disappear.
 * Returns null when nothing carries over, so the caller can lay the circuit out from scratch.
 */
export function mergeLayout(old: VisualCircuitComponent[], elements: ParsedElement[]): VisualCircuitComponent[] | null {
  const byName = new Map(old.filter((c) => c.type !== 'Ground').map((c) => [c.name.toUpperCase(), c]));
  if (!elements.some((e) => byName.has(e.name.toUpperCase()))) return null;
  const out: VisualCircuitComponent[] = [];
  const kept = elements.filter((e) => byName.has(e.name.toUpperCase()));
  for (const e of kept) {
    const c = byName.get(e.name.toUpperCase())!;
    out.push({
      ...c, name: e.name, type: e.type, value: e.value, unit: UNIT[e.type], node1: e.node1, node2: e.node2,
      source: e.source, node3: e.node3, deviceArgs: e.deviceArgs, modelKind: e.modelKind,
    });
  }
  const usesGround = elements.some((e) => [e.node1, e.node2, e.node3].includes('0'));
  if (usesGround) out.push(...old.filter((c) => c.type === 'Ground'));
  const xs = old.map((c) => c.x), ys = old.map((c) => c.y);
  let freeX = (xs.length ? Math.max(...xs) : 0) + 120;
  const top = ys.length ? Math.min(...ys) : 0;
  elements.forEach((e, i) => {
    if (byName.has(e.name.toUpperCase())) return;
    const anchor = out.flatMap(terminalsOf).find((t) => !t.isGroundSymbol && t.node !== '0' && [e.node1, e.node2, e.node3].includes(t.node));
    const vertical = e.node3 === undefined && (e.node1 === '0' || e.node2 === '0');
    let x = anchor ? anchor.pos.x + 60 : freeX, y = anchor ? anchor.pos.y + 60 : top;
    x = Math.round(x / 20) * 20; y = Math.round(y / 20) * 20;
    while (out.some((c) => Math.abs(c.x - x) < 60 && Math.abs(c.y - y) < 60)) x += 60;
    if (!anchor) freeX = x + 120;
    const rotation = e.node3 !== undefined ? 0 : vertical ? (e.node1 === '0' ? 270 : 90) : 0;
    out.push({
      id: `c_${Date.now()}_${i}`, name: e.name, type: e.type, value: e.value, unit: UNIT[e.type], node1: e.node1, node2: e.node2, x, y, rotation,
      ...(e.source ? { source: e.source } : {}), ...(e.node3 !== undefined ? { node3: e.node3 } : {}),
      ...(e.deviceArgs ? { deviceArgs: e.deviceArgs } : {}), ...(e.modelKind ? { modelKind: e.modelKind } : {}),
    });
    if (vertical) out.push({ id: `g_${Date.now()}_${i}`, name: `GND_${e.name}`, type: 'Ground', value: 0, unit: '', node1: '0', node2: '0', x, y: y + 80, rotation: 0 });
  });
  return ensureGroundSymbol(out);
}

/** When the last ground symbol is deleted, node 0 stops existing: its pins get an ordinary node. */
export function dropGroundIfNoSymbol(comps: VisualCircuitComponent[]): VisualCircuitComponent[] {
  if (comps.some((c) => c.type === 'Ground') || !comps.some((c) => nodesOf(c).includes('0'))) return comps;
  const fresh = freshNode(comps);
  return comps.map((c) => ({
    ...c,
    node1: c.node1 === '0' ? fresh : c.node1,
    node2: c.node2 === '0' ? fresh : c.node2,
    ...(c.node3 !== undefined ? { node3: c.node3 === '0' ? fresh : c.node3 } : {}),
  }));
}

/**
 * A hand-drawn layout (from a preset): parts go where the hints say (anything without a hint
 * falls back to the automatic layout), and every grounded pin gets its own ground symbol.
 */
export function layoutWithHints(elements: ParsedElement[], hints: Record<string, [number, number, number, boolean?]>): VisualCircuitComponent[] {
  const auto = autoLayout(elements).filter((c) => c.type !== 'Ground');
  const placed = auto.map((c) => {
    const h = hints[c.name];
    return h ? { ...c, x: h[0], y: h[1], rotation: h[2], ...(h[3] ? { mirror: true } : {}) } : c;
  });
  const grounds: VisualCircuitComponent[] = [];
  placed.flatMap(terminalsOf).filter((t) => t.node === '0').forEach((t, i) => {
    const x = t.pos.x + (t.out.y > 0 ? 0 : t.out.x * 20), y = t.pos.y + (t.out.y > 0 ? 20 : t.out.y < 0 ? -60 : 20);
    grounds.push({ id: `g_${Date.now()}_${i}`, name: `GND${i}`, type: 'Ground', value: 0, unit: '', node1: '0', node2: '0', x, y, rotation: 0 });
  });
  return [...placed, ...grounds];
}

// ------------------------------- Netlist writer -------------------------------

/** Canvas → SPICE netlist: a title comment, one line per part, control cards, then .end. */
export function componentsToNetlist(comps: VisualCircuitComponent[], directives: string[] = [], title = 'My circuit'): string {
  const active = comps.filter((c) => c.type !== 'Ground');
  const deviceLine = (c: VisualCircuitComponent) =>
    [c.name, c.node1, c.node2, ...(c.node3 !== undefined ? [c.node3] : []), c.deviceArgs || (c.modelKind ? defaultModelName(c.modelKind) : '')].filter(Boolean).join(' ');
  // Canvas-added devices refer to DEFAULT_<KIND> models; make sure those cards exist.
  const cards = new Set(directives.map((d) => d.match(/^\.model\s+(\S+)/i)?.[1]?.toLowerCase()).filter(Boolean));
  const defaults = [...new Set(active.filter((c) => isDevice(c.type)).flatMap((c) =>
    (c.deviceArgs ?? (c.modelKind ? defaultModelName(c.modelKind) : '')).split(/\s+/).filter((w) => /^DEFAULT_(D|NPN|PNP|NMOS|PMOS)$/i.test(w))))]
    .filter((m) => !cards.has(m.toLowerCase()))
    .map((m) => `.model ${m} ${m.slice(8).toUpperCase()}`);
  const valueText = (c: VisualCircuitComponent) =>
    c.source && (c.type === 'VoltageSource' || c.type === 'CurrentSource') ? c.source : formatEng(c.value, 12);
  const lines = [`* ${title}`];
  for (const c of active) lines.push(isDevice(c.type) ? deviceLine(c) : `${c.name} ${c.node1} ${c.node2} ${valueText(c)}`);
  return [...lines, ...directives, ...defaults, '.end'].join('\n') + '\n';
}

/** Next unused name for a type, e.g. R3 when R1 and R2 exist (never reuses a taken name). */
export function nextName(comps: VisualCircuitComponent[], type: PartType): string {
  const prefix = type === 'Ground' ? 'GND' : PREFIX[type];
  const taken = new Set(comps.map((c) => c.name.toUpperCase()));
  let i = 1;
  while (taken.has(`${prefix}${i}`.toUpperCase())) i++;
  return `${prefix}${i}`;
}

/** A node name no part uses yet (numbers, like hand-written SPICE). */
export function freshNode(comps: VisualCircuitComponent[], taken: Set<string> = new Set()): string {
  const used = new Set([...comps.flatMap(nodesOf), ...taken]);
  let i = 1;
  while (used.has(String(i))) i++;
  return String(i);
}

/** Applies a Circuit Doctor fix: comments out removed element lines and adds new ones before .end. */
export function applyAutoFix(netlist: string, fix: AutoFix): string {
  let lines = netlist.replace(/\s+$/, '').split(/\r?\n/);
  for (const target of fix.remove_lines) {
    const idx = lines.findIndex((l) => l.trim() === target.trim()) >= 0
      ? lines.findIndex((l) => l.trim() === target.trim())
      : lines.findIndex((l) => l.includes(target));
    if (idx >= 0) lines[idx] = `* removed: ${lines[idx].trim()}`;
  }
  if (fix.append_lines.length) {
    const end = lines.findIndex((l) => /^\s*\.end\b/i.test(l));
    const add = [`* ${fix.label}`, ...fix.append_lines];
    lines = end >= 0 ? [...lines.slice(0, end), ...add, ...lines.slice(end)] : [...lines, ...add];
  }
  return lines.join('\n') + '\n';
}

// ------------------------------- Geometry -------------------------------

export interface Point { x: number; y: number }
export const PIN_OFFSET = 40;

export interface Terminal {
  compId: string;
  compName: string;
  /** 1, 2 (two-terminal) or 1 = C/D, 2 = B/G, 3 = E/S for transistors. */
  pin: 1 | 2 | 3;
  node: string;
  pos: Point;
  /** Unit vector pointing away from the component body. */
  out: Point;
  isGroundSymbol: boolean;
}

export const terminalKey = (t: Pick<Terminal, 'compId' | 'pin'>) => `${t.compId}:${t.pin}`;

/** Short terminal names students see on hover: +/−, anode/cathode, C/B/E, D/G/S. */
export function pinLabel(type: PartType, pin: 1 | 2 | 3): string {
  switch (type) {
    case 'VoltageSource': return pin === 1 ? '+' : '−';
    case 'CurrentSource': return pin === 1 ? 'from' : 'to';
    case 'Diode': return pin === 1 ? 'anode' : 'cathode';
    case 'BJT': return ['collector', 'base', 'emitter'][pin - 1];
    case 'MOSFET': return ['drain', 'gate', 'source'][pin - 1];
    case 'Ground': return 'ground';
    default: return `pin ${pin}`;
  }
}

export function terminalsOf(c: VisualCircuitComponent): Terminal[] {
  if (c.type === 'Ground') {
    return [{ compId: c.id, compName: c.name, pin: 1, node: '0', pos: { x: c.x, y: c.y }, out: { x: 0, y: -1 }, isGroundSymbol: true }];
  }
  const r = ((c.rotation ?? 0) * Math.PI) / 180;
  const dx = Math.round(Math.cos(r) * 1e6) / 1e6, dy = Math.round(Math.sin(r) * 1e6) / 1e6;
  if (c.node3 !== undefined) {
    // Local frame: C/D at (0,−40) up, B/G at (−40,0) left, E/S at (0,40) down; rotated with the part.
    const m = c.mirror ? -1 : 1;
    const rot = (lx: number, ly: number) => ({ x: m * lx * dx - ly * dy, y: m * lx * dy + ly * dx });
    const pin = (p: 1 | 2 | 3, node: string, lx: number, ly: number) => {
      const o = rot(lx, ly);
      return { compId: c.id, compName: c.name, pin: p, node, pos: { x: c.x + o.x, y: c.y + o.y }, out: { x: Math.sign(Math.round(o.x)), y: Math.sign(Math.round(o.y)) }, isGroundSymbol: false };
    };
    return [pin(1, c.node1, 0, -PIN_OFFSET), pin(2, c.node2, -PIN_OFFSET, 0), pin(3, c.node3, 0, PIN_OFFSET)];
  }
  return [
    { compId: c.id, compName: c.name, pin: 1, node: c.node1, pos: { x: c.x - PIN_OFFSET * dx, y: c.y - PIN_OFFSET * dy }, out: { x: -dx, y: -dy }, isGroundSymbol: false },
    { compId: c.id, compName: c.name, pin: 2, node: c.node2, pos: { x: c.x + PIN_OFFSET * dx, y: c.y + PIN_OFFSET * dy }, out: { x: dx, y: dy }, isGroundSymbol: false },
  ];
}

export interface Wire {
  node: string;
  points: number[]; // flat polyline
  /** Current flowing from points[0] toward the end of the polyline (A). */
  current: number;
  /** Terminal keys at the two ends: [start, end]. */
  ends: [string, string];
}

export interface Junction { node: string; pos: Point }

/**
 * Orthogonal route from a pin to a point (or another pin). Of the two L-shapes, prefer the one
 * that leaves `from` outward and enters `toPin` from outside, so a wire never runs back along
 * a component body (which would make it look connected to the other terminal).
 */
function lRoute(from: Terminal, to: Point, toPin?: Terminal): number[] {
  const { x: x1, y: y1 } = from.pos;
  const dot = (ax: number, ay: number, b: Point) => ax * b.x + ay * b.y;
  const penalty = (corner: Point) => {
    let p = 0;
    const lx = corner.x - x1, ly = corner.y - y1;
    if (lx !== 0 || ly !== 0) { if (dot(lx, ly, from.out) < 0) p += 2; }
    else if (dot(to.x - x1, to.y - y1, from.out) < 0) p += 2;
    if (toPin) {
      const ex = to.x - corner.x, ey = to.y - corner.y;
      if ((ex !== 0 || ey !== 0) && dot(ex, ey, toPin.out) > 0) p += 1;
    }
    return p;
  };
  if (x1 === to.x || y1 === to.y) {
    const straight = dot(to.x - x1, to.y - y1, from.out) >= 0;
    if (straight) return [x1, y1, to.x, to.y];
  }
  const horizontalFirst = { x: to.x, y: y1 };
  const verticalFirst = { x: x1, y: to.y };
  const ph = penalty(horizontalFirst), pv = penalty(verticalFirst);
  const preferVertical = pv < ph || (pv === ph && Math.abs(from.out.y) > Math.abs(from.out.x));
  if (x1 === to.x || y1 === to.y) {
    // A straight line would run back through the symbol: step outward, sidestep, come back.
    const d = 20;
    const sx = x1 + from.out.x * d, sy = y1 + from.out.y * d;
    const px = from.out.y * d, py = -from.out.x * d; // perpendicular offset
    return [x1, y1, sx, sy, sx + px, sy + py, to.x + px, to.y + py, to.x, to.y];
  }
  return preferVertical ? [x1, y1, x1, to.y, to.x, to.y] : [x1, y1, to.x, y1, to.x, to.y];
}

/**
 * Current a terminal pushes INTO the node's wiring. Branch current I flows node1 → node2
 * through the element, so it leaves the wiring at pin 1 and returns to the wiring at pin 2.
 */
function injection(t: Terminal, currents: Record<string, number> | undefined, deviceTerminals?: Record<string, number[]>): number {
  if (t.isGroundSymbol) return 0;
  const dev = deviceTerminals?.[t.compName];
  if (dev) return -(dev[t.pin - 1] ?? 0); // current into the device leaves the wiring
  if (!currents) return 0;
  const i = currents[t.compName] ?? 0;
  return t.pin === 1 ? -i : i;
}

const manhattan = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * Wires are derived from node names, so the schematic can never disagree with the netlist.
 * Each node's pins are joined by a minimum spanning tree (shortest total wire, like a hand
 * drawing). On a tree the current in every wire follows from the terminal currents, so the
 * moving dots obey KCL at every pin. Pins on ground run to their nearest ground symbol.
 */
export function routeWires(
  comps: VisualCircuitComponent[],
  currents?: Record<string, number>,
  deviceTerminals?: Record<string, number[]>,
): { wires: Wire[]; junctions: Junction[] } {
  const byNode = new Map<string, Terminal[]>();
  for (const c of comps) for (const t of terminalsOf(c)) byNode.set(t.node, [...(byNode.get(t.node) ?? []), t]);

  const wires: Wire[] = [];
  const junctions: Junction[] = [];
  for (const [node, terms] of byNode) {
    const grounds = terms.filter((t) => t.isGroundSymbol);
    const pins = terms.filter((t) => !t.isGroundSymbol);

    if (node === '0' && grounds.length > 0) {
      // Ground symbols are implicitly connected; each pin wires to its nearest symbol.
      const fanIn = new Map<Terminal, number>();
      for (const t of pins) {
        const g = grounds.reduce((best, cand) => (manhattan(cand.pos, t.pos) < manhattan(best.pos, t.pos) ? cand : best));
        fanIn.set(g, (fanIn.get(g) ?? 0) + 1);
        wires.push({ node, points: lRoute(t, g.pos), current: injection(t, currents, deviceTerminals), ends: [terminalKey(t), terminalKey(g)] });
      }
      for (const [g, n] of fanIn) if (n >= 2) junctions.push({ node, pos: g.pos });
      continue;
    }
    if (pins.length < 2) continue;

    // Prim's algorithm on Manhattan distance, rooted at pin 0.
    const inTree = new Set<number>([0]);
    const parent = new Array<number>(pins.length).fill(-1);
    const best = pins.map((p) => manhattan(p.pos, pins[0].pos));
    const nearest = new Array<number>(pins.length).fill(0);
    const order: number[] = [0];
    while (inTree.size < pins.length) {
      let k = -1;
      for (let i = 0; i < pins.length; i++) if (!inTree.has(i) && (k < 0 || best[i] < best[k])) k = i;
      inTree.add(k);
      parent[k] = nearest[k];
      order.push(k);
      for (let i = 0; i < pins.length; i++) {
        const d = manhattan(pins[i].pos, pins[k].pos);
        if (!inTree.has(i) && d < best[i]) { best[i] = d; nearest[i] = k; }
      }
    }
    // Current in the wire child → parent = everything the child's subtree injects.
    const subtree = pins.map((t) => injection(t, currents, deviceTerminals));
    for (let j = order.length - 1; j > 0; j--) subtree[parent[order[j]]] += subtree[order[j]];
    const degree = new Array<number>(pins.length).fill(0);
    for (let i = 1; i < order.length; i++) {
      const child = order[i], par = parent[child];
      degree[child]++; degree[par]++;
      wires.push({ node, points: lRoute(pins[child], pins[par].pos, pins[par]), current: subtree[child], ends: [terminalKey(pins[child]), terminalKey(pins[par])] });
    }
    pins.forEach((p, i) => { if (degree[i] >= 2) junctions.push({ node, pos: p.pos }); });
  }
  return { wires, junctions };
}

export interface TagAnchor extends Point {
  /** 'h': centre the tag on x, just below y. 'v': put the tag left of x, centred on y. 'pin': beside a lone pin. */
  side: 'h' | 'v' | 'pin';
}

/**
 * Where to put each node's name tag: in the middle of the node's longest straight wire
 * segment, which is on the node's own wiring and away from the parts' labels. Nodes with no
 * wire yet (a single pin) get the tag beside that pin.
 */
export function nodeLabelAnchors(comps: VisualCircuitComponent[]): Map<string, TagAnchor> {
  const anchors = new Map<string, TagAnchor>();
  const best = new Map<string, number>();
  for (const w of routeWires(comps).wires) {
    if (w.node === '0') continue;
    for (let i = 0; i + 3 < w.points.length; i += 2) {
      const [x1, y1, x2, y2] = w.points.slice(i, i + 4);
      const len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
      if (len > (best.get(w.node) ?? 0)) {
        best.set(w.node, len);
        anchors.set(w.node, y1 === y2 ? { x: (x1 + x2) / 2, y: y1, side: 'h' } : { x: x1, y: (y1 + y2) / 2, side: 'v' });
      }
    }
  }
  for (const c of comps) for (const t of terminalsOf(c)) {
    if (!t.isGroundSymbol && t.node !== '0' && !anchors.has(t.node)) anchors.set(t.node, { ...t.pos, side: 'pin' });
  }
  return anchors;
}

/** Distinct colours for nodes on a white canvas (contrast ≥ 3:1), assigned in node order. */
export const NODE_COLORS = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#db2777', '#0891b2', '#b45309', '#dc2626', '#4f46e5', '#0d9488'];
export const GROUND_COLOR = '#475569';

export function nodeColorMap(nodes: Iterable<string>): Map<string, string> {
  const map = new Map<string, string>([['0', GROUND_COLOR]]);
  sortNodes(nodes).forEach((n, i) => map.set(n, NODE_COLORS[i % NODE_COLORS.length]));
  return map;
}

/** Order-insensitive fingerprint of which elements connect which nodes (values excluded). */
export function topologySignature(comps: Array<Pick<VisualCircuitComponent, 'name' | 'node1' | 'node2' | 'type' | 'node3'>>): string {
  return comps.filter((c) => c.type !== 'Ground').map((c) => `${c.name}:${c.node1}-${c.node2}${c.node3 !== undefined ? `-${c.node3}` : ''}`).sort().join('|');
}

/** Current into each device terminal (pin order), from device operating points. */
export function deviceTerminalCurrents(ops: Array<{ name: string; terminals: Array<{ current: number }> }> | undefined): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const o of ops ?? []) out[o.name] = o.terminals.map((t) => t.current);
  return out;
}

// ------------------------------- Editing helpers -------------------------------

/** Renames node `from` to `to` everywhere (joining them if `to` already exists). Ground wins a merge. */
export function mergeNodes(comps: VisualCircuitComponent[], a: string, b: string): VisualCircuitComponent[] {
  if (a === b) return comps;
  const keep = a === '0' || b === '0' ? '0' : a;
  const drop = keep === a ? b : a;
  return comps.map((c) => c.type === 'Ground' ? c : {
    ...c,
    node1: c.node1 === drop ? keep : c.node1,
    node2: c.node2 === drop ? keep : c.node2,
    ...(c.node3 !== undefined ? { node3: c.node3 === drop ? keep : c.node3 } : {}),
  });
}

/** Gives one terminal a node of its own (disconnects it). Ground symbols are simply removed. */
export function detachTerminal(comps: VisualCircuitComponent[], key: string): VisualCircuitComponent[] {
  const [compId, pinText] = key.split(':');
  const comp = comps.find((c) => c.id === compId);
  if (!comp) return comps;
  if (comp.type === 'Ground') return comps.filter((c) => c.id !== compId);
  const fresh = freshNode(comps);
  const field = pinText === '1' ? 'node1' : pinText === '2' ? 'node2' : 'node3';
  return comps.map((c) => (c.id === compId ? { ...c, [field]: fresh } : c));
}

/**
 * Deleting a wire splits its node in two: the pins on the far side of the wire (in the
 * wiring tree) get a new node name.
 */
export function cutWire(comps: VisualCircuitComponent[], wire: Wire): VisualCircuitComponent[] {
  const { wires } = routeWires(comps);
  const same = wires.filter((w) => w.node === wire.node);
  const adj = new Map<string, string[]>();
  for (const w of same) {
    if (w.ends[0] === wire.ends[0] && w.ends[1] === wire.ends[1]) continue;
    for (const [a, b] of [[w.ends[0], w.ends[1]], [w.ends[1], w.ends[0]]]) adj.set(a, [...(adj.get(a) ?? []), b]);
  }
  // Everything still reachable from the wire's start end moves to a new node.
  const side = new Set<string>([wire.ends[0]]);
  const stack = [wire.ends[0]];
  while (stack.length) for (const n of adj.get(stack.pop()!) ?? []) if (!side.has(n)) { side.add(n); stack.push(n); }
  let out = comps;
  // A ground symbol can't change node: if it's on the moving side, move the other side instead.
  const isGround = (k: string) => comps.find((c) => c.id === k.split(':')[0])?.type === 'Ground';
  let moving = [...side];
  if (moving.some(isGround)) {
    const other = new Set<string>([wire.ends[1]]);
    const st = [wire.ends[1]];
    while (st.length) for (const n of adj.get(st.pop()!) ?? []) if (!other.has(n)) { other.add(n); st.push(n); }
    moving = [...other];
    if (moving.some(isGround)) return comps; // both sides grounded: still connected through ground
  }
  const fresh = freshNode(comps);
  for (const key of moving) {
    const [compId, pinText] = key.split(':');
    const field = pinText === '1' ? 'node1' : pinText === '2' ? 'node2' : 'node3';
    out = out.map((c) => (c.id === compId ? { ...c, [field]: fresh } : c));
  }
  return out;
}
