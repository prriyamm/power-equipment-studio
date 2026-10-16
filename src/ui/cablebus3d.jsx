/* To-scale 3D model of a straight 3 to 4 m length of ventilated aluminium cable bus: side rails, bottom plate,
   slotted cover (partly cut away), GPO-3 support blocks at the design spacing and the analysed cables at their
   real positions, with the copper core stripped at the cut end. Millimetres in, metres in the scene.
   Axes: x across the enclosure, y up, z along the run (cut end at +z, nearest the default camera). */
const { useEffect, useRef, useState } = React;
import { createViewer } from "./three/viewer.js";
import { MM, scale, threeColor, gradientCss, std, boxMm, cylMm, addEdges, lineMm, labelEl, v3, plateWithHoles, disposeGroup } from "./three/parts.js";
import { conductorDiameterMm } from "./cablebusUtil.js";
import { fmt } from "./common.jsx";

const PH_HEX = { A: 0xe05a4f, B: 0xe8c35a, C: 0x5aa0e0 };
const PH_CSS = { A: "#e05a4f", B: "#e8c35a", C: "#5aa0e0" };
const LOAD_DOM = 120; // loading colour scale runs 0 to 120 %

const CSS = `
.cb3-box { position: relative; height: 600px; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--bg); }
.cb3-wrap { position: relative; height: 100%; overflow: hidden; }
.cb3-wrap canvas { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
.cb3-wrap canvas:active { cursor: grabbing; }
.cb3-lbl { position: absolute; left: 0; top: 0; display: flex; flex-direction: column; gap: 0; padding: 2px 6px 2px 7px; background: var(--tag-bg); border: 1px solid var(--line); border-left: 3px solid var(--faint); border-radius: 4px; white-space: nowrap; pointer-events: none; }
.cb3-lbl b { font-family: var(--font-data); font-size: 11px; font-weight: 600; color: var(--fg); }
.cb3-lbl span { font-family: var(--font-data); font-size: 9.5px; color: var(--muted); }
.cb3-lbl.dim { border-left-color: var(--muted); }
.cb3-ui { position: absolute; left: 10px; top: 10px; display: flex; align-items: center; gap: 8px; padding: 5px 8px; background: var(--tag-bg); border: 1px solid var(--line); border-radius: 6px; font-size: 11.5px; color: var(--muted); }
.cb3-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
.cb3-seg button { padding: 3px 10px; font-size: 11.5px; color: var(--muted); background: transparent; border: 0; cursor: pointer; }
.cb3-seg button + button { border-left: 1px solid var(--line); }
@media (max-width: 640px) { .cb3-seg button { min-height: 40px; padding: 6px 12px; font-size: 12.5px; } }
.cb3-cap { color: var(--faint); font-size: 10.5px; }
@media (max-width: 640px) { .cb3-lbl span, .cb3-ticks, .cb3-cap { font-size: 11px; } }
.cb3-seg button[aria-pressed="true"] { background: var(--accent-soft, rgba(216,178,90,0.2)); color: var(--fg); }
.cb3-legend { position: absolute; right: 12px; top: 10px; width: 230px; padding: 8px 10px; background: var(--tag-bg); border: 1px solid var(--line); border-radius: 6px; display: flex; flex-direction: column; gap: 4px; pointer-events: none; font-size: 11.5px; color: var(--muted); }
.cb3-legend .t { color: var(--fg); font-weight: 600; }
.cb3-bar { position: relative; height: 10px; border-radius: 3px; border: 1px solid var(--line); }
.cb3-mark { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--fg); }
.cb3-ticks { display: flex; justify-content: space-between; font-family: var(--font-data); font-size: 10.5px; }
.cb3-phs { display: flex; gap: 12px; }
.cb3-phs i { display: inline-block; width: 10px; height: 10px; border-radius: 5px; margin-right: 5px; vertical-align: -1px; }
.cb3-hud { position: absolute; left: 10px; bottom: 8px; font-size: 11.5px; color: var(--faint); pointer-events: none; }
.cb3-fail { display: grid; place-items: center; min-height: 200px; padding: 16px; text-align: center; color: var(--muted); }
/* phone: overlays stack under the canvas instead of covering the model */
@media (max-width: 640px) {
  .cb3-box { height: auto; }
  .cb3-wrap { height: 420px; }
  .cb3-ui, .cb3-legend, .cb3-hud { position: static; width: auto; border: 0; border-top: 1px solid var(--line); border-radius: 0; padding: 8px 12px; }
  .cb3-ui { flex-wrap: wrap; }
}
`;

