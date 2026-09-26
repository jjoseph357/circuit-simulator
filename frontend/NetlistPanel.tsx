import React, { useMemo, useRef, useState } from 'react';
import { explainLine, modelKinds, normalizeNode, validateNetlist, LineToken, GROUND_COLOR } from './netlist';
import { useGlow } from './ui';
import { SpiceReference } from './SpiceReference';
import { Check, Undo2, AlertCircle, Info, BookOpen } from 'lucide-react';

const ROLE_STYLE: Record<LineToken['role'], React.CSSProperties> = {
  name: { color: '#111827', fontWeight: 700 },
  node: { fontWeight: 700 },
  value: { color: '#b45309' },
  keyword: { color: '#7c3aed' },
  directive: { color: '#7c3aed', fontWeight: 700 },
  comment: { color: '#6b7280', fontStyle: 'italic' },
  model: { color: '#0f766e' },
  plain: { color: '#374151' },
};
const LINE_H = 22;

/**
 * The circuit as SPICE text. Node names are coloured like their wires on the schematic, the
 * selected part's line is highlighted, and the line under the cursor is explained in words.
 */
export function NetlistPanel({ text, applied, onChange, onApply, onRevert, selectedName, onCursorElement, nodeColors }: {
  text: string;
  /** The netlist the schematic currently shows. */
  applied: string;
  onChange: (text: string) => void;
  onApply: () => void;
  onRevert: () => void;
  selectedName: string | null;
  /** Called with the element on the cursor's line (or null), so the schematic can select it. */
  onCursorElement: (name: string | null) => void;
  nodeColors: Map<string, string>;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);
  const [cursorLine, setCursorLine] = useState<number | null>(null);
  const [showRef, setShowRef] = useState(false);
  const dirty = text !== applied;
  const glow = useGlow('netlist');
  const updateGlow = useGlow('netlist:update');

  const lines = useMemo(() => text.split('\n'), [text]);
  const firstContentLine = lines.findIndex((l) => l.trim());
  const infos = useMemo(() => { const models = modelKinds(text); return lines.map((l, i) => explainLine(l, i === firstContentLine, models)); }, [lines, firstContentLine, text]);
  const problems = useMemo(() => validateNetlist(text), [text]);
  const problemLines = new Set(problems.map((p) => p.line - 1));
  const selectedLine = selectedName ? infos.findIndex((i) => i.element?.toUpperCase() === selectedName.toUpperCase()) : -1;

  const trackCursor = () => {
    const ta = taRef.current;
    if (!ta) return;
    const line = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
    if (line !== cursorLine) {
      setCursorLine(line);
      onCursorElement(infos[line]?.element ?? null);
    }
  };

  const colorForNode = (t: string) => nodeColors.get(normalizeNode(t)) ?? (normalizeNode(t) === '0' ? GROUND_COLOR : '#6b7280');

  const renderLine = (line: string, i: number) => {
    const tokens = infos[i].tokens;
    const parts: React.ReactNode[] = [];
    let pos = 0;
    tokens.forEach((t, k) => {
      if (t.start > pos) parts.push(line.slice(pos, t.start));
      parts.push(<span key={k} style={t.role === 'node' ? { ...ROLE_STYLE.node, color: colorForNode(t.text) } : ROLE_STYLE[t.role]}>{t.text}</span>);
      pos = t.start + t.text.length;
    });
    if (pos < line.length) parts.push(line.slice(pos));
    return parts;
  };

  const shown = cursorLine !== null && cursorLine < lines.length && lines[cursorLine].trim() ? cursorLine : selectedLine >= 0 ? selectedLine : null;
  const shownInfo = shown !== null ? infos[shown] : null;

  return (
    <div className={`flex h-full flex-col bg-white${glow}`}>
      <div className="border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900">Netlist <span className="ml-1 font-normal text-gray-400">SPICE</span></h2>
          <button className="btn btn-ghost btn-sm -mr-2" onClick={() => setShowRef(true)} title="How to write a SPICE netlist"><BookOpen className="h-3.5 w-3.5" /> Syntax guide</button>
        </div>
        <p className="mt-0.5 text-xs text-gray-500">Your circuit as text: one line per part, <span className="font-mono">name&nbsp;node&nbsp;node&nbsp;value</span>.</p>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden font-mono text-[13px]">
        {/* Highlighted copy behind a transparent textarea: what you see is exactly what you type. */}
        <div ref={hlRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <div className="py-2">
            {lines.map((line, i) => (
              <div key={i} className={`flex ${i === selectedLine ? 'bg-blue-50' : i === cursorLine ? 'bg-gray-50' : ''}`} style={{ height: LINE_H, lineHeight: `${LINE_H}px` }}>
                <span className={`w-9 shrink-0 select-none pr-2 text-right text-[11px] ${problemLines.has(i) ? 'font-bold text-red-600' : 'text-gray-300'}`}>
                  {problemLines.has(i) ? '!' : i + 1}
                </span>
                <span className={`whitespace-pre pl-1 ${problemLines.has(i) ? 'underline decoration-red-400 decoration-wavy underline-offset-4' : ''}`}>{renderLine(line, i)}</span>
              </div>
            ))}
          </div>
        </div>
        <textarea
          ref={taRef}
          value={text}
          spellCheck={false}
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onKeyUp={trackCursor}
          onClick={trackCursor}
          onFocus={trackCursor}
          onBlur={() => setCursorLine(null)}
          onScroll={(e) => { if (hlRef.current) { hlRef.current.scrollTop = e.currentTarget.scrollTop; hlRef.current.scrollLeft = e.currentTarget.scrollLeft; } }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onApply(); } }}
          className="absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent py-2 pl-10 pr-2 text-transparent caret-gray-900 outline-none selection:bg-blue-200/60"
          style={{ lineHeight: `${LINE_H}px` }}
          aria-label="SPICE netlist"
        />
      </div>

      {dirty && (
        <div className="flex items-center gap-2 border-t border-blue-100 bg-blue-50 px-3 py-2">
          <p className="flex-1 text-xs text-blue-900">You edited the netlist.</p>
          <button className="btn btn-ghost btn-sm" onClick={onRevert} title="Throw away your text edits"><Undo2 className="h-3.5 w-3.5" /> Discard</button>
          <button className={`btn btn-primary btn-sm${updateGlow}`} onClick={onApply} title="Ctrl+Enter"><Check className="h-3.5 w-3.5" /> Update schematic</button>
        </div>
      )}

      <div className="min-h-[92px] border-t border-gray-200 bg-gray-50 px-4 py-3 text-xs">
        {problems.length > 0 && (shown === null || !problemLines.has(shown)) ? (
          <div className="flex gap-2 text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p><b>Line {problems[0].line}:</b> {problems[0].message}{problems.length > 1 ? ` (${problems.length - 1} more)` : ''} <button className="underline" onClick={() => setShowRef(true)}>Syntax guide</button></p>
          </div>
        ) : shownInfo && (shownInfo.text || shownInfo.error) ? (
          <div className="space-y-1">
            <p className="font-medium text-gray-400">Line {shown! + 1}</p>
            {shownInfo.text && <p className="text-gray-800">{shownInfo.text}</p>}
            {shownInfo.error && <p className="flex gap-1.5 text-red-700"><AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" /><span>{shownInfo.error} <button className="underline" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowRef(true)}>Syntax guide</button></span></p>}
          </div>
        ) : (
          <p className="flex gap-2 text-gray-500"><Info className="mt-0.5 h-4 w-4 shrink-0" />Click any line to see what it means.</p>
        )}
      </div>
      {showRef && <SpiceReference onClose={() => setShowRef(false)} />}
    </div>
  );
}
