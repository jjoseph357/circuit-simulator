import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CircuitSimulationResult } from './types';
import { formatEng, formatQuantity, parseEngValue, sortNodes } from './netlist';
import { Plot, PlotSeries, SERIES_COLORS } from './Plot';
import { Segmented, useGlow } from './ui';
import { Play, Pause, AlertTriangle, ChevronRight, ChevronDown } from 'lucide-react';

type Mode = 'tran' | 'ac' | 'dc';

interface AnalysisViewProps {
  result: CircuitSimulationResult | null;
  hasRun: boolean;
  /** Current SPICE control cards (.tran / .ac / .dc / .options / .model). */
  directives: string[];
  onApplyDirectives: (lines: string[]) => void;
  /** Index into result.transient.time shown on the schematic (null = DC operating point). */
  timeIndex: number | null;
  onTimeIndexChange: (i: number | null) => void;
  nodeColors: Map<string, string>;
}

const MAX_SERIES = 4;
const MODE_HELP: Record<Mode, string> = {
  tran: 'Simulates the circuit moment by moment. Give a source a step, square or sine signal (click it, “More options”) to see capacitors charge and inductors resist change.',
  ac: 'Wiggles the input at every frequency and measures how big each node’s wiggle is. Mark one source as the AC input (click it, “More options”).',
  dc: 'Re-solves the circuit for each value of one source. This is how you draw a diode’s I-V curve or a logic gate’s transfer curve.',
};

const parseTran = (d: string[]) => {
  const t = d.find((x) => /^\.tran\b/i.test(x))?.split(/\s+/) ?? [];
  return { tstep: t[1] ?? '10u', tstop: t[2] ?? '5m', method: d.some((x) => /method\s*=?\s*(euler|be|gear)/i.test(x)) ? 'euler' : 'trap' };
};
const parseDc = (d: string[]) => {
  const t = d.find((x) => /^\.dc\b/i.test(x))?.split(/\s+/) ?? [];
  return { source: t[1] ?? '', start: t[2] ?? '0', stop: t[3] ?? '5', step: t[4] ?? '0.05' };
};
const parseAc = (d: string[]) => {
  const t = d.find((x) => /^\.ac\b/i.test(x))?.split(/\s+/) ?? [];
  return { points: t[2] ?? '20', fstart: t[3] ?? '1', fstop: t[4] ?? '1meg' };
};

/** Current traces keep their palette slot while selected, so toggling one never repaints another. */
function useSlotRegistry(keys: string[]) {
  const reg = useRef(new Map<string, number>());
  for (const k of [...reg.current.keys()]) if (!keys.includes(k)) reg.current.delete(k);
  for (const k of keys) {
    if (reg.current.has(k)) continue;
    const used = new Set(reg.current.values());
    reg.current.set(k, [...Array(SERIES_COLORS.length).keys()].reverse().find((i) => !used.has(i)) ?? 0);
  }
  return (k: string) => SERIES_COLORS[reg.current.get(k) ?? 0];
}

