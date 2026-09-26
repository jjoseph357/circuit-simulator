import React, { useMemo, useState } from 'react';
import { CircuitSimulationResult, DeviceOp } from './types';
import { formatQuantity } from './netlist';
import { Plot, SERIES_COLORS } from './Plot';
import { Repeat, Info } from 'lucide-react';

const q = (op: DeviceOp | undefined, k: string) => op?.quantities.find(([n]) => n === k)?.[1] ?? NaN;

/** The quantities that describe each device kind's operating point, for the iteration table. */
const KEY_QUANTITIES: Record<string, Array<[string, string]>> = {
  diode: [['Vd', 'V'], ['Id', 'A']],
  npn: [['Vbe', 'V'], ['Ic', 'A']],
  pnp: [['Vbe', 'V'], ['Ic', 'A']],
  nmos: [['Vgs', 'V'], ['Id', 'A']],
  pmos: [['Vgs', 'V'], ['Id', 'A']],
};

/**
 * How the simulator solved a circuit with diodes/transistors: Newton–Raphson replaces each device
 * with its tangent line at the current guess, solves the linear MNA system, and repeats.
 */
export function NewtonView({ result }: { result: CircuitSimulationResult }) {
  const log = result.newton!;
  const iters = log.iterations;
  const diodes = (result.device_ops ?? []).filter((o) => o.kind === 'diode');
  const [diodeName, setDiodeName] = useState(diodes[0]?.name ?? '');
  const [step, setStep] = useState(Math.max(0, iters.length - 1));

  const convergence = useMemo(() => {
    const pts = iters.filter((it) => it.max_dx > 0);
    return [{ key: 'dx', label: 'max |Δx|', color: SERIES_COLORS[0], x: pts.map((it) => it.iteration), y: pts.map((it) => it.max_dx) }];
  }, [iters]);

  // Diode I–V curve reconstructed from the converged operating point: for Id ≫ IS,
  // g ≈ Id / (N·Vt) gives N·Vt, then IS = Id / (e^(Vd/NVt) − 1).
  const tangentPlot = useMemo(() => {
    const final = diodes.find((d) => d.name === diodeName);
    if (!final || iters.length === 0) return null;
    const vd = q(final, 'Vd'), id = q(final, 'Id'), g = q(final, 'g');
    if (!(id > 1e-9) || !(g > 1e-12)) return null;
    const nvt = id / (g - 1e-12);
    const is = id / (Math.exp(vd / nvt) - 1);
    const it = iters[Math.min(step, iters.length - 1)];
    const at = it.devices.find((d) => d.name === diodeName);
    const vk = q(at, 'Vd'), ik = q(at, 'Id'), gk = q(at, 'g');
    const vMax = Math.max(vd, ...iters.map((x) => q(x.devices.find((d) => d.name === diodeName), 'Vd')).filter(isFinite)) + 0.05;
    const vMin = Math.max(0, vMax - 0.5);
    const xs = Array.from({ length: 200 }, (_, k) => vMin + ((vMax - vMin) * k) / 199);
    const curve = xs.map((v) => (is * (Math.exp(v / nvt) - 1)) * 1e3);
    const tx = xs.filter((v) => Math.abs(v - vk) < 0.12);
    const series = [
      { key: 'iv', label: 'diode I–V (Shockley)', color: SERIES_COLORS[0], x: xs, y: curve },
      ...(isFinite(vk) && tx.length > 1 ? [{ key: 'tan', label: `tangent at iteration ${it.iteration}`, color: SERIES_COLORS[1], x: tx, y: tx.map((v) => (ik + gk * (v - vk)) * 1e3) }] : []),
    ];
    return { series, point: isFinite(vk) ? { x: vk, y: ik * 1e3, label: `guess ${it.iteration}` } : null, nvt, is, it };
  }, [diodes, diodeName, iters, step]);

  return (
    <div className="space-y-3">
      <div className="card space-y-1.5 p-4 text-sm text-gray-700">
        <p className="flex items-center gap-2 font-semibold text-gray-900"><Repeat className="h-4 w-4 text-purple-600" />Solving a nonlinear circuit by repeated straight-line guesses</p>
        <p>
          A diode’s current grows exponentially with its voltage, so there is no fixed G. Newton’s method guesses the voltages, replaces each
          device by its <b>tangent line</b> at that guess, solves the ordinary MNA system, and uses the answer as the next guess.
        </p>
        <p className="text-gray-500">
          {log.converged ? `Converged in ${iters.length} iteration${iters.length === 1 ? '' : 's'}` : 'Did not converge'}
          {log.strategy !== 'newton' && ` after using ${log.strategy} to get close (${log.total_iterations} iterations in total)`}.
          {iters.some((i) => i.limited) && ' Rows marked “limited” are steps the simulator held back so they would not overshoot.'}
        </p>
      </div>

      <Plot title="Convergence: largest change per iteration (log scale)" series={convergence} xUnit="" yUnit="V" yLog height={170}
        formatX={(v) => `#${Math.round(v)}`} formatY={(v) => v.toExponential(0)} />

      {tangentPlot && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3 text-sm text-gray-700">
            {diodes.length > 1 && (
              <select value={diodeName} onChange={(e) => setDiodeName(e.target.value)} className="input">
                {diodes.map((d) => <option key={d.name}>{d.name}</option>)}
              </select>
            )}
            <span>Iteration</span>
            <input type="range" min={0} max={iters.length - 1} value={step} onChange={(e) => setStep(parseInt(e.target.value))} className="w-48 accent-purple-600" />
            <span className="font-mono text-purple-700">#{tangentPlot.it.iteration} of {iters.length}</span>
          </div>
          <Plot title={`${diodeName}: the real curve, and the straight line used at this guess`} series={tangentPlot.series}
            xUnit="V" yUnit="mA" height={220} formatY={(v) => `${parseFloat(v.toPrecision(3))} mA`}
            annotations={tangentPlot.point ? [tangentPlot.point] : []} />
          <p className="text-xs text-gray-500 flex gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0" />
            Curve reconstructed from the operating point (N·Vt = {formatQuantity(tangentPlot.nvt, 'V', 3)}, IS = {tangentPlot.is.toExponential(2)} A).
            Step through the iterations: each tangent is a linear model the MNA solver can handle; the next guess is where that linear circuit settles.
          </p>
        </div>
      )}

      <div className="card p-3 overflow-x-auto">
        <table className="text-[11px] font-mono w-full text-right">
          <thead className="text-gray-500">
            <tr>
              <th className="px-2 py-1 text-left">iter</th>
              <th className="px-2 py-1">max |Δx|</th>
              {(iters[0]?.devices ?? []).map((d) => (KEY_QUANTITIES[d.kind] ?? []).map(([k]) => <th key={d.name + k} className="px-2 py-1">{d.name} {k}</th>))}
              <th className="px-2 py-1 text-left">note</th>
            </tr>
          </thead>
          <tbody className="text-gray-800">
            {iters.map((it) => (
              <tr key={it.iteration} className={`border-t border-gray-100 ${it.iteration === tangentPlot?.it.iteration ? 'bg-purple-50' : ''}`}>
                <td className="px-2 py-0.5 text-left">{it.iteration}</td>
                <td className="px-2 py-0.5">{it.max_dx.toExponential(2)}</td>
                {it.devices.map((d) => (KEY_QUANTITIES[d.kind] ?? []).map(([k, u]) => <td key={d.name + k} className="px-2 py-0.5">{formatQuantity(q(d, k), u, 4)}</td>))}
                <td className="px-2 py-0.5 text-left text-amber-700">{it.limited ? 'limited' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {iters.length === 0 && <p className="text-xs text-gray-500">Iteration details are recorded for circuits up to 40 unknowns.</p>}
      </div>
    </div>
  );
}
