import {
  CircuitSimulationResult,
  CircuitDiagnostic,
  PreloadedCircuit,
  ArchitectResult
} from './types';

const API_BASE = '/api';

export async function fetchCircuitExamples(): Promise<PreloadedCircuit[]> {
  const res = await fetch(`${API_BASE}/circuit/examples`);
  if (!res.ok) throw new Error('Failed to fetch circuit examples');
  return res.json();
}

export type SolverType = 'gaussian' | 'sparse_lu' | 'faer';

export interface EngineInfo {
  runtime: 'pyo3' | 'cli' | 'python';
  has_faer: boolean;
  version?: string;
}

export async function fetchEngineInfo(): Promise<EngineInfo> {
  const res = await fetch(`${API_BASE}/circuit/engine`);
  if (!res.ok) throw new Error('Engine info unavailable');
  return res.json();
}

export async function solveCircuit(netlist: string, solverType: SolverType = 'gaussian'): Promise<CircuitSimulationResult> {
  const res = await fetch(`${API_BASE}/circuit/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ netlist, solver_type: solverType })
  });
  if (!res.ok) throw new Error('Simulation network request failed');
  return res.json();
}

export async function lintCircuit(netlist: string): Promise<{ diagnostics: CircuitDiagnostic[] }> {
  const res = await fetch(`${API_BASE}/circuit/lint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ netlist })
  });
  if (!res.ok) throw new Error('Circuit doctor request failed');
  return res.json();
}

export async function explainDiagnostics(
  netlist: string,
  diagnostics: CircuitDiagnostic[]
): Promise<{ explanation: string; source: 'llm' | 'offline' | 'deterministic' }> {
  const res = await fetch(`${API_BASE}/circuit/doctor/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ netlist, diagnostics })
  });
  if (!res.ok) throw new Error('Circuit doctor explanation failed');
  return res.json();
}

export async function askCircuitArchitect(prompt: string): Promise<ArchitectResult> {
  const res = await fetch(`${API_BASE}/circuit/architect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  });
  if (!res.ok) throw new Error('Circuit architect request failed');
  return res.json();
}

export async function askSocraticProfessor(
  question: string,
  netlist: string,
  nodeVoltages: Record<string, number>,
  branchCurrents: Record<string, number> = {}
): Promise<{ answer: string }> {
  const res = await fetch(`${API_BASE}/circuit/socratic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, netlist, node_voltages: nodeVoltages, branch_currents: branchCurrents })
  });
  if (!res.ok) throw new Error('Socratic professor request failed');
  return res.json();
}

export interface LlmSettings {
  provider: string;
  model: string;
  ollama_base_url: string;
  keys: Record<string, boolean>;
  env_overrides: string[];
  providers: string[];
  default_models: Record<string, string>;
}

export async function fetchLlmSettings(): Promise<LlmSettings> {
  const res = await fetch(`${API_BASE}/circuit/settings`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function saveLlmSettings(update: Record<string, unknown>): Promise<LlmSettings> {
  const res = await fetch(`${API_BASE}/circuit/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function tuneOnServer(request: import('./types').TuneRequest): Promise<import('./types').TuneResult> {
  const res = await fetch(`${API_BASE}/circuit/tune`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`Tuner request failed (HTTP ${res.status})`);
  return res.json();
}