export function AnalysisView({ result, hasRun, directives, onApplyDirectives, timeIndex, onTimeIndexChange, nodeColors }: AnalysisViewProps) {
  const tr = hasRun ? result?.transient ?? null : null;
  const ac = hasRun ? result?.ac ?? null : null;
  const dc = hasRun ? result?.dc_sweep ?? null : null;
  const [mode, setMode] = useState<Mode>(() =>
    directives.some((d) => /^\.ac\b/i.test(d)) ? 'ac' : directives.some((d) => /^\.dc\b/i.test(d)) ? 'dc' : 'tran');
  const [tranForm, setTranForm] = useState(() => parseTran(directives));
  const [acForm, setAcForm] = useState(() => parseAc(directives));
  const [dcForm, setDcForm] = useState(() => parseDc(directives));
  const [formError, setFormError] = useState<string | null>(null);
  const [showSolver, setShowSolver] = useState(false);
  const playGlow = useGlow('graphs:play');

  useEffect(() => {
    setTranForm(parseTran(directives)); setAcForm(parseAc(directives)); setDcForm(parseDc(directives));
    // Follow the circuit: a newly loaded .ac or .dc picks its tab.
    if (directives.some((d) => /^\.ac\b/i.test(d)) && !directives.some((d) => /^\.tran\b/i.test(d))) setMode('ac');
    else if (directives.some((d) => /^\.dc\b/i.test(d)) && !directives.some((d) => /^\.tran\b/i.test(d))) setMode('dc');
    else if (directives.some((d) => /^\.tran\b/i.test(d))) setMode('tran');
  }, [directives.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps

  const sources = useMemo(() => Object.keys(result?.branch_currents ?? {}).filter((n) => /^[VI]/i.test(n)).sort(), [result]);
  const nodes = useMemo(() => sortNodes(Object.keys(result?.node_voltages ?? {})), [result]);
  const elements = useMemo(() => Object.keys((mode === 'dc' ? dc?.branch_currents : tr?.branch_currents) ?? {}).sort(), [tr, dc, mode]);

  const [selNodes, setSelNodes] = useState<string[]>([]);
  const [selCurrents, setSelCurrents] = useState<string[]>([]);
  useEffect(() => {
    setSelNodes((prev) => { const keep = prev.filter((n) => nodes.includes(n)); return keep.length ? keep : nodes.slice(-2); });
    setSelCurrents((prev) => prev.filter((n) => elements.includes(n)));
  }, [nodes, elements]);
  const currentColor = useSlotRegistry(selCurrents);
  const vColor = (n: string) => nodeColors.get(n) ?? SERIES_COLORS[0];

  const toggle = (list: string[], set: (v: string[]) => void, key: string) => {
    if (list.includes(key)) set(list.filter((k) => k !== key));
    else if (selNodes.length + selCurrents.length < MAX_SERIES) set([...list, key]);
  };

  // ---- Playback sweeps simulated time at a steady pace
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing || !tr) return;
    const t0 = tr.time[0], t1 = tr.time[tr.time.length - 1];
    const startIdx = timeIndex !== null && timeIndex < tr.time.length - 1 ? timeIndex : 0;
    const duration = 6000;
    const began = performance.now() - ((tr.time[startIdx] - t0) / (t1 - t0 || 1)) * duration;
    let raf = 0;
    const tick = (now: number) => {
      const frac = Math.min(1, (now - began) / duration);
      const target = t0 + frac * (t1 - t0);
      let lo = 0, hi = tr.time.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tr.time[mid] < target) lo = mid + 1; else hi = mid; }
      onTimeIndexChange(lo);
      if (frac < 1) raf = requestAnimationFrame(tick); else setPlaying(false);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, tr]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyTran = () => {
    const tstep = parseEngValue(tranForm.tstep), tstop = parseEngValue(tranForm.tstop);
    if (!tstep || !tstop || tstep <= 0 || tstop <= tstep) { setFormError('The end time must be bigger than the step, e.g. step 10u, end 5m.'); return; }
    setFormError(null);
    onTimeIndexChange(null);
    const others = directives.filter((d) => !/^\.(tran|options?)\b/i.test(d));
    onApplyDirectives([...others, `.tran ${tranForm.tstep} ${tranForm.tstop}`, ...(tranForm.method === 'euler' ? ['.options method=euler'] : [])]);
  };
  const applyAc = () => {
    const f0 = parseEngValue(acForm.fstart), f1 = parseEngValue(acForm.fstop), n = parseEngValue(acForm.points);
    if (!f0 || !f1 || !n || f0 <= 0 || f1 <= f0) { setFormError('Frequencies need 0 < start < end, e.g. 1 to 1meg.'); return; }
    setFormError(null);
    onApplyDirectives([...directives.filter((d) => !/^\.ac\b/i.test(d)), `.ac dec ${acForm.points} ${acForm.fstart} ${acForm.fstop}`]);
  };
  const applyDc = () => {
    const src = dcForm.source || sources[0];
    const a = parseEngValue(dcForm.start), b = parseEngValue(dcForm.stop), st = parseEngValue(dcForm.step);
    if (!src) { setFormError('The circuit needs a voltage or current source to sweep.'); return; }
    if (a === null || b === null || !st || (b - a) / st < 0 || (b - a) / st > 10000) { setFormError('Pick a start, end and step that goes from start to end in at most 10 000 points.'); return; }
    setFormError(null);
    onApplyDirectives([...directives.filter((d) => !/^\.dc\b/i.test(d)), `.dc ${src} ${dcForm.start} ${dcForm.stop} ${dcForm.step}`]);
  };
  const has = { tran: directives.some((d) => /^\.tran\b/i.test(d)), ac: directives.some((d) => /^\.ac\b/i.test(d)), dc: directives.some((d) => /^\.dc\b/i.test(d)) };
  const removeAnalysis = (m: Mode) => {
    if (m === 'tran') onTimeIndexChange(null);
    onApplyDirectives(directives.filter((d) => !(m === 'tran' ? /^\.(tran|options?)\b/i : m === 'ac' ? /^\.ac\b/i : /^\.dc\b/i).test(d)));
  };

  const hasAcSource = result?.diagnostics?.every((d) => d.code !== 'WARN_NO_AC_SOURCE') ?? true;
  const field = (label: string, value: string, set: (v: string) => void, unit?: string) => (
    <label className="flex items-center gap-1.5 text-sm text-gray-600">
      {label}<input className="input w-20 font-mono" value={value} onChange={(e) => set(e.target.value)} />{unit && <span className="text-gray-400">{unit}</span>}
    </label>
  );

  const vSeries: PlotSeries[] = tr ? selNodes.filter((n) => tr.node_voltages[n]).map((n) => ({ key: `v:${n}`, label: `V(${n})`, color: vColor(n), x: tr.time, y: tr.node_voltages[n] })) : [];
  const iSeries: PlotSeries[] = tr ? selCurrents.filter((n) => tr.branch_currents[n]).map((n) => ({ key: `i:${n}`, label: `I(${n})`, color: currentColor(n), x: tr.time, y: tr.branch_currents[n] })) : [];
  const bodeNodes = ac ? selNodes.filter((n) => ac.node_magnitude[n]) : [];
  const magSeries: PlotSeries[] = ac ? bodeNodes.map((n) => ({ key: `v:${n}`, label: `V(${n})`, color: vColor(n), x: ac.frequencies, y: ac.node_magnitude[n].map((m) => 20 * Math.log10(Math.max(m, 1e-300))) })) : [];
  const phaseSeries: PlotSeries[] = ac ? bodeNodes.map((n) => ({ key: `v:${n}`, label: `V(${n})`, color: vColor(n), x: ac.frequencies, y: ac.node_phase_deg[n] })) : [];

  const cutoff = useMemo(() => {
    const s = magSeries[magSeries.length - 1];
    if (!s || s.y.length < 2) return null;
    const ref = s.y[0];
    const k = s.y.findIndex((v) => v < ref - 3);
    if (k <= 0) return null;
    const u = (ref - 3 - s.y[k - 1]) / (s.y[k] - s.y[k - 1]);
    const f = Math.pow(10, Math.log10(s.x[k - 1]) + u * (Math.log10(s.x[k]) - Math.log10(s.x[k - 1])));
    return { x: f, y: ref - 3, label: `−3 dB at ${formatQuantity(f, 'Hz', 3)}` };
  }, [ac, selNodes]); // eslint-disable-line react-hooks/exhaustive-deps

  const tNow = tr && timeIndex !== null ? tr.time[Math.min(timeIndex, tr.time.length - 1)] : null;
  const chips = (list: string[], all: string[], set: (v: string[]) => void, prefix: 'v' | 'i') => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-gray-500">{prefix === 'v' ? 'Voltages' : 'Currents'}</span>
      {all.map((k) => {
        const on = list.includes(k);
        const color = prefix === 'v' ? vColor(k) : currentColor(k);
        return (
          <button key={k} onClick={() => toggle(list, set, k)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-xs ${on ? 'border-gray-400 bg-white text-gray-900' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}
            title={on ? 'Hide' : selNodes.length + selCurrents.length >= MAX_SERIES ? `At most ${MAX_SERIES} traces at once` : 'Show'}>
            <span className="h-2 w-2 rounded-full" style={{ background: on ? color : '#d1d5db' }} />
            {prefix === 'v' ? `V(${k})` : `I(${k})`}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-3 p-4">
      <div className="card space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented value={mode} onChange={(m) => { setMode(m); setFormError(null); }} options={[
            { value: 'tran', label: 'Over time' },
            { value: 'ac', label: 'Over frequency' },
            { value: 'dc', label: 'Sweep a source' },
          ]} />
          <div className="flex flex-wrap items-center gap-3">
            {mode === 'tran' && <>{field('End time', tranForm.tstop, (v) => setTranForm({ ...tranForm, tstop: v }), 's')}{field('Step', tranForm.tstep, (v) => setTranForm({ ...tranForm, tstep: v }), 's')}</>}
            {mode === 'ac' && <>{field('From', acForm.fstart, (v) => setAcForm({ ...acForm, fstart: v }), 'Hz')}{field('to', acForm.fstop, (v) => setAcForm({ ...acForm, fstop: v }), 'Hz')}</>}
            {mode === 'dc' && (
              <>
                <label className="flex items-center gap-1.5 text-sm text-gray-600">Source
                  <select className="input" value={dcForm.source || sources[0] || ''} onChange={(e) => setDcForm({ ...dcForm, source: e.target.value })}>
                    {sources.map((n) => <option key={n}>{n}</option>)}
                  </select>
                </label>
                {field('from', dcForm.start, (v) => setDcForm({ ...dcForm, start: v }))}
                {field('to', dcForm.stop, (v) => setDcForm({ ...dcForm, stop: v }))}
                {field('step', dcForm.step, (v) => setDcForm({ ...dcForm, step: v }))}
              </>
            )}
            <button className="btn btn-primary btn-sm" onClick={mode === 'tran' ? applyTran : mode === 'ac' ? applyAc : applyDc}>
              {has[mode] ? 'Update and run' : 'Add and run'}
            </button>
            {has[mode] && <button className="text-xs text-gray-400 hover:text-red-600" onClick={() => removeAnalysis(mode)}>Remove</button>}
          </div>
        </div>
        <p className="text-xs text-gray-500">{MODE_HELP[mode]} {!has[mode] && <>This adds a <span className="font-mono">.{mode}</span> line to the netlist.</>}</p>
        {formError && <p className="text-sm text-red-700">{formError}</p>}
        {hasRun && result?.analysis_errors?.map((e, i) => <p key={i} className="flex gap-1.5 text-sm text-red-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{e}</p>)}
        {mode === 'ac' && ac && !hasAcSource && (
          <p className="flex gap-1.5 text-sm text-amber-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />No source is marked as the AC input, so every response is zero.</p>
        )}
      </div>

      {mode === 'tran' && tr && (
        <>
          <div className="card flex flex-wrap items-center gap-3 p-3">
            <button onClick={() => setPlaying(!playing)} className={`btn btn-primary btn-sm${playGlow}`} title="Play the circuit over time on the schematic">
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}{playing ? 'Pause' : 'Play'}
            </button>
            <input type="range" min={0} max={tr.time.length - 1} value={timeIndex ?? tr.time.length - 1}
              onChange={(e) => { setPlaying(false); onTimeIndexChange(parseInt(e.target.value)); }}
              className="min-w-40 flex-1 accent-amber-500" />
            <span className="w-36 text-right font-mono text-sm tabular-nums text-gray-800">{tNow !== null ? `t = ${formatQuantity(tNow, 's', 4)}` : 'showing DC values'}</span>
            {timeIndex !== null && <button className="btn btn-ghost btn-sm" onClick={() => { setPlaying(false); onTimeIndexChange(null); }}>Back to DC</button>}
          </div>
          {chips(selNodes, nodes, setSelNodes, 'v')}
          <Plot title="Voltage over time" series={vSeries} xUnit="s" yUnit="V" cursorX={tNow}
            onCursorChange={(t) => { setPlaying(false); onTimeIndexChange(nearest(tr.time, t)); }} markers={tr.breakpoints} markerLabel="source edge" />
          {elements.length > 0 && chips(selCurrents, elements, setSelCurrents, 'i')}
          {iSeries.length > 0 && (
            <Plot title="Current over time" series={iSeries} xUnit="s" yUnit="A" cursorX={tNow}
              onCursorChange={(t) => { setPlaying(false); onTimeIndexChange(nearest(tr.time, t)); }} />
          )}
          <button onClick={() => setShowSolver(!showSolver)} className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-900">
            {showSolver ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} How the solver stepped through time
          </button>
          {showSolver && (
            <div className="space-y-3">
              <div className="card flex flex-wrap items-center gap-4 p-3 text-sm text-gray-700">
                <label className="flex items-center gap-1.5">Method
                  <select className="input" value={tranForm.method} onChange={(e) => setTranForm({ ...tranForm, method: e.target.value })}>
                    <option value="trap">Trapezoidal (2nd order)</option>
                    <option value="euler">Backward Euler (1st order)</option>
                  </select>
                </label>
                <button className="btn btn-secondary btn-sm" onClick={applyTran}>Re-run</button>
                <span>{tr.accepted_steps.toLocaleString()} steps · {tr.rejected_steps.toLocaleString()} retried · {tr.factorizations.toLocaleString()} matrix factorizations</span>
              </div>
              <Plot title="Time step size (log scale)" height={150} yLog cursorX={tNow} markers={tr.breakpoints} markerLabel="source edge" xUnit="s" yUnit="s"
                series={[{ key: 'h', label: 'step', color: SERIES_COLORS[3], x: tr.time.slice(1), y: tr.step_sizes.slice(1) }]} />
              <p className="text-xs text-gray-500">The solver picks its own step: small where the waveform bends quickly, large where it is calm. It always lands exactly on a source edge (the ticks), which is why the step dips there.</p>
            </div>
          )}
        </>
      )}

      {mode === 'ac' && ac && (
        <>
          {chips(selNodes, nodes, setSelNodes, 'v')}
          <Plot title="Gain (dB)" series={magSeries} xUnit="Hz" yUnit="dB" xLog
            formatY={(v) => `${parseFloat(v.toFixed(1))} dB`} formatX={(v) => formatQuantity(v, 'Hz', 3)} annotations={cutoff ? [cutoff] : []} />
          <Plot title="Phase (degrees)" series={phaseSeries} xUnit="Hz" yUnit="°" xLog
            formatY={(v) => `${parseFloat(v.toFixed(1))}°`} formatX={(v) => formatQuantity(v, 'Hz', 3)} />
          {cutoff && <p className="text-xs text-gray-500">The −3 dB point of V({bodeNodes[bodeNodes.length - 1]}) is {formatEng(cutoff.x, 4)}Hz: there the output has half its power.</p>}
        </>
      )}

      {mode === 'dc' && dc && (() => {
        const unit = /^I/i.test(dc.source) ? 'A' : 'V';
        const vs: PlotSeries[] = selNodes.filter((n) => dc.node_voltages[n]).map((n) => ({ key: `v:${n}`, label: `V(${n})`, color: vColor(n), x: dc.values, y: dc.node_voltages[n] }));
        const is: PlotSeries[] = selCurrents.filter((n) => dc.branch_currents[n]).map((n) => ({ key: `i:${n}`, label: `I(${n})`, color: currentColor(n), x: dc.values, y: dc.branch_currents[n] }));
        return (
          <>
            {chips(selNodes, nodes, setSelNodes, 'v')}
            <Plot title={`Voltage as ${dc.source} changes`} series={vs} xUnit={unit} yUnit="V" />
            {chips(selCurrents, elements, setSelCurrents, 'i')}
            {is.length > 0 && <Plot title={`Current as ${dc.source} changes`} series={is} xUnit={unit} yUnit="A" />}
          </>
        );
      })()}

      {((mode === 'tran' && !tr) || (mode === 'ac' && !ac) || (mode === 'dc' && !dc)) && (
        <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
          {!hasRun ? 'Press Run to see graphs.' : has[mode] ? 'Press Run to update the graphs.' : 'Set the range above and press “Add and run”.'}
        </div>
      )}
    </div>
  );
}

function nearest(xs: number[], x: number): number {
  let lo = 0, hi = xs.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid + 1; else hi = mid; }
  return lo > 0 && Math.abs(xs[lo - 1] - x) < Math.abs(xs[lo] - x) ? lo - 1 : lo;
}

export default AnalysisView;
