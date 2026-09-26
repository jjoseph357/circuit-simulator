import React, { useEffect, useState } from 'react';
import { X, KeyRound, Loader2, CheckCircle2 } from 'lucide-react';
import { fetchLlmSettings, saveLlmSettings, LlmSettings, SolverType } from './api';

const PROVIDER_LABEL: Record<string, string> = {
  local: 'Offline (no AI provider)',
  ollama: 'Ollama (local model)',
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini',
};
const KEY_FIELD: Record<string, string> = { openai: 'openai_api_key', anthropic: 'anthropic_api_key', gemini: 'gemini_api_key' };

const SOLVERS: Array<{ id: SolverType; label: string; text: string }> = [
  { id: 'gaussian', label: 'Step-by-step (Gaussian elimination)', text: 'Records every row operation so you can follow it in “How it’s solved”. Best for learning.' },
  { id: 'sparse_lu', label: 'Sparse LU', text: 'Stores only the non-zero entries, like real simulators. Handles circuits with 100 000+ nodes.' },
  { id: 'faer', label: 'faer (industrial sparse LU)', text: 'A production solver library. Runs on the local server; without it the sparse LU is used instead.' },
];

/** Solver, display and AI settings. API keys are stored by the local server, never sent back to the page. */
export function SettingsDialog({ onClose, solver, onSolver, showCurrent, onShowCurrent, serverOnline }: {
  onClose: () => void;
  solver: SolverType;
  onSolver: (s: SolverType) => void;
  showCurrent: boolean;
  onShowCurrent: (v: boolean) => void;
  serverOnline: boolean;
}) {
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [provider, setProvider] = useState('local');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverOnline) return;
    fetchLlmSettings()
      .then((s) => { setSettings(s); setProvider(s.provider); setModel(s.model); setBaseUrl(s.ollama_base_url); })
      .catch((e) => setError(`Could not load AI settings (${e}).`));
  }, [serverOnline]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const keyField = KEY_FIELD[provider];
  const save = async () => {
    setStatus('saving');
    try {
      const body: Record<string, unknown> = { provider, model, ollama_base_url: baseUrl };
      if (keyField && key) body[keyField] = key;
      setSettings(await saveLlmSettings(body));
      setKey('');
      setStatus('saved');
    } catch (e) {
      setError(String(e));
      setStatus('error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h2 className="text-base font-semibold text-gray-900">Settings</h2>
          <button className="icon-btn" onClick={onClose}><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-6 px-5 py-5">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-gray-900">Solver</h3>
            <p className="text-sm text-gray-500">How the simulator solves G·x = b. All three give the same answer.</p>
            {SOLVERS.map((s) => (
              <label key={s.id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${solver === s.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                <input type="radio" name="solver" className="mt-1 accent-blue-600" checked={solver === s.id} onChange={() => onSolver(s.id)} />
                <span>
                  <span className="block text-sm font-medium text-gray-900">{s.label}</span>
                  <span className="block text-xs text-gray-500">{s.text}</span>
                </span>
              </label>
            ))}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-gray-900">Schematic</h3>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" className="accent-blue-600" checked={showCurrent} onChange={(e) => onShowCurrent(e.target.checked)} />
              Show current as moving dots (faster dots mean more current)
            </label>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-900">AI helpers</h3>
            <p className="text-sm text-gray-500">Optional. Used by the tutor and the designer in the Tools tab. Simulation never needs AI.</p>
            {!serverOnline && <p className="text-sm text-gray-600">Start the local server (<span className="font-mono">python circuit_simulator/start.py</span>) to set these up.</p>}
            {error && <p className="text-sm text-red-700">{error}</p>}
            {settings && (
              <>
                <label className="block space-y-1 text-sm">
                  <span className="label">Provider</span>
                  <select className="input w-full" value={provider} onChange={(e) => { setProvider(e.target.value); setModel(settings.default_models[e.target.value] ?? ''); setStatus('idle'); }}>
                    {settings.providers.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p] ?? p}</option>)}
                  </select>
                </label>
                {provider !== 'local' && (
                  <label className="block space-y-1 text-sm">
                    <span className="label">Model</span>
                    <input className="input w-full font-mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder={settings.default_models[provider]} />
                  </label>
                )}
                {provider === 'ollama' && (
                  <label className="block space-y-1 text-sm">
                    <span className="label">Ollama URL</span>
                    <input className="input w-full font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                  </label>
                )}
                {keyField && (
                  <label className="block space-y-1 text-sm">
                    <span className="label flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" /> API key {settings.keys[keyField] && <span className="text-green-700">(saved; leave blank to keep)</span>}</span>
                    <input type="password" className="input w-full font-mono" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
                  </label>
                )}
                {settings.env_overrides.length > 0 && <p className="text-xs text-amber-700">Environment variables override: {settings.env_overrides.join(', ')}.</p>}
                <div className="flex items-center justify-end gap-2">
                  {status === 'saved' && <span className="flex items-center gap-1 text-sm text-green-700"><CheckCircle2 className="h-4 w-4" /> Saved</span>}
                  <button className="btn btn-primary btn-sm" onClick={save} disabled={status === 'saving'}>{status === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save</button>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
