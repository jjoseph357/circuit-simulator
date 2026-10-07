import React from 'react';
import { Circle, Group, Line, Shape } from 'react-konva';
import type { PartType } from './netlist';
import { PIN_OFFSET } from './netlist';

export const INK = '#1f2937';
const BODY = 2.2;

/**
 * Schematic body of a part in its own frame: pins at (∓40, 0) for two-terminal parts, and
 * collector/drain (0,−40), base/gate (−40,0), emitter/source (0,40) for transistors.
 * Leads are drawn in their node's colour so every wire visibly continues into the part.
 */
export function PartBody({ type, rotation = 0, leadColors, polarity, active, ink = INK }: {
  type: PartType;
  rotation?: number;
  /** One colour per pin, in pin order. */
  leadColors: string[];
  /** pnp / pmos draw their mirrored symbols. */
  polarity?: string;
  /** Diode conducting / transistor on: filled or bright body. */
  active?: boolean;
  ink?: string;
}) {
  const [c1, c2, c3] = leadColors;
  const lead = (points: number[], color: string) => <Line points={points} stroke={color} strokeWidth={2.5} lineCap="round" />;

  switch (type) {
    case 'Resistor':
      return (
        <Group>
          {lead([-PIN_OFFSET, 0, -22, 0], c1)}
          {lead([22, 0, PIN_OFFSET, 0], c2)}
          <Line points={[-22, 0, -18, -8, -11, 8, -4, -8, 3, 8, 10, -8, 17, 8, 22, 0]} stroke={ink} strokeWidth={BODY} lineJoin="round" lineCap="round" />
        </Group>
      );
    case 'Capacitor':
      return (
        <Group>
          {lead([-PIN_OFFSET, 0, -5, 0], c1)}
          {lead([5, 0, PIN_OFFSET, 0], c2)}
          <Line points={[-5, -14, -5, 14]} stroke={ink} strokeWidth={3} lineCap="round" />
          <Line points={[5, -14, 5, 14]} stroke={ink} strokeWidth={3} lineCap="round" />
        </Group>
      );
    case 'Inductor':
      return (
        <Group>
          {lead([-PIN_OFFSET, 0, -24, 0], c1)}
          {lead([24, 0, PIN_OFFSET, 0], c2)}
          <Shape
            sceneFunc={(ctx, shape) => {
              ctx.beginPath();
              ctx.moveTo(-24, 0);
              for (let k = 0; k < 4; k++) ctx.arc(-18 + k * 12, 0, 6, Math.PI, 0, false);
              ctx.strokeShape(shape);
            }}
            stroke={ink} strokeWidth={BODY} lineCap="round"
          />
        </Group>
      );
    case 'VoltageSource':
      return (
        <Group>
          {lead([-PIN_OFFSET, 0, -20, 0], c1)}
          {lead([20, 0, PIN_OFFSET, 0], c2)}
          <Circle radius={20} fill="#ffffff" stroke={ink} strokeWidth={BODY} />
          {/* + by pin 1, − by pin 2; the minus is counter-rotated so it always reads as a dash */}
          <Line points={[-14, 0, -6, 0]} stroke={ink} strokeWidth={2} />
          <Line points={[-10, -4, -10, 4]} stroke={ink} strokeWidth={2} />
          <Line x={10} points={[-4, 0, 4, 0]} rotation={-rotation} stroke={ink} strokeWidth={2} />
        </Group>
      );
    case 'CurrentSource':
      return (
        <Group>
          {lead([-PIN_OFFSET, 0, -20, 0], c1)}
          {lead([20, 0, PIN_OFFSET, 0], c2)}
          <Circle radius={20} fill="#ffffff" stroke={ink} strokeWidth={BODY} />
          <Line points={[-11, 0, 10, 0]} stroke={ink} strokeWidth={2} />
          <Line points={[4, -6, 11, 0, 4, 6]} stroke={ink} strokeWidth={2} lineJoin="round" lineCap="round" />
        </Group>
      );
    case 'Diode':
      return (
        <Group>
          {lead([-PIN_OFFSET, 0, -12, 0], c1)}
          {lead([12, 0, PIN_OFFSET, 0], c2)}
          {/* Triangle points anode → cathode (the way current flows); the bar is the cathode */}
          <Line points={[-12, -11, -12, 11, 11, 0]} closed fill={active ? '#fbbf24' : '#ffffff'} stroke={ink} strokeWidth={BODY} lineJoin="round" />
          <Line points={[12, -11, 12, 11]} stroke={ink} strokeWidth={2.6} lineCap="round" />
        </Group>
      );
    case 'BJT': {
      const pnp = polarity === 'pnp';
      return (
        <Group>
          <Circle radius={24} fill="#ffffff" stroke={active ? '#f59e0b' : '#9ca3af'} strokeWidth={1.5} />
          {lead([-PIN_OFFSET, 0, -10, 0], c2)}
          <Line points={[-10, -14, -10, 14]} stroke={ink} strokeWidth={3} lineCap="round" />
          <Line points={[-10, -6, 0, -PIN_OFFSET + 16]} stroke={ink} strokeWidth={BODY} />
          {lead([0, -PIN_OFFSET + 16, 0, -PIN_OFFSET], c1)}
          <Line points={[-10, 6, 0, PIN_OFFSET - 16]} stroke={ink} strokeWidth={BODY} />
          {lead([0, PIN_OFFSET - 16, 0, PIN_OFFSET], c3)}
          {/* Emitter arrow: out of the base for NPN, into it for PNP */}
          <Line points={pnp ? [-2, 19, -9, 9, -11, 17] : [-6, 21, 0, 24, 0, 17]} closed fill={ink} stroke={ink} strokeWidth={1} />
        </Group>
      );
    }
    case 'MOSFET': {
      const pmos = polarity === 'pmos';
      return (
        <Group>
          {lead([-PIN_OFFSET, 0, pmos ? -20 : -12, 0], c2)}
          {pmos && <Circle x={-16} radius={4} fill="#ffffff" stroke={ink} strokeWidth={1.8} />}
          <Line points={[-12, -16, -12, 16]} stroke={ink} strokeWidth={2.6} lineCap="round" />
          {/* Channel: solid when conducting */}
          <Line points={[-4, -18, -4, 18]} stroke={active ? '#f59e0b' : ink} strokeWidth={2.6} dash={active ? undefined : [5, 4]} />
          <Line points={[-4, -12, 0, -12, 0, -PIN_OFFSET + 16]} stroke={ink} strokeWidth={BODY} />
          {lead([0, -PIN_OFFSET + 16, 0, -PIN_OFFSET], c1)}
          <Line points={[-4, 12, 0, 12, 0, PIN_OFFSET - 16]} stroke={ink} strokeWidth={BODY} />
          {lead([0, PIN_OFFSET - 16, 0, PIN_OFFSET], c3)}
          <Line points={pmos ? [-4, 0, 5, -4, 5, 4] : [5, 0, -3, -4, -3, 4]} closed fill={ink} stroke={ink} strokeWidth={1} />
          <Line points={pmos ? [5, 0, 0, 0, 0, 12] : [-3, 0, 0, 0, 0, 12]} stroke={ink} strokeWidth={1.4} />
        </Group>
      );
    }
    case 'Ground':
      return (
        <Group>
          {lead([0, 0, 0, 12], c1)}
          <Line points={[-14, 12, 14, 12]} stroke={ink} strokeWidth={2.6} lineCap="round" />
          <Line points={[-9, 18, 9, 18]} stroke={ink} strokeWidth={2.4} lineCap="round" />
          <Line points={[-4, 24, 4, 24]} stroke={ink} strokeWidth={2.2} lineCap="round" />
        </Group>
      );
    case 'ShortCircuit':
      return (
        <Group>
          {lead([-PIN_OFFSET, 0, -14, 0], c1)}
          {lead([14, 0, PIN_OFFSET, 0], c2)}
          <Line points={[-14, 0, 14, 0]} stroke={ink} strokeWidth={BODY + 1} lineCap="round" />
          <Circle x={-10} y={0} radius={3.5} fill={ink} />
          <Circle x={10} y={0} radius={3.5} fill={ink} />
        </Group>
      );
    case 'OpAmp':
      return (
        <Group>
          {lead([16, 0, PIN_OFFSET, 0], c1)}
          {lead([-PIN_OFFSET, 12, -16, 12], c3 ?? leadColors[2] ?? '#6b7280')}
          {lead([-PIN_OFFSET, -12, -16, -12], c2)}
          <Line points={[-16, -22, -16, 22, 16, 0]} closed fill="#ffffff" stroke={ink} strokeWidth={BODY} lineJoin="round" />
          <Line points={[-12, -12, -6, -12]} stroke={ink} strokeWidth={2} />
          <Line points={[-12, 12, -6, 12]} stroke={ink} strokeWidth={2} />
          <Line points={[-9, 9, -9, 15]} stroke={ink} strokeWidth={2} />
        </Group>
      );
    case 'VCVS':
    case 'CCVS':
      return (
        <Group>
          {lead([-PIN_OFFSET, 0, -18, 0], c1)}
          {lead([18, 0, PIN_OFFSET, 0], c2)}
          <Line points={[0, -18, 18, 0, 0, 18, -18, 0]} closed fill="#ffffff" stroke={ink} strokeWidth={BODY} lineJoin="round" />
          <Line points={[-11, 0, -5, 0]} stroke={ink} strokeWidth={2} />
          <Line points={[-8, -3, -8, 3]} stroke={ink} strokeWidth={2} />
          <Line points={[5, 0, 11, 0]} stroke={ink} strokeWidth={2} />
        </Group>
      );
    case 'VCCS':
    case 'CCCS':
      return (
        <Group>
          {lead([-PIN_OFFSET, 0, -18, 0], c1)}
          {lead([18, 0, PIN_OFFSET, 0], c2)}
          <Line points={[0, -18, 18, 0, 0, 18, -18, 0]} closed fill="#ffffff" stroke={ink} strokeWidth={BODY} lineJoin="round" />
          <Line points={[-8, 0, 8, 0]} stroke={ink} strokeWidth={2} />
          <Line points={[3, -5, 9, 0, 3, 5]} stroke={ink} strokeWidth={2} lineJoin="round" lineCap="round" />
        </Group>
      );
  }
}

