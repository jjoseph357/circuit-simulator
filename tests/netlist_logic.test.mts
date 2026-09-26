// Frontend schematic/netlist logic, checked against the real engine (WebAssembly build).
// Run: node --experimental-strip-types --test circuit_simulator/tests/netlist_logic.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseEngValue, parseNetlistElements, autoLayout, componentsToNetlist, applyAutoFix, routeWires, terminalsOf, terminalKey,
  extractDirectives, extractTitle, dcValueOfSpec, sourceLabel, deviceTerminalCurrents, explainLine, validateNetlist,
  mergeLayout, cutWire, mergeNodes, dropGroundIfNoSymbol, nodesOf,
} from '../frontend/netlist.ts';

const here = dirname(fileURLToPath(import.meta.url));
const presets = JSON.parse(readFileSync(join(here, '..', 'presets.json'), 'utf8'));
const { instance } = await WebAssembly.instantiate(readFileSync(join(here, '..', 'frontend', 'wasm', 'circuit_engine.wasm')), { env: { now_ms: () => performance.now() } });
const ex: any = instance.exports;
const enc = new TextEncoder(), dec = new TextDecoder();
function simulate(netlist: string, solver = 1): any {
  const b = enc.encode(netlist);
  const p = ex.cs_alloc(b.length);
  new Uint8Array(ex.memory.buffer, p, b.length).set(b);
  const out = ex.cs_simulate(p, b.length, solver);
  ex.cs_free(p, b.length);
  const len = new DataView(ex.memory.buffer).getUint32(out, true);
  const r = JSON.parse(dec.decode(new Uint8Array(ex.memory.buffer, out + 4, len)));
  ex.cs_free(out, 4 + len);
  return r;
}

test('engineering notation matches the engine', () => {
  assert.equal(parseEngValue('4.7k'), 4700);
  assert.equal(parseEngValue('2Meg'), 2e6);
  assert.ok(Math.abs(parseEngValue('100n')! - 1e-7) < 1e-20);
  assert.equal(parseEngValue('10mA'), 0.01);
  assert.equal(parseEngValue('abc'), null);
});

test('presets are SPICE, titled, and parse to the engine\'s element names', () => {
  for (const p of presets) {
    assert.ok(extractTitle(p.netlist), `${p.id} has a title comment`);
    assert.deepEqual(validateNetlist(p.netlist), [], `${p.id} validates`);
    const names = parseNetlistElements(p.netlist).map((e) => e.name).sort();
    const engine = Object.keys(simulate(p.netlist).branch_currents).sort();
    assert.deepEqual(names, engine, p.id);
  }
});

test('schematic → netlist round trip reproduces the solution', () => {
  for (const p of presets) {
    const original = simulate(p.netlist);
    const comps = autoLayout(parseNetlistElements(p.netlist));
    const netlist = componentsToNetlist(comps, extractDirectives(p.netlist), 'round trip');
    assert.match(netlist, /^\* round trip\n/);
    assert.match(netlist, /\n\.end\n$/);
    const again = simulate(netlist);
    assert.ok(again.success, `${p.id}: ${again.error_message}`);
    for (const [node, v] of Object.entries(original.node_voltages)) {
      assert.ok(Math.abs((again.node_voltages[node] as number) - (v as number)) < 1e-9, `${p.id} node ${node}`);
    }
    assert.deepEqual(comps.filter((c) => c.type !== 'Ground').map((c) => c.name).sort(), Object.keys(again.branch_currents).sort(), p.id);
    if (original.transient) {
      const a = original.transient.node_voltages, b = again.transient.node_voltages;
      for (const n of Object.keys(a)) assert.ok(Math.abs(a[n].at(-1) - b[n].at(-1)) < 1e-9, `${p.id} transient ${n}`);
    }
  }
});

test('every node used by a preset gets a ground symbol when it touches node 0', () => {
  for (const p of presets) {
    const comps = autoLayout(parseNetlistElements(p.netlist));
    if (comps.some((c) => nodesOf(c).includes('0') && c.type !== 'Ground')) assert.ok(comps.some((c) => c.type === 'Ground'), p.id);
  }
});

