/* Shared three.js (r128 global THREE) scaffolding: renderer, camera, lights, ground, custom orbit controls
   (left drag orbit, right or shift drag pan, wheel zoom), click picking, HTML labels that follow 3D anchors.

   Rendering is on demand: a frame is drawn only after something changed (camera input, resize, labels,
   v.invalidate() from the caller) or while the onFrame callback reports an active animation. No
   requestAnimationFrame is scheduled while the view is hidden, offscreen or the tab is in the background.
   Renderer settings follow the graphics tier in ../quality.js; a tier change rebuilds the renderer on a
   fresh canvas (antialias is fixed per WebGL context). Throws if WebGL is unavailable. */
import { quality } from "../quality.js";

const DEBUG_PERF = typeof location !== "undefined" && /debug-perf/.test(location.hash);
let viewerSeq = 0;

/* #debug-perf only: per-viewer render counters on window.__pswPerf plus a small readout. */
function perfRegistry() {
  if (!DEBUG_PERF) return null;
  if (!window.__pswPerf) {
    const reg = window.__pswPerf = { viewers: {}, total: 0 };
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:99;font:11px/1.35 var(--font-data);color:var(--fg);background:var(--tag-bg);border:1px solid var(--line);border-radius:5px;padding:4px 8px;pointer-events:none;white-space:pre";
    document.body.appendChild(el);
    let last = 0;
    setInterval(() => {
      const q = quality.get();
      const live = Object.values(reg.viewers).filter((x) => !x.disposed);
      el.textContent = `gfx ${q.tier}${q.mode === "auto" ? " (auto)" : ""} · anim ${q.animations ? "on" : "off"}\n`
        + `renders/s ${reg.total - last} · views ${live.length}\n`
        + live.map((x) => `#${x.id} ${x.visible ? "shown" : "hidden"} ${x.looping ? "raf" : "idle"} f=${x.frames}`).join("\n");
      last = reg.total;
    }, 1000);
  }
  return window.__pswPerf;
}

/* Dispose a material and every texture it references. */
export function disposeMaterial(m) {
  if (!m) return;
  for (const mm of Array.isArray(m) ? m : [m]) {
    for (const k in mm) { const t = mm[k]; if (t && t.isTexture) t.dispose(); }
    mm.dispose?.();
  }
}
/* Dispose geometry + materials (+ textures) of everything under obj. */
export function disposeTree(obj) {
  obj.traverse((o) => { o.geometry?.dispose?.(); disposeMaterial(o.material); });
}

