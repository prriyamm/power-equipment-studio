/* 3D site view: the same equipment model rendered with three.js (global THREE, r128 UMD).
   Orbit with left drag, pan with right drag or shift-drag, zoom with the wheel.
   Grid units map to world units: three.x = gx, three.y = height, three.z = gy. */
const { useEffect, useRef, useState } = React;
import { dims, siteRoutes } from "./systemGeometry.js";
import { fmt } from "./common.jsx";

const COLORS = {
  eq: 0x6f7b87, door: 0x56626e, edge: 0x2a333c, tank: 0x4f6f5a, fin: 0x5b7e66, porcelain: 0x8b5a3a, brass: 0xc9a24f,
  motor: 0x3f6894, bldg: 0x77808a, roof: 0x6b4f3c, window: 0x284a63, gen: 0xc9a248, tray: 0xb4bec7, pole: 0x6b5440,
  phA: 0xe05a4f, phB: 0xe8c35a, phC: 0x5aa0e0, ok: 0x4cc38a, warn: 0xff8b4a, crit: 0xff5f5f, ground: 0x111a22, duct: 0x3b4a56,
};
const loadHex = (pct) => (pct == null ? 0x93a8b8 : pct > 100 ? COLORS.crit : pct > 80 ? COLORS.warn : COLORS.ok);

function mats() {
  const m = {};
  const std = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.62, metalness: 0.18, ...o });
  for (const [k, v] of Object.entries(COLORS)) m[k] = std(v);
  m.brass = std(COLORS.brass, { metalness: 0.7, roughness: 0.35 });
  m.tray = std(COLORS.tray, { metalness: 0.55, roughness: 0.4 });
  m.cover = std(COLORS.tray, { metalness: 0.5, roughness: 0.45, transparent: true, opacity: 0.28 });
  m.window = std(COLORS.window, { metalness: 0.1, roughness: 0.15, emissive: 0x0b2233 });
  m.lampOn = new THREE.MeshBasicMaterial({ color: 0xff4040 });
  m.lampOff = new THREE.MeshBasicMaterial({ color: 0x40d080 });
  m.duct = std(COLORS.duct, { transparent: true, opacity: 0.55 });
  return m;
}

/* -------------------------------------------------------------- builders */
function boxAt(M, mat, x, y, z, w, h, d) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x + w / 2, y + h / 2, z + d / 2);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}
function cylY(mat, x, y, z, r, h, seg = 18) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  m.position.set(x, y + h / 2, z); m.castShadow = true; return m;
}
function bushing(G, M, x, y, z, r, h, sheds, mat) {
  G.add(cylY(mat, x, y, z, r, h));
  for (let i = 1; i <= sheds; i++) G.add(cylY(mat, x, y + (i * h) / (sheds + 1), z, r * 1.7, 0.03));
}

