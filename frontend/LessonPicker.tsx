import React, { useEffect } from 'react';
import type { PreloadedCircuit } from './types';
import type { Lesson } from './lessons';
import { X, Check, FilePlus2, ChevronRight } from 'lucide-react';

/** Where to start: a guided lesson, a ready-made example, or an empty canvas. */
export function LessonPicker({ lessons, finished, examples, onLesson, onExample, onBlank, onClose }: {
  lessons: Lesson[];
  finished: Set<string>;
  examples: PreloadedCircuit[];
  onLesson: (id: string) => void;
  onExample: (id: string) => void;
  onBlank: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-gray-900/30 p-4 pt-[8vh]" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">What would you like to do?</h2>
            <p className="text-sm text-gray-500">New to circuit simulation? Start with lesson 1 and go in order.</p>
          </div>
          <button className="icon-btn" onClick={onClose}><X className="h-5 w-5" /></button>
        </div>

        <div className="grid gap-6 p-6 md:grid-cols-[1.2fr_1fr]">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Guided lessons</h3>
            <ol className="space-y-1">
              {lessons.map((l, i) => (
                <li key={l.id}>
                  <button onClick={() => onLesson(l.id)} className="group flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left hover:bg-blue-50">
                    <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${finished.has(l.id) ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                      {finished.has(l.id) ? <Check className="h-3.5 w-3.5" /> : i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-gray-900">{l.title}</span>
                      <span className="block text-xs text-gray-500">{l.goal}</span>
                    </span>
                    <ChevronRight className="mt-1 h-4 w-4 text-gray-300 group-hover:text-blue-600" />
                  </button>
                </li>
              ))}
            </ol>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Or open a circuit</h3>
            <button onClick={onBlank} className="mb-2 flex w-full items-center gap-2 rounded-xl border border-dashed border-gray-300 px-3 py-2 text-left text-sm font-medium text-gray-700 hover:border-blue-400 hover:bg-blue-50">
              <FilePlus2 className="h-4 w-4" /> Empty canvas
            </button>
            <div className="max-h-[52vh] space-y-1 overflow-y-auto pr-1">
              {examples.map((ex) => (
                <button key={ex.id} onClick={() => onExample(ex.id)} className="w-full rounded-lg px-3 py-1.5 text-left hover:bg-gray-50" title={ex.description}>
                  <span className="block text-sm text-gray-800">{ex.title}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
