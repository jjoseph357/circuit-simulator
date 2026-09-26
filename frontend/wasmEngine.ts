import wasmUrl from './wasm/circuit_engine.wasm?url';
import { CircuitDiagnostic, CircuitSimulationResult, TuneRequest, TuneResult } from './types';

/**
 * The Rust engine compiled to WebAssembly (circuit_simulator/build_engine.py --only wasm).
 * It runs entirely in the browser: no server round-trip, and it keeps working offline.
 * ABI (engine/src/wasm_api.rs): strings go in via cs_alloc; results come back as
 * [u32 LE length][UTF-8 JSON] and are released with cs_free(ptr, 4 + length).
 */
interface EngineExports {
  memory: WebAssembly.Memory;
  cs_alloc(len: number): number;
  cs_free(ptr: number, cap: number): void;
  cs_simulate(ptr: number, len: number, solver: number): number;
  cs_lint(ptr: number, len: number): number;
  cs_tune?(ptr: number, len: number): number;
}

export type BrowserSolver = 'gaussian' | 'sparse_lu' | 'faer';
const SOLVER_CODE: Record<BrowserSolver, number> = { gaussian: 0, sparse_lu: 1, faer: 2 };

let enginePromise: Promise<EngineExports | null> | null = null;

export function loadWasmEngine(): Promise<EngineExports | null> {
  enginePromise ??= (async () => {
    const imports = { env: { now_ms: () => performance.now() } };
    try {
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), imports);
      return instance.exports as unknown as EngineExports;
    } catch (e) {
      console.warn('In-browser engine unavailable; using the server instead.', e);
      return null;
    }
  })();
  return enginePromise;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function callJson<T>(ex: EngineExports, entry: (ptr: number, len: number) => number, input: string): T {
  const bytes = encoder.encode(input);
  const inPtr = ex.cs_alloc(bytes.length);
  new Uint8Array(ex.memory.buffer, inPtr, bytes.length).set(bytes);
  const outPtr = entry(inPtr, bytes.length);
  ex.cs_free(inPtr, bytes.length);
  // Re-read the buffer: memory may have grown (and been detached) during the call.
  const len = new DataView(ex.memory.buffer).getUint32(outPtr, true);
  const json = decoder.decode(new Uint8Array(ex.memory.buffer, outPtr + 4, len));
  ex.cs_free(outPtr, 4 + len);
  return JSON.parse(json) as T;
}

/** Solves in the browser, or returns null if the Wasm engine couldn't be loaded. */
export async function simulateInBrowser(netlist: string, solver: BrowserSolver): Promise<CircuitSimulationResult | null> {
  const ex = await loadWasmEngine();
  if (!ex) return null;
  return callJson<CircuitSimulationResult>(ex, (p, n) => ex.cs_simulate(p, n, SOLVER_CODE[solver]), netlist);
}

export async function lintInBrowser(netlist: string): Promise<CircuitDiagnostic[] | null> {
  const ex = await loadWasmEngine();
  if (!ex) return null;
  return callJson<CircuitDiagnostic[]>(ex, (p, n) => ex.cs_lint(p, n), netlist);
}

/** Runs the netlist tuner in the browser (every evaluation is a full engine simulation). */
export async function tuneInBrowser(request: TuneRequest): Promise<TuneResult | null> {
  const ex = await loadWasmEngine();
  if (!ex || !ex.cs_tune) return null;
  return callJson<TuneResult>(ex, (p, n) => ex.cs_tune!(p, n), JSON.stringify(request));
}