test('wire currents obey KCL at every pin of the wiring tree', () => {
  for (const p of presets) {
    const res = simulate(p.netlist);
    const comps = autoLayout(parseNetlistElements(p.netlist));
    const dev = deviceTerminalCurrents(res.device_ops);
    const { wires } = routeWires(comps, res.branch_currents, dev);
    for (const c of comps) {
      for (const t of terminalsOf(c)) {
        if (t.isGroundSymbol || t.node === '0') continue;
        const key = terminalKey(t);
        const injected = dev[t.compName] ? -(dev[t.compName][t.pin - 1] ?? 0) : (t.pin === 1 ? -1 : 1) * (res.branch_currents[t.compName] ?? 0);
        const net = wires.filter((w) => w.ends[1] === key).reduce((s, w) => s + w.current, 0) - wires.filter((w) => w.ends[0] === key).reduce((s, w) => s + w.current, 0);
        assert.ok(Math.abs(injected + net) < 1e-9, `${p.id}: KCL at ${key} (node ${t.node}) off by ${injected + net}`);
      }
    }
    // One tree per node: n pins need n − 1 wires.
    const pinsPerNode = new Map<string, number>();
    for (const c of comps) for (const t of terminalsOf(c)) if (t.node !== '0') pinsPerNode.set(t.node, (pinsPerNode.get(t.node) ?? 0) + 1);
    for (const [node, n] of pinsPerNode) assert.equal(wires.filter((w) => w.node === node).length, n - 1, `${p.id} node ${node}`);
  }
});

test('source specs: DC value and labels', () => {
  assert.equal(dcValueOfSpec('PULSE(0 5 0 1n 1n)'), 0);
  assert.equal(dcValueOfSpec('DC 3 AC 1'), 3);
  assert.equal(dcValueOfSpec('12'), 12);
  assert.match(sourceLabel('PULSE(0 5 0 1n 1n)', 'V'), /step 0→5V/);
  assert.match(sourceLabel('SIN(0 1 1k)', 'V'), /sine 1V @ 1kHz/);
  assert.match(sourceLabel('DC 0 AC 1', 'V'), /AC 1V/);
  const [el] = parseNetlistElements('V1 in 0 PULSE(0 5 1u 1n 1n 10u 20u) AC 1');
  assert.equal(el.source, 'PULSE(0 5 1u 1n 1n 10u 20u) AC 1');
  assert.deepEqual(extractDirectives('R1 1 0 1k\n.tran 1u 1m\n.end'), ['.tran 1u 1m']);
});

test('line explainer: plain English and helpful errors', () => {
  assert.match(explainLine('R1 1 2 4.7k').text, /Resistor R1 of 4\.7 kΩ between node 1 and node 2/);
  assert.match(explainLine('V1 in 0 5').text, /holds node in \(\+\) above ground/);
  assert.match(explainLine('.tran 10u 5m').text, /over time/);
  assert.match(explainLine('* hello', true).text, /Title/);
  assert.ok(explainLine('R1 1 2').error, 'missing value');
  assert.ok(explainLine('R1 1 2 abc').error, 'bad number');
  assert.ok(explainLine('R1 1 2 0').error, 'zero ohms');
  assert.ok(explainLine('Z1 1 2 3').error, 'unknown letter');
  assert.deepEqual(explainLine('R1 out 0 1k').tokens.filter((t) => t.role === 'node').map((t) => t.text), ['out', '0']);
  const problems = validateNetlist('* t\nR1 1 0 1k\nR1 1 0 2k\n');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 3);
});

test('Doctor fixes: removed lines are commented out, new lines go before .end', () => {
  const net = '* t\nV1 1 0 5\nV2 1 0 10\nR1 1 0 100\n.end\n';
  const fixed = applyAutoFix(net, { label: 'Remove V2', explanation: '', append_lines: ['R_x 1 0 1k'], remove_lines: ['V2 1 0 10'] });
  assert.match(fixed, /\* removed: V2 1 0 10/);
  assert.match(fixed, /R_x 1 0 1k\n\.end\n$/);
  const r = simulate(fixed);
  assert.ok(r.success, r.error_message);
  assert.equal(Object.keys(r.branch_currents).sort().join(','), 'R1,R_x,V1');
});

