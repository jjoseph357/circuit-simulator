import React, { useEffect, useState } from 'react';
import type { CircuitDiagnostic, CircuitSimulationResult } from './types';
import type { Lesson, Step } from './lessons';
import { Check, ChevronRight, CircleAlert, TriangleAlert, Wrench, PartyPopper, BookOpen, RotateCcw, PanelLeftClose } from 'lucide-react';

interface GuidePanelProps {
  lesson: Lesson | null;
  completed: string[];
  onComplete: (stepId: string) => void;
  onRestart: () => void;
  nextLesson: Lesson | null;
  onStartLesson: (id: string) => void;
  onOpenLessons: () => void;
  /** Latest result after Run (null before). */
  result: CircuitSimulationResult | null;
  onFix: (d: CircuitDiagnostic) => void;
  onHighlight: (names: string[]) => void;
  onCollapse: () => void;
}

/** Friendlier wording for the Doctor's findings. */
const PROBLEM_TITLE: Record<string, string> = {
  ERR_NO_GROUND: 'The circuit has no ground',
  ERR_PARSE: 'The netlist has a mistake',
  WARN_FLOATING_NODE: 'Something is only connected at one end',
  ERR_CURRENT_ONLY_NODE: 'A node is only connected to current sources',
  ERR_ISOLATED_ISLAND: 'Part of the circuit is cut off from ground',
  ERR_KVL_VIOLATION: 'Voltage sources disagree',
  ERR_PARALLEL_VOLTAGE_SOURCES: 'Two voltage sources are in parallel',
  WARN_SELF_SHORT: 'A part has both ends on the same node',
  WARN_DC_FLOATING_CAP_NODE: 'A node only touches capacitors',
  WARN_NO_AC_SOURCE: 'No source is marked as the AC input',
  WARN_DIODE_NO_CURRENT_LIMIT: 'Nothing limits a diode’s current',
};

export function GuidePanel({
  lesson, completed, onComplete, onRestart, nextLesson, onStartLesson, onOpenLessons, result, onFix, onHighlight, onCollapse,
}: GuidePanelProps) {
  const done = new Set(completed);
  const currentIdx = lesson ? lesson.steps.findIndex((s) => !done.has(s.id)) : -1;
  const finished = lesson !== null && currentIdx === -1;
  const progress = lesson ? lesson.steps.filter((s) => done.has(s.id)).length : 0;

  const problems = (result?.diagnostics ?? []).filter((d) => d.severity !== 'info');
  const failed = result && !result.success;

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-start gap-2 border-b border-gray-200 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-600">{lesson ? 'Lesson' : 'Free build'}</p>
          <h2 className="text-base font-semibold leading-snug text-gray-900">{lesson ? lesson.title : 'Build anything'}</h2>
        </div>
        <button className="icon-btn -mr-1" onClick={onCollapse} title="Hide the guide"><PanelLeftClose className="h-4 w-4" /></button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {(failed || problems.length > 0) && (
          <section className="space-y-2">
            {failed && problems.filter((p) => p.severity === 'error').length === 0 && (
              <ProblemCard title="The circuit could not be solved" text={result!.error_message ?? ''} severity="error" />
            )}
            {problems.slice(0, 3).map((d, i) => (
              <ProblemCard key={`${d.code}${i}`} title={PROBLEM_TITLE[d.code] ?? d.title} text={d.suggestion || d.message} detail={d.code === 'ERR_PARSE' ? d.message : undefined}
                severity={d.severity === 'error' ? 'error' : 'warning'} fixLabel={d.fix?.label}
                onFix={d.fix ? () => onFix(d) : undefined}
                onHover={(on) => onHighlight(on ? d.components_affected : [])} />
            ))}
          </section>
        )}

        {lesson ? (
          <>
            <div>
              <p className="text-sm text-gray-600">{lesson.goal}</p>
              <div className="mt-3 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${(progress / lesson.steps.length) * 100}%` }} />
                </div>
                <span className="text-xs tabular-nums text-gray-500">{progress} / {lesson.steps.length}</span>
              </div>
            </div>

            <ol className="space-y-1.5">
              {lesson.steps.map((step, i) => (
                <StepItem key={`${lesson.id}:${step.id}`} step={step} index={i} state={done.has(step.id) ? 'done' : i === currentIdx ? 'current' : 'todo'}
                  onComplete={() => onComplete(step.id)} />
              ))}
            </ol>

            {finished && (
              <div className="rounded-xl border border-green-200 bg-green-50 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-green-800"><PartyPopper className="h-4 w-4" /> Lesson complete</p>
                <p className="mt-1 text-sm text-green-800">Nice work. Keep experimenting with this circuit, or move on.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {nextLesson && <button className="btn btn-primary btn-sm" onClick={() => onStartLesson(nextLesson.id)}>Next: {nextLesson.title} <ChevronRight className="h-3.5 w-3.5" /></button>}
                  <button className="btn btn-secondary btn-sm" onClick={onOpenLessons}>All lessons</button>
                </div>
              </div>
            )}

            {!finished && progress > 0 && (
              <button onClick={onRestart} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700"><RotateCcw className="h-3 w-3" /> Start this lesson over</button>
            )}
          </>
        ) : (
          <FreeBuildTips onOpenLessons={onOpenLessons} />
        )}
      </div>
    </div>
  );
}

