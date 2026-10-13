/* To-scale 3D model of one switchgear section: cut-away enclosure (front door removed), the horizontal main bus
   (three phase packs with the real lamination count, thickness, width, gap, orientation and phase spacing),
   vertical risers to the breaker stabs, standoff insulators at the support span, bars coloured by temperature.
   Millimetres in, metres in the scene. Axes: x along the bus, y up, z front (+z) to back, phases spaced along z. */
const { useEffect, useRef, useState } = React;
import { createViewer } from "./three/viewer.js";
import { MM, scale, threeColor, gradientCss, std, boxMm, cylMm, addEdges, lineMm, labelEl, v3, disposeGroup } from "./three/parts.js";
import { fmt } from "./common.jsx";

const PH_HEX = [0xe05a4f, 0xe8c35a, 0x5aa0e0];
const PH_CSS = ["#e05a4f", "#e8c35a", "#5aa0e0"];

const CSS = `
.sg3-box { position: relative; height: 600px; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--bg); }
.sg3-wrap { position: relative; height: 100%; overflow: hidden; }
.sg3-wrap canvas { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
.sg3-wrap canvas:active { cursor: grabbing; }
.sg3-lbl { position: absolute; left: 0; top: 0; display: flex; flex-direction: column; gap: 1px; padding: 3px 8px 3px 9px; background: var(--tag-bg); border: 1px solid var(--line); border-left: 3px solid var(--faint); border-radius: 4px; white-space: nowrap; pointer-events: none; }
.sg3-lbl b { font-size: 12px; font-weight: 600; color: var(--fg); }
.sg3-lbl span { font-family: var(--font-data); font-size: 10.5px; color: var(--muted); }
.sg3-lbl.dim { border-left-color: var(--muted); }
.sg3-hud { position: absolute; left: 10px; bottom: 8px; font-size: 11.5px; color: var(--faint); pointer-events: none; }
.sg3-legend { position: absolute; right: 12px; top: 10px; width: 250px; padding: 8px 10px; background: var(--tag-bg); border: 1px solid var(--line); border-radius: 6px; display: flex; flex-direction: column; gap: 4px; pointer-events: none; }
.sg3-legend .t { font-size: 11.5px; color: var(--fg); font-weight: 600; }
.sg3-bar { position: relative; height: 10px; border-radius: 3px; border: 1px solid var(--line); }
.sg3-mark { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--fg); }
.sg3-mark.now { background: var(--bg); box-shadow: 0 0 0 1px var(--fg); }
.sg3-ticks { display: flex; justify-content: space-between; font-family: var(--font-data); font-size: 10.5px; color: var(--muted); }
.sg3-note { font-size: 10.5px; color: var(--faint); }
.sg3-fail { display: grid; place-items: center; min-height: 200px; padding: 16px; text-align: center; color: var(--muted); }
@media (max-width: 640px) { .sg3-lbl span, .sg3-ticks, .sg3-note { font-size: 11px; } }
/* phone: overlays stack under the canvas instead of covering the model */
@media (max-width: 640px) {
  .sg3-box { height: auto; }
  .sg3-wrap { height: 420px; }
  .sg3-legend, .sg3-hud { position: static; width: auto; border: 0; border-top: 1px solid var(--line); border-radius: 0; padding: 8px 12px; }
}
`;

function packLayout(i) {
  const t = i.bar_thickness_mm, w = i.bar_width_mm, n = i.bars_per_phase;
  const gap = i.bar_gap_mm !== null && i.bar_gap_mm !== undefined ? i.bar_gap_mm : t;
  const pack = n * t + (n - 1) * gap;
  const offs = Array.from({ length: n }, (_, b) => -pack / 2 + t / 2 + b * (t + gap));
  return { t, w, n, gap, pack, offs };
}

