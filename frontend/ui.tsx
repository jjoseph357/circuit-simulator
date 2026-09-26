import React, { createContext, useContext } from 'react';

/**
 * Names of UI elements the guide can point at. The current lesson step names one, and that
 * element pulses so the student always knows what to click next.
 */
export type GuideTarget =
  | `part:${string}` | 'run' | 'netlist' | 'netlist:update' | 'canvas' | 'lessons'
  | 'tab:results' | 'tab:graphs' | 'tab:math' | 'tab:tools'
  | 'math:play' | 'math:newton' | 'math:kcl' | 'graphs:play';

export const GuideContext = createContext<GuideTarget | null>(null);

/** ' guide-glow' when the guide is pointing at `id`, else ''. */
export function useGlow(id: GuideTarget): string {
  return useContext(GuideContext) === id ? ' guide-glow' : '';
}

export function Segmented<T extends string>({ value, options, onChange, size = 'sm' }: {
  value: T;
  options: ReadonlyArray<{ value: T; label: React.ReactNode; title?: string; glow?: GuideTarget }>;
  onChange: (v: T) => void;
  size?: 'sm' | 'xs';
}) {
  const target = useContext(GuideContext);
  return (
    <div className="inline-flex rounded-lg bg-gray-100 p-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} title={o.title}
          className={`rounded-md ${size === 'xs' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm'} font-medium transition-colors ${
            value === o.value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}${o.glow && target === o.glow ? ' guide-glow' : ''}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A coloured tag naming a node, matching its wires on the schematic. */
export function NodeTag({ node, color, voltage }: { node: string; color: string; voltage?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-white px-1.5 py-px font-mono text-xs font-semibold"
      style={{ borderColor: color, color }}>
      {node === '0' ? 'ground' : node}
      {voltage && <span className="font-normal text-gray-600">{voltage}</span>}
    </span>
  );
}

export function EmptyState({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="text-gray-300">{icon}</div>}
      <p className="text-sm font-medium text-gray-700">{title}</p>
      {children && <div className="max-w-sm text-sm text-gray-500">{children}</div>}
    </div>
  );
}