/** Half-size of the grab area around a part's body, in its own frame. */
export function bodyExtent(type: PartType): { w: number; h: number } {
  if (type === 'Ground') return { w: 18, h: 16 };
  if (type === 'BJT' || type === 'MOSFET' || type === 'OpAmp') return { w: 28, h: 28 };
  return { w: 26, h: 20 };
}

/** Small drawings for the parts bar, matching the canvas symbols. */
export function PartIcon({ type, className = 'w-9 h-6' }: { type: PartType; className?: string }) {
  const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  let body: React.ReactNode;
  switch (type) {
    case 'Resistor': body = <path d="M2 12h8l2-5 3 10 3-10 3 10 3-10 3 10 2-5h8" {...s} />; break;
    case 'Capacitor': body = <><path d="M2 12h15M23 12h15" {...s} /><path d="M17 5v14M23 5v14" {...s} strokeWidth={2.2} /></>; break;
    case 'Inductor': body = <path d="M2 12h6a3 3 0 0 1 6 0 3 3 0 0 1 6 0 3 3 0 0 1 6 0 3 3 0 0 1 6 0h6" {...s} />; break;
    case 'VoltageSource': body = <><path d="M2 12h9M29 12h9" {...s} /><circle cx="20" cy="12" r="9" {...s} /><path d="M14 12h4M16 10v4M22 12h4" {...s} /></>; break;
    case 'CurrentSource': body = <><path d="M2 12h9M29 12h9" {...s} /><circle cx="20" cy="12" r="9" {...s} /><path d="M15 12h10M22 9l3 3-3 3" {...s} /></>; break;
    case 'Diode': body = <><path d="M2 12h12M26 12h12" {...s} /><path d="M14 6v12l11-6z" {...s} /><path d="M26 6v12" {...s} strokeWidth={2} /></>; break;
    case 'BJT': body = <><circle cx="21" cy="12" r="9" {...s} strokeWidth={1.2} /><path d="M6 12h11M17 7v10M17 10l6-5v-4M17 14l6 5v4" {...s} /></>; break;
    case 'MOSFET': body = <><path d="M6 12h10M16 6v12M20 5v14M20 8h4V1M20 16h4v7" {...s} /></>; break;
    case 'Ground': body = <path d="M20 2v10M11 12h18M14 16h12M17 20h6" {...s} />; break;
    case 'ShortCircuit': body = <><path d="M2 12h36" {...s} strokeWidth={2.2} /><circle cx="12" cy="12" r="3" fill="currentColor" /><circle cx="28" cy="12" r="3" fill="currentColor" /></>; break;
    case 'OpAmp': body = <><path d="M6 4v16l26-8z" {...s} /><path d="M11 9h4M11 15h4M13 13v4" {...s} /></>; break;
    case 'VCVS': case 'CCVS': body = <><path d="M20 3l14 9-14 9-14-9z" {...s} /><path d="M13 12h4M15 10v4M23 12h4" {...s} /></>; break;
    case 'VCCS': case 'CCCS': body = <><path d="M20 3l14 9-14 9-14-9z" {...s} /><path d="M14 12h12M22 9l4 3-4 3" {...s} /></>; break;
  }
  return <svg viewBox="0 0 40 24" className={className} aria-hidden="true">{body}</svg>;
}
