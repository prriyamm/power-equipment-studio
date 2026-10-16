/* Small mesh helpers for the equipment detail views. All inputs are millimetres; geometry is created in metres
   (world unit = 1 m) so the camera, shadows and orbit controls behave like the site view. Axes: x across, y up, z along. */

export const MM = 0.001;

/* Sequential temperature / loading scale shared by the 2D and 3D views (blue -> teal -> yellow -> orange -> red). */
export const STOPS = [[0, [59, 111, 160]], [0.28, [79, 179, 160]], [0.55, [232, 195, 90]], [0.78, [255, 139, 74]], [1, [255, 95, 95]]];
export function scale(t) {
  const x = Math.max(0, Math.min(1, t));
  for (let k = 1; k < STOPS.length; k++) {
    if (x <= STOPS[k][0]) {
      const [a, ca] = STOPS[k - 1], [b, cb] = STOPS[k], f = (x - a) / (b - a);
      return ca.map((v, j) => v + (cb[j] - v) * f);
    }
  }
  return STOPS[STOPS.length - 1][1];
}
export const rgb = (c, k = 1) => `rgb(${c.map((v) => Math.round(Math.min(255, v * k))).join(",")})`;
export const gradientCss = () => `linear-gradient(90deg, ${STOPS.map(([f, cc]) => `${rgb(cc)} ${f * 100}%`).join(", ")})`;
export const threeColor = (c) => new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255);

export function std(color, o = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2, ...o });
}

/* Axis-aligned box from [x0,x1] [y0,y1] [z0,z1] in mm. */
export function boxMm(mat, xr, yr, zr, o = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry((xr[1] - xr[0]) * MM, (yr[1] - yr[0]) * MM, (zr[1] - zr[0]) * MM), mat);
  m.position.set(((xr[0] + xr[1]) / 2) * MM, ((yr[0] + yr[1]) / 2) * MM, ((zr[0] + zr[1]) / 2) * MM);
  m.castShadow = o.cast !== false; m.receiveShadow = o.receive !== false;
  if (o.edge) addEdges(m, o.edge, o.edgeOpacity);
  return m;
}

/* Cylinder between two mm points. */
export function cylMm(mat, p0, p1, r, seg = 28, o = {}) {
  const a = new THREE.Vector3(...p0).multiplyScalar(MM), b = new THREE.Vector3(...p1).multiplyScalar(MM);
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r * MM, r * MM, len, seg, 1, !!o.open), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  m.castShadow = o.cast !== false; m.receiveShadow = o.receive !== false;
  return m;
}

export function addEdges(mesh, color = 0x1b232b, opacity = 0.7) {
  const l = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  mesh.add(l); return l;
}

export function lineMm(pts, color, opacity = 1) {
  const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p[0] * MM, p[1] * MM, p[2] * MM)));
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}

export function labelEl(cls, lines, color) {
  const el = document.createElement("div"); el.className = cls;
  if (color) el.style.borderLeftColor = color;
  lines.forEach((t, i) => { const s = document.createElement(i === 0 ? "b" : "span"); s.textContent = t; el.appendChild(s); });
  return el;
}

export const v3 = (x, y, z) => new THREE.Vector3(x * MM, y * MM, z * MM);

/* Rectangle with optional circular holes extruded along +z (mm), used for the GPO-3 support blocks. */
export function plateWithHoles(mat, x0, x1, y0, y1, z0, z1, holes) {
  const s = new THREE.Shape();
  s.moveTo(x0 * MM, y0 * MM); s.lineTo(x1 * MM, y0 * MM); s.lineTo(x1 * MM, y1 * MM); s.lineTo(x0 * MM, y1 * MM); s.lineTo(x0 * MM, y0 * MM);
  for (const h of holes) { const p = new THREE.Path(); p.absarc(h.x * MM, h.y * MM, h.r * MM, 0, Math.PI * 2, true); s.holes.push(p); }
  const g = new THREE.ExtrudeGeometry(s, { depth: (z1 - z0) * MM, bevelEnabled: false, curveSegments: 28 });
  const m = new THREE.Mesh(g, mat); m.position.z = z0 * MM; m.castShadow = true; m.receiveShadow = true;
  return m;
}

/* Wrap-up shared by the detail views: dispose a group's geometries and materials (built per rebuild,
   never shared across builds) with their textures, and drop its children. */
export function disposeGroup(grp) {
  grp.traverse((o) => {
    o.geometry?.dispose?.();
    for (const m of o.material ? [].concat(o.material) : []) { for (const k in m) if (m[k]?.isTexture) m[k].dispose(); m.dispose?.(); }
  });
  grp.clear();
}
