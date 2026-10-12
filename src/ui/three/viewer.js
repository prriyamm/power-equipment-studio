/* Shared three.js (r128 global THREE) scaffolding: renderer, camera, lights, ground, custom orbit controls
   (left drag orbit, right or shift drag pan, wheel zoom), click picking, HTML labels that follow 3D anchors,
   and a render loop that idles while the canvas is hidden. Throws if WebGL is unavailable. */

export function createViewer(canvas, wrapEl, opts = {}) {
  const {
    background = 0x0a0f14, fog = null, gridSize = 80, gridDivisions = gridSize,
    gridColors = [0x22303c, 0x16212b], groundColor = 0x111a22, groundSize = 200,
    near = 0.1, far = 400, fov = 38, minR = 6, maxR = 120, labelsEl = null,
    orbit: orbitInit = {}, sun: sunOpts = {}, env = false, fill = 1.0,
  } = opts;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  if (fog) scene.fog = new THREE.Fog(fog[0] ?? background, fog[1], fog[2]);
  const camera = new THREE.PerspectiveCamera(fov, 1, near, far);
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2a2420, fill));
  const sun = new THREE.DirectionalLight(0xfff2dd, sunOpts.intensity ?? 1.35);
  sun.position.set(...(sunOpts.position || [-18, 30, -8])); sun.castShadow = true;
  const ext = sunOpts.extent ?? 30;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: sunOpts.near ?? 1, far: sunOpts.far ?? 90 });
  if (sunOpts.bias != null) sun.shadow.bias = sunOpts.bias;
  scene.add(sun); scene.add(sun.target);
  if (env) {
    // small procedural studio environment so metals reflect something other than black
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
    } catch (e) { /* environment is cosmetic */ }
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), new THREE.MeshStandardMaterial({ color: groundColor, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const grid = new THREE.GridHelper(gridSize, gridDivisions, gridColors[0], gridColors[1]); grid.position.y = 0.0005 * Math.max(1, gridSize / 80); scene.add(grid);
  const world = new THREE.Group(); scene.add(world);
  const orbit = Object.assign({ target: new THREE.Vector3(10, 0, 6), r: 34, theta: -0.75, phi: 0.95 }, orbitInit);

  const v = { scene, camera, renderer, world, orbit, sun, ground, grid, labels: [], showLabels: true, raf: 0, clock: new THREE.Clock(), frameCb: null, pickCb: null };
  const labelsLayer = labelsEl || (() => { const d = document.createElement("div"); d.className = "labels3d"; wrapEl.appendChild(d); return d; })();
  v.labelsEl = labelsLayer;

  const place = () => {
    const { target, r, theta, phi } = orbit;
    camera.position.set(target.x + r * Math.sin(phi) * Math.sin(theta), target.y + r * Math.cos(phi), target.z + r * Math.sin(phi) * Math.cos(theta));
    camera.lookAt(target);
  };
  v.place = place;
  const resize = () => {
    const w = wrapEl.clientWidth || 800, h = wrapEl.clientHeight || 500;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize); ro.observe(wrapEl); resize();

  let drag = null;
  const down = (ev) => { canvas.setPointerCapture(ev.pointerId); drag = { x: ev.clientX, y: ev.clientY, pan: ev.button === 2 || ev.shiftKey, moved: false }; };
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
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(world.children, true).find((h) => h.object.userData.pick);
      v.pickCb?.(hit ? hit.object.userData.pick : null);
    }
    drag = null;
  };
  const wheel = (ev) => { ev.preventDefault(); orbit.r = Math.min(maxR, Math.max(minR, orbit.r * Math.exp(ev.deltaY * 0.0012))); place(); };
  const ctx = (ev) => ev.preventDefault();
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up);
  canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("contextmenu", ctx);

  v.onPick = (fn) => { v.pickCb = fn; };
  v.onFrame = (fn) => { v.frameCb = fn; };
  v.addLabel = (el, pos) => { labelsLayer.appendChild(el); const lb = { el, pos: pos.clone() }; v.labels.push(lb); return lb; };
  v.clearLabels = () => { labelsLayer.innerHTML = ""; v.labels = []; };
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

  const tmp = new THREE.Vector3();
  const loop = () => {
    v.raf = requestAnimationFrame(loop);
    if (!wrapEl || wrapEl.offsetParent === null) return; // hidden workspace: skip work
    const dt = v.clock.getDelta();
    v.frameCb?.(dt);
    renderer.render(scene, camera);
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    for (const lb of v.labels) {
      tmp.copy(lb.pos).project(camera);
      const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
      lb.el.style.display = vis && v.showLabels ? "" : "none";
      if (vis) lb.el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  };
  place(); loop();

  v.dispose = () => {
    cancelAnimationFrame(v.raf); ro.disconnect();
    canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("contextmenu", ctx);
    scene.traverse((o) => { o.geometry?.dispose?.(); });
    scene.environment?.dispose?.();
    renderer.dispose();
  };
  return v;
}

/* Remove and dispose everything in a group. */
export function clearGroup(grp) { grp.traverse((o) => { o.geometry?.dispose?.(); }); grp.clear(); }
