import React, { useEffect, useMemo, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage, Layer, Rect, Circle, Line, Text, Group, Shape, Label, Tag } from 'react-konva';
import type { CircuitSimulationResult, VisualCircuitComponent } from './types';
import {
  autoLayout, cutWire, detachTerminal, deviceTerminalCurrents, formatEng, formatQuantity, freshNode, isDevice, mergeNodes,
  nextName, nodeColorMap, nodeLabelAnchors, nodesOf, parseEngValue, pinLabel, routeWires, sourceLabel, terminalKey,
  terminalsOf, topologySignature, dcValueOfSpec, ElementType, ModelKind, PartType, PART_NAME, Point, Terminal, UNIT, Wire,
  GROUND_COLOR,
} from './netlist';
import { PartBody, PartIcon, bodyExtent, INK } from './symbols';
import { useGlow, GuideTarget } from './ui';
import { Minus, Plus, Maximize2, Wand2, RotateCw, Trash2, Undo2, Redo2, ChevronDown, ChevronRight, X, Unplug, FlipHorizontal2 } from 'lucide-react';

interface CircuitCanvasProps {
  components: VisualCircuitComponent[];
  onChange: (components: VisualCircuitComponent[]) => void;
  /** Null until the student has run the simulation. */
  result: CircuitSimulationResult | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Parts to spotlight, e.g. the ones behind a matrix entry. */
  highlightedNames?: string[];
  /** Bump to re-fit the view (after loading a circuit). */
  fitKey?: number;
  showCurrent?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

const GRID = 20;
const snap = (v: number) => Math.round(v / GRID) * GRID;
const MAX_PARTICLE_SPEED = 80; // px/s at the reference current
const PARTICLE_SPACING = 24;

const BASIC_PARTS: PartType[] = ['Resistor', 'VoltageSource', 'CurrentSource', 'Capacitor', 'Ground'];
const MORE_PARTS: PartType[] = ['Inductor', 'Diode', 'BJT', 'MOSFET'];
const PART_LABEL: Record<PartType, string> = {
  Resistor: 'Resistor', VoltageSource: 'Voltage source', CurrentSource: 'Current source', Capacitor: 'Capacitor', Ground: 'Ground',
  Inductor: 'Inductor', Diode: 'Diode', BJT: 'BJT', MOSFET: 'MOSFET',
};
export const PART_HELP: Record<PartType, string> = {
  Resistor: 'Limits current. Ohm’s law: V = I · R.',
  VoltageSource: 'Like a battery: keeps its + end a fixed voltage above its − end.',
  CurrentSource: 'Pushes a fixed current through itself, in the arrow’s direction.',
  Capacitor: 'Stores charge. Blocks steady DC; its voltage cannot jump.',
  Ground: 'The 0 V reference. Every circuit needs one.',
  Inductor: 'Stores energy in a magnetic field. A plain wire at steady DC; its current cannot jump.',
  Diode: 'A one-way valve for current. Turns on at about 0.6–0.7 V.',
  BJT: 'A small base current controls a large collector current.',
  MOSFET: 'The gate voltage controls the drain current.',
};
const DEFAULT_VALUE: Record<PartType, number> = { Resistor: 1000, CurrentSource: 0.001, VoltageSource: 5, Capacitor: 1e-6, Inductor: 1e-3, Diode: 0, BJT: 0, MOSFET: 0, Ground: 0 };
const DEFAULT_ROTATION: Partial<Record<PartType, number>> = { VoltageSource: 90, CurrentSource: 270 };

interface FlowPath { segs: Array<[number, number, number, number, number]>; length: number; speed: number }

function buildPath(points: number[], current: number, iRef: number): FlowPath | null {
  const rel = iRef > 0 ? Math.abs(current) / iRef : 0;
  if (rel < 0.003) return null;
  const segs: FlowPath['segs'] = [];
  let length = 0;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const len = Math.hypot(points[i + 2] - points[i], points[i + 3] - points[i + 1]);
    if (len > 0) { segs.push([points[i], points[i + 1], points[i + 2], points[i + 3], len]); length += len; }
  }
  if (length === 0) return null;
  return { segs, length, speed: Math.sign(current) * MAX_PARTICLE_SPEED * Math.min(rel, 1.5) };
}

/** Joins nodes of pins that sit exactly on top of each other (dropping a part onto a pin connects it). */
function joinTouchingPins(comps: VisualCircuitComponent[], movedId: string): VisualCircuitComponent[] {
  let out = comps;
  const moved = out.find((c) => c.id === movedId);
  if (!moved) return out;
  for (const t of terminalsOf(moved)) {
    const current = terminalsOf(out.find((c) => c.id === movedId)!).find((x) => x.pin === t.pin)!;
    for (const c of out) {
      if (c.id === movedId) continue;
      const hit = terminalsOf(c).find((o) => Math.abs(o.pos.x - current.pos.x) < 1 && Math.abs(o.pos.y - current.pos.y) < 1);
      if (hit && hit.node !== current.node) { out = mergeNodes(out, hit.node, current.node); break; }
    }
  }
  return out;
}

type Wiring = { from: Terminal; mode: 'drag' | 'click'; start: Point; moved: boolean };

