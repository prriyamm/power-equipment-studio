/* 3D site view: the same equipment model rendered with three.js (global THREE, r128 UMD).
   Orbit with left drag, pan with right drag or shift-drag, zoom with the wheel.
   Grid units map to world units: three.x = gx, three.y = height, three.z = gy.

   The procedural models come from ./siteModel.js as plain primitive records. Here they become one
   InstancedMesh per (unit geometry, material) pair, so a 100-element package costs a few dozen draw calls.
   Unit geometries and materials are created once per mount, shared by every rebuild, and disposed on unmount.
   Result overlays (loading, bus voltage, fault current) only rewrite instance colours and labels; they come
   from the analysis object the System workspace already holds, so nothing is re-solved here. */
const { useEffect, useRef, useState, useMemo } = React;
import { createViewer } from "./three/viewer.js";
import { buildSiteModel, MAT_SPEC } from "./siteModel.js";
import { deriveOverlay, overlayLegend, toHex, toCss, greyOut, shadeHex, OVERLAY_MODES } from "./systemOverlay.js";
import { Btn } from "./common.jsx";

const CSS = `
.s3-hud { position: absolute; top: 8px; right: 8px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; pointer-events: none; max-width: calc(100% - 16px); }
.s3-hud > * { pointer-events: auto; }
.s3-bar { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; background: var(--tag-bg); border: 1px solid var(--line); border-radius: 6px; padding: 3px; }
.s3-legend { background: var(--tag-bg); border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px 6px; width: 236px; max-width: 100%; font-size: 11px; color: var(--muted); }
.s3-legend b { display: block; color: var(--fg); font-size: 11px; font-weight: 600; margin-bottom: 5px; }
.s3-ramp { position: relative; height: 9px; border-radius: 3px; }
.s3-band { position: absolute; top: -3px; bottom: -3px; border: 1px dashed var(--fg); border-radius: 3px; opacity: 0.55; }
.s3-ticks { position: relative; height: 14px; font-family: var(--font-data); font-size: 9.5px; }
.s3-ticks span { position: absolute; top: 2px; transform: translateX(-50%); white-space: nowrap; }
.s3-ticks span:first-child { transform: none; } .s3-ticks span:last-child { transform: translateX(-100%); }
.s3-key { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.s3-sw { width: 12px; height: 9px; border-radius: 2px; flex: none; }
.s3-note { margin-top: 3px; font-size: 10.5px; }
.s3-flag { color: var(--crit); }
.lbl3d .s3-ov { color: var(--fg); }
.lbl3d .s3-flagtxt { color: var(--crit); font-weight: 600; }
.lbl3d.s3-con { padding: 2px 6px 2px 7px; }
`;

/* ------------------------------------------------------------ shared kit */
function createKit() {
  const prism = (() => {
    const s = new THREE.Shape(); s.moveTo(-0.5, -0.5); s.lineTo(0.5, -0.5); s.lineTo(0, 0.5); s.lineTo(-0.5, -0.5);
    const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false }); g.translate(0, 0, -0.5); return g;
  })();
  const geos = {
    box: new THREE.BoxGeometry(1, 1, 1),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 10),
    cyl28: new THREE.CylinderGeometry(1, 1, 1, 28),
    sphere: new THREE.SphereGeometry(1, 10, 8),
    dot: new THREE.SphereGeometry(1, 6, 4),
    torus: new THREE.TorusGeometry(1, 0.045, 4, 18).rotateX(Math.PI / 2),
    prism,
    cone: new THREE.ConeGeometry(1, 1, 4),
  };
  for (const g of Object.values(geos)) { g.computeBoundingBox(); g.computeBoundingSphere(); }
  // materials are white so the per-instance colour carries the part colour (and the overlay colour)
  const mats = {};
  for (const [k, spec] of Object.entries(MAT_SPEC)) {
    mats[k] = spec.basic
      ? new THREE.MeshBasicMaterial({ color: 0xffffff })
      : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: spec.roughness ?? 0.62, metalness: spec.metalness ?? 0.18,
        transparent: !!spec.transparent, opacity: spec.opacity ?? 1, emissive: spec.emissive ?? 0x000000, depthWrite: !spec.transparent });
  }
  mats.particle = new THREE.MeshBasicMaterial({ color: 0xffffff });
  mats.flag = new THREE.MeshBasicMaterial({ color: 0xff5f5f });
  return {
    geos, mats,
    dispose() { for (const g of Object.values(geos)) g.dispose(); for (const m of Object.values(mats)) m.dispose(); },
  };
}

