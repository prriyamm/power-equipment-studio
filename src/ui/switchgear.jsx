/* Switchgear bus workspace: Rac/Rdc, lamination sharing, temperature rise and short-circuit bracing
   (pecalc switchgear port), live as inputs change. Starts filled with the 3000 A switchboard example. */
const { useState, useMemo } = React;
import { Btn, Field, NumField, Pill, Section, Tile, cx, fmt } from "./common.jsx";
import { SwitchgearBus3D } from "./switchgear3d.jsx";
import { STOPS, scale, rgb } from "./three/parts.js";
import { analyseBus, busInput, mesh, EMISSIVITY, SPAN } from "../engine/pecalc/switchgear.js";
import { kvRows, checkRows } from "../engine/report.js";
import { ReportButton } from "./reportButton.jsx";

/* 3 x 1/4 x 6 in Cu per phase, edge to edge, 65 kA fault (examples/switchgear-bus-3000a.json). */
const EXAMPLE = {
  current_a: 3000, bar_thickness_mm: 6.35, bar_width_mm: 152.4, bars_per_phase: 3, phase_spacing_mm: 200,
  orientation: "edge_to_edge", internal_air_rise_c: 15, fault_ka: 65, x_over_r: 15, support_span_m: 0.6,
};

/* The filament model solves a dense complex system, so very wide multi-lamination bars get slow. When the
   automatic mesh would exceed MAX_FILAMENTS conductors the width mesh is coarsened (never below 4). */
const MAX_FILAMENTS = 360;

function solve(inp) {
  try {
    let i = inp, coarse = null;
    const [nt, nw] = mesh(i, i.ambient_c + i.internal_air_rise_c + i.max_rise_c);
    const n = 3 * i.bars_per_phase * nt * nw;
    if (n > MAX_FILAMENTS && !i.filaments_width) {
      const w2 = Math.max(4, Math.floor(MAX_FILAMENTS / (3 * i.bars_per_phase * nt)));
      i = { ...i, filaments_thickness: i.filaments_thickness || nt, filaments_width: w2 };
      coarse = `${nt} x ${nw} -> ${nt} x ${w2}`;
    }
    return { result: analyseBus(i), coarse };
  } catch (e) {
    return { error: e.message };
  }
}

/* ------------------------------------------------ temperature colour scale */
const PH = ["var(--ph-a)", "var(--ph-b)", "var(--ph-c)"];

/* Calculation package (see engine/report.js). */
function busReport(r) {
  return {
    title: "Switchgear bus", module: "switchgear", subtitle: `${r.input.current_a} A, ${r.input.bars_per_phase} bar(s) per phase`,
    inputs: kvRows(r.input, { current_a: "A", bar_thickness_mm: "mm", bar_width_mm: "mm", phase_spacing_mm: "mm", internal_air_rise_c: "C", fault_ka: "kA", support_span_m: "m" }),
    results: [
      { label: "Temperature rise", value: r.rise_c, unit: "C" }, { label: "Rating at allowable rise", value: r.rated_current_at_limit_a, unit: "A" },
      { label: "Rac/Rdc", value: r.rac_over_rdc }, { label: "Loss per phase", value: r.loss_w_per_m_per_phase, unit: "W/m" },
      { label: "Peak fault force", value: r.peak_force_n_per_m, unit: "N/m" }, { label: "Bending stress", value: r.bending_stress_mpa, unit: "MPa" },
      { label: "Support load", value: r.support_load_n, unit: "N" }, { label: "Max span", value: r.max_span_m, unit: "m" },
    ],
    checks: checkRows(r.checks),
    tables: [{ title: "Lamination current sharing", columns: ["Lamination", "% of equal share"], rows: (r.lamination_share_pct || []).map((v, k) => [k + 1, v]) }],
    notes: r.notes,
    // Bus material and UL 891 limits are entered from memory in the engine ([UNVERIFIED] markers in the check clauses).
    dataStatus: [{ table: "Bus material constants and UL 891 limits", status: "UNVERIFIED", source: "Engine constants marked [UNVERIFIED]; confirm against the product standard and supplier data." }],
  };
}

