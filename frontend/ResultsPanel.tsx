import React from 'react';
import type { CircuitSimulationResult, VisualCircuitComponent } from './types';
import { formatQuantity, PART_NAME, sortNodes } from './netlist';
import { EmptyState, NodeTag } from './ui';
import { Play, LineChart } from 'lucide-react';

/** Plain results of the DC operating point (or of one instant of a transient run). */
export function ResultsPanel({ result, hasRun, comps, nodeColors, timeLabel, onOpenGraphs }: {
  result: CircuitSimulationResult | null;
  hasRun: boolean;
  comps: VisualCircuitComponent[];
  nodeColors: Map<string, string>;
  /** "at t = 1.2 ms" when the schematic shows one instant of a transient run. */
  timeLabel: string | null;
  onOpenGraphs: () => void;
}) {
  if (!hasRun || !result) {
    return (
      <EmptyState icon={<Play className="h-8 w-8" />} title="No results yet">
        Press <b>Run</b> at the top. The simulator writes the equations for your circuit, solves them, and shows every voltage and current here.
      </EmptyState>
    );
  }
  if (!result.success) {
    return (
      <EmptyState title="The circuit could not be solved">
        {result.error_message ? <span className="block">{result.error_message}</span> : null}
        <span className="mt-1 block">The guide on the left explains what to fix.</span>
      </EmptyState>
    );
  }

  const nodes = sortNodes(Object.keys(result.node_voltages));
  const vMax = Math.max(1e-12, ...nodes.map((n) => Math.abs(result.node_voltages[n])));
  const typeOf = new Map(comps.map((c) => [c.name.toUpperCase(), c.type]));
  const names = Object.keys(result.branch_currents).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const delivered = names.reduce((s, n) => s + Math.max(0, -(result.branch_powers[n] ?? 0)), 0);
  const used = names.reduce((s, n) => s + Math.max(0, result.branch_powers[n] ?? 0), 0);
  const across = (name: string) => {
    const c = comps.find((x) => x.name.toUpperCase() === name.toUpperCase());
    // "Across" only means something for two-terminal parts.
    return c && c.node3 === undefined ? (result.node_voltages[c.node1] ?? 0) - (result.node_voltages[c.node2] ?? 0) : null;
  };
  const extra = [result.transient && 'over time', result.ac && 'over frequency', result.dc_sweep && 'a source sweep'].filter(Boolean);

  return (
    <div className="space-y-3 p-4">
      {(timeLabel || extra.length > 0) && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600">
          {timeLabel ? <span>Showing the circuit <b>{timeLabel}</b>.</span> : <span>These are the steady (DC) values.</span>}
          {extra.length > 0 && (
            <button className="btn btn-secondary btn-sm" onClick={onOpenGraphs}><LineChart className="h-3.5 w-3.5" /> See {extra.join(' and ')} in Graphs</button>
          )}
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="card p-4">
          <h3 className="text-sm font-semibold text-gray-900">Node voltages</h3>
          <p className="mb-3 text-xs text-gray-500">Measured from ground (0 V). Current flows from high to low through resistors.</p>
          <table className="w-full text-sm">
            <tbody>
              {nodes.map((n) => {
                const v = result.node_voltages[n];
                return (
                  <tr key={n} className="border-t border-gray-100">
                    <td className="w-24 py-1.5"><NodeTag node={n} color={nodeColors.get(n) ?? '#6b7280'} /></td>
                    <td className="py-1.5 pr-3">
                      <div className="h-1.5 rounded-full bg-gray-100">
                        <div className={`h-full rounded-full ${v >= 0 ? 'bg-blue-500' : 'bg-orange-500'}`} style={{ width: `${(Math.abs(v) / vMax) * 100}%` }} />
                      </div>
                    </td>
                    <td className="w-28 py-1.5 text-right font-mono tabular-nums text-gray-900">{formatQuantity(Math.abs(v) < 1e-12 * vMax ? 0 : v, 'V', 4)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="card p-4">
          <h3 className="text-sm font-semibold text-gray-900">Parts</h3>
          <p className="mb-3 text-xs text-gray-500">
            Sources deliver {formatQuantity(delivered, 'W')}; the other parts use {formatQuantity(used, 'W')}. {Math.abs(delivered - used) <= 1e-6 * Math.max(delivered, 1e-12) + 1e-15 ? 'Energy balances, as it must.' : ''}
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400">
                <th className="pb-1 font-medium">Part</th>
                <th className="pb-1 text-right font-medium">Current</th>
                <th className="pb-1 text-right font-medium">Voltage across</th>
                <th className="pb-1 text-right font-medium">Power</th>
              </tr>
            </thead>
            <tbody>
              {names.map((n) => {
                const i = result.branch_currents[n];
                const p = result.branch_powers[n] ?? 0;
                const v = across(n);
                const t = typeOf.get(n.toUpperCase());
                return (
                  <tr key={n} className="border-t border-gray-100">
                    <td className="py-1.5"><span className="font-semibold text-gray-900">{n}</span> <span className="text-xs text-gray-400">{t ? PART_NAME[t] : ''}</span></td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-gray-800">{formatQuantity(Math.abs(i), 'A')}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-gray-800">{v === null ? '–' : formatQuantity(Math.abs(v), 'V')}</td>
                    <td className={`py-1.5 text-right font-mono tabular-nums ${p < -1e-15 ? 'text-blue-700' : 'text-gray-800'}`}>
                      {Math.abs(p) < 1e-15 ? '0 W' : p < 0 ? `+${formatQuantity(-p, 'W')}` : formatQuantity(p, 'W')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-gray-400">Power in blue (+) is delivered by a source.</p>
        </section>
      </div>

      {(result.device_ops?.length ?? 0) > 0 && (
        <section className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">Diodes and transistors</h3>
          <div className="flex flex-wrap gap-2">
            {result.device_ops!.map((op) => (
              <div key={op.name} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
                <span className="font-semibold">{op.name}</span> <span className="text-amber-700">{op.region}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