export function CircuitCanvas({
  components, onChange, result, selectedId, onSelect, highlightedNames = [], fitKey = 0, showCurrent = true,
  onUndo, onRedo, canUndo, canRedo,
}: CircuitCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const particleLayerRef = useRef<Konva.Layer>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [stagePos, setStagePos] = useState({ x: 40, y: 40 });
  const [stageScale, setStageScale] = useState(1);
  const [dragOverride, setDragOverride] = useState<{ id: string; x: number; y: number } | null>(null);
  const [placing, setPlacing] = useState<{ type: PartType; rotation: number } | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [wiring, setWiring] = useState<Wiring | null>(null);
  const [hoverPin, setHoverPin] = useState<Terminal | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverWire, setHoverWire] = useState<Wire | null>(null);
  const [hoverPart, setHoverPart] = useState<string | null>(null);
  const [selectedWire, setSelectedWire] = useState<Wire | null>(null);
  const [renaming, setRenaming] = useState<{ node: string; draft: string; x: number; y: number } | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const sim = result?.success ? result : null;
  const liveComps = useMemo(
    () => components.map((c) => (dragOverride && c.id === dragOverride.id ? { ...c, x: dragOverride.x, y: dragOverride.y } : c)),
    [components, dragOverride],
  );
  const colors = useMemo(() => nodeColorMap(components.flatMap(nodesOf)), [components]);
  const colorOf = (n: string) => colors.get(n) ?? GROUND_COLOR;

  // Pins per node: a node with a single pin is a loose end.
  const pinCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of components) for (const t of terminalsOf(c)) m.set(t.node, (m.get(t.node) ?? 0) + 1);
    return m;
  }, [components]);
  const hasGroundSymbol = components.some((c) => c.type === 'Ground');
  const isLoose = (t: Terminal) => !t.isGroundSymbol && (t.node === '0' ? !hasGroundSymbol && (pinCount.get('0') ?? 0) < 2 : (pinCount.get(t.node) ?? 0) < 2);
  const loosePins = useMemo(() => components.flatMap(terminalsOf).filter(isLoose).length, [components, pinCount]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth || 800, height: el.clientHeight || 500 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitToView = (comps = components) => {
    if (comps.length === 0) { setStageScale(1); setStagePos({ x: size.width / 2 - 200, y: size.height / 2 - 150 }); return; }
    const xs = comps.map((c) => c.x), ys = comps.map((c) => c.y);
    const padX = 110, padY = 90;
    const minX = Math.min(...xs) - padX - 150, maxX = Math.max(...xs) + padX; // room for the parts bar on the left
    const minY = Math.min(...ys) - padY, maxY = Math.max(...ys) + padY;
    const scale = Math.max(0.4, Math.min(1.4, Math.min(size.width / (maxX - minX), size.height / (maxY - minY))));
    setStageScale(scale);
    setStagePos({ x: (size.width - (maxX - minX) * scale) / 2 - minX * scale, y: (size.height - (maxY - minY) * scale) / 2 - minY * scale });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fitToView(); }, [fitKey, size.width > 0 && size.height > 0]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(t);
  }, [notice]);

  // Keep the selected part visible: if the inspector card (top right) would cover it, pan left.
  useEffect(() => {
    const c = components.find((x) => x.id === selectedId);
    if (!c) return;
    const sx = c.x * stageScale + stagePos.x, sy = c.y * stageScale + stagePos.y;
    const cardLeft = size.width - 12 - 288 - 16, cardBottom = 12 + 380;
    if (sx + 60 * stageScale > cardLeft && sy - 40 * stageScale < cardBottom) setStagePos((p) => ({ ...p, x: p.x - (sx + 60 * stageScale - cardLeft) }));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop a stale wire selection when the circuit changes under it.
  useEffect(() => { setSelectedWire(null); }, [components]);

  // ---------------- Electrical overlays ----------------
  const devTerminals = useMemo(() => deviceTerminalCurrents(sim?.device_ops), [sim]);
  const { wires, junctions } = useMemo(() => routeWires(liveComps, sim?.branch_currents, devTerminals), [liveComps, sim, devTerminals]);
  const anchors = useMemo(() => nodeLabelAnchors(liveComps), [liveComps]);
  const deviceOp = (name: string) => sim?.device_ops?.find((o) => o.name === name);

  // Reference current only grows while the topology is unchanged, so raising a resistance
  // visibly slows the dots instead of being normalized away.
  const iRefState = useRef<{ sig: string; iRef: number }>({ sig: '', iRef: 0 });
  const iRef = useMemo(() => {
    const sig = topologySignature(components);
    const maxI = Math.max(0, ...Object.values(sim?.branch_currents ?? {}).map(Math.abs));
    if (iRefState.current.sig !== sig) iRefState.current = { sig, iRef: maxI };
    else iRefState.current.iRef = Math.max(iRefState.current.iRef, maxI);
    return iRefState.current.iRef;
  }, [components, sim]);

  const flowPaths = useMemo(() => {
    if (!sim || !showCurrent) return [];
    const paths: FlowPath[] = [];
    for (const w of wires) { const p = buildPath(w.points, w.current, iRef); if (p) paths.push(p); }
    for (const c of liveComps) {
      if (c.type === 'Ground') continue;
      const pins = terminalsOf(c);
      if (pins.length === 3) {
        const cur = devTerminals[c.name] ?? [0, 0, 0];
        const main = buildPath([pins[0].pos.x, pins[0].pos.y, c.x, c.y, pins[2].pos.x, pins[2].pos.y], cur[0], iRef);
        const ctrl = buildPath([pins[1].pos.x, pins[1].pos.y, c.x, c.y], cur[1], iRef);
        if (main) paths.push(main);
        if (ctrl) paths.push(ctrl);
        continue;
      }
      const [t1, t2] = pins;
      const p = buildPath([t1.pos.x, t1.pos.y, t2.pos.x, t2.pos.y], sim.branch_currents[c.name] ?? 0, iRef);
      if (p) paths.push(p);
    }
    return paths;
  }, [wires, liveComps, sim, iRef, devTerminals, showCurrent]);
  const flowRef = useRef<FlowPath[]>([]);
  flowRef.current = flowPaths;
  const animate = flowPaths.length > 0;

  useEffect(() => {
    const layer = particleLayerRef.current;
    if (!layer || !animate) { layer?.batchDraw(); return; }
    const anim = new Konva.Animation(() => {}, layer);
    anim.start();
    return () => { anim.stop(); };
  }, [animate]);

  const drawParticles = (ctx: Konva.Context) => {
    const c = (ctx as any)._context as CanvasRenderingContext2D;
    const t = performance.now() / 1000;
    for (const path of flowRef.current) {
      let s = ((t * path.speed) % PARTICLE_SPACING + PARTICLE_SPACING) % PARTICLE_SPACING;
      let segIdx = 0, segStart = 0;
      for (; s < path.length; s += PARTICLE_SPACING) {
        while (segIdx < path.segs.length - 1 && s > segStart + path.segs[segIdx][4]) { segStart += path.segs[segIdx][4]; segIdx++; }
        const [x1, y1, x2, y2, len] = path.segs[segIdx];
        const u = Math.min(1, (s - segStart) / len);
        c.beginPath(); c.fillStyle = '#f59e0b';
        c.arc(x1 + (x2 - x1) * u, y1 + (y2 - y1) * u, 2.6, 0, Math.PI * 2); c.fill();
      }
    }
  };

  // ---------------- Editing ----------------
  const commit = (next: VisualCircuitComponent[]) => onChange(next);
  const update = (id: string, patch: Partial<VisualCircuitComponent>) => commit(components.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const deletePart = (id: string) => {
    commit(components.filter((c) => c.id !== id));
    if (selectedId === id) onSelect(null);
  };
  const rotatePart = (id: string) => {
    const c = components.find((x) => x.id === id);
    if (!c || c.type === 'Ground') return;
    commit(joinTouchingPins(components.map((x) => (x.id === id ? { ...x, rotation: ((x.rotation || 0) + 90) % 360 } : x)), id));
  };

  const flipPart = (id: string) => {
    const c = components.find((x) => x.id === id);
    if (!c || c.node3 === undefined) return;
    commit(joinTouchingPins(components.map((x) => (x.id === id ? { ...x, mirror: !x.mirror } : x)), id));
  };

  const place = (type: PartType, at: Point, rotation: number) => {
    const taken = new Set<string>();
    const fresh = () => { const n = freshNode(components, taken); taken.add(n); return n; };
    const three = type === 'BJT' || type === 'MOSFET';
    const kinds: Partial<Record<PartType, ModelKind>> = { Diode: 'd', BJT: 'npn', MOSFET: 'nmos' };
    const comp: VisualCircuitComponent = {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: nextName(components, type), type, value: DEFAULT_VALUE[type], unit: UNIT[type],
      node1: type === 'Ground' ? '0' : fresh(), node2: type === 'Ground' ? '0' : fresh(),
      x: snap(at.x), y: snap(at.y), rotation: type === 'Ground' ? 0 : rotation,
      ...(three ? { node3: fresh() } : {}),
      ...(kinds[type] ? { modelKind: kinds[type] } : {}),
    };
    commit(joinTouchingPins([...components, comp], comp.id));
    onSelect(type === 'Ground' ? null : comp.id);
  };

  const connect = (from: Terminal, toNode: string) => {
    const fromNode = components.find((c) => c.id === from.compId) ? terminalsOf(components.find((c) => c.id === from.compId)!).find((t) => t.pin === from.pin)!.node : from.node;
    if (fromNode === toNode) { setNotice('Those are already connected: they are the same node.'); return; }
    commit(mergeNodes(components, fromNode, toNode));
  };

  const arrange = () => {
    const laid = autoLayout(components.filter((c) => c.type !== 'Ground').map((c) => ({
      name: c.name, type: c.type as ElementType, value: c.value, node1: c.node1, node2: c.node2, source: c.source,
      node3: c.node3, deviceArgs: c.deviceArgs, modelKind: c.modelKind,
    })));
    commit(laid);
    setTimeout(() => fitToView(laid), 0);
  };

  const cancelModes = () => { setPlacing(null); setWiring(null); setRenaming(null); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) onRedo?.(); else onUndo?.(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); onRedo?.(); return; }
      if (e.key === 'Escape') { cancelModes(); setSelectedWire(null); onSelect(null); }
      if (e.key === 'r' || e.key === 'R') {
        if (placing) setPlacing({ ...placing, rotation: (placing.rotation + 90) % 360 });
        else if (selectedId) rotatePart(selectedId);
      }
      if ((e.key === 'f' || e.key === 'F') && selectedId) flipPart(selectedId);
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedWire) { commit(cutWire(components, selectedWire)); setSelectedWire(null); }
        else if (selectedId) deletePart(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------------- Pointer handling ----------------
  const worldPointer = (stage: Konva.Stage | null): Point | null => stage?.getRelativePointerPosition() ?? null;

  const onStageMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const p = worldPointer(e.target.getStage());
    if (!p) return;
    if (placing || wiring) setPointer(p);
    if (wiring && !wiring.moved && Math.hypot(p.x - wiring.start.x, p.y - wiring.start.y) > 8) setWiring({ ...wiring, moved: true });
  };

  const onStageUp = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (placing) {
      const p = worldPointer(e.target.getStage());
      if (p) place(placing.type, p, placing.rotation);
      setPlacing(null);
      return;
    }
    if (!wiring) return;
    if (hoverPin && terminalKey(hoverPin) !== terminalKey(wiring.from)) { connect(wiring.from, hoverPin.node); setWiring(null); return; }
    if (hoverWire) { connect(wiring.from, hoverWire.node); setWiring(null); return; }
    if (wiring.mode === 'drag' && !wiring.moved) { setWiring({ ...wiring, mode: 'click' }); return; }
    if (wiring.mode === 'drag') setWiring(null);
  };

  const onStageDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.target !== e.target.getStage()) return;
    if (wiring?.mode === 'click') setWiring(null);
    setRenaming(null);
  };

  const onPinDown = (e: Konva.KonvaEventObject<MouseEvent>, t: Terminal) => {
    e.cancelBubble = true;
    if (placing) return;
    if (wiring?.mode === 'click') {
      if (terminalKey(t) !== terminalKey(wiring.from)) connect(wiring.from, t.node);
      setWiring(null);
      return;
    }
    setWiring({ from: t, mode: 'drag', start: t.pos, moved: false });
    setPointer(t.pos);
    setSelectedWire(null);
  };

  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    const p = stage?.getPointerPosition();
    if (!stage || !p) return;
    const old = stage.scaleX();
    const next = Math.max(0.3, Math.min(e.evt.deltaY < 0 ? old * 1.08 : old / 1.08, 2.5));
    const anchor = { x: (p.x - stage.x()) / old, y: (p.y - stage.y()) / old };
    setStageScale(next);
    setStagePos({ x: p.x - anchor.x * next, y: p.y - anchor.y * next });
  };

  const zoomBy = (f: number) => {
    const next = Math.max(0.3, Math.min(stageScale * f, 2.5));
    const cx = size.width / 2, cy = size.height / 2;
    setStagePos({ x: cx - ((cx - stagePos.x) / stageScale) * next, y: cy - ((cy - stagePos.y) / stageScale) * next });
    setStageScale(next);
  };

  const toScreen = (p: Point) => ({ x: p.x * stageScale + stagePos.x, y: p.y * stageScale + stagePos.y });

  // ---------------- Rendering ----------------
  const highlighted = new Set(highlightedNames);
  const dim = (node: string) => (hoverNode !== null && hoverNode !== node ? 0.25 : 1);
  const voltageOf = (node: string) => {
    const v = sim?.node_voltages[node];
    if (v === undefined) return undefined;
    const vMax = Math.max(1, ...Object.values(sim!.node_voltages).map(Math.abs));
    return Math.abs(v) < 1e-9 * vMax ? 0 : v;
  };

  const renderPart = (comp: VisualCircuitComponent) => {
    const isGround = comp.type === 'Ground';
    const isSelected = selectedId === comp.id;
    const isHighlighted = highlighted.has(comp.name);
    const leadColors = terminalsOf(comp).map((t) => colorOf(t.node));
    const op = deviceOp(comp.name);
    const active = op ? (comp.type === 'MOSFET' ? !op.region.startsWith('cutoff') : op.region.startsWith('forward') || op.region.startsWith('active') || op.region.startsWith('saturation')) : false;
    const { w, h } = bodyExtent(comp.type);
    return (
      <Group
        key={comp.id} x={comp.x} y={comp.y} rotation={isGround ? 0 : comp.rotation || 0} scaleX={comp.mirror ? -1 : 1}
        draggable={!placing && !wiring}
        onDragStart={() => { onSelect(comp.id); setHoverPart(null); }}
        onDragMove={(e) => setDragOverride({ id: comp.id, x: snap(e.target.x()), y: snap(e.target.y()) })}
        onDragEnd={(e) => {
          const x = snap(e.target.x()), y = snap(e.target.y());
          e.target.position({ x, y });
          setDragOverride(null);
          commit(joinTouchingPins(components.map((c) => (c.id === comp.id ? { ...c, x, y } : c)), comp.id));
        }}
        onClick={(e) => { e.cancelBubble = true; if (!wiring) { onSelect(isGround ? null : comp.id); setSelectedWire(null); } }}
        onTap={(e) => { e.cancelBubble = true; onSelect(isGround ? null : comp.id); }}
        onMouseEnter={(e) => { setHoverPart(comp.id); const s = e.target.getStage(); if (s && !placing && !wiring) s.container().style.cursor = 'move'; }}
        onMouseLeave={(e) => { setHoverPart(null); const s = e.target.getStage(); if (s && !placing && !wiring) s.container().style.cursor = 'default'; }}
      >
        {(isSelected || isHighlighted) && (
          <Rect x={-w - 8} y={-h - 8} width={2 * w + 16} height={2 * h + 16} cornerRadius={8}
            fill={isHighlighted ? 'rgba(251,191,36,0.18)' : 'rgba(37,99,235,0.07)'}
            stroke={isHighlighted ? '#f59e0b' : '#2563eb'} strokeWidth={1.5} dash={isHighlighted ? undefined : [5, 4]} />
        )}
        {/* Invisible grab area so the whole symbol is easy to pick up */}
        <Rect x={-w} y={-h} width={2 * w} height={2 * h} fill="transparent" />
        <PartBody type={comp.type} rotation={comp.rotation || 0} leadColors={leadColors} polarity={comp.modelKind} active={active}
          ink={isSelected ? '#1d4ed8' : INK} />
      </Group>
    );
  };

  /** Name and value, drawn unrotated so text never reads upside down. */
  const renderLabel = (comp: VisualCircuitComponent) => {
    if (comp.type === 'Ground') return null;
    const three = comp.node3 !== undefined;
    const vertical = three || Math.abs(Math.sin(((comp.rotation || 0) * Math.PI) / 180)) > 0.5;
    const value = isDevice(comp.type)
      ? (comp.type === 'Diode' ? '' : (comp.modelKind ?? '').toUpperCase())
      : comp.source ? sourceLabel(comp.source, comp.unit) : formatQuantity(comp.value, comp.unit);
    const op = deviceOp(comp.name);
    const state = op ? op.region.split(' (')[0] : '';
    const x = vertical ? comp.x + (three ? 30 : 28) : comp.x - 70;
    const y = vertical ? comp.y - (state ? 20 : 14) : comp.y - 44;
    return (
      <Group key={`l_${comp.id}`} listening={false} opacity={hoverNode ? 0.5 : 1}>
        <Text x={x} y={y} width={140} align={vertical ? 'left' : 'center'} text={comp.name} fontSize={13} fontStyle="bold" fill={INK} fontFamily="Inter, system-ui, sans-serif" />
        <Text x={x} y={y + 15} width={140} align={vertical ? 'left' : 'center'} text={value} fontSize={12} fill="#4b5563" fontFamily="Inter, system-ui, sans-serif" />
        {state && <Text x={x} y={y + 30} width={140} align={vertical ? 'left' : 'center'} text={state} fontSize={11} fill="#b45309" fontFamily="Inter, system-ui, sans-serif" />}
      </Group>
    );
  };

  const renderPins = (comp: VisualCircuitComponent) => terminalsOf(comp).map((t) => {
    const key = terminalKey(t);
    const loose = isLoose(t);
    const isFrom = wiring && terminalKey(wiring.from) === key;
    const isHover = hoverPin && terminalKey(hoverPin) === key;
    const big = isFrom || isHover;
    const color = colorOf(t.node);
    return (
      <Group key={key} opacity={dim(t.node)}>
        {(isHover || isFrom) && <Circle x={t.pos.x} y={t.pos.y} radius={11} fill={isFrom ? 'rgba(37,99,235,0.18)' : 'rgba(37,99,235,0.12)'} listening={false} />}
        <Circle
          x={t.pos.x} y={t.pos.y}
          radius={loose ? 5 : big ? 5 : 3.5}
          fill={loose ? '#ffffff' : color}
          stroke={loose ? '#dc2626' : '#ffffff'}
          strokeWidth={loose ? 2 : 1.2}
          hitStrokeWidth={16}
          onMouseDown={(e) => onPinDown(e, t)}
          onTouchStart={(e) => onPinDown(e as unknown as Konva.KonvaEventObject<MouseEvent>, t)}
          onMouseEnter={(e) => { setHoverPin(t); setHoverNode(t.node); const s = e.target.getStage(); if (s) s.container().style.cursor = 'crosshair'; }}
          onMouseLeave={(e) => { setHoverPin(null); setHoverNode(null); const s = e.target.getStage(); if (s) s.container().style.cursor = placing ? 'copy' : 'default'; }}
        />
      </Group>
    );
  });

  const selectedComp = components.find((c) => c.id === selectedId) ?? null;
  const hoverComp = hoverPart && !selectedComp ? components.find((c) => c.id === hoverPart) ?? null : null;

  // Status line: always says what the student can do right now.
  const status = placing
    ? `Click the canvas to place the ${PART_NAME[placing.type]}. Press R to rotate it, Esc to cancel.`
    : wiring
    ? `Wiring from ${wiring.from.compName} (${pinLabel(components.find((c) => c.id === wiring.from.compId)?.type ?? 'Resistor', wiring.from.pin)}). ${wiring.mode === 'click' ? 'Click' : 'Release on'} another pin or a wire to connect. Esc cancels.`
    : selectedWire
    ? `Press Delete to remove this wire. The pins on one side get a new node.`
    : components.length === 0
    ? ''
    : loosePins > 0
    ? `${loosePins} pin${loosePins > 1 ? 's are' : ' is'} not connected yet (hollow red circles). Drag from a pin to another pin to connect them.`
    : 'Drag parts to move them. Drag from a pin to connect. Scroll to zoom, drag the background to pan.';

  const renameAt = (node: string) => {
    const p = anchors.get(node);
    if (!p) return;
    const s = toScreen(p);
    setRenaming({ node, draft: node, x: Math.max(8, s.x - 60), y: s.y + 28 });
  };
  const applyRename = () => {
    if (!renaming) return;
    const name = renaming.draft.trim();
    const old = renaming.node;
    setRenaming(null);
    if (!name || name === old) return;
    if (!/^[A-Za-z0-9_+-]+$/.test(name)) { setNotice('Node names can use letters, digits, _ + and -.'); return; }
    const target = ['0', 'gnd', 'ground'].includes(name.toLowerCase()) ? '0' : name;
    // Renaming onto an existing name joins the two nodes (that is what a shared name means in SPICE).
    if (components.some((c) => nodesOf(c).includes(target))) setNotice(`Node ${old} is now joined to ${target === '0' ? 'ground' : `node ${target}`}.`);
    commit(mergeNodes(components, target, old));
  };

  const wireKey = (w: Wire) => `${w.ends[0]}|${w.ends[1]}`;
  const selWireKey = selectedWire ? wireKey(selectedWire) : null;
  const canvasGlow = useGlow('canvas');

  return (
    <div className={`relative h-full w-full select-none overflow-hidden bg-white${canvasGlow}`}>
      <div ref={wrapRef} className="absolute inset-0" style={{ cursor: placing ? 'copy' : wiring ? 'crosshair' : undefined }}>
        <Stage
          width={size.width} height={size.height}
          scaleX={stageScale} scaleY={stageScale} x={stagePos.x} y={stagePos.y}
          draggable={!placing && !wiring}
          onWheel={handleWheel}
          onMouseMove={onStageMove}
          onMouseUp={onStageUp}
          onMouseDown={onStageDown}
          onMouseLeave={() => { setPointer(null); }}
          onDragEnd={(e) => { if (e.target === e.target.getStage()) setStagePos({ x: e.target.x(), y: e.target.y() }); }}
          onClick={(e) => { if (e.target === e.target.getStage()) { onSelect(null); setSelectedWire(null); } }}
        >
          {/* Dot grid covering the visible region at any pan/zoom */}
          <Layer listening={false}>
            <Shape
              sceneFunc={(ctx, shape) => {
                const stage = shape.getStage();
                if (!stage) return;
                const s = stage.scaleX();
                const x0 = -stage.x() / s, y0 = -stage.y() / s;
                const x1 = x0 + stage.width() / s, y1 = y0 + stage.height() / s;
                const c = (ctx as any)._context as CanvasRenderingContext2D;
                c.fillStyle = '#d1d5db';
                const step = s < 0.6 ? GRID * 2 : GRID;
                for (let x = Math.floor(x0 / step) * step; x < x1; x += step)
                  for (let y = Math.floor(y0 / step) * step; y < y1; y += step) c.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
              }}
            />
          </Layer>

          {/* Wires, one colour per node */}
          <Layer>
            {wires.map((w) => {
              const k = wireKey(w);
              const sel = k === selWireKey;
              return (
                <Group key={k} opacity={dim(w.node)}>
                  {sel && <Line points={w.points} stroke="#93c5fd" strokeWidth={9} lineCap="round" lineJoin="round" listening={false} />}
                  <Line points={w.points} stroke={colorOf(w.node)} strokeWidth={hoverNode === w.node ? 3.5 : 2.5}
                    lineCap="round" lineJoin="round" hitStrokeWidth={12}
                    onMouseEnter={(e) => { setHoverWire(w); setHoverNode(w.node); const s = e.target.getStage(); if (s && !placing) s.container().style.cursor = 'pointer'; }}
                    onMouseLeave={(e) => { setHoverWire(null); setHoverNode(null); const s = e.target.getStage(); if (s && !placing) s.container().style.cursor = 'default'; }}
                    onMouseDown={(e) => {
                      if (wiring?.mode === 'click') { e.cancelBubble = true; connect(wiring.from, w.node); setWiring(null); }
                    }}
                    onClick={(e) => { e.cancelBubble = true; if (!wiring) { setSelectedWire(w); onSelect(null); } }}
                  />
                </Group>
              );
            })}
            {junctions.map((j, i) => (
              <Circle key={`j${i}`} x={j.pos.x} y={j.pos.y} radius={4.5} fill={colorOf(j.node)} opacity={dim(j.node)} listening={false} />
            ))}
          </Layer>

          <Layer>
            {liveComps.map(renderPart)}
            {liveComps.map(renderLabel)}
            {liveComps.map(renderPins)}

            {/* Node name tags (and voltages once simulated) */}
            {[...anchors.entries()].map(([node, p]) => {
              const v = voltageOf(node);
              const color = colorOf(node);
              const text = v !== undefined ? `${node}  ${formatQuantity(v, 'V', 4)}` : node;
              const w = text.length * 7.3 + 8; // monospace 12px: ~7.3px per character, plus padding
              const x = p.side === 'h' ? p.x - w / 2 : p.side === 'v' ? p.x - w - 8 : p.x + 8;
              const y = p.side === 'h' ? p.y + 6 : p.side === 'v' ? p.y - 11 : p.y - 28;
              return (
                <Label key={`n_${node}`} x={x} y={y} opacity={dim(node)}
                  onMouseEnter={(e) => { setHoverNode(node); const s = e.target.getStage(); if (s) s.container().style.cursor = 'text'; }}
                  onMouseLeave={(e) => { setHoverNode(null); const s = e.target.getStage(); if (s) s.container().style.cursor = 'default'; }}
                  onClick={(e) => { e.cancelBubble = true; renameAt(node); }}>
                  <Tag fill="#ffffff" stroke={color} strokeWidth={1.5} cornerRadius={5} />
                  <Text text={text} fontSize={12} fontStyle="bold"
                    fontFamily="JetBrains Mono, Consolas, monospace" fill={color} padding={4} />
                </Label>
              );
            })}

            {/* Rubber band while wiring */}
            {wiring && pointer && (
              <Line points={[wiring.from.pos.x, wiring.from.pos.y, pointer.x, pointer.y]} stroke="#2563eb" strokeWidth={2} dash={[6, 5]} listening={false} />
            )}
            {/* Ghost of the part being placed */}
            {placing && pointer && (
              <Group x={snap(pointer.x)} y={snap(pointer.y)} rotation={placing.type === 'Ground' ? 0 : placing.rotation} opacity={0.55} listening={false}>
                <PartBody type={placing.type} rotation={placing.rotation} leadColors={['#6b7280', '#6b7280', '#6b7280']} polarity={placing.type === 'BJT' ? 'npn' : 'nmos'} />
              </Group>
            )}
          </Layer>

          <Layer ref={particleLayerRef} listening={false}>
            <Shape sceneFunc={drawParticles} />
          </Layer>
        </Stage>
      </div>

      {/* Parts bar */}
      <PartsBar placing={placing?.type ?? null} showMore={showMore} onToggleMore={() => setShowMore(!showMore)}
        onPick={(type) => { setWiring(null); onSelect(null); setPlacing(placing?.type === type ? null : { type, rotation: DEFAULT_ROTATION[type] ?? 0 }); }} />

      {/* View controls */}
      <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-lg border border-gray-200 bg-white/95 p-1 shadow-sm">
        <button className="icon-btn" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)"><Undo2 className="h-4 w-4" /></button>
        <button className="icon-btn" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)"><Redo2 className="h-4 w-4" /></button>
        <span className="mx-0.5 h-5 w-px bg-gray-200" />
        <button className="icon-btn" onClick={() => zoomBy(1 / 1.2)} title="Zoom out"><Minus className="h-4 w-4" /></button>
        <button className="icon-btn" onClick={() => fitToView()} title="Fit the circuit in view"><Maximize2 className="h-4 w-4" /></button>
        <button className="icon-btn" onClick={() => zoomBy(1.2)} title="Zoom in"><Plus className="h-4 w-4" /></button>
        <span className="mx-0.5 h-5 w-px bg-gray-200" />
        <button className="btn btn-ghost btn-sm" onClick={arrange} disabled={components.length === 0} title="Redraw the schematic neatly from its connections">
          <Wand2 className="h-3.5 w-3.5" /> Tidy up
        </button>
      </div>

      {/* Status line */}
      {(status || notice) && (
        <div className="pointer-events-none absolute bottom-3 left-[18rem] right-3 flex justify-center">
          <div className={`rounded-lg px-3 py-1.5 text-center text-xs shadow-sm ${notice ? 'bg-gray-900 text-white' : wiring || placing ? 'bg-blue-600 text-white' : 'border border-gray-200 bg-white/95 text-gray-600'}`}>
            {notice ?? status}
          </div>
        </div>
      )}

      {/* Empty canvas */}
      {components.length === 0 && !placing && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="max-w-xs rounded-xl border border-dashed border-gray-300 bg-white/90 p-5 text-center">
            <p className="text-sm font-medium text-gray-800">An empty canvas</p>
            <p className="mt-1 text-sm text-gray-500">Pick a part on the left, then click here to place it. Or open a lesson from the top bar.</p>
          </div>
        </div>
      )}

      {/* Hover card: what a part is and what it is doing */}
      {hoverComp && hoverComp.type !== 'Ground' && !placing && !wiring && !dragOverride && (
        <HoverCard comp={hoverComp} result={sim} at={toScreen({ x: hoverComp.x, y: hoverComp.y })} scale={stageScale} width={size.width} />
      )}
      {hoverPin && !wiring && !placing && (
        <div className="pointer-events-none absolute z-20 rounded-md bg-gray-900 px-2 py-1 text-xs text-white shadow"
          style={{ left: toScreen(hoverPin.pos).x + 12, top: toScreen(hoverPin.pos).y + 10 }}>
          {hoverPin.isGroundSymbol ? 'Ground (node 0)' : `${hoverPin.compName} ${pinLabel(components.find((c) => c.id === hoverPin.compId)?.type ?? 'Resistor', hoverPin.pin)} · ${hoverPin.node === '0' ? 'ground' : `node ${hoverPin.node}`}`}
          <span className="text-gray-400"> · drag to connect</span>
        </div>
      )}

      {/* Wire actions */}
      {selectedWire && (
        <div className="absolute z-20" style={{ left: toScreen({ x: selectedWire.points[0], y: selectedWire.points[1] }).x, top: toScreen({ x: selectedWire.points[0], y: selectedWire.points[1] }).y + 14 }}>
          <button className="btn btn-secondary btn-sm shadow" onClick={() => { commit(cutWire(components, selectedWire)); setSelectedWire(null); }}>
            <Trash2 className="h-3.5 w-3.5" /> Delete wire
          </button>
        </div>
      )}

      {/* Rename a node */}
      {renaming && (
        <div className="absolute z-30 flex items-center gap-1 rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg" style={{ left: renaming.x, top: renaming.y }}>
          <span className="label px-1">Node name</span>
          <input autoFocus className="input w-24 font-mono" value={renaming.draft}
            onChange={(e) => setRenaming({ ...renaming, draft: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') applyRename(); if (e.key === 'Escape') setRenaming(null); }} />
          <button className="btn btn-primary btn-sm" onClick={applyRename}>Rename</button>
          <button className="icon-btn" onClick={() => setRenaming(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Properties of the selected part */}
      {selectedComp && (
        <PartInspector
          comp={selectedComp} result={sim}
          onChange={(patch) => update(selectedComp.id, patch)}
          onRotate={() => rotatePart(selectedComp.id)}
          onFlip={selectedComp.node3 !== undefined ? () => flipPart(selectedComp.id) : undefined}
          onDelete={() => deletePart(selectedComp.id)}
          onDetach={(pin) => commit(detachTerminal(components, `${selectedComp.id}:${pin}`))}
          onClose={() => onSelect(null)}
          nodeColor={colorOf}
        />
      )}
    </div>
  );
}

export default CircuitCanvas;

// ------------------------------- Parts bar -------------------------------

function PartButton({ type, active, onPick }: { type: PartType; active: boolean; onPick: (t: PartType) => void }) {
  const glow = useGlow(`part:${type}` as GuideTarget);
  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); onPick(type); }}
      title={PART_HELP[type]}
      className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs font-medium transition-colors ${
        active ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}${glow}`}>
      <PartIcon type={type} className="h-5 w-8 shrink-0" />
      {PART_LABEL[type]}
    </button>
  );
}

function PartsBar({ placing, showMore, onToggleMore, onPick }: {
  placing: PartType | null; showMore: boolean; onToggleMore: () => void; onPick: (t: PartType) => void;
}) {
  return (
    <div className="absolute left-3 top-3 w-40 rounded-xl border border-gray-200 bg-white/95 p-1.5 shadow-sm">
      <p className="px-1.5 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Parts</p>
      {BASIC_PARTS.map((t) => <PartButton key={t} type={t} active={placing === t} onPick={onPick} />)}
      <button onClick={onToggleMore} className="mt-0.5 flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-xs text-gray-500 hover:bg-gray-100">
        {showMore ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} More parts
      </button>
      {showMore && MORE_PARTS.map((t) => <PartButton key={t} type={t} active={placing === t} onPick={onPick} />)}
    </div>
  );
}

// ------------------------------- Hover card -------------------------------

function partReadings(comp: VisualCircuitComponent, sim: CircuitSimulationResult | null): string[] {
  if (!sim) return [];
  const out: string[] = [];
  const i = sim.branch_currents[comp.name];
  const vAcross = (sim.node_voltages[comp.node1] ?? 0) - (sim.node_voltages[comp.node2] ?? 0);
  if (!isDevice(comp.type)) {
    if (i !== undefined) out.push(`Current ${formatQuantity(Math.abs(i), 'A')}`);
    out.push(`Voltage across ${formatQuantity(Math.abs(vAcross), 'V')}`);
    const p = sim.branch_powers[comp.name];
    if (p !== undefined && Math.abs(p) > 1e-15) out.push(p < 0 ? `Delivers ${formatQuantity(-p, 'W')}` : `Uses ${formatQuantity(p, 'W')}`);
  } else {
    const op = sim.device_ops?.find((o) => o.name === comp.name);
    if (op) {
      out.push(op.region.split(' (')[0]);
      const unitOf = (k: string) => (k.startsWith('V') ? 'V' : k.startsWith('I') ? 'A' : k === 'gm' ? 'S' : '');
      for (const [k, v] of op.quantities.filter(([k]) => ['Vd', 'Id', 'Vbe', 'Vce', 'Ic', 'Ib', 'Vgs', 'Vds'].includes(k))) out.push(`${k} = ${formatQuantity(v, unitOf(k), 3)}`);
    }
  }
  return out;
}

function HoverCard({ comp, result, at, scale, width }: { comp: VisualCircuitComponent; result: CircuitSimulationResult | null; at: Point; scale: number; width: number }) {
  const readings = partReadings(comp, result);
  const left = at.x + 50 * scale + 220 > width ? at.x - 50 * scale - 220 : at.x + 50 * scale;
  return (
    <div className="pointer-events-none absolute z-20 w-[220px] rounded-lg border border-gray-200 bg-white p-2.5 text-xs shadow-lg" style={{ left, top: at.y - 30 }}>
      <p className="font-semibold text-gray-900">{comp.name} <span className="font-normal text-gray-500">· {PART_NAME[comp.type]}</span></p>
      <p className="mt-0.5 text-gray-600">{PART_HELP[comp.type]}</p>
      {readings.length > 0 && <div className="mt-1.5 space-y-0.5 border-t border-gray-100 pt-1.5 font-medium text-gray-800">{readings.map((r) => <p key={r}>{r}</p>)}</div>}
      <p className="mt-1.5 text-gray-400">Click to edit</p>
    </div>
  );
}

// ------------------------------- Inspector -------------------------------

type SignalKind = 'dc' | 'step' | 'square' | 'sine';
function signalKind(spec?: string): SignalKind {
  const t = (spec ?? '').toLowerCase();
  if (t.includes('sin')) return 'sine';
  const m = t.match(/pulse\s*\(([^)]*)\)/);
  if (m) return m[1].trim().split(/[\s,]+/).length >= 7 ? 'square' : 'step';
  return 'dc';
}

function PartInspector({ comp, result, onChange, onRotate, onFlip, onDelete, onDetach, onClose, nodeColor }: {
  comp: VisualCircuitComponent;
  result: CircuitSimulationResult | null;
  onChange: (patch: Partial<VisualCircuitComponent>) => void;
  onRotate: () => void;
  onFlip?: () => void;
  onDelete: () => void;
  onDetach: (pin: 1 | 2 | 3) => void;
  onClose: () => void;
  nodeColor: (n: string) => string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [specDraft, setSpecDraft] = useState<string | null>(null);
  const sliderBase = useRef({ id: comp.id, value: comp.value });
  if (sliderBase.current.id !== comp.id) sliderBase.current = { id: comp.id, value: comp.value };
  useEffect(() => { setDraft(null); setSpecDraft(null); }, [comp.id]);

  const isSource = comp.type === 'VoltageSource' || comp.type === 'CurrentSource';
  const hasValue = !isDevice(comp.type) && comp.type !== 'Ground';
  const kind = signalKind(comp.source);
  const readings = partReadings(comp, result);

  const commitDraft = () => {
    if (draft === null) return;
    const v = parseEngValue(draft);
    if (v !== null && isFinite(v) && !(comp.type === 'Resistor' && v <= 0)) {
      if (isSource && comp.source) {
        // Keep the waveform shape, change its level.
        const next = kind === 'dc' ? comp.source.replace(/dc\s+\S+/i, `DC ${formatEng(v, 6)}`) : buildSignal(kind, v, /\bac\b/i.test(comp.source))!;
        onChange({ value: dcValueOfSpec(next), source: next });
      } else onChange({ value: v });
      sliderBase.current = { id: comp.id, value: v };
    }
    setDraft(null);
  };

  const base = sliderBase.current.value || 1;
  const amplitude = isSource && comp.source && kind !== 'dc' ? signalAmplitude(comp.source) : comp.value;
  const sliderPos = base !== 0 && comp.value !== 0 ? Math.round(500 + 250 * Math.log10(Math.abs((isSource ? amplitude : comp.value) / base))) : 500;
  const pins = terminalsOf(comp);

  return (
    <div className="absolute right-3 top-3 z-20 w-72 rounded-xl border border-gray-200 bg-white shadow-lg">
      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <PartIcon type={comp.type} className="h-5 w-8 text-gray-700" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">{comp.name}</p>
          <p className="text-xs text-gray-500">{PART_NAME[comp.type]}</p>
        </div>
        <button className="icon-btn" onClick={onRotate} title="Rotate (R)"><RotateCw className="h-4 w-4" /></button>
        {onFlip && <button className="icon-btn" onClick={onFlip} title="Flip left-right (F)"><FlipHorizontal2 className="h-4 w-4" /></button>}
        <button className="icon-btn hover:!text-red-600" onClick={onDelete} title="Delete (Del)"><Trash2 className="h-4 w-4" /></button>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)"><X className="h-4 w-4" /></button>
      </div>

      <div className="space-y-3 p-3">
        {hasValue && (
          <div>
            <label className="label">{isSource ? (kind === 'dc' ? 'Value' : 'Amplitude') : 'Value'}</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                className="input w-28 font-mono"
                value={draft ?? formatEng(isSource && kind !== 'dc' ? amplitude : comp.value, 6)}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitDraft}
                onKeyDown={(e) => { if (e.key === 'Enter') commitDraft(); if (e.key === 'Escape') setDraft(null); }}
              />
              <span className="text-sm text-gray-500">{comp.unit}</span>
            </div>
            <p className="mt-1 text-[11px] text-gray-400">Use SPICE prefixes: 4.7k, 10m, 100u, 2Meg</p>
            <input type="range" min={0} max={1000} value={Math.max(0, Math.min(1000, sliderPos))}
              onChange={(e) => {
                const v = parseFloat((base * Math.pow(10, (parseInt(e.target.value) - 500) / 250)).toPrecision(3));
                if (isSource && comp.source && kind !== 'dc') { const next = buildSignal(kind, v, /\bac\b/i.test(comp.source))!; onChange({ source: next, value: dcValueOfSpec(next) }); }
                else onChange({ value: v, ...(isSource && comp.source ? { source: comp.source.replace(/dc\s+\S+/i, `DC ${formatEng(v, 6)}`) } : {}) });
              }}
              className="mt-2 w-full accent-blue-600" title="Drag to try values and watch the circuit respond" />
          </div>
        )}

        {isDevice(comp.type) && comp.type !== 'Diode' && (
          <div>
            <label className="label">Type</label>
            <div className="mt-1">
              <select className="input" value={comp.modelKind}
                onChange={(e) => onChange({ modelKind: e.target.value as ModelKind, deviceArgs: `DEFAULT_${e.target.value.toUpperCase()}` })}>
                {(comp.type === 'BJT' ? ['npn', 'pnp'] : ['nmos', 'pmos']).map((k) => <option key={k} value={k}>{k.toUpperCase()}</option>)}
              </select>
            </div>
          </div>
        )}

        {readings.length > 0 && (
          <div className="rounded-lg bg-gray-50 px-2.5 py-2 text-xs text-gray-700">
            {readings.map((r) => <p key={r}>{r}</p>)}
          </div>
        )}

        <button onClick={() => setMore(!more)} className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-900">
          {more ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} More options
        </button>
        {more && (
          <div className="space-y-3">
            {isSource && (
              <div className="space-y-1.5">
                <label className="label">Signal over time</label>
                <select className="input w-full" value={kind}
                  onChange={(e) => { const k = e.target.value as SignalKind; const next = k === 'dc' ? (/\bac\b/i.test(comp.source ?? '') ? `DC ${formatEng(comp.value, 6)} AC 1` : undefined) : buildSignal(k, amplitude || 1, /\bac\b/i.test(comp.source ?? '')); onChange({ source: next, value: next ? dcValueOfSpec(next) : amplitude || comp.value }); }}>
                  <option value="dc">Constant (DC)</option>
                  <option value="step">Step at t = 0</option>
                  <option value="square">Square wave, 1 kHz</option>
                  <option value="sine">Sine wave, 1 kHz</option>
                </select>
                <label className="flex items-center gap-2 text-xs text-gray-700">
                  <input type="checkbox" className="accent-blue-600" checked={/\bac\b/i.test(comp.source ?? '')}
                    onChange={(e) => {
                      const next = kind === 'dc' ? (e.target.checked ? `DC ${formatEng(comp.value, 6)} AC 1` : undefined) : buildSignal(kind, amplitude || 1, e.target.checked);
                      onChange({ source: next, value: next ? dcValueOfSpec(next) : comp.value });
                    }} />
                  Input for frequency (AC) analysis
                </label>
                {comp.source && (
                  <input className="input w-full font-mono text-xs" value={specDraft ?? comp.source}
                    onChange={(e) => setSpecDraft(e.target.value)}
                    onBlur={() => { if (specDraft !== null) { const s = specDraft.trim(); onChange({ source: s || undefined, value: s ? dcValueOfSpec(s) : comp.value }); setSpecDraft(null); } }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    title="SPICE source text: PULSE(v1 v2 delay rise fall width period), SIN(offset amplitude freq), AC mag" />
                )}
              </div>
            )}
            {isDevice(comp.type) && (
              <div>
                <label className="label">Model (from a .model line)</label>
                <input className="input mt-1 w-full font-mono text-xs" defaultValue={comp.deviceArgs ?? ''} placeholder="default model"
                  onBlur={(e) => onChange({ deviceArgs: e.target.value.trim() || undefined })} />
              </div>
            )}
            <div>
              <label className="label">Connections</label>
              <div className="mt-1 space-y-1">
                {pins.map((t) => (
                  <div key={t.pin} className="flex items-center gap-2 text-xs">
                    <span className="w-16 text-gray-500">{pinLabel(comp.type, t.pin)}</span>
                    <input className="input w-20 py-0.5 font-mono text-xs font-semibold" style={{ color: nodeColor(t.node) }}
                      defaultValue={t.node} key={`${comp.id}:${t.pin}:${t.node}`}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.node) onChange({ [t.pin === 1 ? 'node1' : t.pin === 2 ? 'node2' : 'node3']: ['gnd', 'ground'].includes(v.toLowerCase()) ? '0' : v }); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      title="Node name (0 = ground). Two pins with the same node name are connected." />
                    <button className="icon-btn" onClick={() => onDetach(t.pin)} title="Disconnect this pin"><Unplug className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function signalAmplitude(spec: string): number {
  const nums = spec.replace(/[(),]/g, ' ').split(/\s+/).filter(Boolean).filter((t) => !/^(pulse|sin|ac|dc|pwl)$/i.test(t)).map((x) => parseEngValue(x) ?? 0);
  return nums[1] ?? 1; // PULSE(v1 v2 …) and SIN(offset amplitude …): the 2nd number
}

function buildSignal(k: SignalKind, amp: number, ac: boolean): string | undefined {
  const a = formatEng(amp, 6);
  const acPart = ac ? ' AC 1' : '';
  switch (k) {
    case 'step': return `PULSE(0 ${a} 0 1n 1n)${acPart}`;
    case 'square': return `PULSE(0 ${a} 0 1n 1n 500u 1m)${acPart}`;
    case 'sine': return `SIN(0 ${a} 1k)${acPart}`;
    default: return ac ? `DC ${a}${acPart}` : undefined;
  }
}
