import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CircuitSimulationResult, StampingStep, VisualCircuitComponent } from './types';
import type { MathTab } from './lessons';
import { NewtonView } from './NewtonView';
import { buildSymbolic, numericOf, Sym, Term } from './symbolic';
import { formatEng } from './netlist';
import { EmptyState, Segmented, useGlow, GuideTarget, GuideContext } from './ui';
import { Play, Pause, SkipBack, SkipForward, RotateCcw, CheckCircle2, AlertCircle, X, Calculator } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

/** Engineering notation with µ, as in the netlist: 125µ, 3.3k, −1m. */
const eng = (v: number) => formatEng(v, 4).replace(/u$/, 'µ').replace(/Meg$/, 'M').replace(/^-/, '−');

type CellRef = { kind: 'Y'; row: number; col: number } | { kind: 'b'; row: number };
type Show = 'symbols' | 'both' | 'numbers';

const fmt = (v: number) => {
  if (v === 0) return '0';
  const a = Math.abs(v);
  return a >= 1e4 || a < 1e-3 ? v.toExponential(2) : parseFloat(v.toFixed(4)).toString();
};

/** What a row/column of the MNA system means, in words. */
function describeVariable(name: string | undefined, as: 'row' | 'col'): string {
  if (!name) return '';
  const node = name.match(/^V\((.+)\)$/);
  if (node) return as === 'row' ? `KCL at node ${node[1]}: the currents leaving it add to zero` : `unknown: the voltage of node ${node[1]}`;
  const src = name.match(/^I\((.+)\)$/);
  if (src) return as === 'row' ? `${src[1]}'s own rule (its voltage equation)` : `unknown: the current through ${src[1]}`;
  return name;
}

/** Plain-English narration of one stamping step. */
function narrateStamp(step: StampingStep, vars: string[]): string {
  const letter = step.component_name[0]?.toUpperCase();
  const nodeOf = (row: number) => vars[row]?.match(/^V\((.+)\)$/)?.[1];
  const diagRows = step.affected_cells_g.filter((c) => c.row === c.col).map((c) => nodeOf(c.row)).filter(Boolean);
  const sub = step.component_name.slice(1) || step.component_name;
  if (step.component_name.startsWith('GMIN_')) return `${step.component_summary}. A tiny leak to ground so a node that only touches capacitors still has a DC voltage (SPICE does the same).`;
  if (letter === 'R') {
    const grounded = diagRows.length === 1;
    return `${step.component_name} adds its conductance g${sub} = 1/${step.component_name} to the diagonal of ${grounded ? `node ${diagRows[0]}` : `nodes ${diagRows.join(' and ')}`}` +
      (grounded ? '. Its other end is ground, which has no row.' : ', and −g' + sub + ' to the two entries that link them.');
  }
  if (letter === 'I') return `${step.component_name} is a known current, so it only goes into b: +I${sub} where it flows in, −I${sub} where it flows out.`;
  if (letter === 'C') return `${step.component_name}'s current is C·dV/dt. In the frequency domain d/dt becomes s, so it stamps sC${sub} exactly the way a resistor stamps g. At DC, s = 0 and the capacitor disappears (an open circuit).`;
  if (letter === 'L') return `${step.component_name}'s current becomes a new unknown with its own row and column: ±1 link it to its nodes, and −sL${sub} sits on its own row, giving V(a) − V(b) − sL${sub}·I = 0. At DC that says V(a) = V(b): a wire.`;
  if (letter === 'V') return `${step.component_name} fixes a voltage but its current is unknown, so MNA adds that current as a new column and a row saying V(+) − V(−) = V${sub}. The ±1 entries link the source to its two nodes.`;
  return `${step.component_summary}. ${step.explanation}`;
}

/** g₁, sC₂, g_m,Q1 … as HTML with subscripts. */
function SymView({ sym }: { sym: Sym }) {
  return <span>{sym.pre}<i className={sym.base === '1' ? 'not-italic' : ''}>{sym.base}</i>{sym.sub && <sub className="text-[0.75em]">{sym.sub}</sub>}</span>;
}

