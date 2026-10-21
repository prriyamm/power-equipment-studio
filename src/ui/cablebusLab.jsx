/* Cable bus "Lab test" view: a virtual high-power short-circuit test. A short cable bus specimen sits in a test
   bay between a busbar feed and a shorting bar; the calculated currents, forces and temperatures drive a
   slow-motion playback, and the specimen fails (block cracks, conductors whip, arc flash) at the instant the
   calculation says one of its criteria is reached. Engine: src/engine/scLabTest.js; animation state:
   src/ui/labAnim.js; three.js scene: src/ui/three/labEffects.js.
   SCREENING LEVEL: block strength is UNVERIFIED screening data or the tested rating you enter; the effects
   are illustrative. Not a substitute for a CSA C22.2 No. 273 / IEEE C37.23 type test. */
const { useState, useMemo, useEffect, useRef } = React;
import { Btn, Field, NumField, Pill, Section, fmt, StateMsg } from "./common.jsx";
import { Chart, Line, RefLine, Dot, PHASE_VAR } from "./charts/index.js";
import { useQuality } from "./quality.js";
import { createViewer } from "./three/viewer.js";
import { disposeGroup } from "./three/parts.js";
import { buildLab } from "./three/labEffects.js";
import { BLOCK_MATERIALS } from "../engine/pecalc/cablebus_design.js";
import { labInput, runLabTest, findFailureCurrent, SCREENING_NOTE } from "../engine/scLabTest.js";
import { labState, labLayout, playEnd, stillTime, utilColor } from "./labAnim.js";

export const LAB_STATE = {
  ka: undefined, xr: undefined, dur: 0.5, angle: undefined, mat: "GPO-3", thk: 25.4, sf: 2, blk: undefined, frc: undefined,
  dmg: undefined, spans: 3, scale: 100, cover: "cut", visited: false,
};
const COVERS = [["cut", "cut-away"], ["transparent", "transparent"], ["closed", "closed"]];
const SCALES = [[10, "1 ms = 10 ms"], [100, "1 ms = 100 ms"], [1000, "1 ms = 1 s"]];

const CSS = `
.lab-grid { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 12px; padding: 12px 16px; align-items: start; }
.lab-form, .lab-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.lab-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; }
.lab-fields .lab-wide { grid-column: 1 / -1; }
.lab-stage { position: relative; height: 440px; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--bg); }
.lab-wrap { position: absolute; inset: 0; }
.lab-wrap canvas { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
.lab-lbl { position: absolute; left: 0; top: 0; display: flex; flex-direction: column; padding: 2px 6px 2px 7px; background: var(--tag-bg); border: 1px solid var(--line); border-left: 3px solid var(--faint); border-radius: 4px; white-space: nowrap; pointer-events: none; }
.lab-lbl b { font-family: var(--font-data); font-size: 11px; font-weight: 600; color: var(--fg); }
.lab-lbl span { font-family: var(--font-data); font-size: 9.5px; color: var(--muted); }
.lab-banner { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); padding: 6px 16px; border-radius: 6px; font-weight: 700; font-size: 14px; letter-spacing: 0.02em; pointer-events: none; white-space: nowrap; }
.lab-banner.fail { background: rgba(220, 38, 38, 0.92); color: #fff; box-shadow: 0 0 24px rgba(255, 60, 60, 0.45); }
.lab-banner.pass { background: rgba(22, 150, 90, 0.92); color: #fff; }
.lab-hud { position: absolute; left: 10px; bottom: 30px; padding: 4px 8px; background: var(--tag-bg); border: 1px solid var(--line); border-radius: 5px; font-family: var(--font-data); font-size: 11.5px; color: var(--fg); pointer-events: none; }
.lab-cap { position: absolute; left: 10px; right: 10px; bottom: 8px; font-size: 11px; color: var(--muted); pointer-events: none; text-shadow: 0 0 4px var(--bg), 0 0 4px var(--bg); }
.lab-cap b { color: var(--fg); font-weight: 600; }
.lab-legend { position: absolute; right: 10px; top: 10px; padding: 5px 8px; background: var(--tag-bg); border: 1px solid var(--line); border-radius: 5px; font-size: 11px; color: var(--muted); pointer-events: none; display: flex; flex-direction: column; gap: 3px; }
.lab-legend .bar { height: 8px; width: 130px; border-radius: 2px; border: 1px solid var(--line); }
.lab-legend .tk { display: flex; justify-content: space-between; font-family: var(--font-data); font-size: 10px; }
.lab-ctl { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.lab-ctl input[type=range] { flex: 1 1 260px; min-width: 160px; accent-color: var(--accent); }
.lab-read { font-family: var(--font-data); font-size: 12px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 2px 14px; }
.lab-read b { color: var(--fg); font-weight: 500; }
.lab-kv { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 14px; font-size: 13px; }
.lab-kv span:nth-child(odd) { color: var(--muted); }
.lab-kv span:nth-child(even) { font-family: var(--font-data); text-align: right; }
.lab-res { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-weight: 700; font-size: 15px; }
.lab-res.fail { color: var(--crit); } .lab-res.pass { color: var(--ok); }
.lab-note { font-size: 12px; color: var(--faint); margin-top: 6px; }
.lab-st-USER { color: var(--muted); } .lab-st-UNVERIFIED, .lab-st-NOTSET { color: var(--st-warn); }
.lab-svg { width: 100%; height: 100%; display: block; background: var(--bg); }
.lab-scope { display: flex; flex-direction: column; gap: 4px; }
@media (max-width: 899px) { .lab-grid { grid-template-columns: minmax(0, 1fr); } .lab-stage { height: 360px; } }
`;

