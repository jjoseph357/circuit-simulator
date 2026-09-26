import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CircuitSimulationResult, StampingStep } from './types';
import type { MathTab } from './lessons';
import { NewtonView } from './NewtonView';
import { EmptyState, useGlow, GuideTarget, GuideContext } from './ui';
import { Play, Pause, SkipBack, SkipForward, RotateCcw, CheckCircle2, AlertCircle, X, Calculator } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

type CellRef = { kind: 'G' | 'C'; row: number; col: number } | { kind: 'b'; row: number };

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
  if (src) return as === 'row' ? `${src[1]}'s own rule (e.g. its voltage equals its set value)` : `unknown: the current through ${src[1]}`;
  return name;
}

/** Plain-English narration of one stamping step. */
function narrateStamp(step: StampingStep, vars: string[]): string {
  const letter = step.component_name[0]?.toUpperCase();
  const nodeOf = (row: number) => vars[row]?.match(/^V\((.+)\)$/)?.[1];
  const diagRows = step.affected_cells_g.filter((c) => c.row === c.col).map((c) => nodeOf(c.row)).filter(Boolean);
  if (letter === 'R') {
    const g = step.affected_cells_g[0]?.delta ?? 0;
    const grounded = diagRows.length === 1;
    return `${step.component_name} adds its conductance 1/R = ${fmt(g)} S to the diagonal of ${grounded ? `node ${diagRows[0]}` : `nodes ${diagRows.join(' and ')}`}` +
      (grounded ? '. Its other end is ground, which has no row.' : ', and subtracts it from the two entries that link them.');
  }
  if (letter === 'I') {
    return `${step.component_name} is a known current, so it only goes into b: ` +
      step.affected_cells_b.map((c) => `${c.delta > 0 ? '+' : '−'}${fmt(Math.abs(c.delta))} A at node ${nodeOf(c.row)}`).join(', ') + '.';
  }
  if (step.component_name.startsWith('GMIN_')) return `${step.component_summary}. A tiny leak to ground so a node that only touches capacitors still has a DC voltage (SPICE does the same).`;
  if (letter === 'C') return `${step.component_name}'s current depends on how fast its voltage changes (C·dV/dt), so it goes into the second matrix C, not G. In steady DC it carries no current.`;
  if (letter === 'L') return `${step.component_name}'s current becomes a new unknown with its own row and column (±1 in G), and −L goes into C. In steady DC an inductor is a plain wire.`;
  if (letter === 'V') return `${step.component_name} fixes a voltage but its current is unknown, so MNA adds that current as a new column and a new row stating the voltage rule. The ±1 entries link the source to its two nodes.`;
  return step.explanation;
}

const TABS: Array<{ id: MathTab; label: string; glow?: GuideTarget }> = [
  { id: 'matrix', label: 'Build the matrix' },
  { id: 'gaussian', label: 'Solve it' },
  { id: 'kcl', label: 'Check KCL', glow: 'math:kcl' },
  { id: 'spy', label: 'Sparsity' },
  { id: 'newton', label: 'Newton’s method', glow: 'math:newton' },
];

