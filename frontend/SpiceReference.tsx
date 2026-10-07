import React, { useEffect, useState } from 'react';
import { X, Copy, Check } from 'lucide-react';

/** The SPICE netlist syntax this simulator reads, as a beginner's reference. */

const SECTIONS = [
  { id: 'shape', label: 'Shape of a netlist' },
  { id: 'parts', label: 'Parts' },
  { id: 'values', label: 'Numbers and units' },
  { id: 'sources', label: 'Source signals' },
  { id: 'models', label: 'Diode and transistor models' },
  { id: 'analyses', label: 'Analyses' },
  { id: 'mistakes', label: 'Common mistakes' },
] as const;
type SectionId = typeof SECTIONS[number]['id'];

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-lg bg-gray-50 px-3 py-2 font-mono text-[13px] leading-relaxed text-gray-800">{children}</pre>
      <button className="icon-btn absolute right-1.5 top-1.5 bg-white opacity-0 shadow-sm group-hover:opacity-100" title="Copy"
        onClick={() => { navigator.clipboard?.writeText(children).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); }}>
        {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

const Table = ({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-left text-sm">
      <thead><tr className="text-xs text-gray-400">{head.map((h) => <th key={h} className="pb-1 pr-4 font-medium">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-gray-100 align-top">{r.map((c, j) => <td key={j} className="py-1.5 pr-4">{c}</td>)}</tr>)}</tbody>
    </table>
  </div>
);
const M = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-gray-100 px-1 font-mono text-[12.5px] text-gray-900">{children}</code>;

function Body({ id }: { id: SectionId }) {
  switch (id) {
    case 'shape':
      return (
        <>
          <p>A netlist is a plain-text list of parts. Every simulator in the SPICE family (ngspice, LTspice, HSPICE, Spectre) reads this format.</p>
          <Code>{`* Voltage divider      (line 1 is the title)
V1 in 0 12            ; a part: name, nodes, value
R1 in out 8k          ; comments start with ; or $
R2 out 0 4k
.op                   ; control cards start with a dot
.end                  ; the end of the netlist`}</Code>
          <ul className="list-disc space-y-1 pl-5">
            <li><b>One part per line</b>: its <b>name</b>, the <b>nodes</b> it connects, then its <b>value</b>.</li>
            <li>The <b>first letter of the name</b> says what the part is: <M>R1</M>, <M>Rload</M> and <M>R_top</M> are all resistors. Every name must be unique.</li>
            <li><b>Nodes</b> are just names: <M>1</M>, <M>in</M>, <M>vout</M>. Two pins with the same node name are wired together. That is the only way wires exist in a netlist.</li>
            <li><M>0</M> (or <M>gnd</M>) is <b>ground</b>, the 0 V reference. Every circuit needs it.</li>
            <li>Lines starting with <M>*</M> are comments. SPICE always reads the first line as the title, so start it with <M>*</M>.</li>
          </ul>
        </>
      );
    case 'parts':
      return (
        <>
          <Table head={['Letter', 'Part', 'Form', 'Example']} rows={[
            [<M>R</M>, 'Resistor', <M>Rname n1 n2 ohms</M>, <M>R1 in out 4.7k</M>],
            [<M>C</M>, 'Capacitor', <M>Cname n1 n2 farads</M>, <M>C1 out 0 100n</M>],
            [<M>L</M>, 'Inductor', <M>Lname n1 n2 henries</M>, <M>L1 a b 10m</M>],
            [<M>V</M>, 'Voltage source', <M>Vname n+ n- value</M>, <M>V1 in 0 5</M>],
            [<M>I</M>, 'Current source', <M>Iname n+ n- value</M>, <M>I1 0 1 2m</M>],
            [<M>D</M>, 'Diode', <M>Dname anode cathode model</M>, <M>D1 a k DMOD</M>],
            [<M>Q</M>, 'BJT', <M>Qname collector base emitter model</M>, <M>Q1 c b e QN</M>],
            [<M>M</M>, 'MOSFET', <M>Mname drain gate source [bulk] model W= L=</M>, <M>M1 d g 0 NM W=10u L=1u</M>],
            [<M>O</M>, 'Op-Amp', <M>Oname out [out_ref] in+ in- [gain]</M>, <M>O1 out 0 0 inv</M>],
            [<M>E</M>, 'VCVS', <M>Ename out+ out- in+ in- gain</M>, <M>E1 out 0 in 0 3.0</M>],
            [<M>G</M>, 'VCCS', <M>Gname out+ out- in+ in- gm</M>, <M>G1 out 0 in 0 2m</M>],
            [<M>F</M>, 'CCCS', <M>Fname out+ out- [ctrl+ ctrl- | Vctrl] gain</M>, <M>F1 out 0 in 0 10</M>],
            [<M>H</M>, 'CCVS', <M>Hname out+ out- [ctrl+ ctrl- | Vctrl] r</M>, <M>H1 out 0 in 0 1k</M>],
            [<M>W</M>, 'Short circuit', <M>Wname n1 n2</M>, <M>W1 1 2</M>],
            [<M>K</M>, 'Coupled inductors', <M>Kname L1 L2 k</M>, <M>K1 L1 L2 0.95</M>],
            [<M>T</M>, 'Transformer', <M>Tname p+ p- s+ s- L1 L2 M</M>, <M>T1 1 0 2 0 10m 40m 18m</M>],
          ]} />
          <ul className="list-disc space-y-1 pl-5">
            <li><b>Voltage source</b>: the first node is +. <M>V1 in 0 5</M> holds <M>in</M> 5 V above ground.</li>
            <li><b>Current source</b>: current flows <i>through the source</i> from the first node to the second, so it comes out into the second node. <M>I1 0 1 2m</M> pushes 2 mA into node 1.</li>
            <li><b>Op-Amp</b>: ideal operational amplifier with virtual short between <M>in+</M> and <M>in-</M>, or finite open-loop gain when a value is given.</li>
            <li><b>Controlled sources</b>: <M>E</M> (VCVS) and <M>G</M> (VCCS) sense differential input voltage; <M>F</M> (CCCS) and <M>H</M> (CCVS) sense branch or source current.</li>
            <li><b>Short circuit</b>: <M>W1 1 2</M> acts as an ideal zero-resistance jumper wire between nodes 1 and 2.</li>
            <li>A part’s current is reported flowing from its first node to its second.</li>
          </ul>
        </>
      );
    case 'values':
      return (
        <>
          <p>Values are numbers with an optional scale letter right after them. Letters after that (units) are ignored, so <M>10k</M>, <M>10kohm</M> and <M>10000</M> are the same.</p>
          <Table head={['Suffix', 'Means', 'Example']} rows={[
            [<M>T</M>, '× 10¹²', <M>1T</M>], [<M>G</M>, '× 10⁹', <M>2G</M>], [<M>Meg</M>, '× 10⁶ (mega)', <M>1Meg</M>],
            [<M>k</M>, '× 10³', <M>4.7k</M>], [<M>m</M>, '× 10⁻³ (milli)', <M>10m</M>], [<M>u</M>, '× 10⁻⁶ (micro)', <M>100u</M>],
            [<M>n</M>, '× 10⁻⁹', <M>22n</M>], [<M>p</M>, '× 10⁻¹²', <M>10p</M>], [<M>f</M>, '× 10⁻¹⁵', <M>1f</M>],
          ]} />
          <p className="rounded-lg bg-amber-50 p-2 text-amber-900"><b>Watch out:</b> SPICE ignores upper/lower case, so <M>M</M> means <b>milli</b>, not mega. <M>1M</M> is 0.001. Write <M>1Meg</M> for a million.</p>
          <p>Scientific notation works too: <M>1.5e-3</M>, <M>2E6</M>.</p>
        </>
      );
    case 'sources':
      return (
        <>
          <p>After the two nodes, a source can say how it behaves. Plain numbers mean a steady (DC) value.</p>
          <Table head={['Write', 'Meaning']} rows={[
            [<M>5</M>, 'or DC 5: a steady 5 V (or A)'],
            [<M>AC 1</M>, 'the input for an .ac frequency sweep, amplitude 1 (an optional phase in degrees can follow)'],
            [<M>PULSE(v1 v2 delay rise fall width period)</M>, 'starts at v1, jumps to v2. Leave off width and period for a single step.'],
            [<M>SIN(offset amplitude freq)</M>, 'a sine wave'],
            [<M>PWL(t1 v1 t2 v2 …)</M>, 'straight lines between (time, value) points'],
          ]} />
          <Code>{`V1 in 0 PULSE(0 5 0 1n 1n)            ; 0 → 5 V step at t = 0
V2 in 0 PULSE(0 5 0 1n 1n 500u 1m)    ; 1 kHz square wave
V3 in 0 SIN(0 1 1k)                   ; 1 V, 1 kHz sine
V4 in 0 DC 0 AC 1                     ; input for a Bode plot`}</Code>
        </>
      );
    case 'models':
      return (
        <>
          <p>Diodes and transistors point to a <M>.model</M> line that holds their parameters. Anything left out uses a default.</p>
          <Code>{`D1 a k DSI
.model DSI D(IS=1e-14 N=1)

Q1 c b e QN
.model QN NPN(IS=1e-15 BF=150 BR=1)

M1 out in 0 NM W=10u L=1u
.model NM NMOS(VTO=0.8 KP=100u LAMBDA=0.01)`}</Code>
          <Table head={['Type', 'Parameters']} rows={[
            [<M>D</M>, 'IS saturation current, N emission coefficient'],
            [<M>NPN</M> , 'IS, BF forward gain (β), BR reverse gain. Use PNP for the opposite polarity.'],
            [<M>NMOS</M>, 'VTO threshold voltage, KP transconductance, LAMBDA channel-length modulation. Use PMOS for the opposite polarity; W= and L= go on the M line.'],
          ]} />
        </>
      );
    case 'analyses':
      return (
        <>
          <p>Control cards (lines starting with a dot) say what to simulate. With none, you get the DC operating point: every voltage with sources held steady.</p>
          <Table head={['Card', 'What it does']} rows={[
            [<M>.op</M>, 'DC operating point (always computed)'],
            [<M>.tran 10u 5m</M>, 'over time: report every 10 µs, stop at 5 ms'],
            [<M>.ac dec 20 10 100k</M>, 'over frequency: 20 points per decade from 10 Hz to 100 kHz (dec, oct or lin)'],
            [<M>.dc V1 0 5 0.1</M>, 'sweep source V1 from 0 to 5 in steps of 0.1'],
            [<M>.options method=euler</M>, 'transient method: trap (default) or euler'],
            [<M>.model …</M>, 'device parameters (see models)'],
            [<M>.end</M>, 'end of the netlist'],
          ]} />
          <p>You can also set these up from the Graphs tab, which writes the line for you.</p>
        </>
      );
    case 'mistakes':
      return (
        <Table head={['Mistake', 'Fix']} rows={[
          ['No node 0', 'Connect something (usually the − end of the supply) to 0.'],
          [<><M>1M</M> meant as a million</>, <>Use <M>1Meg</M>. <M>M</M> is milli.</>],
          ['A part connected at only one end', 'It carries no current. Connect its other end, or delete it.'],
          ['Two parts with the same name', 'Rename one: every name must be unique.'],
          ['0 Ω resistor', 'Just give both ends the same node name.'],
          ['Two voltage sources in parallel', 'They fight over one voltage. Remove one, or put a resistor in series.'],
          ['A node only touching current sources', 'Its voltage is undefined. Add a resistor to it.'],
        ]} />
      );
  }
}

export function SpiceReference({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>('shape');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-gray-900/30 p-4 pt-[6vh]" onClick={onClose}>
      <div className="flex max-h-[86vh] w-full max-w-4xl flex-col rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">SPICE netlist syntax</h2>
            <p className="text-sm text-gray-500">Everything this simulator understands, with examples you can copy.</p>
          </div>
          <button className="icon-btn" onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav className="w-48 shrink-0 space-y-0.5 border-r border-gray-100 p-3">
            {SECTIONS.map((s) => (
              <button key={s.id} onClick={() => setSection(s.id)}
                className={`w-full rounded-md px-2.5 py-1.5 text-left text-sm ${section === s.id ? 'bg-blue-50 font-medium text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`}>
                {s.label}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6 text-sm leading-relaxed text-gray-700">
            <h3 className="text-base font-semibold text-gray-900">{SECTIONS.find((s) => s.id === section)!.label}</h3>
            <Body id={section} />
          </div>
        </div>
      </div>
    </div>
  );
}
