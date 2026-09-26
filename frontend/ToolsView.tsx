import React, { useMemo, useState } from 'react';
import type { ArchitectResult, CircuitSimulationResult } from './types';
import { askCircuitArchitect, askSocraticProfessor } from './api';
import { TunerPanel } from './TunerPanel';
import { Segmented } from './ui';
import { Send, Loader2, CheckCircle2, AlertTriangle, XCircle, Wand2, Info } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

type Tool = 'tune' | 'tutor' | 'design';

/** Optional helpers: the tuner (runs in the browser) and two AI helpers (need the local server). */
export function ToolsView({ netlist, result, serverOnline, onApplyNetlist }: {
  netlist: string;
  result: CircuitSimulationResult | null;
  serverOnline: boolean;
  onApplyNetlist: (netlist: string, relayout: boolean) => void;
}) {
  const [tool, setTool] = useState<Tool>('tune');
  return (
    <div className="space-y-3 p-4">
      <Segmented value={tool} onChange={setTool} options={[
        { value: 'tune', label: 'Find values for me' },
        { value: 'tutor', label: 'Ask the tutor' },
        { value: 'design', label: 'Design from words' },
      ]} />
      {tool === 'tune' && (
        <div className="card max-w-3xl p-4">
          <p className="mb-3 text-sm text-gray-600">Say what the circuit should do (for example “node out = 3.3 V”) and which parts may change. The simulator tries values until it gets there.</p>
          <TunerPanel netlist={netlist} result={result} onApply={(net) => onApplyNetlist(net, false)} />
        </div>
      )}
      {tool !== 'tune' && !serverOnline && (
        <div className="card flex max-w-3xl gap-2 p-4 text-sm text-gray-600">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
          <p>The AI helpers need the Circuit Lab server. Start it with <span className="font-mono">python circuit_simulator/start.py</span>, then pick an AI provider in Settings (the gear, top right).</p>
        </div>
      )}
      {tool === 'tutor' && serverOnline && <Tutor netlist={netlist} result={result} />}
      {tool === 'design' && serverOnline && <Designer onApply={(net) => onApplyNetlist(net, true)} />}
    </div>
  );
}

function Tutor({ netlist, result }: { netlist: string; result: CircuitSimulationResult | null }) {
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([
    { role: 'assistant', content: 'Ask me about any voltage, current or matrix entry in your circuit. I’ll answer with questions that help you work it out.' },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const starters = useMemo(() => {
    const nodes = Object.entries(result?.node_voltages ?? {}).filter(([n]) => n !== '0').sort((a, b) => b[1] - a[1]);
    const qs: string[] = [];
    if (nodes.length >= 2) qs.push(`Why is node ${nodes[1][0]} lower than node ${nodes[0][0]}?`);
    if (nodes.length >= 1) qs.push(`How do I write KCL at node ${nodes[nodes.length - 1][0]}?`);
    qs.push(result?.variable_names.some((v) => v.startsWith('I(')) ? 'Why does a voltage source add an extra row?' : 'Why does a current source only change b?');
    return qs;
  }, [result]);

  const send = async (q = input) => {
    if (!q.trim()) return;
    const next = [...messages, { role: 'user' as const, content: q }];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const res = await askSocraticProfessor(q, netlist, result?.node_voltages ?? {}, result?.branch_currents ?? {});
      setMessages([...next, { role: 'assistant', content: res.answer }]);
    } catch (e) {
      setMessages([...next, { role: 'assistant', content: `Sorry, I couldn’t reach the tutor (${e}).` }]);
    } finally { setLoading(false); }
  };

  return (
    <div className="card flex max-w-3xl flex-col gap-3 p-4">
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {messages.map((m, i) => (
          <div key={i} className={`rounded-xl px-3 py-2 text-sm leading-relaxed ${m.role === 'user' ? 'ml-10 bg-blue-600 text-white' : 'mr-10 bg-gray-100 text-gray-800'}`}>
            <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{m.content}</ReactMarkdown>
          </div>
        ))}
        {loading && <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Thinking…</p>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {starters.map((q) => <button key={q} onClick={() => send(q)} className="rounded-full border border-gray-200 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50">{q}</button>)}
      </div>
      <div className="flex gap-2">
        <input className="input flex-1" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="Ask a question…" />
        <button className="btn btn-primary" onClick={() => send()} disabled={loading || !input.trim()}><Send className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

function Designer({ onApply }: { onApply: (netlist: string) => void }) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<ArchitectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (p = prompt) => {
    if (!p.trim()) return;
    setBusy(true); setError(null);
    try { setOut(await askCircuitArchitect(p)); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const ok = out && out.verification.success && !out.verification.diagnostics.some((d) => d.severity === 'error') && out.verification.spec_checks.every((c) => c.passed);
  return (
    <div className="card max-w-3xl space-y-3 p-4">
      <p className="text-sm text-gray-600">Describe a circuit. The design is simulated and checked against the numbers you asked for before you see it.</p>
      <div className="flex flex-wrap gap-1.5">
        {['A 12 V to 3.3 V voltage divider drawing 1 mA', 'An RC low-pass filter with a 1 kHz cutoff'].map((p) => (
          <button key={p} onClick={() => { setPrompt(p); run(p); }} className="rounded-full border border-gray-200 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50">{p}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <input className="input flex-1" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} placeholder="e.g. divide 9 V down to 5 V using at most 2 mA" />
        <button className="btn btn-primary" onClick={() => run()} disabled={busy || !prompt.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Design</button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {out && (
        <div className="space-y-2 rounded-lg border border-gray-200 p-3">
          <p className={`flex items-center gap-1.5 text-sm font-semibold ${ok ? 'text-green-700' : 'text-amber-700'}`}>
            {ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}{ok ? 'Checked by simulation' : out.netlist ? 'Needs attention' : 'No design produced'}
          </p>
          {out.verification.spec_checks.map((c, i) => (
            <p key={i} className="flex items-start gap-1.5 text-sm text-gray-700">
              {c.passed ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />}{c.label} <span className="text-gray-400">({c.detail})</span>
            </p>
          ))}
          {out.netlist && (
            <>
              <pre className="overflow-x-auto rounded-lg bg-gray-50 p-2.5 font-mono text-xs text-gray-800">{out.netlist}</pre>
              <button className="btn btn-secondary btn-sm" onClick={() => onApply(out.netlist)}>Load into the schematic</button>
            </>
          )}
          <div className="max-h-48 space-y-2 overflow-y-auto text-sm text-gray-700"><ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{out.explanation}</ReactMarkdown></div>
        </div>
      )}
    </div>
  );
}