function buildEquipment(e, M, energized) {
  const G = new THREE.Group();
  const { w, d, h } = dims(e); const x = e.gx, z = e.gy;
  switch (e.type) {
    case "switchgear": case "mcc": case "panel": {
      G.add(boxAt(M, M.eq, x, 0, z, w, h, d));
      const n = e.type === "panel" ? 1 : e.sections, sw = w / n, mv = e.kv > 1;
      const rows = e.type === "mcc" ? 6 : mv ? 2 : 3;
      for (let i = 0; i < n; i++) for (let j = 0; j < rows; j++) {
        const v0 = 0.1 + (j * (h - 0.2)) / rows, vh = (h - 0.2) / rows - 0.05;
        G.add(boxAt(M, M.door, x + i * sw + 0.05, v0, z + d, sw - 0.1, vh, 0.03));
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), energized ? M.lampOn : M.lampOff);
        lamp.position.set(x + (i + 1) * sw - 0.15, v0 + vh * 0.75, z + d + 0.05); G.add(lamp);
        if (e.type !== "mcc") G.add(boxAt(M, M.edge, x + i * sw + sw * 0.3, v0 + vh * 0.3, z + d + 0.03, sw * 0.4, vh * 0.3, 0.02));
      }
      G.add(boxAt(M, M.edge, x + 0.1, h, z + 0.2, w - 0.2, 0.04, 0.35));
      break;
    }
    case "transformer": {
      G.add(boxAt(M, M.tank, x, 0, z, w, h, d));
      for (let i = 0; i < 7; i++) {
        G.add(boxAt(M, M.fin, x + w, 0.25, z + 0.25 + (i * (d - 0.5)) / 6, 0.42, h - 0.55, 0.05));
        G.add(boxAt(M, M.fin, x + 0.25 + (i * (w - 0.5)) / 6, 0.25, z + d, 0.05, h - 0.55, 0.36));
      }
      for (const f of [0.3, 0.75, 1.2]) bushing(G, M, x + 0.4, h, z + f + 0.15, 0.08, 0.75, 3, M.porcelain);
      for (const f of [0.35, 0.8, 1.25]) G.add(cylY(M.brass, x + w - 0.4, h, z + f + 0.1, 0.1, 0.38));
      G.add(boxAt(M, M.door, x + 0.35, h * 0.45, z + d - 0.01, 0.55, h * 0.27, 0.04));
      break;
    }
    case "motor": {
      const r = d * 0.42, cy = r + 0.18;
      G.add(boxAt(M, M.eq, x + 0.15, 0, z + 0.05, w - 0.3, 0.16, d - 0.1));
      const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w - 0.45, 28), M.motor);
      body.rotation.z = Math.PI / 2; body.position.set(x + 0.25 + (w - 0.45) / 2, cy, z + d / 2); body.castShadow = true; G.add(body);
      for (let i = 0; i < 6; i++) { const rib = new THREE.Mesh(new THREE.TorusGeometry(r * 1.01, 0.018, 6, 28), M.motor); rib.rotation.y = Math.PI / 2; rib.position.set(x + 0.45 + i * 0.2, cy, z + d / 2); G.add(rib); }
      const cowl = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.96, r * 0.96, 0.3, 24), M.edge); cowl.rotation.z = Math.PI / 2; cowl.position.set(x + 0.15, cy, z + d / 2); G.add(cowl);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.3, 10), M.brass); shaft.rotation.z = Math.PI / 2; shaft.position.set(x + w, cy, z + d / 2); G.add(shaft);
      G.add(boxAt(M, M.motor, x + 0.7, cy + r - 0.05, z + d / 2 - 0.22, 0.45, 0.3, 0.44));
      break;
    }
    case "load": {
      G.add(boxAt(M, M.bldg, x, 0, z, w, h, d));
      const shape = new THREE.Shape(); shape.moveTo(0, 0); shape.lineTo(d, 0); shape.lineTo(d / 2, 0.55); shape.lineTo(0, 0);
      const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: w + 0.1, bevelEnabled: false }), M.roof);
      roof.rotation.y = Math.PI / 2; roof.position.set(x - 0.05, h, z + d); roof.castShadow = true; G.add(roof);
      G.add(boxAt(M, M.door, x + w * 0.4, 0, z + d, w * 0.2, h * 0.7, 0.03));
      for (const f of [0.12, 0.72]) G.add(boxAt(M, M.window, x + w * f, h * 0.45, z + d, w * 0.16, h * 0.3, 0.03));
      break;
    }
    case "capacitor": {
      G.add(boxAt(M, M.eq, x, 0, z, w, h, d));
      for (const f of [0.3, 0.6, 0.9]) G.add(cylY(M.eq, x + f + 0.05, h, z + d / 2, 0.11, 0.35));
      for (const v of [0.25, 0.4, 0.55, 0.7]) G.add(boxAt(M, M.edge, x + w * 0.15, h * v, z + d, w * 0.7, 0.04, 0.02));
      break;
    }
    case "generator": {
      G.add(boxAt(M, M.gen, x, 0, z, w, h, d));
      G.add(cylY(M.edge, x + w - 0.5, h, z + d / 2, 0.1, 0.8));
      break;
    }
    case "utility": {
      const cx = x + 0.5, cz = z + 0.5, H = 4;
      for (const dz of [-0.45, 0.45]) G.add(cylY(M.pole, cx, 0, cz + dz, 0.07, H, 10));
      G.add(boxAt(M, M.pole, cx - 0.06, H - 0.36, cz - 0.75, 0.12, 0.12, 1.5));
      for (const dz of [-0.55, 0, 0.55]) {
        bushing(G, M, cx, H - 0.25, cz + dz, 0.05, 0.3, 2, M.porcelain);
        const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(cx, H + 0.05, cz + dz), new THREE.Vector3(cx - 2.5, H + 0.1, cz + dz - 0.6), new THREE.Vector3(cx - 5, H + 0.9, cz + dz - 1.2));
        G.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.012, 4, false), M.tray));
      }
      break;
    }
    default: G.add(boxAt(M, M.eq, x, 0, z, w, h, d));
  }
  G.userData = { kind: "eq", id: e.id, top: new THREE.Vector3(x + w / 2, h + (e.type === "transformer" ? 0.9 : 0.3), z + d / 2) };
  G.traverse((o) => { o.userData.pick = { kind: "eq", id: e.id }; });
  return G;
}

