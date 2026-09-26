import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CircuitDiagnostic, CircuitSimulationResult, PreloadedCircuit, VisualCircuitComponent } from './types';
import { fetchEngineInfo, solveCircuit, EngineInfo, SolverType } from './api';
import { loadWasmEngine, simulateInBrowser } from './wasmEngine';
import presets from '../presets.json';
import {
  applyAutoFix, autoLayout, componentsToNetlist, dropGroundIfNoSymbol, extractDirectives, extractTitle, formatQuantity,
  layoutWithHints, mergeLayout, nodeColorMap, nodesOf, parseNetlistElements,
} from './netlist';
import { CircuitCanvas } from './CircuitCanvas';
import { NetlistPanel } from './NetlistPanel';
import { GuidePanel } from './GuidePanel';
import { ResultsPanel } from './ResultsPanel';
import { AnalysisView } from './AnalysisView';
import { MathView } from './MathView';
import { ToolsView } from './ToolsView';
import { SettingsDialog } from './SettingsDialog';
import { LessonPicker } from './LessonPicker';
import { BottomTab, LabSnapshot, LESSONS, MathTab } from './lessons';
import { GuideContext, GuideTarget, useGlow } from './ui';
import { Play, Loader2, Settings as SettingsIcon, BookOpen, ChevronDown, ChevronUp, PanelLeftOpen, X, Zap } from 'lucide-react';

type Snapshot = { comps: VisualCircuitComponent[]; directives: string[] };

const LAST_LESSON_KEY = 'circuitlab.lastLesson';
const FINISHED_KEY = 'circuitlab.finishedLessons';
const readStore = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeStore = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

