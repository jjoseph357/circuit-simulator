import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Table2, LineChart } from 'lucide-react';
import { formatQuantity } from './netlist';

/**
 * Categorical series colours for the white surface, in fixed slot order (each ≥ 3:1 against
 * white). Assign by entity and never cycle past 8.
 */
export const SERIES_COLORS = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#db2777', '#0891b2', '#b45309', '#dc2626'];

export interface PlotSeries {
  key: string;
  label: string;
  color: string;
  x: number[];
  y: number[];
}

interface PlotProps {
  title: string;
  series: PlotSeries[];
  xUnit: string;
  yUnit: string;
  xLog?: boolean;
  yLog?: boolean;
  height?: number;
  /** Vertical cursor (e.g. the animation time) and a handler to move it by clicking/dragging. */
  cursorX?: number | null;
  onCursorChange?: (x: number) => void;
  /** Thin ticks along the x axis (e.g. source breakpoints). */
  markers?: number[];
  markerLabel?: string;
  /** Labelled points, e.g. the −3 dB frequency. */
  annotations?: Array<{ x: number; y: number; label: string }>;
  formatY?: (v: number) => string;
  formatX?: (v: number) => string;
}

const M = { top: 10, right: 12, bottom: 30, left: 58 };

function niceLinearTicks(min: number, max: number, count = 5): number[] {
  if (!isFinite(min) || !isFinite(max)) return [];
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return ticks;
}

function logTicks(min: number, max: number, maxTicks = 5): number[] {
  const lo = Math.floor(Math.log10(min)), hi = Math.ceil(Math.log10(max));
  // Label every decade when there's room, otherwise every 2nd, 3rd … so labels never pile up.
  const stride = Math.max(1, Math.ceil((hi - lo + 1) / maxTicks));
  const ticks = [];
  for (let e = hi - ((hi - lo) % stride === 0 ? 0 : 0); e >= lo; e -= stride) {
    const v = Math.pow(10, e);
    if (v >= min * 0.999 && v <= max * 1.001) ticks.push(v);
  }
  return ticks.reverse();
}

/** Index of the sample nearest to x (xs ascending). */
function nearestIndex(xs: number[], x: number): number {
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid; else hi = mid;
  }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