function build(grp, viewer, inp, res, mode) {
  const od = res.cable_od_mm, rows = res.conductors, dc = conductorDiameterMm(res.input, res.cable_data);
  const xs = rows.map((r) => r.x_mm), ys = rows.map((r) => r.y_mm);
  const xc = (Math.min(...xs) + Math.max(...xs)) / 2, yc = (Math.min(...ys) + Math.max(...ys)) / 2;
  const w_in = inp.enclosure_width_mm || Math.max(...xs) - Math.min(...xs) + 2 * od + 50;
  const h_in = inp.enclosure_height_mm || Math.max(...ys) - Math.min(...ys) + 2 * od + 70;
  const ts = inp.side_thickness_mm, tc = inp.cover_thickness_mm;
  const W = w_in + 2 * ts, Hh = h_in + 2 * tc;
  const span = inp.support_span_m * 1000;
  const Lz = Math.min(4000, Math.max(3000, 4 * span)), Lc = Lz * 0.56;
  const bx = (r) => ts + w_in / 2 + (r.x_mm - xc), by = (r) => tc + h_in / 2 + (r.y_mm - yc);
  const al = res.input.material === "Al";

  const alu = std(0xaab3bb, { roughness: 0.42, metalness: 0.85 });
  const aluDark = std(0x8d979f, { roughness: 0.5, metalness: 0.8 });
  const glassM = std(0xa7bccd, { roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false });
  const gpo = std(0xb0502e, { roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide });
  const coreM = al ? std(0xcdd3d9, { roughness: 0.3, metalness: 0.95 }) : std(0xc9773a, { roughness: 0.28, metalness: 0.95 });
  const insM = std(0xe7e0c8, { roughness: 0.6, metalness: 0 });

  /* enclosure: bottom plate, two side rails (near one translucent), slotted cover over the back 56 % */
  grp.add(boxMm(alu, [ts, W - ts], [0, tc], [0, Lz], { edge: 0x202830, edgeOpacity: 0.5 }));
  const rail = (x0, x1, mat, near) => {
    const g = new THREE.Group();
    g.add(boxMm(mat, [x0, x1], [0, Hh - tc], [0, Lz], { cast: !near, edge: 0x2a343d, edgeOpacity: 0.6 }));
    const lip = x0 < ts ? [x0, x1 + 26] : [x0 - 26, x1];
    for (const [ya, yb2] of [[0, ts], [Hh - tc - ts, Hh - tc]]) g.add(boxMm(alu, lip, [ya, yb2], [0, Lz]));
    return g;
  };
  grp.add(rail(0, ts, glassM, true), rail(W - ts, W, alu, false));
  // near rail edge lines so its outline reads through the translucent plate
  grp.add(lineMm([[0, 0, 0], [0, 0, Lz], [0, Hh - tc, Lz], [0, Hh - tc, 0], [0, 0, 0]], 0x8fa0ae, 0.8));

  const cover = new THREE.Shape();
  cover.moveTo(0, 0); cover.lineTo(W * MM, 0); cover.lineTo(W * MM, Lc * MM); cover.lineTo(0, Lc * MM); cover.lineTo(0, 0);
  const cols = Math.max(3, Math.floor(w_in / 70)), cw = (w_in - 40) / cols, slotW = cw * 0.55, slotL = 78, pitch = 118;
  for (let z = 70; z + slotL < Lc - 50; z += pitch) for (let c = 0; c < cols; c++) {
    const xm = ts + 20 + cw * (c + 0.5), p = new THREE.Path();
    const a = xm - slotW / 2, b = xm + slotW / 2;
    p.moveTo(a * MM, z * MM); p.lineTo(a * MM, (z + slotL) * MM); p.lineTo(b * MM, (z + slotL) * MM); p.lineTo(b * MM, z * MM); p.lineTo(a * MM, z * MM);
    cover.holes.push(p);
  }
  const cg = new THREE.ExtrudeGeometry(cover, { depth: tc * MM, bevelEnabled: false });
  const coverMesh = new THREE.Mesh(cg, alu); coverMesh.rotation.x = Math.PI / 2;      // shape y -> +z, extrusion depth -> -y (hangs below the top face)
  coverMesh.position.set(0, Hh * MM, 0);
  coverMesh.castShadow = true; coverMesh.receiveShadow = true;
  grp.add(coverMesh);

  /* GPO-3 support blocks: one plate per tier at each support, bored for the cables of that tier */
  const nSup = Math.max(2, Math.floor((Lz - 300) / span) + 1);
  const zs = Array.from({ length: nSup }, (_, k) => (Lz - (nSup - 1) * span) / 2 + k * span);
  const tiers = [...new Set(rows.map((r) => r.y_mm))].sort((a, b) => a - b);
  const lip = 14, tb = 25.4;
  for (const z of zs) for (const ty of tiers) {
    const tr = rows.filter((r) => r.y_mm === ty);
    const yt = by(tr[0]);
    grp.add(plateWithHoles(gpo, ts, W - ts, yt - od / 2 - lip, yt + od / 2 + lip, z - tb / 2, z + tb / 2, tr.map((r) => ({ x: bx(r), y: by(r), r: od / 2 + 0.5 }))));
  }
  // support spacing dimension on the front-left, outside the near rail
  const zd0 = zs[Math.max(0, zs.length - 2)], zd1 = zs[zs.length - 1];
  if (zs.length > 1) {
    const xd = -70, yd = 0;
    grp.add(lineMm([[xd, yd, zd0], [xd, yd, zd1]], 0xaab6c2, 0.9));
    for (const z of [zd0, zd1]) grp.add(lineMm([[xd - 25, yd, z], [xd + 25, yd, z]], 0xaab6c2, 0.9));
    viewer.addLabel(labelEl("cb3-lbl dim", [`supports every ${fmt(span, 0)} mm (${fmt(span / 25.4, 0)} in)`]), v3(xd, yd + 30, (zd0 + zd1) / 2));
  }

  /* cables: jacket to the strip point, stepped insulation, bare core */
  const many = rows.length > 6;
  const loadCol = (r) => threeColor(scale((r.loading_pct ?? 0) / LOAD_DOM));
  for (const r of rows) {
    const x = bx(r), y = by(r);
    const col = mode === "loading" ? loadCol(r) : new THREE.Color(PH_HEX[r.phase]);
    const jacket = std(col, { roughness: 0.42, metalness: 0.08 });
    grp.add(cylMm(jacket, [x, y, 0], [x, y, Lz - 55], od / 2, 36));
    grp.add(cylMm(insM, [x, y, Lz - 55], [x, y, Lz - 8], Math.max(dc / 2 + 2, od * 0.36), 32));
    grp.add(cylMm(coreM, [x, y, Lz - 8], [x, y, Lz + 40], dc / 2, 28));
    const lines = many ? [`${r.phase} ${fmt(r.current_a, 0)} A`, `${fmt(r.loading_pct, 0)} %`] : [`${r.phase}  ${fmt(r.current_a, 0)} A`, `${fmt(r.loading_pct, 0)} % loaded`];
    const stagger = rows.indexOf(r) % 2 ? 150 : 0;
    const tone = mode === "loading" ? `rgb(${scale((r.loading_pct ?? 0) / LOAD_DOM).map(Math.round).join(",")})` : PH_CSS[r.phase];
    viewer.addLabel(labelEl("cb3-lbl", lines, tone), v3(x, y + od / 2 + 12 + stagger, Lz + 48));
  }
  const box = new THREE.Box3(v3(-120, -40, -80), v3(W + 120, Hh + 60, Lz + 120));
  return { box, W, Hh, Lz, span };
}