/* Instantiate the primitive list: one InstancedMesh per geometry|material. */
function instantiate(kit, model) {
  const groups = new Map();
  for (const p of model.prims) {
    const key = `${p.g}|${p.m}`;
    let grp = groups.get(key); if (!grp) groups.set(key, (grp = { g: p.g, m: p.m, list: [] }));
    grp.list.push(p);
  }
  const meshes = [], bounds = {};
  const mtx = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(), dir = new THREE.Vector3(), box = new THREE.Box3(), col = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  for (const grp of groups.values()) {
    const geo = kit.geos[grp.g], mat = kit.mats[grp.m];
    const im = new THREE.InstancedMesh(geo, mat, grp.list.length);
    im.castShadow = !mat.transparent && grp.m !== "line"; im.receiveShadow = true;
    im.frustumCulled = false; // instances spread across the site; the geometry's own sphere would cull them wrongly
    const picks = new Array(grp.list.length);
    grp.list.forEach((p, i) => {
      pos.set(p.p[0], p.p[1], p.p[2]); scl.set(p.s[0], p.s[1], p.s[2]);
      if (p.dir) quat.setFromUnitVectors(up, dir.set(p.dir[0], p.dir[1], p.dir[2]));
      else if (p.rotY) quat.setFromAxisAngle(up, p.rotY); else quat.identity();
      mtx.compose(pos, quat, scl); im.setMatrixAt(i, mtx);
      im.setColorAt(i, col.setHex(p.c ?? MAT_SPEC[p.m].color));
      picks[i] = { kind: p.kind, id: p.id };
      box.copy(geo.boundingBox).applyMatrix4(mtx);
      const k = p.kind + ":" + p.id; (bounds[k] ||= new THREE.Box3()).union(box);
    });
    im.instanceMatrix.needsUpdate = true;
    im.userData = { picks, prims: grp.list };
    meshes.push(im);
  }
  return { meshes, bounds };
}

/* Instance colours for the current overlay: part colour, overlay colour on painted parts, grey when de-energized. */
function paint(built, ov) {
  const col = new THREE.Color();
  for (const im of built.meshes) {
    const prims = im.userData.prims;
    for (let i = 0; i < prims.length; i++) {
      const p = prims[i], e = (p.kind === "eq" ? ov.equipment : ov.connectors)[p.id];
      let hex = p.c ?? MAT_SPEC[p.m].color;
      if (e?.off) hex = greyOut(hex);
      else if (ov.mode !== "none" && p.paint && e?.color) hex = shadeHex(toHex(e.color), 0.82 * (p.shade ?? 1)); // a touch darker than the legend so lighting still reads
      im.setColorAt(i, col.setHex(hex));
    }
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }
}

function labelFor(kind, name, base, ovEntry, ov, showFault) {
  const el = document.createElement("div"); el.className = "lbl3d" + (kind === "con" ? " s3-con" : "");
  const b = document.createElement("b"); b.textContent = name; el.appendChild(b);
  const line = (txt, cls) => { if (!txt) return; const s = document.createElement("span"); s.textContent = txt; if (cls) s.className = cls; el.appendChild(s); };
  let tone = base.tone;
  if (ovEntry?.off) { line(ovEntry.text); tone = ""; el.style.opacity = "0.75"; }
  else if (ov.mode !== "none" && ovEntry?.text) {
    line(ovEntry.text, ovEntry.flag ? "s3-flagtxt" : "s3-ov");
    tone = ovEntry.state === "na" ? "" : ovEntry.state;
    if (ovEntry.color) el.style.borderLeftColor = toCss(ovEntry.color);
  } else line(base.line2);
  if (showFault && ovEntry?.fault && !ovEntry.off) line(ovEntry.fault.text, ovEntry.fault.state === "crit" ? "s3-flagtxt" : "");
  else if (!showFault && ov.mode === "none" && base.line3) line(base.line3);
  el.dataset.tone = tone || "";
  return el;
}