export function createViewer(canvas, wrapEl, opts = {}) {
  const {
    background = 0x0a0f14, fog = null, gridSize = 80, gridDivisions = gridSize,
    gridColors = [0x22303c, 0x16212b], groundColor = 0x111a22, groundSize = 200,
    near = 0.1, far = 400, fov = 38, minR = 6, maxR = 120, labelsEl = null,
    orbit: orbitInit = {}, sun: sunOpts = {}, env = false, fill = 1.0,
  } = opts;

  let q = quality.get();
  let cur = canvas;          // the canvas the live renderer draws on (ours after a tier change)
  const makeRenderer = (S) => {
    const r = new THREE.WebGLRenderer({ canvas: cur, antialias: S.antialias, powerPreference: S.tier === "low" ? "low-power" : "default" });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, S.maxPixelRatio));
    r.shadowMap.enabled = S.shadows; r.shadowMap.type = S.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    return r;
  };
  let renderer = makeRenderer(q.settings);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  if (fog) scene.fog = new THREE.Fog(fog[0] ?? background, fog[1], fog[2]);
  const camera = new THREE.PerspectiveCamera(fov, 1, near, far);
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2a2420, fill));
  const sun = new THREE.DirectionalLight(0xfff2dd, sunOpts.intensity ?? 1.35);
  sun.position.set(...(sunOpts.position || [-18, 30, -8]));
  const ext = sunOpts.extent ?? 30;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: sunOpts.near ?? 1, far: sunOpts.far ?? 90 });
  if (sunOpts.bias != null) sun.shadow.bias = sunOpts.bias;
  scene.add(sun); scene.add(sun.target);
  const applyShadowSettings = (S) => {
    sun.castShadow = S.shadows;
    sun.shadow.map?.dispose?.(); sun.shadow.map = null; // re-created at the new size on next render
    sun.shadow.mapSize.set(S.shadowMapSize || 512, S.shadowMapSize || 512);
  };
  applyShadowSettings(q.settings);

  // small procedural studio environment so metals reflect something other than black (high tier only)
  const buildEnv = () => {
    if (!env || !q.settings.env) { scene.environment = null; return; }
    try {
      const es = new THREE.Scene();
      es.add(new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: "varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
        fragmentShader: "varying vec3 p; void main(){ float h = normalize(p).y; vec3 c = mix(vec3(0.10,0.11,0.13), vec3(0.62,0.68,0.76), smoothstep(-0.4,0.9,h)); gl_FragColor = vec4(c,1.0); }",
      })));
      const panel = (x, y, z, w, h, k) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k * 0.96), side: THREE.DoubleSide }));
        m.position.set(x, y, z); m.lookAt(0, 0, 0); es.add(m);
      };
      panel(0, 8, 2, 8, 3, 4); panel(-8, 3, -3, 3, 6, 2.2); panel(7, 2, 5, 3, 5, 1.6);
      const pm = new THREE.PMREMGenerator(renderer);
      scene.environment = pm.fromScene(es, 0.02).texture; pm.dispose();
      disposeTree(es);
    } catch (e) { scene.environment = null; /* environment is cosmetic */ }
  };
  buildEnv();

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), new THREE.MeshStandardMaterial({ color: groundColor, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const grid = new THREE.GridHelper(gridSize, gridDivisions, gridColors[0], gridColors[1]); grid.position.y = 0.0005 * Math.max(1, gridSize / 80); scene.add(grid);
  const world = new THREE.Group(); scene.add(world);
  const orbit = Object.assign({ target: new THREE.Vector3(10, 0, 6), r: 34, theta: -0.75, phi: 0.95 }, orbitInit);

  const v = { scene, camera, renderer, world, orbit, sun, ground, grid, labels: [], raf: 0, clock: new THREE.Clock(), frameCb: null, pickCb: null, quality: q };
  const labelsLayer = labelsEl || (() => { const d = document.createElement("div"); d.className = "labels3d"; wrapEl.appendChild(d); return d; })();
  v.labelsEl = labelsLayer;

  /* ---------------------------------------------------------- on-demand render loop */
  const reg = perfRegistry();
  const stat = { id: ++viewerSeq, frames: 0, visible: true, looping: false, disposed: false };
  if (reg) { reg.viewers[stat.id] = stat; v.perf = stat; stat.viewer = v; }
  let disposed = false, inView = true, animating = false;
  const isVisible = () => !disposed && inView && !(typeof document !== "undefined" && document.hidden) && !!wrapEl && wrapEl.offsetParent !== null;

  const tmp = new THREE.Vector3();
  let showLabels = true;
  const projectLabels = () => {
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    for (const lb of v.labels) {
      tmp.copy(lb.pos).project(camera);
      const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
      lb.el.style.display = vis && showLabels ? "" : "none";
      if (vis) lb.el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  };
  const draw = () => {
    renderer.render(scene, camera);
    projectLabels();
    stat.frames++; if (reg) reg.total++;
  };
  const tick = () => {
    v.raf = 0; stat.looping = false;
    if (!(stat.visible = isVisible())) { animating = false; return; }
    const raw = v.clock.getDelta();
    const dt = animating ? Math.min(raw, 0.1) : 0; // first frame after idle: no time jump
    animating = !!v.frameCb?.(dt);
    draw();
    if (animating) schedule();
  };
  const schedule = () => {
    if (v.raf || disposed) return;
    if (!(stat.visible = isVisible())) return; // resumed by the IntersectionObserver / visibilitychange
    v.raf = requestAnimationFrame(tick); stat.looping = true;
  };
  v.invalidate = schedule;
  Object.defineProperty(v, "showLabels", { get: () => showLabels, set: (b) => { if (b !== showLabels) { showLabels = b; schedule(); } } });

  const place = () => {
    const { target, r, theta, phi } = orbit;
    camera.position.set(target.x + r * Math.sin(phi) * Math.sin(theta), target.y + r * Math.cos(phi), target.z + r * Math.sin(phi) * Math.cos(theta));
    camera.lookAt(target);
    schedule();
  };
  v.place = place;
  const resize = () => {
    const w = wrapEl.clientWidth || 800, h = wrapEl.clientHeight || 500;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    // setSize clears the drawing buffer: redraw now (ResizeObserver runs before paint) to avoid a blank frame
    if (isVisible()) draw(); else schedule();
  };
  const ro = new ResizeObserver(resize); ro.observe(wrapEl);
  const io = typeof IntersectionObserver !== "undefined"
    ? new IntersectionObserver((es) => { const e = es[es.length - 1]; inView = e.isIntersecting; if (inView) schedule(); })
    : null;
  io?.observe(wrapEl);
  const onVis = () => { if (!document.hidden) schedule(); };
  document.addEventListener("visibilitychange", onVis);

  /* ---------------------------------------------------------- controls */
  let drag = null;
  const down = (ev) => { cur.setPointerCapture(ev.pointerId); drag = { x: ev.clientX, y: ev.clientY, pan: ev.button === 2 || ev.shiftKey, moved: false }; };
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
      const rect = cur.getBoundingClientRect();
      const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
      // plain meshes carry userData.pick; instanced meshes carry one entry per instance in userData.picks
      const pickOf = (h) => h.object.userData.pick || (h.instanceId != null ? h.object.userData.picks?.[h.instanceId] : null);
      const hit = ray.intersectObjects(world.children, true).find(pickOf);
      v.pickCb?.(hit ? pickOf(hit) : null);
    }
    drag = null;
  };
  const wheel = (ev) => { ev.preventDefault(); orbit.r = Math.min(maxR, Math.max(minR, orbit.r * Math.exp(ev.deltaY * 0.0012))); place(); };
  const ctx = (ev) => ev.preventDefault();
  const listen = (c, on) => {
    const f = on ? "addEventListener" : "removeEventListener";
    c[f]("pointerdown", down); c[f]("pointermove", move); c[f]("pointerup", up);
    c[f]("wheel", wheel, { passive: false }); c[f]("contextmenu", ctx);
  };
  listen(cur, true);

  /* ---------------------------------------------------------- graphics tier changes */
  const sameSettings = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
  const unsubscribe = quality.subscribe((next) => {
    const prev = q; q = next; v.quality = next;
    if (!sameSettings(prev.settings, next.settings)) {
      // antialias is a context attribute, so rebuild the renderer on a fresh canvas and free the old context
      const old = renderer, oldCanvas = cur;
      scene.environment?.dispose?.(); scene.environment = null;
      const nc = document.createElement("canvas");
      nc.className = canvas.className;
      oldCanvas.parentNode?.insertBefore(nc, oldCanvas);
      listen(oldCanvas, false);
      old.dispose();
      if (oldCanvas === canvas) canvas.style.display = "none"; // React owns it; keep it in the DOM, hidden
      else { old.forceContextLoss(); oldCanvas.remove(); }
      cur = nc; listen(cur, true);
      renderer = v.renderer = makeRenderer(next.settings);
      applyShadowSettings(next.settings);
      buildEnv();
      scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
      resize();
    }
    schedule();
  });

  v.onPick = (fn) => { v.pickCb = fn; };
  /* fn(dt) runs before each render; return true while it is animating to keep frames coming. */
  v.onFrame = (fn) => { v.frameCb = fn; schedule(); };
  v.addLabel = (el, pos) => { labelsLayer.appendChild(el); const lb = { el, pos: pos.clone() }; v.labels.push(lb); schedule(); return lb; };
  v.clearLabels = () => { labelsLayer.innerHTML = ""; v.labels = []; schedule(); };
  /* Aim the orbit at a Box3 and back off far enough to see all of it; the sun follows. */
  v.frame = (box) => {
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const rad = Math.max(size.length() / 2, 1e-3);
    orbit.target.copy(c);
    orbit.r = Math.min(maxR, Math.max(minR, (rad / Math.sin((camera.fov * Math.PI) / 360)) * (camera.aspect < 1.2 ? 1.1 : 0.9)));
    sun.target.position.copy(c);
    const k = sunOpts.distance ?? rad * 3;
    sun.position.set(c.x - k * 0.5, c.y + k * 0.9, c.z + k * 0.6);
    place();
  };

  resize(); place();

  v.dispose = () => {
    disposed = true; stat.disposed = true; stat.looping = false;
    cancelAnimationFrame(v.raf); v.raf = 0;
    ro.disconnect(); io?.disconnect(); unsubscribe();
    document.removeEventListener("visibilitychange", onVis);
    listen(cur, false);
    disposeTree(scene);
    scene.environment?.dispose?.();
    sun.shadow.map?.dispose?.();
    renderer.dispose();
    if (cur !== canvas) { renderer.forceContextLoss(); cur.remove(); canvas.style.display = ""; }
  };
  return v;
}

/* Remove and dispose everything in a group. */
export function clearGroup(grp) { disposeTree(grp); grp.clear(); }