export function Plot({
  title, series, xUnit, yUnit, xLog, yLog, height = 190, cursorX, onCursorChange, markers, markerLabel, annotations, formatY, formatX,
}: PlotProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const dragging = useRef(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Inner width of the card (its padding is 12px each side); the SVG uses exactly this.
    const ro = new ResizeObserver(() => setWidth(Math.max(260, el.clientWidth - 24)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fx = formatX ?? ((v: number) => formatQuantity(v, xUnit, 3));
  const fy = formatY ?? ((v: number) => formatQuantity(v, yUnit, 4));

  const { xMin, xMax, yMin, yMax } = useMemo(() => {
    const xs = series.flatMap((s) => [s.x[0], s.x[s.x.length - 1]]).filter((v) => v !== undefined && (!xLog || v > 0));
    const ys = series.flatMap((s) => s.y).filter((v) => isFinite(v) && (!yLog || v > 0));
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (!yLog) {
      const pad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.1 || 1;
      y0 -= pad; y1 += pad;
    }
    return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: y0, yMax: y1 };
  }, [series, xLog, yLog]);

  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  const sx = (x: number) => M.left + (xLog ? (Math.log10(x) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin) || 1) : (x - xMin) / (xMax - xMin || 1)) * plotW;
  const sy = (y: number) => M.top + (1 - (yLog ? (Math.log10(y) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin) || 1) : (y - yMin) / (yMax - yMin || 1))) * plotH;
  const invX = (px: number) => {
    const u = Math.min(1, Math.max(0, (px - M.left) / plotW));
    return xLog ? Math.pow(10, Math.log10(xMin) + u * (Math.log10(xMax) - Math.log10(xMin))) : xMin + u * (xMax - xMin);
  };

  // Thin very long series to ~2 points per pixel column (keeps min/max so spikes survive).
  const paths = useMemo(() => series.map((s) => {
    const n = s.x.length;
    const bucket = Math.max(1, Math.floor(n / (plotW * 2)));
    let d = '';
    for (let i = 0; i < n; i += bucket) {
      let lo = i, hi = i;
      for (let j = i; j < Math.min(n, i + bucket); j++) {
        if (s.y[j] < s.y[lo]) lo = j;
        if (s.y[j] > s.y[hi]) hi = j;
      }
      for (const k of lo <= hi ? [lo, hi] : [hi, lo]) {
        if (!isFinite(s.y[k]) || (xLog && s.x[k] <= 0) || (yLog && s.y[k] <= 0)) continue;
        d += `${d ? 'L' : 'M'}${sx(s.x[k]).toFixed(1)},${sy(s.y[k]).toFixed(1)}`;
      }
    }
    return d;
  }), [series, plotW, xMin, xMax, yMin, yMax]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!series.length || !isFinite(xMin) || !isFinite(yMin)) {
    // Keep the measured wrapper mounted so the width is right once data arrives.
    return <div ref={wrapRef} className="card p-3 text-xs text-gray-500">{title}: nothing to plot yet.</div>;
  }

  const xTicks = xLog ? logTicks(xMin, xMax) : niceLinearTicks(xMin, xMax, Math.max(3, Math.floor(plotW / 110)));
  const yTicks = yLog ? logTicks(yMin, yMax) : niceLinearTicks(yMin, yMax, 4);

  // Direct end-labels for 2–4 series (one series is named by the title), nudged apart so they never overlap.
  const endLabels = series.length >= 2 && series.length <= 4 ? series.map((s) => ({ s, y: sy(s.y[s.y.length - 1]) })).sort((a, b) => a.y - b.y) : [];
  for (let i = 1; i < endLabels.length; i++) endLabels[i].y = Math.max(endLabels[i].y, endLabels[i - 1].y + 12);

  const hoverRows = hoverX === null ? [] : series.map((s) => { const i = nearestIndex(s.x, hoverX); return { s, x: s.x[i], y: s.y[i] }; });
  const setFromEvent = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return invX(e.clientX - rect.left);
  };

  return (
    <div className="card p-3" ref={wrapRef}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h5 className="text-xs font-semibold text-gray-800">{title}</h5>
        <div className="flex flex-wrap items-center gap-3">
          {series.length >= 2 && series.map((s) => (
            <span key={s.key} className="flex items-center gap-1 text-[11px] text-gray-600">
              <span className="w-3 h-[2px] rounded" style={{ background: s.color }} />{s.label}
            </span>
          ))}
          <button onClick={() => setShowTable(!showTable)} className="icon-btn" title={showTable ? 'Show chart' : 'Show values as a table'}>
            {showTable ? <LineChart className="w-3.5 h-3.5" /> : <Table2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {showTable ? (
        <div className="overflow-auto max-h-56">
          <table className="text-[11px] font-mono w-full text-right">
            <thead className="text-gray-500 sticky top-0 bg-white">
              <tr><th className="px-2 py-1 text-left">{xUnit === 's' ? 'time' : xUnit === 'Hz' ? 'frequency' : 'x'}</th>{series.map((s) => <th key={s.key} className="px-2 py-1">{s.label}</th>)}</tr>
            </thead>
            <tbody className="text-gray-800">
              {Array.from({ length: Math.min(40, series[0].x.length) }, (_, r) => {
                const i = Math.round((r / Math.max(1, Math.min(40, series[0].x.length) - 1)) * (series[0].x.length - 1));
                return (
                  <tr key={r} className="border-t border-gray-100">
                    <td className="px-2 py-0.5 text-left">{fx(series[0].x[i])}</td>
                    {series.map((s) => <td key={s.key} className="px-2 py-0.5">{fy(s.y[Math.min(i, s.y.length - 1)])}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg
            width={width} height={height} className="block select-none"
            style={{ cursor: onCursorChange ? 'ew-resize' : 'crosshair' }}
            onMouseMove={(e) => { const x = setFromEvent(e); setHoverX(x); if (dragging.current) onCursorChange?.(x); }}
            onMouseLeave={() => { setHoverX(null); dragging.current = false; }}
            onMouseDown={(e) => { if (onCursorChange) { dragging.current = true; onCursorChange(setFromEvent(e)); } }}
            onMouseUp={() => { dragging.current = false; }}
          >
            {/* Grid + axes */}
            {yTicks.map((t) => (
              <g key={`y${t}`}>
                <line x1={M.left} x2={M.left + plotW} y1={sy(t)} y2={sy(t)} stroke="#eef0f3" strokeWidth={1} />
                <text x={M.left - 6} y={sy(t) + 3} textAnchor="end" fontSize={10} fill="#6b7280">{fy(t)}</text>
              </g>
            ))}
            {xTicks.map((t) => (
              <g key={`x${t}`}>
                <line x1={sx(t)} x2={sx(t)} y1={M.top} y2={M.top + plotH} stroke="#eef0f3" strokeWidth={1} />
                {/* Edge ticks anchor inward so their labels are never clipped */}
                <text x={sx(t)} y={height - 10} fontSize={10} fill="#6b7280"
                  textAnchor={sx(t) > M.left + plotW - 30 ? 'end' : sx(t) < M.left + 30 ? 'start' : 'middle'}>{fx(t)}</text>
              </g>
            ))}
            <line x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} stroke="#9ca3af" />

            {(markers ?? []).filter((m) => m >= xMin && m <= xMax).map((m, i) => (
              <line key={`m${i}`} x1={sx(m)} x2={sx(m)} y1={M.top + plotH - 6} y2={M.top + plotH} stroke="#9ca3af" strokeWidth={1.5}>
                <title>{markerLabel ?? 'marker'} at {fx(m)}</title>
              </line>
            ))}

            {paths.map((d, i) => (
              <path key={series[i].key} d={d} fill="none" stroke={series[i].color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}

            {(annotations ?? []).map((a, i) => (
              <g key={`a${i}`}>
                <circle cx={sx(a.x)} cy={sy(a.y)} r={4} fill="#111827" stroke="#ffffff" strokeWidth={2} />
                <text x={sx(a.x) + 7} y={sy(a.y) - 7} fontSize={11} fontWeight={600} fill="#111827">{a.label}</text>
              </g>
            ))}

            {cursorX !== null && cursorX !== undefined && cursorX >= xMin && cursorX <= xMax && (
              <line x1={sx(cursorX)} x2={sx(cursorX)} y1={M.top} y2={M.top + plotH} stroke="#f59e0b" strokeWidth={2} />
            )}

            {endLabels.map(({ s, y }) => (
              <text key={`e${s.key}`} x={M.left + plotW - 4} y={Math.min(M.top + plotH - 2, Math.max(M.top + 9, y - 4))} textAnchor="end" fontSize={10} fill="#374151">
                {s.label}
              </text>
            ))}

            {hoverX !== null && (
              <g pointerEvents="none">
                <line x1={sx(hoverX)} x2={sx(hoverX)} y1={M.top} y2={M.top + plotH} stroke="#9ca3af" strokeWidth={1} />
                {hoverRows.map(({ s, x, y }) => isFinite(y) && (
                  <circle key={`h${s.key}`} cx={sx(x)} cy={sy(y)} r={4} fill={s.color} stroke="#ffffff" strokeWidth={2} />
                ))}
              </g>
            )}
          </svg>
          {hoverX !== null && hoverRows.length > 0 && (
            <div className="absolute top-1 pointer-events-none bg-white border border-gray-200 rounded-md px-2 py-1 text-[11px] font-mono shadow-lg"
              style={{ left: Math.min(sx(hoverX) + 10, width - 190) }}>
              <div className="text-gray-500">{fx(hoverRows[0].x)}</div>
              {hoverRows.map(({ s, y }) => (
                <div key={s.key} className="flex items-center gap-1.5 text-gray-900">
                  <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />{s.label}: {fy(y)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