/** A sum of terms, e.g. g₁ + g₂ − sC₃. Terms from `fresh` are highlighted (just stamped). */
function Expr({ terms, fresh }: { terms: Term[]; fresh?: number }) {
  if (!terms.length) return <span className="text-gray-300">0</span>;
  return (
    <span className="whitespace-nowrap">
      {terms.map((t, i) => (
        <span key={i} className={t.step === fresh ? 'rounded bg-green-200/70 px-0.5 text-green-900' : ''}>
          {i === 0 ? (t.sign < 0 ? '−' : '') : t.sign < 0 ? ' − ' : ' + '}
          <SymView sym={t.sym} />
        </span>
      ))}
    </span>
  );
}

const TABS: Array<{ id: MathTab; label: string; glow?: GuideTarget }> = [
  { id: 'matrix', label: 'Build the matrix' },
  { id: 'gaussian', label: 'Solve it' },
  { id: 'kcl', label: 'Check KCL', glow: 'math:kcl' },
  { id: 'spy', label: 'Sparsity' },
  { id: 'newton', label: 'Newton’s method', glow: 'math:newton' },
];

export function MathView({ result, hasRun, tab, onTab, selectedName, onInspect, comps, solver, onUseGaussian }: {
  result: CircuitSimulationResult | null;
  hasRun: boolean;
  tab: MathTab;
  onTab: (t: MathTab) => void;
  selectedName: string | null;
  onInspect: (names: string[]) => void;
  comps: VisualCircuitComponent[];
  solver: string;
  onUseGaussian: () => void;
}) {
  const [stampStep, setStampStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [inspected, setInspected] = useState<CellRef | null>(null);
  const [show, setShow] = useState<Show>('both');
  const playGlow = useGlow('math:play');
  const target = React.useContext(GuideContext);

  const steps = result?.stamping_timeline ?? [];
  const nSteps = steps.length;
  const educational = result?.educational_views !== false && (result?.matrix_g?.length ?? 0) > 0;
  const symbolic = useMemo(() => (result?.success ? buildSymbolic(result, comps) : null), [result, comps]);

  useEffect(() => {
    if (!playing || nSteps === 0) return;
    const id = setInterval(() => setStampStep((p) => { if (p >= nSteps) { setPlaying(false); return nSteps; } return p + 1; }), 1300);
    return () => clearInterval(id);
  }, [playing, nSteps]);

  useEffect(() => { setStampStep(result?.stamping_timeline?.length ?? 0); setInspected(null); }, [result]);

  // Terms stamped so far (the animation shows the matrix growing part by part).
  const upTo = (terms: Term[] | undefined) => (terms ?? []).filter((t) => t.step < stampStep);
  const inspectedTerms = !inspected || !symbolic ? [] : upTo(inspected.kind === 'Y' ? symbolic.Y.get(`${inspected.row},${inspected.col}`) : symbolic.b.get(inspected.row));

  const reportRef = useRef(onInspect);
  reportRef.current = onInspect;
  const inspectedParts = [...new Set(inspectedTerms.map((t) => t.part))].join('|');
  useEffect(() => { reportRef.current(inspectedParts ? inspectedParts.split('|') : []); }, [inspectedParts]);
  useEffect(() => () => reportRef.current([]), []);

  const selectedCells = useMemo(() => {
    const s = steps.find((x) => x.component_name === selectedName);
    return {
      y: new Set([...(s?.affected_cells_g ?? []), ...(s?.affected_cells_c ?? [])].map((c) => `${c.row},${c.col}`)),
      b: new Set(s?.affected_cells_b.map((c) => c.row) ?? []),
    };
  }, [steps, selectedName]);

  if (!hasRun || !result) {
    return <EmptyState icon={<Calculator className="h-8 w-8" />} title="Run the circuit first">Then this tab shows how the simulator turns your circuit into the matrix equation G·x = b and solves it.</EmptyState>;
  }
  if (!result.success) return <EmptyState title="Nothing to show">The circuit could not be solved. The guide on the left explains why.</EmptyState>;

  const vars = result.variable_names;
  const n = vars.length;
  const active = stampStep > 0 && stampStep <= nSteps ? steps[stampStep - 1] : null;
  const activeIdx = active ? stampStep - 1 : undefined;
  const toggleInspect = (cell: CellRef) => setInspected((p) => (p && JSON.stringify(p) === JSON.stringify(cell) ? null : cell));
  const tabs = TABS.filter((t) => t.id !== 'newton' || result.newton);
  const dyn = symbolic?.dynamic ?? false;
  const shownDefs = (symbolic?.defs ?? []).filter((d) => d.step < stampStep);

  const cell = (terms: Term[], isInspected: boolean, isSelected: boolean) => {
    const fresh = activeIdx !== undefined && terms.some((t) => t.step === activeIdx);
    return {
      className: `cursor-pointer border border-gray-100 px-2.5 py-1.5 text-center align-middle ${
        isInspected ? 'bg-amber-100 ring-2 ring-amber-400 ring-inset' : fresh ? 'bg-green-50' : isSelected ? 'bg-blue-50 ring-1 ring-blue-300 ring-inset' : terms.length ? 'hover:bg-gray-50' : 'hover:bg-gray-50'}`,
      body: (
        <>
          {show !== 'numbers' && <div className="font-serif text-[14px] text-gray-900"><Expr terms={terms} fresh={activeIdx} /></div>}
          {show !== 'symbols' && terms.length > 0 && <div className={`font-mono ${show === 'numbers' ? 'text-xs text-gray-900' : 'text-[11px] text-gray-400'}`}>{numericOf(terms, eng)}</div>}
          {show === 'numbers' && terms.length === 0 && <div className="font-mono text-xs text-gray-300">0</div>}
        </>
      ),
    };
  };

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex flex-wrap rounded-lg bg-gray-100 p-0.5">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => onTab(t.id)}
              className={`rounded-md px-3 py-1 text-sm font-medium ${tab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}${t.glow && target === t.glow ? ' guide-glow' : ''}`}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400" title="Largest error when the answer is plugged back into G·x = b">
          {result.solver_used} · {result.execution_time_us} µs{result.residual_max_abs != null ? ` · error ${result.residual_max_abs.toExponential(0)}` : ''}
        </span>
      </div>

      {!educational && tab !== 'spy' && tab !== 'newton' && (
        <div className="card p-4 text-sm text-gray-600">This circuit has {result.num_equations} unknowns: too many to print as tables. The Sparsity tab still shows the matrix’s shape.</div>
      )}

      {tab === 'matrix' && educational && symbolic && (
        <div className="space-y-3">
          <div className="card flex flex-wrap items-center gap-3 p-3">
            <div className="flex items-center gap-1">
              <button className="icon-btn" onClick={() => { setPlaying(false); setStampStep(0); }} title="Back to the empty matrix"><RotateCcw className="h-4 w-4" /></button>
              <button className="icon-btn" onClick={() => setStampStep((s) => Math.max(s - 1, 0))} title="Previous part"><SkipBack className="h-4 w-4" /></button>
              <button className={`btn btn-primary btn-sm${playGlow}`} onClick={() => { if (!playing && stampStep >= nSteps) setStampStep(0); setPlaying(!playing); }}>
                {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}{playing ? 'Pause' : 'Play'}
              </button>
              <button className="icon-btn" onClick={() => setStampStep((s) => Math.min(s + 1, nSteps))} title="Next part"><SkipForward className="h-4 w-4" /></button>
            </div>
            <input type="range" min={0} max={nSteps} value={stampStep} onChange={(e) => { setPlaying(false); setStampStep(parseInt(e.target.value)); }} className="min-w-32 flex-1 accent-blue-600" />
            <span className="text-sm tabular-nums text-gray-600">part {stampStep} of {nSteps}</span>
            <Segmented size="xs" value={show} onChange={setShow} options={[
              { value: 'symbols', label: 'Symbols' }, { value: 'both', label: 'Both' }, { value: 'numbers', label: 'Numbers' },
            ]} />
          </div>
          <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
            {active ? <><b>{active.component_summary}.</b> {narrateStamp(active, vars)}</> : 'Every entry starts at zero. Press Play to add the parts one at a time, and watch each entry become a sum of the parts that touch it.'}
          </div>

          <div className="grid gap-3 xl:grid-cols-[1fr_18rem]">
            <div className="card overflow-x-auto p-3">
              <p className="mb-2 text-xs text-gray-500">
                <span className="font-mono font-semibold text-gray-800">{dyn ? '(G + sC) · x = b' : 'G · x = b'}</span>
                {dyn && <> · s = jω is the frequency; at DC s = 0 and every s-term drops out</>}
                <span className="text-gray-400"> · click any entry to see where it came from</span>
              </p>
              <table className="border-collapse">
                <thead>
                  <tr>
                    <th />
                    {vars.map((v, i) => <th key={i} className="border-b border-gray-200 p-1.5 font-mono text-[11px] font-medium text-blue-700" title={describeVariable(v, 'col')}>{v}</th>)}
                    <th className="w-4" />
                    <th className="border-b border-gray-200 p-1.5 font-mono text-[11px] font-medium text-gray-500">x</th>
                    <th className="w-4" />
                    <th className="border-b border-gray-200 p-1.5 font-mono text-[11px] font-medium text-gray-500">b</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: n }, (_, r) => {
                    const bTerms = upTo(symbolic.b.get(r));
                    const bc = cell(bTerms, inspected?.kind === 'b' && inspected.row === r, selectedCells.b.has(r));
                    return (
                      <tr key={r}>
                        <td className="border-r border-gray-200 p-1.5 pr-2 text-right font-mono text-[11px] text-blue-700" title={describeVariable(vars[r], 'row')}>{vars[r]}</td>
                        {Array.from({ length: n }, (_, c) => {
                          const terms = upTo(symbolic.Y.get(`${r},${c}`));
                          const yc = cell(terms, inspected?.kind === 'Y' && inspected.row === r && inspected.col === c, selectedCells.y.has(`${r},${c}`));
                          return <td key={c} onClick={() => toggleInspect({ kind: 'Y', row: r, col: c })} className={yc.className}>{yc.body}</td>;
                        })}
                        <td className="text-center text-gray-400">{r === Math.floor((n - 1) / 2) ? '·' : ''}</td>
                        <td className="border border-gray-100 px-2 py-1.5 text-center font-mono text-[11px] text-gray-700">{vars[r]}</td>
                        <td className="text-center text-gray-400">{r === Math.floor((n - 1) / 2) ? '=' : ''}</td>
                        <td onClick={() => toggleInspect({ kind: 'b', row: r })} className={bc.className}>{bc.body}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="card p-3 text-sm">
              <p className="mb-2 font-semibold text-gray-900">What the symbols mean</p>
              {shownDefs.length === 0 ? <p className="text-gray-500">Nothing stamped yet.</p> : (
                <ul className="space-y-1.5">
                  {shownDefs.map((d) => (
                    <li key={d.key} className={`${activeIdx === d.step ? 'rounded bg-green-50' : ''}`}>
                      <span className="font-serif text-[15px] text-gray-900"><SymView sym={d.sym} /></span>
                      <span className="text-gray-600"> = {d.meaning}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 border-t border-gray-100 pt-2 text-xs text-gray-500">
                <b>±1</b> entries link a voltage source’s (or inductor’s) current to its two nodes. Each row with V(…) is KCL at that node; each row with I(…) is that part’s own equation.
                {comps.some((c) => c.type === 'Inductor') && ' Hand analysis often puts 1/(sL) in the node rows instead; SPICE gives each inductor its own current unknown, which gives the same voltages.'}
              </p>
            </div>
          </div>

          {inspected && (
            <div className="relative rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-gray-800">
              <button onClick={() => setInspected(null)} className="icon-btn absolute right-2 top-2"><X className="h-4 w-4" /></button>
              <p className="font-semibold text-amber-900">{inspected.kind === 'b' ? `b[${vars[inspected.row]}]` : `Entry [${vars[inspected.row]}, ${vars[inspected.col]}]`}</p>
              <p className="mt-1"><b>Row:</b> {describeVariable(vars[inspected.row], 'row')}.</p>
              {inspected.kind === 'Y' && <p><b>Column:</b> {describeVariable(vars[inspected.col], 'col')}.</p>}
              {inspectedTerms.length === 0 ? (
                <p className="mt-1 text-gray-600">No part touches this entry, so it stays 0. Most of an MNA matrix is zeros like this.</p>
              ) : (
                <>
                  <p className="mt-2 font-serif text-[15px]">
                    <Expr terms={inspectedTerms} />
                    <span className="font-sans text-gray-500"> = </span>
                    <span className="font-mono text-sm">{inspectedTerms.map((t, i) => `${i === 0 ? (t.value < 0 ? '−' : '') : t.value < 0 ? ' − ' : ' + '}${eng(Math.abs(t.value))}${t.s ? '·s' : ''}`).join('')}</span>
                    {inspectedTerms.length > 1 && <span className="font-mono text-sm"> = {numericOf(inspectedTerms, eng)}</span>}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">From {[...new Set(inspectedTerms.map((t) => t.part))].join(', ')} (highlighted on the schematic).</p>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'gaussian' && educational && (
        <div className="space-y-3">
          <SolverComparison result={result} solver={solver} onUseGaussian={onUseGaussian} />
          {result.gaussian_steps.length > 0 && (
            <>
              <p className="text-sm text-gray-600">The {result.gaussian_steps.length} row operations for this circuit:</p>
              {result.gaussian_steps.map((step) => (
                <div key={step.step_index} className="card p-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-gray-800">{step.step_index}. {step.description}</span>
                    <span className="pill bg-gray-100 text-gray-500">{step.phase.replace('_', ' ')}</span>
                  </div>
                  <div className="overflow-x-auto text-sm"><ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{`$$${step.latex_equation}$$`}</ReactMarkdown></div>
                  <div className="overflow-x-auto pt-1">
                    <table className="mx-auto border-collapse text-center font-mono text-[11px]"><tbody>
                      {step.matrix_snapshot.map((row, r) => (
                        <tr key={r}>{row.map((val, c) => (
                          <td key={c} className={`border border-gray-100 px-2.5 py-1 ${c === row.length - 1 ? 'border-l-2 border-l-blue-400 text-amber-700' : ''} ${step.target_row === r ? 'bg-amber-50' : step.current_row === r ? 'bg-blue-50' : 'text-gray-800'}`}>{fmt(val)}</td>
                        ))}</tr>
                      ))}
                    </tbody></table>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {tab === 'kcl' && educational && (
        <div className="space-y-2">
          <p className="text-sm text-gray-600">Charge can’t pile up at a node, so the currents leaving it add to zero. Each line is one row of G·x = b with the answer plugged in.</p>
          {result.kcl_equations.map((eq) => {
            const ok = Math.abs(eq.evaluated_sum) < 1e-6;
            return (
              <div key={eq.node} className="card flex flex-col justify-between gap-2 p-3 md:flex-row md:items-center">
                <div className="min-w-0">
                  <span className="text-xs font-semibold text-blue-700">Node {eq.node}</span>
                  <div className="overflow-x-auto text-sm"><ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{`$$${eq.latex_equation}$$`}</ReactMarkdown></div>
                </div>
                <span className={`flex shrink-0 items-center gap-1.5 font-mono text-xs ${ok ? 'text-green-700' : 'text-red-700'}`}>
                  {ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />} sum = {eq.evaluated_sum.toExponential(1)} A
                </span>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'spy' && <SpyPlot result={result} onInspect={(r, c) => { onTab('matrix'); toggleInspect({ kind: 'Y', row: r, col: c }); }} />}
      {tab === 'newton' && (result.newton ? <NewtonView result={result} /> : <div className="card p-4 text-sm text-gray-600">This circuit has no diodes or transistors, so it is solved in one step. Newton’s method is only needed for nonlinear parts.</div>)}
    </div>
  );
}

/** Gaussian elimination vs sparse LU, in plain words, with this circuit's own numbers. */
function SolverComparison({ result, solver, onUseGaussian }: { result: CircuitSimulationResult; solver: string; onUseGaussian: () => void }) {
  const n = result.num_equations;
  const nnz = result.spy_plot?.non_zeros ?? 0;
  return (
    <div className="card space-y-3 p-4 text-sm text-gray-700">
      <p className="font-semibold text-gray-900">Two ways to solve G·x = b</p>
      <p>
        Both do the same thing you would do by hand: use one equation to eliminate an unknown from the others, repeat until one
        unknown is left, then substitute back up. They give the same answer. The difference is bookkeeping.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg bg-gray-50 p-3">
          <p className="font-medium text-gray-900">Gaussian elimination (step-by-step)</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            <li>Keeps the whole {n}×{n} grid, all {n * n} entries, zeros included.</li>
            <li>Works directly on [G | b] and records every row operation, so you can follow it below.</li>
            <li>Work grows like n³: fine for 10 unknowns, hopeless for a chip with a million.</li>
          </ul>
        </div>
        <div className="rounded-lg bg-gray-50 p-3">
          <p className="font-medium text-gray-900">Sparse LU (what real simulators use)</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            <li><b>Sparse:</b> stores only the {nnz} non-zero entries of this circuit, not all {n * n}.</li>
            <li><b>LU:</b> saves the elimination as two triangles, G = L·U. Solving is then two quick substitutions, and when only b changes (every time step, every sweep point) it reuses L and U instead of eliminating again.</li>
            <li>Picks the elimination order to create as few new non-zeros (“fill-in”) as possible{result.lu_fill_in != null ? `: ${result.lu_fill_in} here` : ''}.</li>
          </ul>
        </div>
      </div>
      <p className="text-gray-500">faer is a production sparse LU library: the same idea, heavily optimized.</p>
      {result.gaussian_steps.length === 0 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3">
          <span>This run used {solver === 'faer' ? 'faer' : 'sparse LU'}, which doesn’t record steps.</span>
          <button className="btn btn-secondary btn-sm" onClick={onUseGaussian}>Show me the steps (switch to step-by-step)</button>
        </div>
      )}
    </div>
  );
}

/** Small systems: clickable cells. Large systems: one pixel block per non-zero. */
function SpyPlot({ result, onInspect }: { result: CircuitSimulationResult; onInspect: (row: number, col: number) => void }) {
  const { dimension: n, entries, non_zeros, sparsity_percentage } = result.spy_plot;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const useCanvas = n > 24;
  const lookup = useMemo(() => new Map(entries.map((e) => [`${e.row},${e.col}`, e])), [entries]);
  const dynamicEntries = result.spy_plot.dynamic_entries ?? [];
  const dynamicLookup = useMemo(() => new Map(dynamicEntries.map((e) => [`${e.row},${e.col}`, e])), [dynamicEntries]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!useCanvas || !cv) return;
    const px = Math.max(1, Math.floor(480 / n));
    cv.width = cv.height = Math.max(n * px, 1);
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    for (const e of entries) { ctx.fillStyle = e.entry_type === 'conductance' ? '#2563eb' : '#16a34a'; ctx.fillRect(e.col * px, e.row * px, px, px); }
    for (const e of dynamicEntries) { if (lookup.has(`${e.row},${e.col}`)) continue; ctx.fillStyle = '#9333ea'; ctx.fillRect(e.col * px, e.row * px, px, px); }
  }, [entries, n, useCanvas]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-xl text-sm text-gray-600">Each part only touches the few nodes it connects, so most entries are zero. Real chips have millions of nodes, which is why simulators store only the non-zeros.</p>
        <span className="text-xs text-gray-500">{n}×{n} · {non_zeros} non-zeros · <b className="text-green-700">{sparsity_percentage}% zeros</b></span>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-blue-600" />conductance (resistors)</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-green-600" />±1 links (sources, inductors)</span>
        {dynamicEntries.length > 0 && <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-purple-600" />only s-terms (capacitors, inductors)</span>}
      </div>
      <div className="flex justify-center overflow-x-auto">
        {entries.length === 0 && n > 0 ? <p className="text-sm text-gray-500">Too many unknowns ({n}) to draw.</p>
          : useCanvas ? <canvas ref={canvasRef} className="rounded border border-gray-200" style={{ imageRendering: 'pixelated', width: Math.min(480, n * Math.max(1, Math.floor(480 / n))) }} />
          : (
            <div className="grid gap-1 rounded-lg border border-gray-200 bg-gray-50 p-2" style={{ gridTemplateColumns: `repeat(${n}, 28px)` }}>
              {Array.from({ length: n * n }, (_, i) => {
                const r = Math.floor(i / n), c = i % n;
                const e = lookup.get(`${r},${c}`), dyn = dynamicLookup.get(`${r},${c}`);
                return (
                  <button key={i} onClick={() => onInspect(r, c)}
                    className={`h-7 w-7 rounded transition-transform hover:scale-110 ${e ? (e.entry_type === 'conductance' ? 'bg-blue-600' : 'bg-green-600') : dyn ? 'bg-purple-400' : 'bg-white border border-gray-200'}`}
                    title={e ? `${e.description} (click to inspect)` : dyn ? dyn.description : `${result.variable_names[r]}, ${result.variable_names[c]}: 0`} />
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
}