export function SwitchgearWorkspace() {
  const [inp, setInp] = useState(() => busInput(EXAMPLE));
  const { result: r, error, coarse } = useMemo(() => solve(inp), [inp]);
  const set = (k, optional) => (v) => setInp((s) => (v === undefined && !optional ? s : { ...s, [k]: v === undefined ? null : v }));

  const num = (k, label, unit, o = {}) => (
    <Field label={label} unit={unit} hint={o.hint}>
      <NumField id={`sg-${k}`} value={inp[k] === null ? undefined : inp[k]} placeholder={o.ph} onCommit={set(k, o.optional)} />
    </Field>
  );
  const pick = (k, label, opts, parse) => (
    <Field label={label}>
      <select id={`sg-${k}`} className="num-input" value={inp[k]} onChange={(e) => setInp((s) => ({ ...s, [k]: parse ? parse(e.target.value) : e.target.value }))}>
        {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </Field>
  );

  const nFail = r ? r.checks.filter((c) => !c.passed).length : 0;
  return (
    <div className="ws">
      <style>{CSS}</style>
      <header className="topbar">
        <div className="ws-title">Switchgear bus</div>
        <span className="text-muted text-[12.5px]">Switchboard main bus and risers · 3-phase</span>
        <div className="flex items-center gap-2 ml-auto">
          {r && <Pill tone={r.passed ? "ok" : "crit"}>{r.passed ? "All checks pass" : `${nFail} check(s) fail`}</Pill>}
          {r && <ReportButton filename="switchgear-bus-calc" getReport={() => busReport(r)} />}
          <Btn onClick={() => setInp(busInput(EXAMPLE))} title="Restore the 3000 A example inputs">Reset to example</Btn>
        </div>
      </header>

      <div className="main">
        <div className="sg-grid">
          <div className="sg-form">
            <Section title="Load and standard">
              <div className="sg-fields">
                {num("current_a", "Bus current", "A")}
                {pick("standard", "Standard", [["UL 891", "UL 891"], ["ANSI C37.20.1", "ANSI C37.20.1"], ["ANSI C37.20.2", "ANSI C37.20.2"], ["ANSI C37.20.3", "ANSI C37.20.3"]])}
                {num("voltage_v", "Voltage", "V")}
                {num("frequency_hz", "Frequency", "Hz")}
              </div>
            </Section>
            <Section title="Bars">
              <div className="sg-fields">
                {pick("material", "Material", [["Cu", "Copper"], ["Al", "Aluminium"]])}
                {pick("bars_per_phase", "Bars per phase", [1, 2, 3, 4, 5, 6].map((n) => [n, String(n)]), Number)}
                {num("bar_thickness_mm", "Bar thickness", "mm")}
                {num("bar_width_mm", "Bar width", "mm")}
                {num("bar_gap_mm", "Gap between bars", "mm", { optional: true, ph: "= thickness" })}
                {pick("finish", "Surface finish", Object.keys(EMISSIVITY).map((f) => [f, f[0].toUpperCase() + f.slice(1)]))}
                {pick("orientation", "Orientation", [["edge_to_edge", "Edge to edge"], ["face_to_face", "Face to face"]])}
                {num("phase_spacing_mm", "Phase spacing", "mm", { hint: "centre to centre" })}
              </div>
            </Section>
            <Section title="Temperature">
              <div className="sg-fields">
                {num("ambient_c", "Room ambient", "°C")}
                {num("internal_air_rise_c", "Enclosure air rise", "°C", { hint: "above room" })}
                {num("max_rise_c", "Allowed rise", "°C", { hint: "UNVERIFIED default" })}
              </div>
            </Section>
            <Section title="Short circuit and supports">
              <div className="sg-fields">
                {num("fault_ka", "Fault current", "kA rms", { optional: true, ph: "none" })}
                {num("x_over_r", "X/R", "")}
                {num("support_span_m", "Support span", "m")}
                {pick("support_condition", "Span condition", Object.keys(SPAN).map((c) => [c, c[0].toUpperCase() + c.slice(1)]))}
                {num("yield_mpa", "Bar yield strength", "MPa", { optional: true, ph: inp.material === "Cu" ? "200 typical" : "165 typical" })}
                {num("support_rating_n", "Support rating", "N", { optional: true, ph: "not checked" })}
              </div>
            </Section>
          </div>

          <div className="sg-results">
            {error && <div className="notice notice-crit"><b>Cannot analyse.</b> {error}</div>}
            {r && <Results r={r} coarse={coarse} />}
          </div>
        </div>
      </div>
    </div>
  );
}

const lim = (r, name) => r.checks.find((c) => c.name.startsWith(name));

function Results({ r, coarse }) {
  const i = r.input;
  const tempCheck = lim(r, "Temperature"), bendCheck = lim(r, "Bar bending");
  const shares = r.lamination_share_pct;
  const spread = Math.max(...shares) - Math.min(...shares);
  const std = (v) => (Number.isFinite(v) ? fmt(v, Math.abs(v) < 10 ? 2 : 1) : "∞");
  const hasFault = r.peak_force_n_per_m !== null;
  const air = i.ambient_c + i.internal_air_rise_c;
  return (
    <>
      {coarse && <div className="notice notice-info">Large bar layout: the filament mesh was coarsened ({coarse} filaments per bar) to keep the page responsive. Set filaments in the engine call for full resolution.</div>}
      <div className="tiles">
        <Tile label="Rac / Rdc" value={fmt(r.rac_over_rdc, 3)} sub={`loss ${fmt(r.loss_w_per_m_per_phase, 0)} W/m per phase`} />
        <Tile label="Temperature rise" value={fmt(r.rise_c, 1)} unit="°C" tone={tempCheck.passed ? "ok" : "crit"}
          sub={`limit ${fmt(i.max_rise_c, 0)} °C · rated ${fmt(r.rated_current_at_limit_a, 0)} A at limit`} />
        <Tile label="Lamination imbalance" value={fmt(spread, 1)} unit="pts" tone={i.bars_per_phase > 1 && spread > 25 ? "warn" : undefined}
          sub={i.bars_per_phase > 1 ? `shares ${fmt(Math.min(...shares), 0)}–${fmt(Math.max(...shares), 0)} % of equal` : "single bar per phase"} />
        <Tile label="Peak force per phase" value={hasFault ? fmt(r.peak_force_n_per_m, 0) : "—"} unit={hasFault ? "N/m" : ""}
          sub={hasFault ? `${fmt(r.peak_force_n_per_m * 0.0685218, 0)} lbf/ft · support ${fmt(r.support_load_n, 0)} N` : "enter a fault current"} />
        <Tile label="Bending stress" value={hasFault ? fmt(r.bending_stress_mpa, 1) : "—"} unit={hasFault ? "MPa" : ""} tone={bendCheck ? (bendCheck.passed ? "ok" : "crit") : undefined}
          sub={bendCheck ? `allowable ${fmt(bendCheck.limit, 0)} MPa (yield)` : "no fault"} />
        <Tile label="Max support span" value={hasFault ? fmt(r.max_span_m, 3) : "—"} unit={hasFault ? "m" : ""}
          tone={hasFault ? (r.max_span_m >= i.support_span_m ? "ok" : "crit") : undefined} sub={hasFault ? `installed ${fmt(i.support_span_m, 2)} m, ${i.support_condition}` : ""} />
      </div>

      <Section title="Checks" aside={<Pill tone={r.passed ? "ok" : "crit"}>{r.passed ? "Pass" : "Fail"}</Pill>}>
        <div className="table-wrap">
          <table className="grid-table">
            <thead><tr><th>Check</th><th className="r">Value</th><th className="r">Limit</th><th>Result</th><th>Clause</th></tr></thead>
            <tbody>
              {r.checks.map((c) => (
                <tr key={c.name} title={c.note}>
                  <td className="sg-wrap">{c.name}<div className="sg-note">{c.note}</div></td>
                  <td className="r">{std(c.value)} <em className="sg-unit">{c.unit}</em></td>
                  <td className="r">{std(c.limit)} <em className="sg-unit">{c.unit}</em></td>
                  <td><Pill tone={c.passed ? "ok" : "crit"}>{c.passed ? "Pass" : "Fail"}</Pill></td>
                  <td className="sg-wrap sg-clause">{c.clause}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="sg-two">
        <Section title="Lamination current sharing" aside={<span className="text-faint text-[12px]">phase A, % of equal share</span>}>
          <ShareChart shares={shares} />
        </Section>
        <Section title="Phase packs" aside={<span className="text-faint text-[12px]">cross-section to scale, mm</span>}>
          <CrossSection i={i} rise={r.rise_c} />
        </Section>
      </div>

      <Section title="Switchgear section" aside={<span className="text-faint text-[12px]">3D, to scale, bars coloured by temperature</span>}>
        <SwitchgearBus3D input={i} result={r} fallback={<IsoSection i={i} rise={r.rise_c} air={air} />} />
      </Section>

      <Section title="Notes">
        <ul className="sg-notes">{r.notes.map((n, k) => <li key={k}>{n}</li>)}</ul>
      </Section>
    </>
  );
}

/* ---------------------------------------------------------- share chart */
function ShareChart({ shares }) {
  const row = 28, top = 8, W = 420, lab = 66, right = 52;
  const mx = Math.max(125, ...shares) * 1.04;
  const x = (v) => lab + (v / mx) * (W - lab - right);
  const H = top + shares.length * row + 22;
  return (
    <svg className="sg-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Lamination current shares: ${shares.join(", ")} percent of an equal share`}>
      {shares.map((s, k) => {
        const y = top + k * row, dev = Math.abs(s - 100);
        const col = dev > 25 ? "var(--high)" : "var(--accent)";
        return (
          <g key={k}>
            <text x={lab - 8} y={y + 15} textAnchor="end" className="sg-axis">Bar {k + 1}</text>
            <rect x={lab} y={y + 4} width={Math.max(1, x(s) - lab)} height={row - 10} rx="2" fill={col} opacity="0.85" />
            <text x={x(s) + 6} y={y + 16} className="sg-val">{fmt(s, 1)} %</text>
          </g>
        );
      })}
      <line x1={x(100)} x2={x(100)} y1={top - 2} y2={top + shares.length * row} className="sg-ref" />
      <text x={x(100)} y={H - 6} textAnchor="middle" className="sg-axis">100 % = equal share</text>
    </svg>
  );
}

/* ------------------------------------------------------- cross-section */
function packLayout(i) {
  const t = i.bar_thickness_mm, w = i.bar_width_mm, n = i.bars_per_phase;
  const gap = i.bar_gap_mm !== null ? i.bar_gap_mm : t;
  const pack = n * t + (n - 1) * gap;
  const offs = Array.from({ length: n }, (_, b) => -pack / 2 + t / 2 + b * (t + gap));
  return { t, w, n, gap, pack, offs };
}

function CrossSection({ i, rise }) {
  const { t, w, n, gap, pack, offs } = packLayout(i);
  const f2f = i.orientation === "face_to_face";
  const sp = i.phase_spacing_mm;
  const ext = (f2f ? [pack, w] : [w, pack]);                 // pack extent along x, y
  const fs = Math.max(2 * sp + ext[0], ext[1] * 2) * 0.035;
  const left = ext[0] / 2 + 5 * fs, right = ext[0] / 2 + 2 * fs, top = ext[1] / 2 + 4 * fs, bot = ext[1] / 2 + 8 * fs;
  const vw = 2 * sp + left + right, vh = ext[1] + top - ext[1] / 2 + bot;
  const ox = left, oy = top, col = rgb(scale(rise / (i.max_rise_c * 1.25)));
  const sw = fs * 0.07;
  const bars = [0, 1, 2].flatMap((p) => offs.map((o, b) => {
    const cx0 = p * sp;
    const r = f2f ? { x: cx0 + o - t / 2, y: -w / 2, w: t, h: w } : { x: cx0 - w / 2, y: o - t / 2, w: w, h: t };
    return <rect key={`${p}-${b}`} className="sg-bar" x={r.x} y={r.y} width={r.w} height={r.h} fill={col} strokeWidth={sw} />;
  }));
  const dimH = (x0, x1, y, label) => (
    <g className="sg-dim">
      <path d={`M${x0} ${y}H${x1}M${x0} ${y - fs * 0.4}v${fs * 0.8}M${x1} ${y - fs * 0.4}v${fs * 0.8}`} strokeWidth={sw} />
      <text x={(x0 + x1) / 2} y={y + fs * 1.3} textAnchor="middle" style={{ fontSize: fs }}>{label}</text>
    </g>
  );
  const dimV = (x, y0, y1, label) => (
    <g className="sg-dim">
      <path d={`M${x} ${y0}V${y1}M${x - fs * 0.4} ${y0}h${fs * 0.8}M${x - fs * 0.4} ${y1}h${fs * 0.8}`} strokeWidth={sw} />
      <text transform={`translate(${x - fs * 0.5} ${(y0 + y1) / 2}) rotate(-90)`} textAnchor="middle" style={{ fontSize: fs }}>{label}</text>
    </g>
  );
  const by = ext[1] / 2 + 2.2 * fs;
  return (
    <div className="sg-draw">
      <svg className="sg-svg" viewBox={`0 0 ${vw} ${ext[1] + top + bot - ext[1] / 2}`} role="img"
        aria-label={`Three phase packs of ${n} bars, ${fmt(t, 2)} by ${fmt(w, 1)} mm, ${sp} mm centre to centre`}>
        <g transform={`translate(${ox} ${oy + ext[1] / 2})`}>
          {bars}
          {[0, 1, 2].map((p) => <text key={p} x={p * sp} y={-ext[1] / 2 - 1.4 * fs} textAnchor="middle" style={{ fontSize: fs * 1.4, fill: PH[p] }} className="sg-ph">{"ABC"[p]}</text>)}
          {dimH(0, sp, by, `${fmt(sp, 0)}`)}
          {dimH(sp, 2 * sp, by, `${fmt(sp, 0)}`)}
          {f2f ? dimV(-ext[0] / 2 - 2 * fs, -w / 2, w / 2, `${fmt(w, 1)}`) : dimH(-w / 2, w / 2, by + 3.2 * fs, `${fmt(w, 1)}`)}
          {f2f ? dimH(-pack / 2, pack / 2, by + 3.2 * fs, `${fmt(pack, 1)}`) : dimV(-w / 2 - 2 * fs, -pack / 2, pack / 2, `${fmt(pack, 1)}`)}
        </g>
      </svg>
      <div className="sg-legend">
        <span>{n} × {fmt(t, 2)} × {fmt(w, 1)} mm per phase, gap {fmt(gap, 2)} mm</span>
        <span className="text-faint">{f2f ? "face to face" : "edge to edge"} · pack {fmt(pack, 1)} mm</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ iso view */
const C30 = Math.cos(Math.PI / 6);
const iso = (x, y, z = 0) => [(x - y) * C30, (x + y) * 0.5 - z];
const P = (pts) => pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");

/* Axis-aligned bar box with the three visible faces shaded from one base colour. */
function IBox({ x0, x1, y0, y1, z0, z1, c, sw = 0.7, edge = "rgba(10,15,20,0.55)" }) {
  const top = [iso(x0, y0, z1), iso(x1, y0, z1), iso(x1, y1, z1), iso(x0, y1, z1)];
  const left = [iso(x0, y1, z0), iso(x1, y1, z0), iso(x1, y1, z1), iso(x0, y1, z1)];
  const right = [iso(x1, y1, z0), iso(x1, y0, z0), iso(x1, y0, z1), iso(x1, y1, z1)];
  const o = { stroke: edge, strokeWidth: sw, strokeLinejoin: "round", vectorEffect: "non-scaling-stroke" };
  return (
    <g>
      <polygon points={P(left)} fill={rgb(c, 0.72)} {...o} />
      <polygon points={P(right)} fill={rgb(c, 0.5)} {...o} />
      <polygon points={P(top)} fill={rgb(c, 1.08)} {...o} />
    </g>
  );
}

function IsoSection({ i, rise, air }) {
  const { t, w, n, gap, offs } = packLayout(i);
  const f2f = i.orientation === "face_to_face";
  const sp = i.phase_spacing_mm;
  const tmax = i.max_rise_c * 1.25, dom = Math.max(tmax, rise * 1.1);
  const c = scale(rise / dom);
  // Enclosure (mm): one section, floor standing.
  const L = i.support_span_m * 1000;
  const W = Math.max(1000, 1.7 * L), D = Math.max(800, 2 * sp + 520), H = 1700;
  const y0 = D * 0.34, zb = H * 0.78, xr = W * 0.66, zlow = 420;
  const ys = [0, 1, 2].map((p) => y0 + p * sp);
  // Thin bars are drawn at least 8 mm thick so they stay visible; positions follow the real layout otherwise.
  const k = Math.max(1, 8 / t), td = t * k, od = offs.map((o) => o * k);
  const aw = f2f ? 0 : w;                                    // pack extent along the phase axis for edge to edge
  // a = across the phase axis (y), b = other axis (z for the bus, x for the riser)
  const lamBox = (p, b, axisBus) => {
    const o = od[b];
    const aa = f2f ? [ys[p] + o - td / 2, ys[p] + o + td / 2] : [ys[p] - aw / 2, ys[p] + aw / 2];
    const bb = f2f ? [-w / 2, w / 2] : [o - td / 2, o + td / 2];
    return { aa, bb };
  };
  const boxes = [];
  for (let p = 0; p < 3; p++) {
    for (let b = 0; b < n; b++) {
      const { aa, bb } = lamBox(p, b);
      boxes.push({ p, grp: 1, key: aa[0] + aa[1] + bb[0] + bb[1], x0: 0, x1: W, y0: aa[0], y1: aa[1], z0: zb + bb[0], z1: zb + bb[1] });
      boxes.push({ p, grp: 0, key: aa[0] + aa[1] + bb[0] + bb[1], x0: xr + bb[0], x1: xr + bb[1], y0: aa[0], y1: aa[1], z0: zlow, z1: zb });
    }
  }
  boxes.sort((a, b) => a.p - b.p || a.grp - b.grp || a.key - b.key);
  // Support cross-members under the bus at the span positions.
  const sx = [W / 2 - L / 2, W / 2 + L / 2];
  const busBottom = zb - (f2f ? w / 2 : (n * td + (n - 1) * gap * k) / 2);
  const ext0 = ys[0] - (f2f ? td * n : aw) / 2 - 60, ext1 = ys[2] + (f2f ? td * n : aw) / 2 + 60;
  const pts = [[0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0], [0, 0, H], [W, 0, H], [W, D, H], [0, D, H]].map((q) => iso(...q));
  const xs = pts.map((q) => q[0]), yv = pts.map((q) => q[1]);
  const pad = 30, minx = Math.min(...xs) - pad, maxx = Math.max(...xs) + pad, miny = Math.min(...yv) - pad, maxy = Math.max(...yv) + pad;
  const wallBack = [iso(0, 0, 0), iso(W, 0, 0), iso(W, 0, H), iso(0, 0, H)];
  const wallLeft = [iso(0, 0, 0), iso(0, D, 0), iso(0, D, H), iso(0, 0, H)];
  const floor = [iso(0, 0, 0), iso(W, 0, 0), iso(W, D, 0), iso(0, D, 0)];
  const ln = (a, b) => `M${a[0].toFixed(1)},${a[1].toFixed(1)}L${b[0].toFixed(1)},${b[1].toFixed(1)}`;
  const frame = `${ln(iso(0, D, 0), iso(0, D, H))}${ln(iso(W, D, 0), iso(W, D, H))}${ln(iso(W, 0, 0), iso(W, 0, H))}${ln(iso(0, D, H), iso(W, D, H))}${ln(iso(W, D, H), iso(W, 0, H))}${ln(iso(0, D, H), iso(0, 0, H))}${ln(iso(W, 0, H), iso(0, 0, H))}`;
  const door = (u0, v0, u1, v1) => P([iso(u0, 0, v0), iso(u1, 0, v0), iso(u1, 0, v1), iso(u0, 0, v1)]);
  const lab = (p) => iso(W + 50, ys[p], zb + (f2f ? w / 2 : 0) + 120);
  // legend ticks in °C
  const tMin = air, tMax = air + dom;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => tMin + (tMax - tMin) * f);
  const limitT = air + i.max_rise_c, limPos = Math.min(1, (limitT - tMin) / (tMax - tMin));
  const riseT = air + rise;
  const grad = `linear-gradient(90deg, ${STOPS.map(([f, cc]) => `${rgb(cc)} ${f * 100}%`).join(", ")})`;
  const gradDom = (v) => Math.max(0, Math.min(1, v));
  return (
    <div className="sg-draw">
      <svg className="sg-svg sg-iso" viewBox={`${minx.toFixed(0)} ${miny.toFixed(0)} ${(maxx - minx).toFixed(0)} ${(maxy - miny).toFixed(0)}`} role="img"
        aria-label={`Cut-away of a switchgear section: horizontal main bus and vertical risers, ${n} bars per phase, bars at ${fmt(riseT, 0)} degrees C`}>
        <polygon points={P(floor)} fill="var(--eq-t)" opacity="0.55" />
        <polygon points={P(wallLeft)} fill="var(--eq-l)" stroke="var(--eq-edge)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <polygon points={P(wallBack)} fill="var(--eq-r)" stroke="var(--eq-edge)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {/* breaker doors drawn faintly on the rear wall to read as a cabinet */}
        {[0.06, 0.52].map((f) => [[0.1, 0.46], [0.5, 0.95]].map(([a, b], q) => (
          <polygon key={f + "-" + q} points={door(W * (f + 0.01), H * a * 0.9, W * (f + 0.42), H * b * 0.9)} fill="none" stroke="var(--eq-edge)" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity="0.55" />
        )))}
        <path d={frame} fill="none" stroke="var(--wire)" strokeWidth="1" strokeDasharray="5 4" opacity="0.5" vectorEffect="non-scaling-stroke" />
        {/* bus supports */}
        {sx.map((x) => (
          <g key={x}>
            <IBox x0={x - 18} x1={x + 18} y0={ext0} y1={ext1} z0={busBottom - 40} z1={busBottom - 6} c={[150, 120, 90]} />
            <IBox x0={x - 18} x1={x + 18} y0={ext0} y1={ext0 + 36} z0={busBottom - 300} z1={busBottom - 40} c={[150, 120, 90]} />
            <IBox x0={x - 18} x1={x + 18} y0={ext1 - 36} y1={ext1} z0={busBottom - 300} z1={busBottom - 40} c={[150, 120, 90]} />
          </g>
        ))}
        {boxes.map((b, q) => <IBox key={q} {...b} c={c} />)}
        {/* riser lug blocks */}
        {[0, 1, 2].map((p) => <IBox key={"lug" + p} x0={xr - (f2f ? w / 2 : (n * td) / 2 + 10)} x1={xr + (f2f ? w / 2 : (n * td) / 2 + 10)} y0={ys[p] - (f2f ? td * n / 2 : aw / 2) - 8} y1={ys[p] + (f2f ? td * n / 2 : aw / 2) + 8} z0={zlow - 50} z1={zlow} c={[201, 162, 79]} />)}
        {[0, 1, 2].map((p) => { const q = lab(p); return <text key={p} x={q[0]} y={q[1]} className="sg-ph" style={{ fill: PH[p], fontSize: 120 }}>{"ABC"[p]}</text>; })}
      </svg>
      <div className="sg-scale">
        <div className="sg-scale-bar" style={{ background: grad }} role="img" aria-label={`Temperature scale ${fmt(tMin, 0)} to ${fmt(tMax, 0)} degrees C`}>
          <i className="sg-mark" style={{ left: `${gradDom(limPos) * 100}%` }} title={`limit ${fmt(limitT, 0)} °C`} />
          <i className="sg-mark sg-mark-now" style={{ left: `${gradDom((riseT - tMin) / (tMax - tMin)) * 100}%` }} title={`bars ${fmt(riseT, 0)} °C`} />
        </div>
        <div className="sg-scale-ticks">{ticks.map((v, q) => <span key={q}>{fmt(v, 0)} °C</span>)}</div>
        <div className="sg-legend">
          <span>Bars at {fmt(riseT, 0)} °C ({fmt(rise, 1)} K over {fmt(air, 0)} °C air)</span>
          <span className="text-faint">marker: limit {fmt(limitT, 0)} °C · supports every {fmt(i.support_span_m, 2)} m · bars {fmt(t, 2)} mm drawn ≥ 8 mm thick · enclosure illustrative</span>
        </div>
      </div>
    </div>
  );
}

const CSS = `
.sg-grid { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 12px; padding: 12px 16px; align-items: start; }
.sg-form, .sg-results { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.sg-results .tiles { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.sg-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; }
.sg-two { align-items: start; display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.sg-wrap { white-space: normal !important; min-width: 150px; font-family: var(--font-ui) !important; }
.sg-note { font-size: 11px; color: var(--faint); margin-top: 2px; }
.sg-clause { color: var(--muted); font-size: 12px !important; }
.sg-unit { font-style: normal; color: var(--faint); font-size: 11px; }
.sg-notes { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); list-style: disc; padding-left: 18px; }
.sg-draw { display: flex; flex-direction: column; gap: 8px; }
.sg-svg { width: 100%; height: auto; max-height: 460px; display: block; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
.sg-svg.sg-iso { max-height: 620px; }
.sg-svg text { font-family: var(--font-data); fill: var(--fg); }
.sg-axis { font-size: 11.5px; fill: var(--muted) !important; }
.sg-faint { fill: var(--faint) !important; font-size: 10px; }
.sg-val { font-size: 12px; }
.sg-ref { stroke: var(--muted); stroke-dasharray: 4 3; stroke-width: 1; }
.sg-bar { stroke: rgba(10, 15, 20, 0.7); }
.sg-ph { font-weight: 600; }
.sg-dim path { stroke: var(--muted); fill: none; }
.sg-dim text { fill: var(--muted) !important; }
.sg-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-family: var(--font-data); font-size: 11.5px; color: var(--muted); }
.sg-scale { display: flex; flex-direction: column; gap: 4px; max-width: 520px; }
.sg-scale-bar { position: relative; height: 12px; border-radius: 3px; border: 1px solid var(--line); }
.sg-mark { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--fg); }
.sg-mark-now { background: var(--bg); box-shadow: 0 0 0 1px var(--fg); }
.sg-scale-ticks { display: flex; justify-content: space-between; font-family: var(--font-data); font-size: 11px; color: var(--muted); }
@media (max-width: 899px) { .sg-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 420px) { .sg-fields { grid-template-columns: minmax(0, 1fr); } .sg-grid { padding: 10px 12px; } .sg-two { grid-template-columns: minmax(0, 1fr); } }
`;