const stdFmt = (v) => (Number.isFinite(v) ? fmt(v, Math.abs(v) >= 100 ? 0 : Math.abs(v) < 10 ? 2 : 1) : "inf");

/* ------------------------------------------------------------ model */
export function mkLab(inp, lab) {
  return labInput({
    bus: inp, test_ka: lab.ka ?? inp.fault_ka ?? null, x_over_r: lab.xr ?? null, duration_s: lab.dur ?? 0.5,
    closing_angle_deg: lab.angle ?? null, block_material: lab.mat || null, block_thickness_mm: lab.thk ?? 25.4,
    block_safety_factor: lab.sf ?? 2, tested_block_load_n: lab.blk ?? null, tested_force_n_per_m: lab.frc ?? null,
    damage_temp_c: lab.dmg ?? null, n_spans: lab.spans ?? 3,
  });
}
export function computeLab(inp, ctx, lab) {
  try {
    const L = mkLab(inp, lab);
    return { L, run: runLabTest(L, ctx) };
  } catch (e) { return { error: e.message }; }
}

/* ------------------------------------------------------------ 3D stage */
function Stage({ run, layout, tier, cover, scale, t, playing, end, onTime, onEnd, onFail }) {
  const wrapRef = useRef(null), canvasRef = useRef(null), vRef = useRef(null), handleRef = useRef(null);
  const live = useRef({});
  live.current = { run, layout, tier, cover, scale, end, playing, onTime, onEnd };
  const tRef = useRef(t), lastEmit = useRef(0), shaken = useRef(false);

  const apply = (tt) => {
    const L = live.current, h = handleRef.current, v = vRef.current;
    if (!h || !v) return null;
    const st = labState(L.run, L.layout, tt, { scale: L.scale, tier: L.tier });
    h.update(st);
    const sh = st.shake;
    if (sh[0] || sh[1] || sh[2]) { v.place(); v.camera.position.x += sh[0]; v.camera.position.y += sh[1]; v.camera.position.z += sh[2]; shaken.current = true; }
    else if (shaken.current) { v.place(); shaken.current = false; }
    return st;
  };

  useEffect(() => {
    if (typeof THREE === "undefined") { onFail(); return undefined; }
    let v;
    try {
      v = createViewer(canvasRef.current, wrapRef.current, {
        background: 0x0b1117, gridSize: 12, gridDivisions: 24, gridColors: [0x1b2630, 0x131b22], groundColor: 0x0e1419, groundSize: 60,
        near: 0.05, far: 80, minR: 1.2, maxR: 14, env: false, fill: 0.85,
        orbit: { theta: -0.8, phi: 1.1, r: 4.6 }, sun: { intensity: 1.45, extent: 6, near: 0.5, far: 30, bias: -0.0005, position: [-6, 9, 5] },
      });
    } catch (e) { onFail(); return undefined; }
    v.group = new THREE.Group(); v.world.add(v.group);
    vRef.current = v;
    window.__scLab = window.__scLab || { frames: 0 };
    v.onFrame((dt) => {
      const L = live.current;
      if (L.playing) {
        let tt = tRef.current + dt / L.scale;
        if (tt >= L.end) { tt = L.end; L.playing = false; live.current.playing = false; L.onEnd(tt); }
        tRef.current = tt;
        const now = performance.now();
        if (now - lastEmit.current > 60) { lastEmit.current = now; L.onTime(tt); }
      }
      apply(tRef.current);
      window.__scLab.frames++;
      return live.current.playing;
    });
    return () => { v.dispose(); vRef.current = null; handleRef.current = null; };
  }, []);

  // (re)build the bay when the run, layout or graphics tier changes
  useEffect(() => {
    const v = vRef.current; if (!v) return;
    disposeGroup(v.group); v.clearLabels();
    const h = buildLab(v.group, v, layout, run, { tier, cover: live.current.cover });
    handleRef.current = h;
    if (!v.framed) {
      v.orbit.target.copy(h.center); v.sun.target.position.copy(h.center);
      v.framed = true;
    }
    v.place();
    apply(tRef.current);
    v.invalidate();
  }, [run, layout, tier]);

  // cover mode: material and visibility only, no rebuild
  useEffect(() => {
    const v = vRef.current, h = handleRef.current; if (!v || !h) return;
    h.setCover(cover); apply(tRef.current); v.invalidate();
  }, [cover]);

  // scrub / reset while not playing
  useEffect(() => {
    const v = vRef.current;
    if (!v) return;
    if (!playing) { tRef.current = t; apply(t); v.invalidate(); }
  }, [t, playing, scale]);
  useEffect(() => {
    const v = vRef.current; if (!v) return;
    if (playing) { live.current.playing = true; v.invalidate(); }
  }, [playing]);

  return <div ref={wrapRef} className="lab-wrap"><canvas ref={canvasRef} /></div>;
}