/* ------------------------------------------------------------ component */
const initialOverlay = () => {
  const h = typeof location !== "undefined" ? location.hash : "";
  const m = /^#system-3d-(loading|voltage|fault)$/.exec(h);
  return m ? { mode: m[1] === "fault" ? "none" : m[1], fault: m[1] === "fault" } : { mode: "none", fault: false };
};

export function Site3D({ sys, analysis, selection, setSelection, animate, showTags, fitSignal = 0 }) {
  const wrapRef = useRef(null), canvasRef = useRef(null), labelsRef = useRef(null);
  const st = useRef(null);
  const [failed, setFailed] = useState(typeof THREE === "undefined");
  const [ovMode, setOvMode] = useState(() => initialOverlay().mode);
  const [showFault, setShowFault] = useState(() => initialOverlay().fault);

  // procedural model + overlay data (pure; reuse the workspace's analysis, no second solve)
  const model = useMemo(() => buildSiteModel(sys, analysis), [sys, analysis]);
  const ov = useMemo(() => deriveOverlay(sys, analysis, { mode: ovMode, fault: showFault }), [sys, analysis, ovMode, showFault]);
  const legend = overlayLegend(ovMode, ov.band);

  // one-time viewer: renderer, camera, lights, controls (shared scaffolding in ./three/viewer.js)
  useEffect(() => {
    if (typeof THREE === "undefined") return;
    let viewer;
    try {
      viewer = createViewer(canvasRef.current, wrapRef.current, {
        background: 0x0a0f14, fog: [0x0a0f14, 45, 110], gridSize: 80, groundColor: 0x111a22, labelsEl: labelsRef.current,
        orbit: { target: new THREE.Vector3(10, 0, 6), r: 34, theta: -0.75, phi: 0.95 },
      });
    } catch (err) { setFailed(true); return; }
    const flows = new THREE.Group(), flags = new THREE.Group(); viewer.scene.add(flows); viewer.scene.add(flags);
    const s = Object.assign(viewer, { flows, flags, kit: createKit(), built: null, particles: null, selBox: null, animate: true });
    st.current = s;
    const m4 = new THREE.Matrix4(), tmp = new THREE.Vector3();
    let tFlag = 0;
    // runs only when the viewer renders; returns true while something moves so frames keep coming.
    // Motion needs the global Animations switch on and a tier above low (../quality.js).
    s.onFrame((dt) => {
      const q = s.quality, motion = q.animations && q.settings.particles;
      s.flows.visible = s.animate && motion;
      const flagsMove = motion && s.flags.children.length > 0;
      if (flagsMove) {
        tFlag += dt;
        for (const f of s.flags.children) { f.rotation.y += dt * 1.6; f.position.y = f.userData.y + Math.sin(tFlag * 3) * 0.08; }
      }
      const P = s.particles; if (!s.flows.visible || !P) return flagsMove;
      for (let k = 0; k < P.list.length; k++) {
        const p = P.list[k];
        p.t = (p.t + dt * p.speed) % 1;
        const L = p.total * p.t; let acc = 0;
        for (let i = 0; i < p.pts.length - 1; i++) {
          const seg = p.seg[i];
          if (acc + seg >= L) { tmp.lerpVectors(p.pts[i], p.pts[i + 1], (L - acc) / Math.max(seg, 1e-9)); break; }
          acc += seg;
        }
        m4.makeScale(0.07, 0.07, 0.07).setPosition(tmp); P.mesh.setMatrixAt(k, m4);
      }
      P.mesh.instanceMatrix.needsUpdate = true;
      return true;
    });
    return () => {
      dropBuilt(s);
      s.dispose();
      s.kit.dispose();
      st.current = null;
    };
  }, []);

  useEffect(() => { if (st.current) st.current.onPick((p) => setSelection(p ? { kind: p.kind, id: p.id } : null)); }, [setSelection]);
  useEffect(() => { if (st.current) { st.current.animate = animate; st.current.showLabels = showTags; st.current.invalidate(); } }, [animate, showTags]);

  // rebuild instanced meshes when the model changes
  useEffect(() => {
    const s = st.current; if (!s) return;
    dropBuilt(s);
    const built = instantiate(s.kit, model);
    for (const im of built.meshes) s.world.add(im);
    s.built = built;
    // power-flow markers: a single InstancedMesh, matrices updated per frame
    const list = [];
    for (const f of model.flows) {
      const pts = f.pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
      const seg = pts.slice(1).map((p, i) => p.distanceTo(pts[i]));
      for (let i = 0; i < f.n; i++) list.push({ pts, seg, total: f.total, t: i / f.n, speed: f.speed, loading_pct: f.loading_pct });
    }
    if (list.length) {
      const mesh = new THREE.InstancedMesh(s.kit.geos.dot, s.kit.mats.particle, list.length);
      mesh.frustumCulled = false;
      const col = new THREE.Color(), m4 = new THREE.Matrix4();
      list.forEach((p, i) => { mesh.setColorAt(i, col.setHex(particleHex(p.loading_pct))); m4.makeScale(0.07, 0.07, 0.07).setPosition(p.pts[0]); mesh.setMatrixAt(i, m4); });
      s.flows.add(mesh); s.particles = { mesh, list };
    }
    if (!s.framed && frameSite(s, model.extent)) s.framed = true;
    s.invalidate();
  }, [model]);

  // the toolbar's Fit button (and opening a project) re-aims the camera at the whole site
  const firstFit = useRef(true);
  useEffect(() => {
    if (firstFit.current) { firstFit.current = false; return; }
    if (st.current) frameSite(st.current, model.extent);
  }, [fitSignal]); // eslint-disable-line

  // overlay: instance colours, labels, out-of-band flags (no geometry rebuild)
  useEffect(() => {
    const s = st.current; if (!s || !s.built) return;
    paint(s.built, ov);
    s.clearLabels();
    const ok = analysis?.ok, res = analysis?.equipment || {};
    const fm = (x, d) => (x == null ? "–" : x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
    for (const e of sys.equipment) {
      const at = model.anchors.eq[e.id]; if (!at) continue;
      const r = ok ? res[e.id] : null;
      const tone = !r || r.deenergized ? "" : (r.loading_pct > 100 || r.sc_duty_pct > 100) ? "crit" : (r.vflag !== "ok" || r.loading_pct > 80 || r.sc_duty_pct > 90) ? "warn" : "ok";
      const line2 = !r ? "" : r.deenergized ? "De-energized" : r.loading_pct != null ? `${r.v_pu.toFixed(3)} pu · ${fm(r.loading_pct, 0)}%` : `${r.v_pu.toFixed(3)} pu`;
      const line3 = r?.ik_ka != null && ["switchgear", "mcc", "panel", "utility"].includes(e.type) ? `I″k ${fm(r.ik_ka, 1)} kA` : "";
      s.addLabel(labelFor("eq", e.name || e.id, { tone, line2, line3 }, ov.equipment[e.id], ov, showFault), new THREE.Vector3(...at));
    }
    if (ovMode !== "none") for (const c of sys.connectors) {
      const at = model.anchors.con[c.id], oe = ov.connectors[c.id];
      if (!at || !oe || (!oe.text && !oe.off)) continue;
      s.addLabel(labelFor("con", c.id, { tone: "" }, oe, ov, false), new THREE.Vector3(...at));
    }
    // floating markers over anything outside the voltage band
    for (const f of [...s.flags.children]) s.flags.remove(f);
    if (ovMode === "voltage") for (const e of sys.equipment) {
      const oe = ov.equipment[e.id], b = s.built.bounds["eq:" + e.id];
      if (!oe?.flag || !b) continue;
      const m = new THREE.Mesh(s.kit.geos.cone, s.kit.mats.flag);
      m.scale.set(0.18, oe.flag === "low" ? -0.32 : 0.32, 0.18);
      const c = b.getCenter(new THREE.Vector3());
      m.userData.y = b.max.y + 0.45; m.position.set(c.x, m.userData.y, c.z);
      s.flags.add(m);
    }
    s.invalidate();
  }, [model, ov, showFault]); // eslint-disable-line

  // selection highlight from the instanced bounds
  useEffect(() => {
    const s = st.current; if (!s) return;
    if (s.selBox) { s.scene.remove(s.selBox); s.selBox.geometry.dispose(); s.selBox.material.dispose(); s.selBox = null; s.invalidate(); }
    if (!selection || !s.built) return;
    const b = s.built.bounds[(selection.kind === "eq" ? "eq" : "con") + ":" + selection.id];
    if (!b) return;
    s.selBox = new THREE.Box3Helper(b.clone().expandByScalar(0.04), 0xd8b25a); s.scene.add(s.selBox); s.invalidate();
  }, [selection, model]);

  if (failed) return <div className="canvas-wrap grid place-items-center text-muted p-6 text-center">3D view needs WebGL, which this browser or frame does not provide. The isometric view shows the same model.</div>;
  return (
    <div ref={wrapRef} className="canvas-wrap site3d">
      <style>{CSS}</style>
      <canvas ref={canvasRef} className="canvas3d" />
      <div ref={labelsRef} className="labels3d" />
      <div className="s3-hud">
        <div className="s3-bar" role="group" aria-label="Result overlay">
          {OVERLAY_MODES.map((m) => <Btn key={m} active={ovMode === m} onClick={() => setOvMode(m)} title={m === "none" ? "Equipment colours" : m === "loading" ? "Colour by loading vs rating" : "Colour buses by per-unit voltage"}>{m === "none" ? "Plain" : m === "loading" ? "Loading" : "Voltage"}</Btn>)}
          <Btn active={showFault} onClick={() => setShowFault(!showFault)} title="Show three-phase fault current labels (IEC 60909)">I″k</Btn>
        </div>
        {(legend || showFault || ov.summary.off > 0) && (
          <div className="s3-legend">
            {!ov.solved ? <><b>Overlay</b><div>No solved results: the overlay needs a converged load flow.</div></> : <>
              {legend && <>
                <b>{legend.title}</b>
                <div className="s3-ramp" style={{ background: legend.gradient }}>
                  {legend.band && <div className="s3-band" style={{ left: `${legend.band[0] * 100}%`, width: `${(legend.band[1] - legend.band[0]) * 100}%` }} />}
                </div>
                <div className="s3-ticks">{legend.ticks.map((t) => <span key={t.label} style={{ left: `${t.at * 100}%` }}>{t.label}</span>)}</div>
                {legend.notes.map((n) => <div key={n} className="s3-note">{n}</div>)}
                {ovMode === "voltage" && ov.summary.flagged > 0 && <div className="s3-note s3-flag">{ov.summary.flagged} item{ov.summary.flagged > 1 ? "s" : ""} outside the band (marked ▲/▼)</div>}
                {ovMode === "loading" && ov.summary.overloaded > 0 && <div className="s3-note s3-flag">{ov.summary.overloaded} over 100 %</div>}
              </>}
              {showFault && <div className="s3-note">I″k: IEC 60909 three-phase bolted; gear shows duty vs its rating.</div>}
              {ov.summary.off > 0 && <div className="s3-key"><span className="s3-sw" style={{ background: "rgb(92,98,104)" }} />De-energized / open ({ov.summary.off})</div>}
            </>}
          </div>
        )}
      </div>
      <div className="canvas-hud left"><span className="hidden sm:inline">Drag to orbit · right-drag or shift-drag to pan · scroll to zoom · click to select</span></div>
    </div>
  );
}

function frameSite(s, ex) {
  if (!isFinite(ex.minX)) return false;
  s.orbit.target.set((ex.minX + ex.maxX) / 2, 0.8, (ex.minZ + ex.maxZ) / 2);
  s.orbit.r = Math.min(120, Math.max(18, 1.25 * Math.hypot(ex.maxX - ex.minX, ex.maxZ - ex.minZ)));
  s.sun.target.position.copy(s.orbit.target); s.sun.position.set(s.orbit.target.x - 18, 30, s.orbit.target.z - 10);
  s.place();
  return true;
}

const particleHex = (pct) => (pct == null ? 0x93a8b8 : pct > 100 ? 0xff5f5f : pct > 80 ? 0xff8b4a : 0x4cc38a);

/* Drop the per-build objects. Unit geometries and materials belong to the kit and survive rebuilds;
   InstancedMesh.dispose frees the instance buffers. */
function dropBuilt(s) {
  if (s.built) { for (const im of s.built.meshes) { s.world.remove(im); im.dispose?.(); } s.built = null; }
  if (s.particles) { s.flows.remove(s.particles.mesh); s.particles.mesh.dispose?.(); s.particles = null; }
  for (const f of [...s.flags.children]) s.flags.remove(f);
  s.clearLabels();
}