/* Build the whole section into `grp`. Returns the bounding box and puts labels on the viewer. */
function buildSection(grp, viewer, input, result) {
  const i = input, r = result;
  const { t, w, n, pack, offs } = packLayout(i);
  const f2f = i.orientation === "face_to_face";
  const sp = i.phase_spacing_mm, L = i.support_span_m * 1000;
  const air = i.ambient_c + i.internal_air_rise_c, riseT = air + r.rise_c;
  const tmax = i.max_rise_c * 1.25, dom = Math.max(tmax, r.rise_c * 1.1);
  const barCol = threeColor(scale(r.rise_c / dom));

  const ext = 2 * sp + (f2f ? pack : w);                      // extent of the three packs along z
  const ph = f2f ? pack : w;                                   // one pack along z
  const lowerExt = f2f ? w / 2 : pack / 2, upperExt = lowerExt; // pack half-extent along y
  const Wd = Math.min(2600, Math.max(1000, 2 * L + 500)), D = Math.max(1000, ext + 520), H = 2300;
  const zmid = D * 0.5, yb = 1500, ylow = 520;
  const nSup = Math.max(2, Math.min(7, Math.floor((Wd - 300) / L) + 1));
  const xs = Array.from({ length: nSup }, (_, k) => (Wd - (nSup - 1) * L) / 2 + k * L);
  const xr = (xs[nSup - 1] + xs[nSup - 2]) / 2 + (nSup === 2 ? L * 0.0 : 0);
  const zp = [0, 1, 2].map((p) => zmid + sp - p * sp);        // A at the front

  /* materials */
  const paint = std(0x8a949e, { roughness: 0.55, metalness: 0.35 });
  const paintDark = std(0x5d6772, { roughness: 0.5, metalness: 0.45 });
  const glass = std(0x9fb4c6, { roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false });
  const bar = std(barCol, { metalness: 0.3, roughness: 0.38, emissive: barCol, emissiveIntensity: 0.18 });
  const glastic = std(0xb2552f, { roughness: 0.55, metalness: 0.05 });
  const steel = std(0x7d8793, { roughness: 0.5, metalness: 0.4 });
  const brass = std(0xcaa64e, { roughness: 0.35, metalness: 0.45 });
  const silver = std(0xd7dce0, { roughness: 0.3, metalness: 0.4 });
  const floorM = std(0x2a3139, { roughness: 0.9, metalness: 0.1 });

  /* enclosure: floor slab, solid rear wall, translucent sides and roof, corner posts, no front door */
  const T = 3;
  grp.add(boxMm(floorM, [0, Wd], [-40, 0], [0, D]));
  grp.add(boxMm(paint, [0, Wd], [0, H], [-T, 0]));                                        // back wall
  for (const [xa, xb] of [[-T, 0], [Wd, Wd + T]]) { const s = boxMm(glass, [xa, xb], [0, H], [0, D], { cast: false }); addEdges(s, 0x7e8c99, 0.5); grp.add(s); }
  const roof = boxMm(glass, [0, Wd], [H, H + T], [0, D], { cast: false }); addEdges(roof, 0x7e8c99, 0.5); grp.add(roof);
  for (const x of [0, Wd - 60]) for (const z of [0, D - 60]) grp.add(boxMm(paintDark, [x, x + 60], [0, H], [z, z + 60]));
  for (const y of [0, H - 60]) for (const z of [0, D - 60]) grp.add(boxMm(paintDark, [0, Wd], [y, y + 60], [z, z + 60]));
  for (const y of [0, H - 60]) for (const x of [0, Wd - 60]) grp.add(boxMm(paintDark, [x, x + 60], [y, y + 60], [0, D]));
  // vertical barrier between the bus compartment and the breaker cell, with stab windows
  const bx0 = xr + (f2f ? w / 2 : pack / 2) + 70;
  grp.add(boxMm(glass, [bx0, bx0 + 6], [ylow - 250, ylow + 330], [60, D - 60], { cast: false }));

  /* horizontal bus: three packs, full section length */
  const lam = (p, b) => {
    const o = offs[b];
    const zr = f2f ? [zp[p] + o - t / 2, zp[p] + o + t / 2] : [zp[p] - w / 2, zp[p] + w / 2];
    const yr = f2f ? [yb - w / 2, yb + w / 2] : [yb + o - t / 2, yb + o + t / 2];
    return { zr, yr };
  };
  for (let p = 0; p < 3; p++) for (let b = 0; b < n; b++) {
    const { zr, yr } = lam(p, b);
    grp.add(boxMm(bar, [45, Wd - 45], yr, zr, { edge: 0x14181c, edgeOpacity: 0.5 }));
    // vertical riser: laminations stack along x, same phase pack footprint along z
    const xo = f2f ? [xr - w / 2, xr + w / 2] : [xr + offs[b] - t / 2, xr + offs[b] + t / 2];
    const zr2 = f2f ? [zp[p] + offs[b] - t / 2, zp[p] + offs[b] + t / 2] : [zp[p] - w / 2, zp[p] + w / 2];
    grp.add(boxMm(bar, xo, [ylow, f2f ? yb + w / 2 : yb + offs[b] + t / 2], zr2, { edge: 0x14181c, edgeOpacity: 0.5 }));
  }

  /* stabs: tin plated lug block at the foot of each riser, two stab fingers pointing into the breaker cell */
  const rx = f2f ? w / 2 : pack / 2;
  for (let p = 0; p < 3; p++) {
    const zhalf = ph / 2 + 12;
    grp.add(boxMm(brass, [xr - rx - 14, xr + rx + 14], [ylow - 40, ylow + 4], [zp[p] - zhalf, zp[p] + zhalf]));
    grp.add(boxMm(brass, [xr + rx, xr + rx + 16], [ylow - 230, ylow + 4], [zp[p] - 24, zp[p] + 24]));
    for (const y of [ylow - 80, ylow - 180]) grp.add(cylMm(silver, [xr + rx + 10, y, zp[p]], [bx0 + 140, y, zp[p]], 19, 24));
  }

  /* supports: channel + standoff insulators + top clamp at each support location, spaced by the span */
  const insH = 140, chTop = yb - lowerExt - insH, zA = zp[0] + ph / 2 + 70, zC = zp[2] - ph / 2 - 70;
  for (const x of xs) {
    grp.add(boxMm(steel, [x - 40, x + 40], [chTop - 50, chTop], [zC, zA]));
    for (const z of [zC + 20, zA - 20]) grp.add(boxMm(steel, [x - 25, x + 25], [0, chTop - 50], [z - 25, z + 25]));
    for (let p = 0; p < 3; p++) {
      grp.add(cylMm(glastic, [x, chTop, zp[p]], [x, yb - lowerExt, zp[p]], 30, 28));
      for (const f of [0.3, 0.55, 0.8]) grp.add(cylMm(glastic, [x, chTop + insH * f - 5, zp[p]], [x, chTop + insH * f + 5, zp[p]], 40, 28));
      grp.add(cylMm(steel, [x, chTop - 6, zp[p]], [x, chTop + 6, zp[p]], 44, 24));
      const top = yb + upperExt;
      grp.add(boxMm(paintDark, [x - 28, x + 28], [top, top + 14], [zp[p] - ph / 2 - 14, zp[p] + ph / 2 + 14]));
      grp.add(cylMm(steel, [x, top + 14, zp[p] - ph / 2 - 0], [x, top + 36, zp[p] - ph / 2 - 0], 9, 12));
    }
  }
  // dimension line for the span, under the supports at the front
  if (xs.length > 1) {
    const yd = chTop - 120, zd = zA + 40;
    grp.add(lineMm([[xs[0], yd, zd], [xs[1], yd, zd]], 0xaab6c2, 0.9));
    for (const x of xs.slice(0, 2)) grp.add(lineMm([[x, yd - 25, zd], [x, yd + 25, zd]], 0xaab6c2, 0.9));
    viewer.addLabel(labelEl("sg3-lbl dim", [`support span ${fmt(L, 0)} mm`]), v3((xs[0] + xs[1]) / 2, yd - 30, zd));
  }

  /* labels: phase and peak short-circuit force per phase at the free end of the bus */
  const hasFault = r.peak_force_n_per_m !== null && r.peak_force_n_per_m !== undefined;
  for (let p = 0; p < 3; p++) {
    const el = labelEl("sg3-lbl", [`Phase ${"ABC"[p]}`, hasFault ? `${fmt(r.peak_force_n_per_m / 1000, 1)} kN/m peak` : "no fault entered"], PH_CSS[p]);
    viewer.addLabel(el, v3(Wd * (0.06 + 0.1 * p), yb + upperExt + 90 + 170 * p, zp[p]));
  }
  viewer.addLabel(labelEl("sg3-lbl", [`Bars ${fmt(riseT, 0)} °C`, `${n} x ${fmt(t, 2)} x ${fmt(w, 1)} mm per phase`], "#e8c35a"), v3(Wd * 0.5, H + 40, zmid));

  const box = new THREE.Box3(v3(-120, -60, -120), v3(Wd + 120, H, D + 80));
  return { box, riseT, tMin: air, tMax: air + dom, limitT: air + i.max_rise_c, air };
}