export function CableBus3D({ input, result, fallback }) {
  const wrapRef = useRef(null), canvasRef = useRef(null), vRef = useRef(null);
  const [failed, setFailed] = useState(typeof THREE === "undefined");
  const [mode, setMode] = useState("phase");
  const [info, setInfo] = useState(null);

  useEffect(() => {
    if (typeof THREE === "undefined") return;
    let v;
    try {
      v = createViewer(canvasRef.current, wrapRef.current, {
        background: 0x0b1117, fog: [0x0b1117, 10, 34], gridSize: 10, gridDivisions: 50, gridColors: [0x25323e, 0x17212a], groundColor: 0x10171e, groundSize: 60,
        near: 0.05, far: 80, minR: 0.8, maxR: 16, env: false, fill: 0.9,
        orbit: { theta: -0.75, phi: 1.08 }, sun: { intensity: 1.5, extent: 4.5, near: 0.5, far: 24, bias: -0.0004 },
      });
    } catch (e) { setFailed(true); return; }
    v.group = new THREE.Group(); v.world.add(v.group);
    vRef.current = v;
    return () => { v.dispose(); vRef.current = null; };
  }, []);

  useEffect(() => {
    const v = vRef.current; if (!v || !input || !result) return;
    disposeGroup(v.group); v.clearLabels();
    const m = build(v.group, v, input, result, mode);
    if (!v.framed) {
      v.frame(m.box);
      Object.assign(v.orbit, { theta: -0.42, phi: 1.12, r: Math.max(1.8, m.W * MM * 4.3) });
      v.orbit.target.set((m.W / 2) * MM, (m.Hh / 2) * MM, m.Lz * 0.62 * MM); v.place(); v.framed = true;
    }
    setInfo({ W: m.W, H: m.Hh, L: m.Lz });
  }, [input, result, mode, failed]);

  if (failed) return fallback || <div className="cb3-fail"><style>{CSS}</style>3D view needs WebGL, which this browser or frame does not provide.</div>;
  const rows = result.conductors;
  const maxLoad = Math.max(...rows.map((r) => r.loading_pct ?? 0));
  return (
    <div className="cb3-box">
      <style>{CSS}</style>
      <div ref={wrapRef} className="cb3-wrap"><canvas ref={canvasRef} /></div>
      <div className="cb3-ui">
        <span>Colour</span>
        <div className="cb3-seg" role="group" aria-label="Cable colour mode">
          <button type="button" aria-pressed={mode === "phase"} onClick={() => setMode("phase")}>By phase</button>
          <button type="button" aria-pressed={mode === "loading"} onClick={() => setMode("loading")}>By loading %</button>
        </div>
      </div>
      <div className="cb3-legend">
        {mode === "phase" ? (
          <>
            <div className="t">Phase</div>
            <div className="cb3-phs">{["A", "B", "C"].map((p) => <span key={p}><i style={{ background: PH_CSS[p] }} />{p}</span>)}</div>
          </>
        ) : (
          <>
            <div className="t">Cable loading, % of rated</div>
            <div className="cb3-bar" style={{ background: gradientCss() }} role="img" aria-label="Loading scale 0 to 120 percent">
              <i className="cb3-mark" style={{ left: `${(100 / LOAD_DOM) * 100}%` }} title="100 %" />
            </div>
            <div className="cb3-ticks">{[0, 30, 60, 90, 120].map((v) => <span key={v}>{v}</span>)}</div>
            <div>highest cable {fmt(maxLoad, 0)} % · marker at 100 %</div>
          </>
        )}
        <div className="cb3-cap">{info ? `${fmt(info.W, 0)} x ${fmt(info.H, 0)} mm ventilated Al enclosure, ${fmt(info.L / 1000, 2)} m shown` : ""}</div>
      </div>
      <div className="cb3-hud">Drag to orbit · right-drag or shift-drag to pan · scroll to zoom · cover cut away, GPO-3 blocks at the design spacing</div>
    </div>
  );
}