/* ------------------------------------------------------------ 2D cut-away fallback (no WebGL) */
function SvgStage({ run, layout, tier, t, scale }) {
  const st = labState(run, layout, t, { scale, tier: "low" });
  const W = 760, H = 300, padX = 40, zs = layout.zs, L = layout.L;
  const X = (z) => padX + (z / L) * (W - 2 * padX), yPx = (y) => 190 - (y - layout.base) * 120;
  const ex = 40; // deflection shown extra-exaggerated in the cut-away
  const ys = [...new Set(layout.cables.map((c) => c.y))];
  return (
    <svg className="lab-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cut-away elevation of the specimen during the virtual test">
      <rect x={X(0) - 10} y={yPx(layout.H + layout.base) } width={X(L) - X(0) + 20} height={layout.H * 120} fill="none" style={{ stroke: "var(--muted)" }} strokeDasharray="6 4" />
      {layout.cables.map((c) => {
        const s = st.conductors.find((q) => q.i === c.i);
        const pts = Array.from({ length: 49 }, (_, k) => {
          const z = (k / 48) * L, w = (() => { let a = 0; while (a < zs.length - 2 && z > zs[a + 1]) a++; const z0 = zs[a], z1 = zs[a + 1], u = (z - z0) / (z1 - z0); return 16 * u * u * (1 - u) * (1 - u); })();
          return `${X(z)},${yPx(c.y) - (s ? s.dy * ex * 120 * w : 0)}`;
        });
        return <polyline key={c.i} points={pts.join(" ")} fill="none" strokeWidth="3" style={{ stroke: PHASE_VAR[c.phase] }} />;
      })}
      {zs.map((z, b) => {
        const u = st.blocks[b], [r, g, bl] = utilColor(u.util);
        return u.broken ? null : <rect key={b} x={X(z) - 5} y={yPx(Math.max(...ys)) - 28} width="10" height={(Math.max(...ys) - Math.min(...ys)) * 120 + 56} fill={`rgb(${r | 0},${g | 0},${bl | 0})`} />;
      })}
      {st.fragments.map((f, k) => <rect key={k} x={X(f.pos[2]) - 4} y={yPx(f.pos[1])} width="8" height="6" fill="#b0502e" transform={`rotate(${(f.rot[0] * 57) % 360} ${X(f.pos[2])} ${yPx(f.pos[1])})`} />)}
      {st.failed && st.flash.i > 0.01 && <circle cx={X(st.origin[2])} cy={yPx(st.origin[1])} r={14 + 60 * st.flash.i} fill="#fff" opacity={Math.min(1, st.flash.i)} />}
      <text x={padX} y="24" style={{ fill: "var(--muted)", fontSize: 11 }}>2D cut-away (WebGL not available): elevation along the run, deflection exaggerated further</text>
    </svg>
  );
}