function StepItem({ step, index, state, onComplete }: { step: Step; index: number; state: 'done' | 'current' | 'todo'; onComplete: () => void }) {
  if (state !== 'current') {
    return (
      <li className="flex items-start gap-2.5 px-1 py-1">
        <span className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${state === 'done' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
          {state === 'done' ? <Check className="h-3 w-3" /> : index + 1}
        </span>
        <span className={`text-sm ${state === 'done' ? 'text-gray-400 line-through decoration-gray-300' : 'text-gray-400'}`}>{step.title}</span>
      </li>
    );
  }
  return (
    <li className="rounded-xl border border-blue-200 bg-blue-50/60 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-semibold text-white">{index + 1}</span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-semibold text-gray-900">{step.title}</p>
          {step.detail && <p className="text-sm leading-relaxed text-gray-700">{step.detail}</p>}
          {step.quiz ? <QuizBox step={step} onCorrect={onComplete} />
            : !step.check ? <button className="btn btn-primary btn-sm" onClick={onComplete}>Done <ChevronRight className="h-3.5 w-3.5" /></button>
            : <p className="text-xs text-blue-700">This ticks itself off when you’ve done it.</p>}
        </div>
      </div>
    </li>
  );
}

function QuizBox({ step, onCorrect }: { step: Step; onCorrect: () => void }) {
  const quiz = step.quiz!;
  const [picked, setPicked] = useState<number | null>(null);
  const [wrong, setWrong] = useState<Set<number>>(new Set());
  useEffect(() => { setPicked(null); setWrong(new Set()); }, [step.id]);
  const right = picked === quiz.answer;
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-800">{quiz.question}</p>
      <div className="space-y-1.5">
        {quiz.options.map((o, i) => (
          <button key={o} disabled={right}
            onClick={() => { setPicked(i); if (i !== quiz.answer) setWrong(new Set([...wrong, i])); }}
            className={`w-full rounded-lg border px-3 py-1.5 text-left text-sm transition-colors ${
              right && i === quiz.answer ? 'border-green-500 bg-green-50 text-green-900'
                : wrong.has(i) ? 'border-red-200 bg-red-50 text-red-800 line-through'
                : 'border-gray-300 bg-white text-gray-800 hover:border-blue-400 hover:bg-blue-50'}`}>
            {o}
          </button>
        ))}
      </div>
      {picked !== null && !right && <p className="text-sm text-red-700">Not quite. Try another answer.</p>}
      {(right || wrong.size >= 2) && <p className="text-sm leading-relaxed text-gray-700">{quiz.explain}</p>}
      {right && <button className="btn btn-primary btn-sm" onClick={onCorrect}>Continue <ChevronRight className="h-3.5 w-3.5" /></button>}
    </div>
  );
}

function ProblemCard({ title, text, detail, severity, fixLabel, onFix, onHover }: {
  title: string; text: string; detail?: string; severity: 'error' | 'warning'; fixLabel?: string; onFix?: () => void; onHover?: (on: boolean) => void;
}) {
  const err = severity === 'error';
  return (
    <div onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}
      className={`rounded-xl border p-3 ${err ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
      <p className={`flex items-center gap-1.5 text-sm font-semibold ${err ? 'text-red-800' : 'text-amber-900'}`}>
        {err ? <CircleAlert className="h-4 w-4 shrink-0" /> : <TriangleAlert className="h-4 w-4 shrink-0" />}{title}
      </p>
      {text && <p className={`mt-1 text-sm ${err ? 'text-red-800' : 'text-amber-900'}`}>{text}</p>}
      {detail && <p className="mt-1 font-mono text-xs text-red-700">{detail}</p>}
      {onFix && (
        <button className="btn btn-secondary btn-sm mt-2" onClick={onFix}><Wrench className="h-3.5 w-3.5" /> Fix it: {fixLabel}</button>
      )}
    </div>
  );
}

function FreeBuildTips({ onOpenLessons }: { onOpenLessons: () => void }) {
  const tips: Array<[string, string]> = [
    ['Place parts', 'Pick a part on the left of the canvas, then click where it should go. Press R to rotate.'],
    ['Connect them', 'Drag from one pin to another. Pins with the same colour are the same node.'],
    ['Add ground', 'Every circuit needs one ground symbol: the 0 V reference.'],
    ['Run', 'Press Run. Node tags show voltages; hover over a part for its current.'],
    ['Explore', 'Change values and watch the results update. See Graphs and “How it’s solved” below the schematic.'],
  ];
  return (
    <div className="space-y-4">
      <ol className="space-y-3">
        {tips.map(([t, d], i) => (
          <li key={t} className="flex gap-2.5">
            <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-500">{i + 1}</span>
            <div><p className="text-sm font-medium text-gray-900">{t}</p><p className="text-sm text-gray-600">{d}</p></div>
          </li>
        ))}
      </ol>
      <button className="btn btn-secondary w-full" onClick={onOpenLessons}><BookOpen className="h-4 w-4" /> Follow a guided lesson</button>
    </div>
  );
}
