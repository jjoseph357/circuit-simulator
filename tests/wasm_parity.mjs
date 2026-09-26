// Loads the browser build of the Rust engine in Node and checks it against every curriculum
// preset (both syntaxes, all solvers). Run: node circuit_simulator/tests/wasm_parity.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(here, '..', 'frontend', 'wasm', 'circuit_engine.wasm');
const presets = JSON.parse(readFileSync(join(here, '..', 'presets.json'), 'utf8'));

const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), { env: { now_ms: () => performance.now() } });
const ex = instance.exports;
const enc = new TextEncoder(), dec = new TextDecoder();

function call(entry, text, ...extra) {
  const bytes = enc.encode(text);
  const inPtr = ex.cs_alloc(bytes.length);
  new Uint8Array(ex.memory.buffer, inPtr, bytes.length).set(bytes);
  const outPtr = entry(inPtr, bytes.length, ...extra);
  ex.cs_free(inPtr, bytes.length);
  const len = new DataView(ex.memory.buffer).getUint32(outPtr, true);
  const out = JSON.parse(dec.decode(new Uint8Array(ex.memory.buffer, outPtr + 4, len)));
  ex.cs_free(outPtr, 4 + len);
  return out;
}

const failures = [];
let checked = 0;
for (const p of presets) {
  for (const [solver, code] of [['gaussian', 0], ['sparse_lu', 1], ['faer', 2]]) {
    const res = call(ex.cs_simulate, p.netlist, code);
    checked++;
    if (!res.success) { failures.push(`${p.id} ${solver}: ${res.error_message}`); continue; }
    for (const [node, v] of Object.entries(p.expected_voltages)) {
      if (Math.abs(res.node_voltages[node] - v) > 1e-6) failures.push(`${p.id} ${solver}: node ${node} = ${res.node_voltages[node]}, expected ${v}`);
    }
  }
}

// Milestone 2: transient accuracy in the browser build (RC charging, tau = 1 ms)
const rc = call(ex.cs_simulate, 'V1 1 0 PULSE(0 5 0 1n 1n)\nR1 1 2 1k\nC1 2 0 1u\n.tran 10u 5m', 1);
const vEnd = rc.transient?.node_voltages?.['2']?.at(-1);
if (!(Math.abs(vEnd - 5 * (1 - Math.exp(-5))) < 1e-3)) failures.push(`RC transient end value ${vEnd}, expected ${5 * (1 - Math.exp(-5))}`);
const lp = call(ex.cs_simulate, 'V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac lin 1 159.1549430918953 159.1549430918953', 1);
if (!(Math.abs(lp.ac?.node_magnitude?.out?.[0] - Math.SQRT1_2) < 1e-9)) failures.push(`AC |H(fc)| = ${lp.ac?.node_magnitude?.out?.[0]}`);

const lint = call(ex.cs_lint, 'V1 1 0 5\nV2 1 0 10\nR1 1 0 100');
if (!lint.some((d) => d.code === 'ERR_KVL_VIOLATION')) failures.push('cs_lint did not flag a KVL violation');
const parse = call(ex.cs_lint, 'J1 1 0 1');
if (parse[0]?.code !== 'ERR_PARSE') failures.push('cs_lint did not report a parse error');

// Many calls must not leak: memory should stay bounded.
const before = ex.memory.buffer.byteLength;
for (let i = 0; i < 2000; i++) call(ex.cs_simulate, presets[0].netlist, 0);
if (ex.memory.buffer.byteLength > before + 8 * 65536) failures.push(`memory grew from ${before} to ${ex.memory.buffer.byteLength} bytes over 2000 solves`);

if (failures.length) {
  console.error(`WASM PARITY FAILED (${failures.length}):\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log(`WASM PARITY OK: ${checked} preset solves, lint, and 2000-call leak check`);