function segmentBox(M, mat, a, b, W, H, yOff = 0) {
  // axis-aligned segment from a to b (three coords), cross-section W×H
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz); if (len < 1e-6) return null;
  const g = Math.abs(dy) > 1e-6 ? new THREE.BoxGeometry(W, len, H) : Math.abs(dx) > 1e-6 ? new THREE.BoxGeometry(len + W, H, W) : new THREE.BoxGeometry(W, H, len + W);
  const m = new THREE.Mesh(g, mat);
  m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2 + yOff, (a.z + b.z) / 2); m.castShadow = true; m.receiveShadow = true;
  return m;
}
const V = (p) => new THREE.Vector3(p[0], p[2], p[1]);

function buildConnector(c, route, M, res) {
  const G = new THREE.Group();
  const pts = route.pts.map(V);
  if (c.kind === "cablebus") {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const vertical = Math.abs(a.y - b.y) > 1e-6;
      if (vertical) { const s = segmentBox(M, M.tray, a, b, 0.42, 0.24); if (s) G.add(s); continue; }
      const base = segmentBox(M, M.tray, new THREE.Vector3(a.x, a.y - 0.2, a.z), new THREE.Vector3(b.x, b.y - 0.2, b.z), 0.44, 0.03); if (base) G.add(base);
      const horizX = Math.abs(a.x - b.x) > 1e-6;
      for (const off of [-0.21, 0.21]) {
        const o = horizX ? new THREE.Vector3(0, 0, off) : new THREE.Vector3(off, 0, 0);
        const rail = segmentBox(M, M.tray, a.clone().add(o).setY(a.y - 0.1), b.clone().add(o).setY(b.y - 0.1), 0.03, 0.2); if (rail) { rail.scale.set(horizX ? 1 : 0.07, 1, horizX ? 0.07 : 1); G.add(rail); }
      }
      const cover = segmentBox(M, M.cover, a, b, 0.44, 0.02); if (cover) G.add(cover);
      [M.phA, M.phB, M.phC].forEach((mat, k) => {
        const off = (k - 1) * 0.11;
        const o = horizX ? new THREE.Vector3(0, 0, off) : new THREE.Vector3(off, 0, 0);
        const p0 = a.clone().add(o).setY(a.y - 0.12), p1 = b.clone().add(o).setY(b.y - 0.12);
        const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(p0, p1), 1, 0.035, 8, false), mat); G.add(tube);
      });
    }
  } else if (c.kind !== "direct") {
    const g = pts.map((p) => p.clone().setY(0.02));
    for (let i = 0; i < g.length - 1; i++) { const s = segmentBox(M, M.duct, g[i], g[i + 1], Math.min(0.18 + (c.sets ?? 1) * 0.05, 0.5), 0.04); if (s) G.add(s); }
    const line = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(g.map((p) => p.clone().setY(0.06)), false, "catmullrom", 0), 64, 0.03, 6, false),
      new THREE.MeshBasicMaterial({ color: loadHex(res?.loading_pct) }));
    G.add(line);
  }
  G.traverse((o) => { o.userData.pick = { kind: "con", id: c.id }; });
  G.userData = { kind: "con", id: c.id };
  return G;
}