export function SwitchgearBus3D({ input, result, fallback }) {
  const wrapRef = useRef(null), canvasRef = useRef(null), vRef = useRef(null);
  const [failed, setFailed] = useState(typeof THREE === "undefined");
  const [meta, setMeta] = useState(null);

  useEffect(() => {
    if (typeof THREE === "undefined") return;
    let v;
    try {
      v = createViewer(canvasRef.current, wrapRef.current, {
        background: 0x0b1117, fog: [0x0b1117, 9, 30], gridSize: 8, gridDivisions: 40, gridColors: [0x25323e, 0x17212a], groundColor: 0x10171e, groundSize: 60,
        near: 0.05, far: 80, minR: 1.2, maxR: 14, env: false, fill: 0.9,
        orbit: { theta: -0.78, phi: 1.12 }, sun: { intensity: 1.5, extent: 4, near: 0.5, far: 20, bias: -0.0004 },
      });
    } catch (e) { setFailed(true); return; }
    v.group = new THREE.Group(); v.world.add(v.group);
    vRef.current = v;
    return () => { v.dispose(); vRef.current = null; };
  }, []);

  useEffect(() => {
    const v = vRef.current; if (!v || !input || !result) return;
    disposeGroup(v.group); v.clearLabels();
    const m = buildSection(v.group, v, input, result);
    if (!v.framed) { v.frame(m.box); v.orbit.r *= 0.95; v.orbit.target.y -= 0.1; v.place(); v.framed = true; }
    setMeta({ riseT: m.riseT, tMin: m.tMin, tMax: m.tMax, limitT: m.limitT, air: m.air, rise: result.rise_c });
  }, [input, result, failed]);

  if (failed) return fallback || <div className="sg3-fail"><style>{CSS}</style>3D view needs WebGL, which this browser or frame does not provide.</div>;
  const pos = (v) => `${Math.max(0, Math.min(1, v)) * 100}%`;
  return (
    <div className="sg3-box">
      <style>{CSS}</style>
      <div ref={wrapRef} className="sg3-wrap"><canvas ref={canvasRef} /></div>
      {meta && (
        <div className="sg3-legend">
          <div className="t">Bar temperature, °C</div>
          <div className="sg3-bar" style={{ background: gradientCss() }} role="img" aria-label={`Temperature scale ${fmt(meta.tMin, 0)} to ${fmt(meta.tMax, 0)} degrees C`}>
            <i className="sg3-mark" style={{ left: pos((meta.limitT - meta.tMin) / (meta.tMax - meta.tMin)) }} title={`limit ${fmt(meta.limitT, 0)} °C`} />
            <i className="sg3-mark now" style={{ left: pos((meta.riseT - meta.tMin) / (meta.tMax - meta.tMin)) }} title={`bars ${fmt(meta.riseT, 0)} °C`} />
          </div>
          <div className="sg3-ticks">{[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{fmt(meta.tMin + (meta.tMax - meta.tMin) * f, 0)}</span>)}</div>
          <div className="sg3-note">Bars {fmt(meta.riseT, 0)} °C ({fmt(meta.rise, 1)} K over {fmt(meta.air, 0)} °C enclosure air) · limit marker {fmt(meta.limitT, 0)} °C</div>
        </div>
      )}
      <div className="sg3-hud">Drag to orbit · right-drag or shift-drag to pan · scroll to zoom · front door removed, enclosure illustrative</div>
    </div>
  );
}