test('editing the netlist keeps the drawing: kept parts stay put, new parts appear', () => {
  const before = autoLayout(parseNetlistElements('V1 in 0 12\nR1 in out 8k\nR2 out 0 4k'));
  const r1 = before.find((c) => c.name === 'R1')!;
  const after = mergeLayout(before, parseNetlistElements('V1 in 0 12\nR1 in out 2k\nR2 out 0 4k\nR3 out 0 1k'))!;
  const r1b = after.find((c) => c.name === 'R1')!;
  assert.equal(r1b.x, r1.x); assert.equal(r1b.y, r1.y); assert.equal(r1b.value, 2000);
  assert.ok(after.some((c) => c.name === 'R3'));
  assert.equal(mergeLayout(before, parseNetlistElements('R9 a 0 1k')), null, 'nothing in common → fresh layout');
  const net = componentsToNetlist(after, []);
  assert.ok(simulate(net).success);
});

test('deleting a wire splits the node; deleting ground removes node 0', () => {
  const comps = autoLayout(parseNetlistElements('V1 in 0 12\nR1 in out 8k\nR2 out 0 4k\nR3 out 0 4k'));
  const { wires } = routeWires(comps);
  const w = wires.find((x) => x.node === 'out')!;
  const cut = cutWire(comps, w);
  const outPins = cut.flatMap(terminalsOf).filter((t) => t.node === 'out').length;
  assert.ok(outPins < 3 && outPins > 0, 'some pins left node out');
  assert.equal(routeWires(cut).wires.filter((x) => x.node === 'out').length, outPins - 1);

  const joined = mergeNodes(cut, 'out', cut.flatMap(terminalsOf).find((t) => t.node !== 'out' && t.node !== 'in' && t.node !== '0')!.node);
  assert.equal(joined.flatMap(terminalsOf).filter((t) => t.node === 'out').length, 3, 'reconnected');

  const noGround = dropGroundIfNoSymbol(comps.filter((c) => c.type !== 'Ground'));
  assert.ok(!noGround.some((c) => nodesOf(c).includes('0')));
  const r = simulate(componentsToNetlist(noGround, []));
  assert.ok(r.diagnostics.some((d: any) => d.code === 'ERR_NO_GROUND'));
});

test('hand-drawn preset layouts describe the same circuit, with every grounded pin on a ground symbol', async () => {
  const { layoutWithHints } = await import('../frontend/netlist.ts');
  for (const p of presets.filter((x: any) => x.layout)) {
    const comps = layoutWithHints(parseNetlistElements(p.netlist), p.layout);
    for (const name of Object.keys(p.layout)) assert.ok(comps.some((c) => c.name === name), `${p.id}: ${name} placed`);
    const again = simulate(componentsToNetlist(comps, extractDirectives(p.netlist)));
    const original = simulate(p.netlist);
    for (const [node, v] of Object.entries(original.node_voltages)) assert.ok(Math.abs(again.node_voltages[node] - (v as number)) < 1e-9, `${p.id} node ${node}`);
    const grounded = comps.flatMap(terminalsOf).filter((t) => t.node === '0' && !t.isGroundSymbol).length;
    assert.equal(comps.filter((c) => c.type === 'Ground').length, grounded, p.id);
  }
});

test('SPICE title line: the first line is a title unless it is a valid element', () => {
  assert.equal(parseNetlistElements('My divider\nV1 1 0 10\nR1 1 0 1k').length, 2);
  assert.equal(parseNetlistElements('Voltage divider circuit example\nV1 1 0 10\nR1 1 0 1k').length, 2);
  assert.equal(parseNetlistElements('V1 1 0 10\nR1 1 0 1k').length, 2, 'element on line 1 is kept');
  assert.match(explainLine('My divider', true).text, /Title/);
  const r = simulate('My divider\nV1 1 0 10\nR1 1 2 1k\nR2 2 0 1k');
  assert.ok(r.success && Math.abs(r.node_voltages['2'] - 5) < 1e-9);
});