/* ------------------------------------------------------------ component */
export function Site3D({ sys, analysis, selection, setSelection, animate, showTags }) {
  const wrapRef = useRef(null), canvasRef = useRef(null), labelsRef = useRef(null);
  const st = useRef(null);
  const [failed, setFailed] = useState(typeof THREE === "undefined");

  // one-time renderer, camera, lights, controls
  useEffect(() => {
    if (typeof THREE === "undefined") return;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas: canvasRef.current, antialias: true }); }
    catch (err) { setFailed(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0f14); scene.fog = new THREE.Fog(0x0a0f14, 45, 110);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
    scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2a2420, 1.0));
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.35); sun.position.set(-18, 30, -8); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 90 });
    scene.add(sun); scene.add(sun.target);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    const grid = new THREE.GridHelper(80, 80, 0x22303c, 0x16212b); grid.position.y = 0.005; scene.add(grid);
    const world = new THREE.Group(); scene.add(world);
    const flows = new THREE.Group(); scene.add(flows);
    const orbit = { target: new THREE.Vector3(10, 0, 6), r: 34, theta: -0.75, phi: 0.95 };
    const s = { renderer, scene, camera, sun, world, flows, orbit, M: mats(), labels: [], particles: [], selBox: null, raf: 0, clock: new THREE.Clock(), animate: true };
    st.current = s;

    const place = () => {
      const { target, r, theta, phi } = orbit;
      camera.position.set(target.x + r * Math.sin(phi) * Math.sin(theta), target.y + r * Math.cos(phi), target.z + r * Math.sin(phi) * Math.cos(theta));
      camera.lookAt(target);
    };
    s.place = place;
    const resize = () => {
      const el = wrapRef.current; if (!el) return;
      const w = el.clientWidth || 800, h = el.clientHeight || 500;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize); ro.observe(wrapRef.current); resize();

    // controls
    const cv = canvasRef.current; let drag = null;
    const down = (ev) => { cv.setPointerCapture(ev.pointerId); drag = { x: ev.clientX, y: ev.clientY, pan: ev.button === 2 || ev.shiftKey, moved: false }; };
    const move = (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y; drag.x = ev.clientX; drag.y = ev.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
      if (drag.pan) {
        const k = orbit.r * 0.0016;
        const right = new THREE.Vector3().subVectors(camera.position, orbit.target).cross(camera.up).normalize();
        const fwd = new THREE.Vector3(Math.sin(orbit.theta), 0, Math.cos(orbit.theta));
        orbit.target.addScaledVector(right, dx * k).addScaledVector(fwd, -dy * k);
      } else {
        orbit.theta -= dx * 0.006; orbit.phi = Math.min(1.45, Math.max(0.15, orbit.phi - dy * 0.005));
      }
      place();
    };
    const up = (ev) => {
      if (drag && !drag.moved) {
        const rect = cv.getBoundingClientRect();
        const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
        const hit = ray.intersectObjects(world.children, true).find((h) => h.object.userData.pick);
        s.onPick?.(hit ? hit.object.userData.pick : null);
      }
      drag = null;
    };
    const wheel = (ev) => { ev.preventDefault(); orbit.r = Math.min(120, Math.max(6, orbit.r * Math.exp(ev.deltaY * 0.0012))); place(); };
    const ctx = (ev) => ev.preventDefault();
    cv.addEventListener("pointerdown", down); cv.addEventListener("pointermove", move); cv.addEventListener("pointerup", up);
    cv.addEventListener("wheel", wheel, { passive: false }); cv.addEventListener("contextmenu", ctx);

    const tmp = new THREE.Vector3();
    const loop = () => {
      s.raf = requestAnimationFrame(loop);
      if (!wrapRef.current || wrapRef.current.offsetParent === null) return; // hidden workspace: skip work
      const dt = s.clock.getDelta();
      if (s.animate) for (const p of s.particles) {
        p.t = (p.t + dt * p.speed) % 1;
        const L = p.total * p.t; let acc = 0;
        for (let i = 0; i < p.pts.length - 1; i++) {
          const seg = p.pts[i].distanceTo(p.pts[i + 1]);
          if (acc + seg >= L) { p.mesh.position.lerpVectors(p.pts[i], p.pts[i + 1], (L - acc) / Math.max(seg, 1e-9)); break; }
          acc += seg;
        }
      }
      renderer.render(scene, camera);
      // HTML labels follow their anchor points
      const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
      for (const lb of s.labels) {
        tmp.copy(lb.pos).project(camera);
        const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
        lb.el.style.display = vis && s.showTags ? "" : "none";
        if (vis) lb.el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -100%)`;
      }
    };
    place(); loop();
    return () => {
      cancelAnimationFrame(s.raf); ro.disconnect();
      cv.removeEventListener("pointerdown", down); cv.removeEventListener("pointermove", move); cv.removeEventListener("pointerup", up);
      cv.removeEventListener("wheel", wheel); cv.removeEventListener("contextmenu", ctx);
      renderer.dispose();
    };
  }, []);

  useEffect(() => { if (st.current) st.current.onPick = (p) => setSelection(p ? { kind: p.kind, id: p.id } : null); }, [setSelection]);
  useEffect(() => { if (st.current) { st.current.animate = animate; st.current.showTags = showTags; st.current.flows.visible = animate; } }, [animate, showTags]);

  // rebuild meshes when the model or results change
  useEffect(() => {
    const s = st.current; if (!s) return;
    const dispose = (grp) => { grp.traverse((o) => { o.geometry?.dispose?.(); }); grp.clear(); };
    dispose(s.world); dispose(s.flows); s.particles = [];
    const labelsEl = labelsRef.current; labelsEl.innerHTML = ""; s.labels = [];
    const { eqMap, routes } = siteRoutes(sys);
    const ok = analysis?.ok, res = analysis?.equipment || {}, cres = analysis?.connectors || {};
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const e of Object.values(eqMap)) {
      const g = buildEquipment(e, s.M, !!ok); s.world.add(g);
      const { w, d } = dims(e); minX = Math.min(minX, e.gx); maxX = Math.max(maxX, e.gx + w); minZ = Math.min(minZ, e.gy); maxZ = Math.max(maxZ, e.gy + d);
      const r = ok ? res[e.id] : null;
      const el = document.createElement("div"); el.className = "lbl3d";
      const tone = !r ? "" : (r.loading_pct > 100 || r.sc_duty_pct > 100) ? "crit" : (r.vflag !== "ok" || r.loading_pct > 80 || r.sc_duty_pct > 90) ? "warn" : "ok";
      el.dataset.tone = tone;
      const line2 = !r ? "" : r.loading_pct != null ? `${r.v_pu.toFixed(3)} pu · ${fmt(r.loading_pct, 0)}%` : `${r.v_pu.toFixed(3)} pu`;
      const line3 = r?.ik_ka != null && ["switchgear", "mcc", "panel", "utility"].includes(e.type) ? `I″k ${fmt(r.ik_ka, 1)} kA` : "";
      el.innerHTML = `<b></b><span></span><span></span>`;
      el.children[0].textContent = e.name || e.id; el.children[1].textContent = line2; el.children[2].textContent = line3;
      labelsEl.appendChild(el); s.labels.push({ el, pos: g.userData.top.clone() });
    }
    for (const c of sys.connectors) {
      const rt = routes[c.id]; if (!rt || rt.direct) continue;
      const r = ok ? cres[c.id] : null;
      s.world.add(buildConnector({ ...c }, rt, s.M, r));
      if (r) {
        let pts = rt.pts.map(V).map((p) => (c.kind === "cablebus" ? p.clone().setY(p.y + 0.05) : p.clone().setY(0.12)));
        if (c.kind !== "cablebus") pts = pts.map((p) => p.clone().setY(0.12));
        if (r.dir < 0) pts.reverse();
        let total = 0; for (let i = 0; i < pts.length - 1; i++) total += pts[i].distanceTo(pts[i + 1]);
        const n = Math.max(2, Math.round(total / 1.4)), speed = (0.25 + 0.9 * Math.min(1, (r.loading_pct ?? 30) / 100)) * (6 / Math.max(total, 1));
        const mat = new THREE.MeshBasicMaterial({ color: loadHex(r.loading_pct) });
        for (let i = 0; i < n; i++) {
          const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), mat);
          s.flows.add(mesh); s.particles.push({ mesh, pts, total, t: i / n, speed });
        }
      }
    }
    if (!s.framed && isFinite(minX)) {
      s.orbit.target.set((minX + maxX) / 2, 0.8, (minZ + maxZ) / 2);
      s.orbit.r = Math.max(18, 1.25 * Math.hypot(maxX - minX, maxZ - minZ));
      s.sun.target.position.copy(s.orbit.target); s.sun.position.set(s.orbit.target.x - 18, 30, s.orbit.target.z - 10);
      s.place(); s.framed = true;
    }
  }, [sys, analysis]);

  // selection highlight
  useEffect(() => {
    const s = st.current; if (!s) return;
    if (s.selBox) { s.scene.remove(s.selBox); s.selBox = null; }
    if (!selection) return;
    const target = s.world.children.find((g) => g.userData.kind === (selection.kind === "eq" ? "eq" : "con") && g.userData.id === selection.id);
    if (!target) return;
    s.selBox = new THREE.BoxHelper(target, 0xd8b25a); s.scene.add(s.selBox);
  }, [selection, sys, analysis]);

  if (failed) return <div className="canvas-wrap grid place-items-center text-muted p-6 text-center">3D view needs WebGL, which this browser or frame does not provide. The isometric view shows the same model.</div>;
  return (
    <div ref={wrapRef} className="canvas-wrap site3d">
      <canvas ref={canvasRef} className="canvas3d" />
      <div ref={labelsRef} className="labels3d" />
      <div className="canvas-hud left"><span className="hidden sm:inline">Drag to orbit · right-drag or shift-drag to pan · scroll to zoom · click to select</span></div>
    </div>
  );
}