/* ------------------------------------------------------------ view */
export function LabView({ active, inp, ctx, ss, setSs }) {
  const lab = ss.lab || LAB_STATE;
  const setLab = (patch) => setSs((s) => ({ ...s, lab: { ...(s.lab || LAB_STATE), ...patch } }));
  const q = useQuality();
  const anim = q.animations;
  const labKey = [lab.ka, lab.xr, lab.dur, lab.angle, lab.mat, lab.thk, lab.sf, lab.blk, lab.frc, lab.dmg, lab.spans].join("|");
  const res = useMemo(() => computeLab(inp, ctx, lab), [inp, ctx, labKey]);
  const run = res.run;
  const layout = useMemo(() => (ctx ? labLayout(ctx, lab.spans ?? 3, 0.4, { block_thickness_mm: lab.thk ?? 25.4 }) : null), [ctx, lab.spans, lab.thk]);
  const scale = lab.scale ?? 100;
  const [t, setT] = useState(0), [playing, setPlaying] = useState(false), [noGl, setNoGl] = useState(false);
  const [ff, setFf] = useState(null);
  useEffect(() => { if (active && !lab.visited) setLab({ visited: true }); }, [active]);
  const end = run ? playEnd(run, scale) : 0;
  // new run: back to the start (or the final state image when animations are off)
  useEffect(() => { setPlaying(false); setT(run ? (anim ? 0 : stillTime(run, scale)) : 0); }, [run, anim]);
  useEffect(() => { setFf(null); }, [inp, ctx, lab.dur, lab.xr, lab.angle, lab.mat, lab.thk, lab.sf, lab.blk, lab.frc, lab.dmg]);
  useEffect(() => { if (!anim) setPlaying(false); }, [anim]);

  const dt = run ? run.t_s[1] - run.t_s[0] : 1;
  const kEnd = run ? Math.min(run.t_s.length - 1, Math.round(end / dt)) : 0;
  const tc = Math.min(t, end);
  const kc = run ? Math.min(kEnd, Math.round(tc / dt)) : 0;
  const tms = useMemo(() => (run ? run.t_s.slice(0, kEnd + 1).map((v) => v * 1000) : []), [run, kEnd]);
  const winMs = tms.length ? tms[tms.length - 1] : 1;

  const scopeLines = useMemo(() => {
    if (!run) return null;
    const pts = (arr, f = 1) => tms.map((x, k) => ({ x, y: arr[k] * f }));
    const stride = Math.max(1, Math.floor(tms.length / 1200));
    const dec = (d) => (stride > 1 ? d.filter((_, k) => k % stride === 0 || k === d.length - 1) : d);
    const ymax = Math.max(...["A", "B", "C"].map((p) => Math.max(...run.phase_current_a[p].slice(0, kEnd + 1).map(Math.abs)))) / 1000 * 1.1;
    const um = Math.min(250, Math.max(115, run.peak_utilisation * 110));
    const cl = (arr) => dec(tms.map((x, k) => ({ x, y: Math.min(um, arr[k] * 100) })));
    return {
      ymax, um,
      cur: ["A", "B", "C"].map((p) => <Line key={p} data={dec(pts(run.phase_current_a[p], 0.001))} color={PHASE_VAR[p]} width={1.6} />),
      util: [
        run.block_ratio ? <Line key="b" data={cl(run.block_ratio)} color="var(--accent)" /> : null,
        run.force_ratio ? <Line key="f" data={cl(run.force_ratio)} color="var(--series-2)" dash="4 3" /> : null,
        <Line key="t" data={cl(run.heat_ratio)} color="var(--high)" width={1.6} dash="2 3" />,
      ],
    };
  }, [run, tms, kEnd]);

  const play = () => {
    if (!anim || !run) return;
    if (playing) { setPlaying(false); return; }
    if (t >= end - 1e-9) setT(0);
    setPlaying(true);
  };
  const runTest = () => { if (!run) return; if (!anim) { setT(stillTime(run, scale)); return; } setT(0); setPlaying(true); };
  const findFail = () => {
    try { setFf({ r: findFailureCurrent(res.L, ctx) }); } catch (e) { setFf({ error: e.message }); }
  };
  const blow = () => {
    if (!ff?.r) return;
    setLab({ ka: Math.ceil(ff.r.lowest.current_ka * 1.02 * 1000) / 1000 });
  };

  const f = run?.failure;
  const bannerFail = f && tc >= f.t_s;
  const bannerPass = run && !f && (tc >= end * 0.97 || !anim);
  const st = run && layout ? labState(run, layout, tc, { scale, tier: q.tier }) : null;
  const peakU = run ? run.peak_utilisation : 0;
  const setN = (k) => (v) => setLab({ [k]: v });
  const ang = lab.angle === undefined ? (run ? run.worst_angle_deg : 0) : lab.angle;
  const autoAng = lab.angle === undefined;

  return (
    <div className="lab-grid">
      <style>{CSS}</style>
      <div className="lab-form">
        <Section title="Test setup" aside={<span className="text-faint text-[12px]">virtual lab, screening level</span>}>
          <div className="lab-fields">
            <Field label="Test current" unit="kA rms sym"><NumField id="lab-ka" value={lab.ka} placeholder={inp?.fault_ka ? String(inp.fault_ka) : "required"} onCommit={setN("ka")} /></Field>
            <Field label="X/R"><NumField id="lab-xr" value={lab.xr} placeholder={String(inp?.x_over_r ?? 15)} onCommit={setN("xr")} /></Field>
            <Field label="Duration" unit="s" hint="from your test plan"><NumField id="lab-dur" value={lab.dur} onCommit={(v) => v !== undefined && v > 0 && setN("dur")(v)} /></Field>
            <Field label="Specimen spans" hint="blocks = spans + 1">
              <select id="lab-spans" className="num-input" value={lab.spans ?? 3} onChange={(e) => setLab({ spans: Number(e.target.value) })}>{[2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </Field>
            <div className="lab-wide">
              <span className="field-label">Closing angle <em>{fmt(ang, 0)}°{autoAng ? " (worst case)" : ""}</em></span>
              <div className="lab-ctl" style={{ marginTop: 4 }}>
                <input id="lab-angle" type="range" min="0" max="180" step="1" value={Math.round(ang)} aria-label="Closing angle in degrees" onChange={(e) => setLab({ angle: Number(e.target.value) })} />
                <Btn onClick={() => setLab({ angle: undefined })} active={autoAng} title="Use the angle at which the force is greatest">Worst</Btn>
              </div>
            </div>
            <Field label="Block material">
              <select id="lab-mat" className="num-input" value={lab.mat || ""} onChange={(e) => setLab({ mat: e.target.value })}>
                <option value="">none</option>{Object.keys(BLOCK_MATERIALS).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
            <Field label="Block thickness" unit="mm"><NumField id="lab-thk" value={lab.thk} onCommit={(v) => v !== undefined && v > 0 && setN("thk")(v)} /></Field>
            <Field label="Safety factor" hint="1 = tensile strength"><NumField id="lab-sf" value={lab.sf} onCommit={(v) => v !== undefined && v > 0 && setN("sf")(v)} /></Field>
            <Field label="Tested block rating" unit="N" hint="replaces the screening limit"><NumField id="lab-blk" value={lab.blk} placeholder="optional" onCommit={setN("blk")} /></Field>
            <Field label="Tested force" unit="N/m" hint="optional criterion"><NumField id="lab-frc" value={lab.frc} placeholder="optional" onCommit={setN("frc")} /></Field>
            <Field label="Damage temperature" unit="°C" hint="default: insulation limit"><NumField id="lab-dmg" value={lab.dmg} placeholder={String(inp?.insulation_sc_limit_c ?? 250)} onCommit={setN("dmg")} /></Field>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <Btn kind="primary" onClick={runTest} disabled={!run} title="Start the test from t = 0">Run test</Btn>
            <Btn onClick={findFail} disabled={!run} title="Lowest current at which a criterion is reached">Find failure current</Btn>
          </div>
          {ff?.error && <p className="lab-note" role="alert">{ff.error}</p>}
          {ff?.r && (
            <div className="mt-3" aria-live="polite">
              <div className="lab-kv">
                {ff.r.modes.map((m) => (<React.Fragment key={m.mode}><span>{m.mode === "block" ? "Block" : m.mode === "force" ? "Conductor force" : "Conductor temperature"} ({m.method})</span><span>{fmt(m.current_ka, 2)} kA</span></React.Fragment>))}
                <span><b>Lowest failure current</b></span><span><b>{fmt(ff.r.lowest.current_ka, 2)} kA</b> ({fmt(ff.r.ratio_to_test, 2)} × test)</span>
              </div>
              <div className="mt-2"><Btn onClick={blow} title="Sets the test current to the failure current plus 2 %">Set test current to failure +2 %</Btn></div>
              <p className="lab-note">Same X/R, closing angle and {fmt(lab.dur ?? 0.5, 2)} s duration. Force and block load scale with I²; temperature by bisection. Screening level.</p>
            </div>
          )}
          <p className="lab-note">Block strength: the tested rating if entered, otherwise the designer&apos;s web-stress screening (material values UNVERIFIED). Starting conductor temperature is the insulation rating of the design.</p>
        </Section>

        <Section title="Result" aside={run ? <Pill tone={run.passed ? "ok" : "crit"}>{run.passed ? "Passed" : "Failed"}</Pill> : null}>
          {res.error && <StateMsg kind="error" title="Cannot run the virtual test">{res.error}. Enter the test current (kA rms symmetrical).</StateMsg>}
          {run && (
            <>
              <div className={`lab-res ${run.passed ? "pass" : "fail"}`}>
                {run.passed ? `PASSED — peak utilisation ${fmt(peakU * 100, 0)} %` : `FAILED at ${fmt(f.t_ms, 1)} ms — ${f.mode_label}`}
              </div>
              <div className="lab-kv">
                <span>Verdict</span><span>{run.passed ? "no criterion reached" : "criterion reached"}</span>
                <span>Failure mode</span><span>{f ? f.mode_label : "none"}</span>
                <span>Failure time</span><span>{f ? `${fmt(f.t_ms, 2)} ms` : "—"}</span>
                <span>Failed element</span><span>{f ? `conductor ${f.conductor_phase} (#${f.conductor_index}), block ${f.block_index + 1} of ${f.n_blocks}` : "—"}</span>
                <span>Peak utilisation</span><span>{fmt(peakU * 100, 1)} % ({run.governing_mode})</span>
                <span>Margin</span><span>{run.margin_pct >= 0 ? `${fmt(run.margin_pct, 1)} %` : `exceeded by ${fmt(-run.margin_pct, 1)} %`}</span>
                <span>Block utilisation (peak)</span><span>{run.peaks.block === null ? "not evaluated" : `${fmt(run.peaks.block * 100, 1)} %`}</span>
                <span>Conductor temp. at end</span><span>{fmt(run.peak_temp_c, 1)} °C / {fmt(run.limits.damage_c, 0)} °C</span>
                <span>Peak force</span><span>{fmt(run.peak_force_n_per_m, 0)} N/m</span>
                <span>Block strength basis</span><span>{run.limits.block_basis}</span>
              </div>
              <p className="lab-note"><b>UNVERIFIED</b> screening result. {SCREENING_NOTE}</p>
            </>
          )}
        </Section>
      </div>

      <div className="lab-main">
        {!run && !res.error ? null : null}
        {run && layout && (
          <>
            <div className="lab-stage" data-testid="lab-stage">
              {noGl || typeof THREE === "undefined"
                ? <SvgStage run={run} layout={layout} tier={q.tier} t={tc} scale={scale} />
                : <Stage run={run} layout={layout} tier={q.tier} cover={lab.cover ?? "cut"} scale={scale} t={tc} playing={playing} end={end}
                  onTime={(v) => setT(v)} onEnd={(v) => { setPlaying(false); setT(v); }} onFail={() => setNoGl(true)} />}
              <div className="lab-hud">t = {fmt(tc * 1000, 2)} ms · screen {fmt(tc * scale, 2)} s · {SCALES.find((s) => s[0] === scale)?.[1]}</div>
              <div className="lab-legend">
                <b style={{ color: "var(--fg)" }}>Block utilisation</b>
                <div className="bar" style={{ background: `linear-gradient(90deg, ${[0, 0.3, 0.6, 0.8, 1].map((u) => `rgb(${utilColor(u).map(Math.round).join(",")}) ${u * 100}%`).join(", ")})` }} />
                <div className="tk"><span>0</span><span>60</span><span>100 %</span></div>
                <span>conductors warm toward orange with temperature</span>
              </div>
              {bannerFail && <div className="lab-banner fail" role="status">FAILED at {fmt(f.t_ms, 1)} ms — {f.mode_label}</div>}
              {bannerPass && <div className="lab-banner pass" role="status">PASSED — peak utilisation {fmt(peakU * 100, 0)} %</div>}
              <div className="lab-cap"><b>Illustrative animation; failure time and mode from calculations.</b> {run.deflection.exaggeration >= 1.05 ? `Deflection exaggerated ×${fmt(run.deflection.exaggeration, 0)}` : `Deflection drawn at ${fmt(run.deflection.exaggeration, 2)}× the elastic estimate`} · screening level{q.tier === "low" ? " · low graphics tier: reduced effects" : ""}</div>
            </div>
            <div className="lab-ctl">
              {anim
                ? <Btn onClick={play} active={playing} title="Play or pause the slow-motion test">{playing ? "Pause" : t >= end - 1e-9 ? "Replay" : "Play"}</Btn>
                : <span className="text-faint text-[12px]" title="Animations are off in the graphics menu or by the system motion setting">Animation off: final state shown</span>}
              <Btn onClick={() => { setPlaying(false); setT(0); }} title="Back to before the test">Reset</Btn>
              <span className="text-[12px] text-faint" id="lab-cover-lbl">Cover</span>
              <div role="group" aria-labelledby="lab-cover-lbl" style={{ display: "inline-flex", gap: 4 }}>
                {COVERS.map(([v, l]) => <Btn key={v} active={(lab.cover ?? "cut") === v} onClick={() => setLab({ cover: v })} title={`Enclosure cover: ${l}`}>{l}</Btn>)}
              </div>
              <input type="range" min="0" max={kEnd} step="1" value={kc} aria-label="Test time" onChange={(e) => { setPlaying(false); setT(Number(e.target.value) * dt); }} />
              <label className="text-[12px] text-faint">Slow motion{" "}
                <select className="num-input" style={{ width: "auto" }} value={scale} onChange={(e) => setLab({ scale: Number(e.target.value) })} aria-label="Time scale">
                  {SCALES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            </div>
            <div className="lab-read">
              <span>t <b>{fmt(tc * 1000, 2)} ms</b></span>
              {["A", "B", "C"].map((p) => <span key={p}>i{p} <b>{fmt(run.phase_current_a[p][kc] / 1000, 1)} kA</b></span>)}
              <span>force <b>{fmt(run.force_envelope_n_per_m[kc], 0)} N/m</b></span>
              <span>block util. <b>{run.block_ratio ? `${fmt(run.block_ratio[kc] * 100, 1)} %` : "—"}</b></span>
              <span>hot conductor <b>{fmt(run.limits.t0 + run.heat_ratio[kc] * (run.limits.damage_c - run.limits.t0), 1)} °C</b></span>
            </div>
            <Section title="Oscilloscope" aside={<span className="text-faint text-[12px]">{fmt(run.test_ka, 1)} kA rms sym · X/R {fmt(run.x_over_r, 1)} · closing angle {fmt(run.closing_angle_deg, 0)}°</span>}>
              <div className="lab-scope">
                <Chart height={170} ariaLabel="Phase currents versus time in the virtual test" reportTitle="Virtual lab test: phase currents"
                  x={{ domain: [0, winMs], nice: false, label: "Time", unit: "ms", grid: true }}
                  y={{ domain: [-scopeLines.ymax, scopeLines.ymax], label: "Phase current", unit: "kA" }}
                  legend={[{ name: "A", color: PHASE_VAR.A }, { name: "B", color: PHASE_VAR.B }, { name: "C", color: PHASE_VAR.C }]}>
                  {scopeLines.cur}
                  {f && f.t_ms <= winMs ? <RefLine x={f.t_ms} tone="crit" label="failure" dash="3 3" /> : null}
                  <RefLine x={tc * 1000} tone="accent" dash="2 3" />
                </Chart>
                <Chart height={160} ariaLabel="Utilisation versus time in the virtual test" reportTitle="Virtual lab test: utilisation versus time"
                  x={{ domain: [0, winMs], nice: false, label: "Time", unit: "ms", grid: true }}
                  y={{ domain: [0, scopeLines.um], label: "Utilisation", unit: "%" }}
                  legend={[...(run.block_ratio ? [{ name: "block load / strength", color: "var(--accent)" }] : []), ...(run.force_ratio ? [{ name: "force / tested", color: "var(--series-2)", kind: "ref" }] : []), { name: "temperature rise / allowed", color: "var(--high)", kind: "ref" }]}>
                  <RefLine y={100} tone="crit" label="100 % = failure" align="start" />
                  {scopeLines.util}
                  {f && f.t_ms <= winMs ? <Dot x={f.t_ms} y={Math.min(scopeLines.um, 100)} color="var(--crit)" label={`${fmt(f.t_ms, 1)} ms`} /> : null}
                  <RefLine x={tc * 1000} tone="accent" dash="2 3" />
                </Chart>
              </div>
              <p className="lab-note">Utilisation is the largest of block load / block strength, force / tested force (if entered) and the share of the allowed temperature rise used. 100 % is the failure criterion.</p>
            </Section>
            <Section title="Data status" aside={<Pill tone="warn">screening, UNVERIFIED</Pill>}>
              <div className="table-wrap">
                <table className="grid-table">
                  <thead><tr><th>Value</th><th>Used</th><th>Status</th><th>Source</th></tr></thead>
                  <tbody>{run.data_status.map((r, k) => (
                    <tr key={k}><td className="cb-wrap">{r.name}</td><td className="cb-wrap">{r.value}</td>
                      <td className={`lab-st-${String(r.status).split(" ")[0].replace(/[^A-Z]/g, "")}`}><b>{r.status}</b></td><td className="cb-wrap">{r.source}</td></tr>))}</tbody>
                </table>
              </div>
              <ul className="cb-notes mt-2">{run.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ calculation package */
export function labReportParts(inp, ctx, lab) {
  if (!lab || !lab.visited) return null;
  const res = computeLab(inp, ctx, lab);
  if (!res.run) return null;
  const { run, L } = res;
  let ff = null;
  try { ff = findFailureCurrent(L, ctx); } catch (e) { ff = null; }
  const f = run.failure;
  const checks = [
    run.block_ratio ? { name: "Virtual lab test: block load within block strength", clause: "screening (UNVERIFIED)", value: run.peaks.block * 100, limit: 100, unit: "%", passed: run.peaks.block < 1, note: run.limits.block_basis } : null,
    { name: "Virtual lab test: conductor temperature below damage temperature", clause: "ICEA P-32-382 (adiabatic)", value: run.peak_temp_c, limit: run.limits.damage_c, unit: "C", passed: run.peaks.thermal < 1, note: `from ${fmt(run.limits.t0, 0)} C over ${fmt(run.duration_s * 1000, 0)} ms` },
    run.force_ratio ? { name: "Virtual lab test: force within tested force per metre", clause: "tested value", value: run.peak_force_n_per_m, limit: L.tested_force_n_per_m, unit: "N/m", passed: run.peaks.force < 1, note: "" } : null,
  ].filter(Boolean);
  return {
    inputs: [
      { label: "Lab test current", value: run.test_ka, unit: "kA rms sym" }, { label: "Lab test X/R", value: run.x_over_r, unit: "" },
      { label: "Lab test duration", value: run.duration_s, unit: "s" }, { label: "Lab test closing angle", value: run.closing_angle_deg, unit: "deg" },
      { label: "Lab block strength basis", value: run.limits.block_basis, unit: "" }, { label: "Lab damage temperature", value: run.limits.damage_c, unit: "C" },
    ],
    results: [
      { label: "Lab test verdict", value: run.passed ? "PASSED" : "FAILED", unit: "" },
      { label: "Lab test failure mode", value: f ? f.mode_label : "none", unit: "" },
      { label: "Lab test failure time", value: f ? f.t_ms : "n/a", unit: f ? "ms" : "" },
      { label: "Lab test failed element", value: f ? `conductor ${f.conductor_phase} (#${f.conductor_index}), block ${f.block_index + 1} of ${f.n_blocks}` : "n/a", unit: "" },
      { label: "Lab test peak utilisation", value: run.peak_utilisation * 100, unit: "%" },
      { label: "Lab test margin", value: run.margin_pct, unit: "%" },
      ...(ff ? [{ label: "Lowest failure current (same X/R, angle, duration)", value: ff.lowest.current_ka, unit: "kA" }, { label: "Lowest failure mode", value: ff.lowest.mode, unit: "" }] : []),
    ],
    checks, notes: run.notes,
    dataStatus: run.data_status.map((d) => ({ ...d, name: `Lab test, ${d.name}` })),
  };
}