export function MathView({ result, hasRun, tab, onTab, selectedName, onInspect }: {
  result: CircuitSimulationResult | null;
  hasRun: boolean;
  tab: MathTab;
  onTab: (t: MathTab) => void;
  selectedName: string | null;
  onInspect: (names: string[]) => void;
}) {
  const [stampStep, setStampStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [inspected, setInspected] = useState<CellRef | null>(null);
  const playGlow = useGlow('math:play');
  const target = React.useContext(GuideContext);

  const steps = result?.stamping_timeline ?? [];
  const nSteps = steps.length;
  const educational = result?.educational_views !== false && (result?.matrix_g?.length ?? 0) > 0;

  useEffect(() => {
    if (!playing || nSteps === 0) return;
    const id = setInterval(() => setStampStep((p) => { if (p >= nSteps) { setPlaying(false); return nSteps; } return p + 1; }), 1300);
    return () => clearInterval(id);
  }, [playing, nSteps]);

  useEffect(() => { setStampStep(result?.stamping_timeline?.length ?? 0); setInspected(null); }, [result]);

  const contributions = useMemo(() => {
    if (!inspected || !result) return [];
    return steps.flatMap((s) => {
      const cells = inspected.kind === 'G' ? s.affected_cells_g.filter((c) => c.row === inspected.row && c.col === inspected.col)
        : inspected.kind === 'C' ? (s.affected_cells_c ?? []).filter((c) => c.row === inspected.row && c.col === inspected.col)
        : s.affected_cells_b.filter((c) => c.row === inspected.row);
      return cells.map((c) => ({ name: s.component_name, delta: c.delta }));
    });
  }, [inspected, steps, result]);

  const reportRef = useRef(onInspect);
  reportRef.current = onInspect;
  useEffect(() => { reportRef.current([...new Set(contributions.map((c) => c.name))]); }, [contributions]);
  useEffect(() => () => reportRef.current([]), []);

  const selectedCells = useMemo(() => {
    const s = steps.find((x) => x.component_name === selectedName);
    return { g: new Set(s?.affected_cells_g.map((c) => `${c.row},${c.col}`) ?? []), b: new Set(s?.affected_cells_b.map((c) => c.row) ?? []) };
  }, [steps, selectedName]);

  if (!hasRun || !result) {
    return <EmptyState icon={<Calculator className="h-8 w-8" />} title="Run the circuit first">Then this tab shows how the simulator turns your circuit into the matrix equation G·x = b and solves it.</EmptyState>;
  }
  if (!result.success) return <EmptyState title="Nothing to show">The circuit could not be solved. The guide on the left explains why.</EmptyState>;

  const vars = result.variable_names;
  const active = stampStep > 0 && stampStep <= nSteps ? steps[stampStep - 1] : null;
  const G = active ? active.matrix_g_snapshot : result.matrix_g;
  const B = active ? active.vector_b_snapshot : result.vector_b;
  const hasC = (result.matrix_c?.length ?? 0) > 0;
  const Cm = active?.matrix_c_snapshot?.length ? active.matrix_c_snapshot : result.matrix_c ?? [];
  const toggleInspect = (cell: CellRef) => setInspected((p) => (p && JSON.stringify(p) === JSON.stringify(cell) ? null : cell));
  const tabs = TABS.filter((t) => t.id !== 'newton' || result.newton);
  const cellClass = (isInspected: boolean, isDelta: boolean, isSel: boolean, nonzero: boolean) =>
    isInspected ? 'bg-amber-100 text-amber-900 font-bold ring-2 ring-amber-400 ring-inset'
      : isDelta ? 'bg-green-100 text-green-900 font-bold'
      : isSel ? 'bg-blue-50 text-blue-900 ring-1 ring-blue-300 ring-inset'
      : nonzero ? 'text-gray-900 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-50';

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

      {tab === 'matrix' && educational && (
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
          </div>
          <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
            {active ? <><b>{active.component_summary}.</b> {narrateStamp(active, vars)}</> : 'Every entry starts at zero. Press Play to add the parts one at a time.'}
          </div>

          <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
            <div className="card overflow-x-auto p-3">
              <p className="mb-2 font-mono text-xs font-semibold text-gray-700">G · x = b <span className="font-sans font-normal text-gray-400"> · click any number to see where it came from</span></p>
              <table className="border-collapse text-center font-mono text-xs">
                <thead>
                  <tr><th />{vars.map((v, i) => <th key={i} className="border-b border-gray-200 p-1.5 text-[11px] font-medium text-blue-700" title={describeVariable(v, 'col')}>{v}</th>)}</tr>
                </thead>
                <tbody>
                  {G.map((row, r) => (
                    <tr key={r}>
                      <td className="border-r border-gray-200 p-1.5 pr-2 text-right text-[11px] text-blue-700" title={describeVariable(vars[r], 'row')}>{vars[r]}</td>
                      {row.map((val, c) => (
                        <td key={c} onClick={() => toggleInspect({ kind: 'G', row: r, col: c })}
                          className={`min-w-14 cursor-pointer border border-gray-100 px-2.5 py-1.5 ${cellClass(inspected?.kind === 'G' && inspected.row === r && inspected.col === c, !!active?.affected_cells_g.some((x) => x.row === r && x.col === c), selectedCells.g.has(`${r},${c}`), Math.abs(val) > 1e-15)}`}>
                          {fmt(val)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card flex gap-4 p-3">
              <div>
                <p className="mb-2 font-mono text-xs font-semibold text-gray-700">b</p>
                <table className="border-collapse text-center font-mono text-xs"><tbody>
                  {B.map((val, r) => (
                    <tr key={r}><td onClick={() => toggleInspect({ kind: 'b', row: r })}
                      className={`min-w-14 cursor-pointer border border-gray-100 px-2.5 py-1.5 ${cellClass(inspected?.kind === 'b' && inspected.row === r, !!active?.affected_cells_b.some((x) => x.row === r), selectedCells.b.has(r), Math.abs(val) > 1e-15)}`}>{fmt(val)}</td></tr>
                  ))}
                </tbody></table>
              </div>
              <div>
                <p className="mb-2 font-mono text-xs font-semibold text-gray-700">x (answer)</p>
                <table className="border-collapse text-center font-mono text-xs"><tbody>
                  {result.solution_vector.map((v, r) => (
                    <tr key={r}><td className="px-1.5 py-1.5 text-[11px] text-blue-700">{vars[r]}</td><td className="border border-gray-100 px-2.5 py-1.5 text-green-800">{fmt(v)}</td></tr>
                  ))}
                </tbody></table>
              </div>
            </div>
          </div>

          {hasC && (
            <div className="card overflow-x-auto p-3">
              <p className="mb-2 font-mono text-xs font-semibold text-gray-700">C <span className="font-sans font-normal text-gray-400"> · the full system is G·x + C·dx/dt = b</span></p>
              <table className="border-collapse text-center font-mono text-xs">
                <thead><tr><th />{vars.map((v, i) => <th key={i} className="border-b border-gray-200 p-1.5 text-[11px] font-medium text-purple-700">{v}</th>)}</tr></thead>
                <tbody>
                  {Cm.map((row, r) => (
                    <tr key={r}>
                      <td className="border-r border-gray-200 p-1.5 pr-2 text-right text-[11px] text-purple-700">{vars[r]}</td>
                      {row.map((val, c) => (
                        <td key={c} onClick={() => toggleInspect({ kind: 'C', row: r, col: c })}
                          className={`min-w-14 cursor-pointer border border-gray-100 px-2.5 py-1.5 ${cellClass(inspected?.kind === 'C' && inspected.row === r && inspected.col === c, !!active?.affected_cells_c?.some((x) => x.row === r && x.col === c), false, Math.abs(val) > 0)}`}>{fmt(val)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {inspected && (
            <div className="relative rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-gray-800">
              <button onClick={() => setInspected(null)} className="icon-btn absolute right-2 top-2"><X className="h-4 w-4" /></button>
              <p className="font-semibold text-amber-900">{inspected.kind === 'b' ? `b[${vars[inspected.row]}]` : `${inspected.kind}[${vars[inspected.row]}, ${vars[inspected.col]}]`}</p>
              <p className="mt-1"><b>Row:</b> {describeVariable(vars[inspected.row], 'row')}.</p>
              {inspected.kind !== 'b' && <p><b>Column:</b> {describeVariable(vars[inspected.col], 'col')}.</p>}
              {contributions.length === 0 ? (
                <p className="mt-1 text-gray-600">No part touches this entry, so it stays 0. Most of an MNA matrix is zeros like this.</p>
              ) : (
                <p className="mt-1 font-mono">
                  {contributions.map((c, i) => <span key={i}>{i > 0 ? (c.delta < 0 ? ' − ' : ' + ') : c.delta < 0 ? '−' : ''}{fmt(Math.abs(c.delta))} <span className="text-gray-500">({c.name})</span></span>)}
                  <span> = {fmt(contributions.reduce((s, c) => s + c.delta, 0))}</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'gaussian' && educational && (
        <div className="space-y-3">
          {result.gaussian_steps.length === 0 ? (
            <div className="card p-4 text-sm text-gray-600">The step-by-step log comes from the step-by-step solver. Choose it in Settings (the gear, top right) to see every row operation.</div>
          ) : (
            <>
              <p className="text-sm text-gray-600">Gaussian elimination subtracts multiples of rows until [G | b] is a triangle, then solves from the bottom row up. {result.gaussian_steps.length} steps:</p>
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

      {tab === 'spy' && <SpyPlot result={result} onInspect={(r, c) => { onTab('matrix'); toggleInspect({ kind: 'G', row: r, col: c }); }} />}
      {tab === 'newton' && (result.newton ? <NewtonView result={result} /> : <div className="card p-4 text-sm text-gray-600">This circuit has no diodes or transistors, so it is solved in one step. Newton’s method is only needed for nonlinear parts.</div>)}
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
        {dynamicEntries.length > 0 && <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-purple-600" />only in C (capacitors, inductors)</span>}
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