export function CircuitLab() {
  const examples = presets as unknown as PreloadedCircuit[];

  // ---------------- The circuit ----------------
  const [title, setTitle] = useState('My circuit');
  const [comps, setComps] = useState<VisualCircuitComponent[]>([]);
  const [directives, setDirectives] = useState<string[]>([]);
  const [netlist, setNetlist] = useState(() => componentsToNetlist([], [], 'My circuit'));
  const [editorText, setEditorText] = useState(netlist);
  const [history, setHistory] = useState<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const [fitKey, setFitKey] = useState(0);

  // ---------------- Simulation ----------------
  const [solver, setSolver] = useState<SolverType>('gaussian');
  const [wasmReady, setWasmReady] = useState<boolean | null>(null);
  const [serverInfo, setServerInfo] = useState<EngineInfo | null>(null);
  const [result, setResult] = useState<CircuitSimulationResult | null>(null);
  const [hasRun, setHasRun] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [timeIndex, setTimeIndex] = useState<number | null>(null);
  const [showCurrent, setShowCurrent] = useState(true);

  // ---------------- UI ----------------
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<string[]>([]);
  const [problemHighlight, setProblemHighlight] = useState<string[]>([]);
  const [bottomTab, setBottomTab] = useState<BottomTab>('results');
  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomHeight, setBottomHeight] = useState(300);
  const [mathTab, setMathTab] = useState<MathTab>('matrix');
  const [guideOpen, setGuideOpen] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  // ---------------- Lessons ----------------
  const [lessonId, setLessonId] = useState<string | null>(null);
  const [exampleId, setExampleId] = useState<string | null>(null);
  const [completed, setCompleted] = useState<string[]>([]);
  const [finished, setFinished] = useState<Set<string>>(() => new Set(JSON.parse(readStore(FINISHED_KEY) ?? '[]')));
  const lesson = LESSONS.find((l) => l.id === lessonId) ?? null;

  // ---------------- Solving ----------------
  const seq = useRef(0);
  const debounce = useRef<number | undefined>(undefined);
  const routing = useRef({ wasmReady, serverInfo, solver });
  routing.current = { wasmReady, serverInfo, solver };

  const runSimulation = useCallback(async (net: string) => {
    const my = ++seq.current;
    setSimulating(true);
    const { wasmReady: wasmOk, serverInfo: srv, solver: s } = routing.current;
    // faer is a native library, so it runs on the local server. Anything that fails there
    // falls back to the in-browser engine instead of showing an error.
    const tryServer = (s === 'faer' && srv?.has_faer) || !wasmOk;
    let res: CircuitSimulationResult | null = null;
    let note: string | null = null;
    try {
      if (tryServer) {
        try { res = await solveCircuit(net, s); } catch {
          setServerInfo(null);
          if (s === 'faer') note = 'faer runs on the local server, which isn’t reachable, so the built-in sparse LU solved this instead. Start the server with python circuit_simulator/start.py to use faer.';
        }
      }
      if (!res && wasmOk) res = await simulateInBrowser(net, s === 'faer' ? 'sparse_lu' : s);
      if (my !== seq.current) return;
      if (res) { setResult(res); setNotice(note ?? (s === 'faer' && !tryServer ? 'faer runs on the local server, which isn’t reachable, so the built-in sparse LU solved this instead.' : null)); }
      else setNotice('The simulation engine could not be loaded. Start the app with python circuit_simulator/start.py.');
    } finally {
      if (my === seq.current) setSimulating(false);
    }
  }, []);

  const scheduleRun = useCallback((net: string) => {
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => runSimulation(net), routing.current.wasmReady ? 16 : 150);
  }, [runSimulation]);

  useEffect(() => {
    fetchEngineInfo().then(setServerInfo).catch(() => setServerInfo(null));
    loadWasmEngine().then((ex) => setWasmReady(ex !== null));
  }, []);

  // ---------------- Changing the circuit ----------------
  const hasRunRef = useRef(hasRun);
  hasRunRef.current = hasRun;

  /** The one way the circuit changes from the canvas, undo, or analysis settings. */
  const commit = useCallback((next: VisualCircuitComponent[], nextDirectives: string[], opts: { record?: boolean; title?: string } = {}) => {
    const t = opts.title ?? title;
    const net = componentsToNetlist(next, nextDirectives, t);
    if (opts.record !== false) setHistory((h) => ({ past: [...h.past.slice(-60), { comps, directives }], future: [] }));
    setComps(next);
    setDirectives(nextDirectives);
    setNetlist(net);
    setEditorText(net);
    if (hasRunRef.current) scheduleRun(net);
  }, [comps, directives, title, scheduleRun]);

  const onCanvasChange = (next: VisualCircuitComponent[]) => {
    const hadGround = comps.some((c) => c.type === 'Ground');
    commit(hadGround ? dropGroundIfNoSymbol(next) : next, directives);
  };

  /** Make netlist text the working circuit (from the editor, a preset, or a fix). */
  const loadNetlist = useCallback((text: string, opts: { relayout?: boolean; resetRun?: boolean; layout?: PreloadedCircuit['layout'] } = {}) => {
    const elements = parseNetlistElements(text);
    const merged = opts.relayout ? null : mergeLayout(comps, elements);
    const next = merged ?? (opts.layout ? layoutWithHints(elements, opts.layout) : autoLayout(elements));
    setHistory((h) => ({ past: [...h.past.slice(-60), { comps, directives }], future: [] }));
    setComps(next);
    setDirectives(extractDirectives(text));
    setTitle(extractTitle(text) ?? 'My circuit');
    setNetlist(text);
    setEditorText(text);
    setSelectedId(null);
    setTimeIndex(null);
    if (!merged) setFitKey((k) => k + 1);
    if (opts.resetRun) { setHasRun(false); setResult(null); setNotice(null); }
    else if (hasRunRef.current) runSimulation(text);
  }, [comps, directives, runSimulation]);

  const undo = () => {
    const prev = history.past[history.past.length - 1];
    if (!prev) return;
    setHistory({ past: history.past.slice(0, -1), future: [{ comps, directives }, ...history.future] });
    commit(prev.comps, prev.directives, { record: false });
  };
  const redo = () => {
    const next = history.future[0];
    if (!next) return;
    setHistory({ past: [...history.past, { comps, directives }], future: history.future.slice(1) });
    commit(next.comps, next.directives, { record: false });
  };

  const run = () => {
    let net = netlist;
    if (editorText !== netlist) { loadNetlist(editorText); net = editorText; }
    if (parseNetlistElements(net).length === 0) { setNotice('Add some parts to the canvas first.'); return; }
    setHasRun(true);
    setBottomOpen(true);
    runSimulation(net);
  };

  const fix = (d: CircuitDiagnostic) => { if (d.fix) loadNetlist(applyAutoFix(netlist, d.fix)); };

  // ---------------- Lessons & examples ----------------
  const startLesson = (id: string) => {
    const l = LESSONS.find((x) => x.id === id);
    if (!l) return;
    setLessonId(id);
    setExampleId(null);
    setCompleted([]);
    setShowPicker(false);
    setGuideOpen(true);
    setBottomTab('results');
    setMathTab('matrix');
    writeStore(LAST_LESSON_KEY, id);
    const preset = l.preset ? examples.find((e) => e.id === l.preset) : null;
    if (preset) loadNetlist(preset.netlist, { relayout: true, resetRun: true, layout: preset.layout });
    else {
      setTitle('My first circuit');
      setComps([]); setDirectives([]);
      const net = componentsToNetlist([], [], 'My first circuit');
      setNetlist(net); setEditorText(net);
      setHistory({ past: [], future: [] });
      setHasRun(false); setResult(null); setNotice(null); setTimeIndex(null); setSelectedId(null);
      setFitKey((k) => k + 1);
    }
  };
  const openExample = (id: string) => {
    const ex = examples.find((e) => e.id === id);
    if (!ex) return;
    setLessonId(null);
    setExampleId(id);
    setShowPicker(false);
    loadNetlist(ex.netlist, { relayout: true, resetRun: true, layout: ex.layout });
  };
  const openBlank = () => {
    setLessonId(null); setExampleId(null); setShowPicker(false);
    setTitle('My circuit'); setComps([]); setDirectives([]);
    const net = componentsToNetlist([], [], 'My circuit');
    setNetlist(net); setEditorText(net);
    setHasRun(false); setResult(null); setNotice(null); setTimeIndex(null); setSelectedId(null);
    setFitKey((k) => k + 1);
  };

  // First visit: lesson 1. Later visits: the last lesson.
  useEffect(() => { startLesson(readStore(LAST_LESSON_KEY) ?? LESSONS[0].id); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const shownResult = hasRun ? result : null;
  const snapshot: LabSnapshot = {
    comps, result: shownResult, hasRun, bottomTab: bottomOpen ? bottomTab : null, mathTab, timeIndex, inspecting,
    netlistEdited: editorText !== netlist,
  };
  const currentStep = lesson?.steps.find((s) => !completed.includes(s.id)) ?? null;

  // Tick off the current step as soon as its check passes (one step per render, in order).
  useEffect(() => {
    if (!lesson || !currentStep?.check) return;
    if (currentStep.check(snapshot)) setCompleted((c) => (c.includes(currentStep.id) ? c : [...c, currentStep.id]));
  });
  useEffect(() => {
    if (lesson && !currentStep && !finished.has(lesson.id)) {
      const next = new Set(finished).add(lesson.id);
      setFinished(next);
      writeStore(FINISHED_KEY, JSON.stringify([...next]));
    }
  }, [lesson, currentStep, finished]);

  const guideTarget: GuideTarget | null = currentStep && !currentStep.quiz ? currentStep.target ?? null : null;

  // ---------------- Derived display ----------------
  const displayResult = useMemo<CircuitSimulationResult | null>(() => {
    const tr = shownResult?.transient;
    if (!shownResult || !tr || timeIndex === null) return shownResult;
    const k = Math.min(timeIndex, tr.time.length - 1);
    const node_voltages: Record<string, number> = { '0': 0 };
    for (const [n, vs] of Object.entries(tr.node_voltages)) node_voltages[n] = vs[k];
    const branch_currents: Record<string, number> = {};
    for (const [n, is] of Object.entries(tr.branch_currents)) branch_currents[n] = is[k];
    const device_ops = (shownResult.device_ops ?? []).map((op) => {
      const terminals = op.terminals.map((t, i) => ({ ...t, current: tr.terminal_currents?.[`${op.name}:${i}`]?.[k] ?? t.current }));
      const region = op.kind === 'diode' ? (terminals[0].current > 1e-6 ? 'forward (conducting)' : 'off') : '';
      return { ...op, terminals, region, quantities: [] as Array<[string, number]> };
    });
    return { ...shownResult, node_voltages, branch_currents, device_ops };
  }, [shownResult, timeIndex]);

  const nodeColors = useMemo(() => nodeColorMap(comps.flatMap(nodesOf)), [comps]);
  const selectedName = comps.find((c) => c.id === selectedId)?.name ?? null;
  const timeLabel = shownResult?.transient && timeIndex !== null ? `at t = ${formatQuantity(shownResult.transient.time[Math.min(timeIndex, shownResult.transient.time.length - 1)], 's', 4)}` : null;
  const headerLabel = lesson ? `Lesson ${LESSONS.indexOf(lesson) + 1}: ${lesson.title}` : exampleId ? examples.find((e) => e.id === exampleId)?.title ?? title : 'Free build';
  const nextLesson = lesson ? LESSONS[LESSONS.indexOf(lesson) + 1] ?? null : null;

  // Drag the divider above the bottom panel to resize it.
  const startResize = (e: React.MouseEvent) => {
    const y0 = e.clientY, h0 = bottomHeight;
    const move = (ev: MouseEvent) => setBottomHeight(Math.max(140, Math.min(window.innerHeight - 260, h0 + (y0 - ev.clientY))));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <GuideContext.Provider value={guideTarget}>
      <div className="flex h-dvh min-h-[600px] flex-col overflow-hidden bg-gray-100 text-gray-900">
        {/* Top bar: where you are, and the one button that matters */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600"><Zap className="h-4 w-4 text-white" /></div>
            <span className="text-base font-semibold tracking-tight">Circuit Lab</span>
          </div>
          <span className="h-6 w-px bg-gray-200" />
          <LessonButton label={headerLabel} onClick={() => setShowPicker(true)} />
          <div className="ml-auto flex items-center gap-2">
            <RunButton onClick={run} simulating={simulating} hasRun={hasRun} />
            <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings"><SettingsIcon className="h-5 w-5" /></button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Guide */}
          {guideOpen ? (
            <aside className="w-80 shrink-0 border-r border-gray-200">
              <GuidePanel lesson={lesson} completed={completed} onComplete={(id) => setCompleted((c) => [...c, id])}
                onRestart={() => lesson && startLesson(lesson.id)} nextLesson={nextLesson} onStartLesson={startLesson}
                onOpenLessons={() => setShowPicker(true)} result={shownResult} onFix={fix} onHighlight={setProblemHighlight}
                onCollapse={() => setGuideOpen(false)} />
            </aside>
          ) : (
            <button onClick={() => setGuideOpen(true)} className="flex w-9 shrink-0 flex-col items-center gap-2 border-r border-gray-200 bg-white pt-3 text-gray-500 hover:text-gray-900" title="Show the guide">
              <PanelLeftOpen className="h-4 w-4" />
              <span className="text-xs font-medium [writing-mode:vertical-rl]">Guide</span>
            </button>
          )}

          {/* Schematic + results */}
          <main className="flex min-w-0 flex-1 flex-col">
            {notice && (
              <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
                <span className="flex-1">{notice}</span>
                <button className="icon-btn" onClick={() => setNotice(null)}><X className="h-4 w-4" /></button>
              </div>
            )}
            <div className="relative min-h-0 flex-1">
              <CircuitCanvas
                components={comps} onChange={onCanvasChange} result={displayResult}
                selectedId={selectedId} onSelect={setSelectedId}
                highlightedNames={[...inspecting, ...problemHighlight]} fitKey={fitKey} showCurrent={showCurrent}
                onUndo={undo} onRedo={redo} canUndo={history.past.length > 0} canRedo={history.future.length > 0}
              />
            </div>

            <section className="flex shrink-0 flex-col border-t border-gray-200 bg-gray-50" style={{ height: bottomOpen ? bottomHeight : undefined }}>
              {bottomOpen && <div onMouseDown={startResize} className="h-1.5 shrink-0 cursor-row-resize hover:bg-blue-200" title="Drag to resize" />}
              <div className="flex shrink-0 items-center border-b border-gray-200 bg-white px-2">
                {([
                  ['results', 'Results'], ['graphs', 'Graphs'], ['math', 'How it’s solved'], ['tools', 'Tools'],
                ] as const).map(([id, label]) => (
                  <BottomTabButton key={id} id={id} label={label} active={bottomOpen && bottomTab === id}
                    dot={id === 'graphs' && !!shownResult && !!(shownResult.transient || shownResult.ac || shownResult.dc_sweep)}
                    onClick={() => { setBottomTab(id); setBottomOpen(true); }} />
                ))}
                <button className="icon-btn ml-auto" onClick={() => setBottomOpen(!bottomOpen)} title={bottomOpen ? 'Hide this panel' : 'Show this panel'}>
                  {bottomOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                </button>
              </div>
              {bottomOpen && (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {bottomTab === 'results' && <ResultsPanel result={displayResult} hasRun={hasRun} comps={comps} nodeColors={nodeColors} timeLabel={timeLabel} onOpenGraphs={() => setBottomTab('graphs')} />}
                  {bottomTab === 'graphs' && (
                    <AnalysisView result={shownResult} hasRun={hasRun} directives={directives} nodeColors={nodeColors}
                      onApplyDirectives={(lines) => { setTimeIndex(null); commit(comps, lines); if (!hasRun) { setHasRun(true); runSimulation(componentsToNetlist(comps, lines, title)); } }}
                      timeIndex={timeIndex} onTimeIndexChange={setTimeIndex} />
                  )}
                  {bottomTab === 'math' && <MathView result={shownResult} hasRun={hasRun} tab={mathTab} onTab={setMathTab} selectedName={selectedName} onInspect={setInspecting} />}
                  {bottomTab === 'tools' && <ToolsView netlist={netlist} result={shownResult} serverOnline={!!serverInfo} onApplyNetlist={(net, relayout) => loadNetlist(net, { relayout })} />}
                </div>
              )}
            </section>
          </main>

          {/* Netlist */}
          <aside className="w-[22rem] shrink-0 border-l border-gray-200">
            <NetlistPanel text={editorText} applied={netlist} onChange={setEditorText}
              onApply={() => loadNetlist(editorText)} onRevert={() => setEditorText(netlist)}
              selectedName={selectedName}
              onCursorElement={(name) => { const c = name ? comps.find((x) => x.name.toUpperCase() === name.toUpperCase()) : null; if (c) setSelectedId(c.id); }}
              nodeColors={nodeColors} />
          </aside>
        </div>

        {showSettings && (
          <SettingsDialog onClose={() => setShowSettings(false)} solver={solver}
            onSolver={(s) => { setSolver(s); routing.current.solver = s; if (s === 'faer') fetchEngineInfo().then((i) => { setServerInfo(i); routing.current.serverInfo = i; }).catch(() => setServerInfo(null)).finally(() => { if (hasRun) runSimulation(netlist); }); else if (hasRun) runSimulation(netlist); }}
            showCurrent={showCurrent} onShowCurrent={setShowCurrent} serverOnline={!!serverInfo} />
        )}
        {showPicker && (
          <LessonPicker lessons={LESSONS} finished={finished} examples={examples}
            onLesson={startLesson} onExample={openExample} onBlank={openBlank} onClose={() => setShowPicker(false)} />
        )}
      </div>
    </GuideContext.Provider>
  );
}

function LessonButton({ label, onClick }: { label: string; onClick: () => void }) {
  const glow = useGlow('lessons');
  return (
    <button onClick={onClick} className={`btn btn-ghost max-w-md${glow}`} title="Lessons and example circuits">
      <BookOpen className="h-4 w-4 shrink-0 text-blue-600" />
      <span className="truncate">{label}</span>
      <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
    </button>
  );
}

function RunButton({ onClick, simulating, hasRun }: { onClick: () => void; simulating: boolean; hasRun: boolean }) {
  const glow = useGlow('run');
  return (
    <button onClick={onClick} className={`btn btn-primary px-5${glow}`} title={hasRun ? 'Results update by themselves as you edit. Press to run again.' : 'Simulate the circuit'}>
      {simulating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
      Run
    </button>
  );
}

function BottomTabButton({ id, label, active, dot, onClick }: { id: BottomTab; label: string; active: boolean; dot: boolean; onClick: () => void }) {
  const glow = useGlow(`tab:${id}` as GuideTarget);
  return (
    <button onClick={onClick} className={`tab relative${active ? ' tab-active' : ''}${glow}`}>
      {label}
      {dot && !active && <span className="absolute right-1 top-2 h-1.5 w-1.5 rounded-full bg-blue-500" />}
    </button>
  );
}

export default CircuitLab;
