import React, { useEffect, useMemo, useState } from 'react';
import { CircuitSimulationResult, TuneGoal, TuneResult } from './types';
import { formatEng, formatQuantity, parseEngValue, parseNetlistElements, sortNodes, UNIT } from './netlist';
import { tuneInBrowser } from './wasmEngine';
import { tuneOnServer } from './api';
import { Plot, SERIES_COLORS } from './Plot';
import { Loader2, Plus, Trash2, SlidersHorizontal, CheckCircle2, XCircle, Wand2 } from 'lucide-react';

type GoalKind = TuneGoal['kind'];
interface GoalRow { kind: GoalKind; target: string; node: string; element: string; freq: string }
interface ParamRow { element: string; unit: string; value: number; enabled: boolean; min: string; max: string }

const GOAL_LABEL: Record<GoalKind, string> = {
  node_voltage: 'Node voltage',
  element_current: 'Current through',
  cutoff_hz: '−3 dB cutoff at node',
  gain_db: 'Gain at node',
};

/**
 * The netlist tuner: pick which parts may change and what the circuit should achieve; the engine
 * searches for values (Nelder–Mead on real simulations) and reports how close it got.
 */
export function TunerPanel({ netlist, result, onApply }: {
  netlist: string;
  result: CircuitSimulationResult | null;
  onApply: (netlist: string) => void;
}) {
  const elements = useMemo(() => parseNetlistElements(netlist).filter((e) => !['Diode', 'BJT', 'MOSFET'].includes(e.type) && !e.source), [netlist]);
  const nodes = useMemo(() => sortNodes(Object.keys(result?.node_voltages ?? {})), [result]);
  const allElements = useMemo(() => Object.keys(result?.branch_currents ?? {}).sort(), [result]);

  const [params, setParams] = useState<ParamRow[]>([]);
  useEffect(() => {
    setParams((prev) => elements.map((e) => {
      const old = prev.find((p) => p.element === e.name);
      const positive = e.value > 0;
      return old ?? {
        element: e.name, unit: UNIT[e.type], value: e.value, enabled: false,
        min: positive ? formatEng(e.value / 10) : formatEng(-Math.max(1, Math.abs(e.value) * 2)),
        max: positive ? formatEng(e.value * 10) : formatEng(Math.max(1, Math.abs(e.value) * 2)),
      };
    }));
  }, [elements]);

  const [goals, setGoals] = useState<GoalRow[]>([]);
  useEffect(() => {
    if (goals.length === 0 && nodes.length) setGoals([{ kind: 'node_voltage', target: '1', node: nodes[nodes.length - 1], element: allElements[0] ?? '', freq: '1k' }]);
  }, [nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  const [running, setRunning] = useState(false);
  const [out, setOut] = useState<TuneResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    const parameters = params.filter((p) => p.enabled).map((p) => ({ element: p.element, min: parseEngValue(p.min) ?? NaN, max: parseEngValue(p.max) ?? NaN }));
    if (!parameters.length) { setError('Tick at least one part the tuner may change.'); return; }
    if (parameters.some((p) => !isFinite(p.min) || !isFinite(p.max) || p.min >= p.max)) { setError('Each range needs min < max (engineering notation works: 100, 4.7k, 10n).'); return; }
    const tuneGoals: TuneGoal[] = [];
    for (const g of goals) {
      const target = parseEngValue(g.target);
      if (target === null) { setError(`"${g.target}" is not a number.`); return; }
      if (g.kind === 'node_voltage') tuneGoals.push({ kind: g.kind, node: g.node, target });
      else if (g.kind === 'element_current') tuneGoals.push({ kind: g.kind, element: g.element, target });
      else if (g.kind === 'cutoff_hz') tuneGoals.push({ kind: g.kind, node: g.node, target });
      else tuneGoals.push({ kind: g.kind, node: g.node, freq: parseEngValue(g.freq) ?? 1000, target });
    }
    if (!tuneGoals.length) { setError('Add at least one goal.'); return; }
    setRunning(true);
    try {
      const req = { netlist, parameters, goals: tuneGoals };
      setOut((await tuneInBrowser(req)) ?? (await tuneOnServer(req)));
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const input = 'input py-0.5 font-mono text-xs';
  const history = out?.history ?? [];

  return (
    <div className="space-y-4 text-sm">
      <section className="space-y-1.5">
        <h4 className="font-semibold text-gray-900">1. Which parts may change?</h4>
        {params.length === 0 && <p className="text-gray-500">No resistors, capacitors, inductors or DC sources to tune.</p>}
        {params.map((p, i) => (
          <div key={p.element} className="flex items-center gap-1.5">
            <label className="flex items-center gap-1.5 w-24 text-gray-800">
              <input type="checkbox" checked={p.enabled} onChange={(e) => setParams(params.map((q, k) => (k === i ? { ...q, enabled: e.target.checked } : q)))} className="accent-blue-600" />
              {p.element}
            </label>
            <span className="text-gray-500 w-20 font-mono text-xs">{formatQuantity(p.value, p.unit, 3)}</span>
            <input className={`${input} w-14`} value={p.min} onChange={(e) => setParams(params.map((q, k) => (k === i ? { ...q, min: e.target.value } : q)))} title="Lowest allowed value" />
            <span className="text-gray-400">to</span>
            <input className={`${input} w-14`} value={p.max} onChange={(e) => setParams(params.map((q, k) => (k === i ? { ...q, max: e.target.value } : q)))} title="Highest allowed value" />
          </div>
        ))}
      </section>

      <section className="space-y-1.5">
        <h4 className="font-semibold text-gray-900">2. What should the circuit do?</h4>
        {goals.map((g, i) => {
          const set = (patch: Partial<GoalRow>) => setGoals(goals.map((q, k) => (k === i ? { ...q, ...patch } : q)));
          return (
            <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 p-1.5">
              <select value={g.kind} onChange={(e) => set({ kind: e.target.value as GoalKind })} className={input}>
                {(Object.keys(GOAL_LABEL) as GoalKind[]).map((k) => <option key={k} value={k}>{GOAL_LABEL[k]}</option>)}
              </select>
              {g.kind === 'element_current' ? (
                <select value={g.element} onChange={(e) => set({ element: e.target.value })} className={input}>
                  {allElements.map((n) => <option key={n}>{n}</option>)}
                </select>
              ) : (
                <select value={g.node} onChange={(e) => set({ node: e.target.value })} className={input}>
                  {nodes.map((n) => <option key={n}>{n}</option>)}
                </select>
              )}
              {g.kind === 'gain_db' && <>at <input className={`${input} w-14`} value={g.freq} onChange={(e) => set({ freq: e.target.value })} /> Hz</>}
              = <input className={`${input} w-16`} value={g.target} onChange={(e) => set({ target: e.target.value })} />
              <span className="text-gray-500">{g.kind === 'node_voltage' ? 'V' : g.kind === 'element_current' ? 'A' : g.kind === 'cutoff_hz' ? 'Hz' : 'dB'}</span>
              <button onClick={() => setGoals(goals.filter((_, k) => k !== i))} className="ml-auto icon-btn hover:!text-red-600" title="Remove goal"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          );
        })}
        <button onClick={() => setGoals([...goals, { kind: 'node_voltage', target: '1', node: nodes[0] ?? '', element: allElements[0] ?? '', freq: '1k' }])}
          className="btn btn-ghost btn-sm"><Plus className="w-3.5 h-3.5" /> Add goal</button>
        <p className="text-xs text-gray-500">Frequency goals need a source marked as the AC input.</p>
      </section>

      <button onClick={run} disabled={running}
        className="btn btn-primary w-full">
        {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SlidersHorizontal className="w-3.5 h-3.5" />}
        {running ? 'Searching…' : 'Find values'}
      </button>
      {error && <p className="text-red-700">{error}</p>}

      {out && (
        <div className="card space-y-2 p-3">
          <p className={out.success ? 'text-green-700' : 'text-amber-700'}>{out.message}</p>
          <table className="w-full font-mono text-xs">
            <tbody>
              {out.goals.map((g, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="py-0.5">{g.met ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> : <XCircle className="w-3.5 h-3.5 text-red-600" />}</td>
                  <td className="py-0.5 text-gray-800">{g.label}</td>
                  <td className="py-0.5 text-right text-gray-500">{g.achieved === null ? 'n/a' : parseFloat(g.achieved.toPrecision(5))}</td>
                </tr>
              ))}
              {out.parameters.map((name, i) => (
                <tr key={name} className="border-t border-gray-100">
                  <td />
                  <td className="py-0.5 text-gray-800">{name}</td>
                  <td className="py-0.5 text-right text-gray-700">{formatEng(out.initial_values[i], 4)} → <b className="text-blue-700">{formatEng(out.values[i], 4)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.length > 1 && (
            <Plot title={`Search progress: ${out.evaluations} simulations`} height={140} yLog
              series={[{ key: 'obj', label: 'error', color: SERIES_COLORS[2], x: history.map((h) => h.evaluation), y: history.map((h) => Math.max(h.objective, 1e-16)) }]}
              xUnit="" yUnit="" formatX={(v) => `${Math.round(v)}`} formatY={(v) => v.toExponential(0)} />
          )}
          {out.parameters.length > 0 && (
            <button onClick={() => onApply(out.netlist)}
              className="btn btn-secondary w-full">
              <Wand2 className="w-3.5 h-3.5" /> Apply these values to the circuit
            </button>
          )}
        </div>
      )}
    </div>
  );
}
