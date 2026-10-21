/* three.js (r128 global THREE) scene for the virtual short-circuit lab test: test bay, busbar feed, cable bus
   specimen (enclosure, support blocks, flexing cables) and the failure effects (fragments, arc flash, sparks,
   smoke, buckling rail, lifting cover panel). Everything is driven by labState() from ../labAnim.js through
   handle.update(state). Geometry is built per call and disposed with disposeGroup() by the caller.
   Metres; y up, z along the run. */
import { budgetFor, shapeWeight, utilColor, railBulge } from "../labAnim.js";
import { fillSparks, smokePuffs } from "../labAnim.js";

const PH_HEX = { A: 0xe05a4f, B: 0xe8c35a, C: 0x5aa0e0 };
// GPO-3 block colour: the isometric cut-away's block top (BLOCK_T in cablebus.jsx). The 2D fill 0xe9b9a1 read as
// white once lit and shaded under the cover.
const GPO_HEX = 0xc98f74;
const GPO = new THREE.Color(GPO_HEX);
const COVER_OPACITY = 0.22;

function radialTexture(stops, size = 128) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"), r = size / 2;
  const gr = g.createRadialGradient(r, r, 0, r, r, r);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

const box = (mat, x0, x1, y0, y1, z0, z1, shadow = true) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.castShadow = shadow; m.receiveShadow = true;
  return m;
};
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2, ...o });

function plateMesh(mat, p, z) {
  const s = new THREE.Shape();
  s.moveTo(p.x0, p.y0); s.lineTo(p.x1, p.y0); s.lineTo(p.x1, p.y1); s.lineTo(p.x0, p.y1); s.lineTo(p.x0, p.y0);
  for (const h of p.holes) { const q = new THREE.Path(); q.absarc(h.x, h.y, h.r, 0, Math.PI * 2, true); s.holes.push(q); }
  const m = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: p.d, bevelEnabled: false, curveSegments: 20 }), mat);
  m.position.z = z - p.d / 2; m.castShadow = true; m.receiveShadow = true;
  return m;
}

/* Builders: each adds one part of the scene to `group`. */
function buildBay(group, layout) {
  const { W, H, L, base } = layout;
  const slab = std(0x222a31, { roughness: 0.92, metalness: 0 });
  group.add(box(slab, -3.4, W + 3.4, -0.02, 0, -3.2, L + 2.6, false));
  const yellow = std(0xd9a82a, { roughness: 0.8, metalness: 0 });
  for (const [x0, x1, z0, z1] of [[-1.5, W + 1.5, L + 1.4, L + 1.46], [-1.5, W + 1.5, -2.0, -1.94], [-1.5, -1.44, -2.0, L + 1.46], [W + 1.44, W + 1.5, -2.0, L + 1.46]]) group.add(box(yellow, x0, x1, 0, 0.004, z0, z1, false));
  const wall = std(0x2b343d, { roughness: 0.9, metalness: 0 });
  group.add(box(wall, W + 2.1, W + 2.25, 0, 3.0, -3.2, L + 2.6));
  group.add(box(wall, -3.4, W + 2.25, 0, 3.0, -3.3, -3.15));
  const rib = std(0x38444f, { roughness: 0.8, metalness: 0 });
  for (let k = 0; k < 6; k++) { group.add(box(rib, W + 2.0, W + 2.1, 0, 3.0, -2.8 + k * ((L + 4.8) / 5), -2.7 + k * ((L + 4.8) / 5), false)); }
  const cab = std(0x3a4651, { roughness: 0.55, metalness: 0.5 });
  group.add(box(cab, -0.45, W + 0.45, 0, base + H + 0.45, -2.15, -1.2));
  group.add(box(std(0xc23a30, { roughness: 0.5, metalness: 0.2 }), W / 2 - 0.1, W / 2 + 0.1, base + H + 0.45, base + H + 0.56, -1.75, -1.6, false));

}

/* Ventilation slots for a horizontal cover piece: a grid of rounded-rectangle holes (x across, z along the run).
   slots 0 = none, 1 = coarse pitch, 2 = full pitch (as the 3D cable bus model). Returns THREE.Path holes. */
function slotHoles(x0, x1, z0, z1, W, ts, slots) {
  const holes = [];
  if (!slots) return holes;
  const inner = W - 2 * ts, cols = Math.max(3, Math.floor(inner / 0.07));
  const cw = (inner - 0.04) / cols, sw = cw * 0.55, sl = 0.078, pitch = slots === 2 ? 0.118 : 0.236;
  for (let c = 0; c < cols; c++) {
    const xm = ts + 0.02 + cw * (c + 0.5), a = xm - sw / 2, b = xm + sw / 2;
    if (a < x0 + 0.01 || b > x1 - 0.01) continue;
    for (let z = z0 + 0.03; z + sl <= z1 - 0.03; z += pitch) {
      const p = new THREE.Path();
      p.moveTo(a, z); p.lineTo(a, z + sl); p.lineTo(b, z + sl); p.lineTo(b, z); p.lineTo(a, z);
      holes.push(p);
    }
  }
  return holes;
}

/* Horizontal plate x0..x1 by z0..z1, top face at yTop, thickness t, with optional holes. Built in shape space
   (shape y = world z) and rotated so the extrusion hangs below yTop. */
function horizPlate(mat, x0, x1, z0, z1, yTop, t, holes = []) {
  const s = new THREE.Shape();
  s.moveTo(x0, z0); s.lineTo(x1, z0); s.lineTo(x1, z1); s.lineTo(x0, z1); s.lineTo(x0, z0);
  for (const h of holes) s.holes.push(h);
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
  g.rotateX(Math.PI / 2); g.translate(0, yTop, 0);
  const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true;
  return m;
}

/* Side rail web at x. Medium/high: a plane sampled along the run so it can buckle (vertices move outward after the
   failure, see update()). Low: a plain box. */
function railWeb(mat, x, sign, layout, bulge) {
  const { base, H, ts, L } = layout;
  const zA = -0.1, zB = L + 0.1;
  if (!bulge) return box(mat, x - ts / 2, x + ts / 2, base, base + H, zA, zB);
  const g = new THREE.PlaneGeometry(zB - zA, H, 40, 1);
  g.rotateY(Math.PI / 2); g.translate(x, base + H / 2, (zA + zB) / 2);
  const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true;
  m.userData.rail = { base0: Float32Array.from(g.attributes.position.array), sign };
  return m;
}

/* Channel-profile side rail: web plus flanges turned outward at top and bottom (as the 3D cable bus model). */
function buildRail(group, layout, budget, x, sign, mat) {
  const { W, base, H, ts, L } = layout;
  const zA = -0.1, zB = L + 0.1;
  const g = new THREE.Group();
  const web = railWeb(mat, x, sign, layout, budget.bulge);
  g.add(web);
  const lx = sign < 0 ? [-0.026, x + ts / 2] : [x - ts / 2, W + 0.026];
  for (const y of [base, base + H - ts]) g.add(box(mat, lx[0], lx[1], y, y + ts, zA, zB));
  group.add(g);
  return { group: g, web };
}

/* End flange: the enclosure cross-section as a plate at one end of the run, with a hole for every cable. */
function endFlange(mat, layout, zStart) {
  const { W, base, H, od, cables } = layout;
  const depth = 0.008;
  const s = new THREE.Shape();
  s.moveTo(0, base); s.lineTo(W, base); s.lineTo(W, base + H); s.lineTo(0, base + H); s.lineTo(0, base);
  for (const c of cables) { const q = new THREE.Path(); q.absarc(c.x, c.y, od / 2 + 0.001, 0, Math.PI * 2, true); s.holes.push(q); }
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 16 });
  g.translate(0, 0, zStart);
  const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true;
  return m;
}

/* Enclosure on trestles: ventilated bottom cover, two channel side rails (the near one can be cut away or made
   transparent), top cover split into one panel per support span (the panel at a failure can lift off), and end
   flanges at the feed and shorting-bar ends. Returns the handles update() and setCover() use. */
function buildEnclosure(group, layout, budget) {
  const { W, H, L, base, ts, tc, panels } = layout;
  const ez0 = -0.1, ez1 = L + 0.1;
  // aluminium reads as a light metal with the scene's direct light only (no environment map in this viewer)
  const ALU = { roughness: 0.5, metalness: 0.3 };
  const alu = std(0xc3cad1, ALU);
  const railNearMat = std(0xc3cad1, { ...ALU, side: THREE.DoubleSide });
  const railFarMat = std(0xc3cad1, { ...ALU, side: THREE.DoubleSide });
  const coverMat = std(0xc3cad1, { ...ALU, side: THREE.DoubleSide });
  const slots = budget.slots;

  // bottom cover, ventilated across the inside width
  group.add(horizPlate(alu, ts, W - ts, ez0, ez1, base + tc, tc, slotHoles(ts, W - ts, ez0, ez1, W, ts, slots)));

  // side rails: near one at x = 0 (the camera side at the default orbit), far one at x = W
  const nearRail = buildRail(group, layout, budget, ts / 2, -1, railNearMat);
  const farRail = buildRail(group, layout, budget, W - ts / 2, 1, railFarMat);

  // top cover: one pivot group per span panel. The near strip (x < cut) is what the cut-away removes.
  const cut = ts + 0.35 * (W - 2 * ts);
  const coverPanels = panels.map((p) => {
    const c0 = new THREE.Vector3(W / 2, base + H - tc / 2, (p.z0 + p.z1) / 2);
    const near = horizPlate(coverMat, ts, cut, p.z0, p.z1, base + H, tc, slotHoles(ts, cut, p.z0, p.z1, W, ts, slots));
    const far = horizPlate(coverMat, cut, W - ts, p.z0, p.z1, base + H, tc, slotHoles(cut, W - ts, p.z0, p.z1, W, ts, slots));
    // pivot at the panel centre: rest pose puts the centre at c0, a lift-off moves and turns the pivot
    const inner = new THREE.Group(); inner.position.copy(c0).multiplyScalar(-1);
    inner.add(near, far);
    const pivot = new THREE.Group(); pivot.position.copy(c0); pivot.add(inner);
    group.add(pivot);
    return { pivot, near, far, c0 };
  });

  // end flanges at the feed and the shorting-bar ends
  group.add(endFlange(alu, layout, ez0 - 0.008));
  group.add(endFlange(alu, layout, ez1));

  // legs on trestles
  const leg = std(0x45525e, { roughness: 0.6, metalness: 0.6 });
  const zl = [panels[0].z0 + 0.25, panels[panels.length - 1].z1 - 0.25];
  for (const z of zl) for (const x of [0.05, W - 0.05]) group.add(box(leg, x - 0.04, x + 0.04, 0, base, z - 0.04, z + 0.04));
  for (const z of zl) group.add(box(leg, -0.05, W + 0.05, base - 0.06, base, z - 0.05, z + 0.05));

  const setCover = (mode) => {
    const tr = mode === "transparent", cutAway = mode === "cut";
    for (const m of [railNearMat, coverMat]) { m.transparent = tr; m.opacity = tr ? COVER_OPACITY : 1; m.depthWrite = !tr; m.needsUpdate = true; }
    nearRail.group.visible = !cutAway;
    for (const p of coverPanels) p.near.visible = !cutAway;
  };
  return { rails: [nearRail, farRail], coverPanels, setCover };
}

/* Support blocks, one material per block so each tints on its own. Returns [{ z, mat, meshes }]. Solid GPO-3 plates
   with a hole for every conductor and every tier. */
function buildBlocks(group, layout) {
  const { zs } = layout;
  const blocks = zs.map((z) => {
    const mat = std(GPO.clone(), { roughness: 0.7, metalness: 0.02, side: THREE.DoubleSide });
    const meshes = layout.plates.map((p) => { const m = plateMesh(mat, p, z); group.add(m); return m; });
    return { z, mat, meshes };
  });

  return blocks;
}

/** Deformable cables along z. Returns the cable handles used by update(). */
function buildConductors(group, layout, failedBlock) {
  const { L, od, zs } = layout;
  const rows = layout.cables;
  const zA = -0.35, zB = L + 0.35;
  const cableRad = od / 2;
  const cables = rows.map((r) => {
    const segs = Math.max(24, Math.round((zB - zA) / 0.05));
    const g = new THREE.CylinderGeometry(cableRad, cableRad, zB - zA, 18, segs, false);
    g.rotateX(Math.PI / 2); g.translate(r.x, r.y, (zA + zB) / 2);
    const posA = g.attributes.position, n = posA.count;
    const baseP = new Float32Array(posA.array), w0 = new Float32Array(n), w1 = failedBlock === null ? w0 : new Float32Array(n);
    for (let v = 0; v < n; v++) {
      const z = baseP[v * 3 + 2];
      w0[v] = shapeWeight(z, zs, null);
      if (failedBlock !== null) w1[v] = shapeWeight(z, zs, failedBlock);
    }
    const mat = std(PH_HEX[r.phase], { roughness: 0.42, metalness: 0.08, emissive: 0x000000 });
    const mesh = new THREE.Mesh(g, mat); mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    return { i: r.i, phase: r.phase, mesh, mat, baseP, w0, w1, col: new THREE.Color(PH_HEX[r.phase]), x: r.x, y: r.y };
  });

  return cables;
}

/** Busbar feed and shorting bar. Returns the bar extents for labels. */
function buildFeed(group, layout) {
  const { L, od } = layout;
  const rows = layout.cables;
  const cu = std(0xc9773a, { roughness: 0.3, metalness: 0.95 });
  for (const r of rows) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(od * 0.3, od * 0.3, 0.8, 14), std(PH_HEX[r.phase], { roughness: 0.4, metalness: 0.5 }));
    c.rotation.x = Math.PI / 2; c.position.set(r.x, r.y, -0.75); c.castShadow = true; group.add(c);
    group.add(box(cu, r.x - od * 0.4, r.x + od * 0.4, r.y - od * 0.4, r.y + od * 0.4, -0.38, -0.32));
  }
  const xmin = Math.min(...rows.map((r) => r.x)), xmax = Math.max(...rows.map((r) => r.x));
  const ymin = Math.min(...rows.map((r) => r.y)), ymax = Math.max(...rows.map((r) => r.y));
  group.add(box(cu, xmin - od * 0.7, xmax + od * 0.7, ymin - od * 0.6, ymax + od * 0.6, L + 0.35, L + 0.43));
  group.add(box(std(0x39434d, { roughness: 0.5, metalness: 0.6 }), xmin - od * 0.9, xmax + od * 0.9, ymin - od * 0.8, ymax + od * 0.8, L + 0.43, L + 0.5));

  return { xmin, xmax, ymin, ymax };
}

/** Build the bay and specimen into `group`. opts.cover: "cut" | "transparent" | "closed". Returns
    { update(state), setCover(mode), labels, box, center }. */
export function buildLab(group, viewer, layout, run, opts = {}) {
  const budget = budgetFor(opts.tier || "medium");
  const { W, H, L, base, od } = layout;
  const failedBlock = run.failure ? run.failure.block_index : null;
  buildBay(group, layout);
  const enc = buildEnclosure(group, layout, budget);
  enc.setCover(opts.cover || "cut");
  const blocks = buildBlocks(group, layout);
  const cables = buildConductors(group, layout, failedBlock);
  const { xmin, xmax, ymax } = buildFeed(group, layout);

  const labels = [
    ["Busbar feed", "3-phase source", new THREE.Vector3(W / 2, base + H + 0.65, -1.5)],
    ["Shorting bar", "bolted fault", new THREE.Vector3((xmin + xmax) / 2, ymax + od, L + 0.5)],
  ];
  for (const [a, b, pos] of labels) {
    const el = document.createElement("div"); el.className = "lab-lbl";
    const bb = document.createElement("b"); bb.textContent = a; const sp = document.createElement("span"); sp.textContent = b;
    el.appendChild(bb); el.appendChild(sp); viewer.addLabel(el, pos);
  }

  /* ---- effects ---- */
  const flashTex = radialTexture([[0, "rgba(255,255,255,1)"], [0.25, "rgba(255,255,255,0.85)"], [0.6, "rgba(255,255,255,0.25)"], [1, "rgba(255,255,255,0)"]]);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: 0xcfe0ff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
  flash.visible = false; flash.renderOrder = 10; group.add(flash);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: 0x6aa0ff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
  glow.visible = false; glow.renderOrder = 9; group.add(glow);
  let light = null;
  if (budget.light) { light = new THREE.PointLight(0xcfe0ff, 0, 7, 1.6); group.add(light); }
  let sparks = null, sparkPos = null, sparkCol = null;
  if (budget.sparks > 0) {
    sparkPos = new Float32Array(budget.sparks * 3); sparkCol = new Float32Array(budget.sparks * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3)); g.setAttribute("color", new THREE.BufferAttribute(sparkCol, 3));
    sparks = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.04, sizeAttenuation: true, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    sparks.frustumCulled = false; sparks.visible = false; group.add(sparks);
  }
  const smokes = [];
  if (budget.smoke > 0) {
    const tex = radialTexture([[0, "rgba(150,150,155,0.9)"], [0.5, "rgba(110,110,115,0.45)"], [1, "rgba(80,80,85,0)"]]);
    for (let k = 0; k < budget.smoke; k++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false; s.renderOrder = 8; group.add(s); smokes.push(s);
    }
  }
  let frags = [];
  const fragMat = std(GPO_HEX, { roughness: 0.7, metalness: 0.02, side: THREE.DoubleSide });
  const tmpC = new THREE.Color();
  let bulged = false;

  const update = (st) => {
    // conductors: deflection (exaggerated) and temperature tint
    const useFail = st.failed_block !== null;
    for (const c of cables) {
      const s = st.conductors.find((q) => q.i === c.i);
      const pa = c.mesh.geometry.attributes.position, arr = pa.array, w = useFail ? c.w1 : c.w0;
      const dx = s ? s.dx : 0, dy = s ? s.dy : 0;
      for (let v = 0, n = pa.count; v < n; v++) {
        arr[v * 3] = c.baseP[v * 3] + dx * w[v];
        arr[v * 3 + 1] = c.baseP[v * 3 + 1] + dy * w[v];
      }
      pa.needsUpdate = true;
      const f = s ? Math.min(1, s.temp_frac * 1.1) : 0;
      tmpC.setRGB(1, 0.5 + 0.5 * f, 0.15 + 0.7 * f * f);
      c.mat.color.copy(c.col).lerp(tmpC, Math.min(1, f * 1.4));
      c.mat.emissive.setRGB(0.9 * f, 0.25 * f, 0.03 * f);
    }
    // blocks: GPO-3 colour, tinted by utilisation (colour and a faint emissive glow), the broken one hidden.
    // The tint grows with utilisation so a lightly loaded block still reads as laminate, not green.
    blocks.forEach((b, k) => {
      const u = st.blocks[k];
      const [r, g, bl] = utilColor(u.util);
      const t = 0.1 + 0.45 * Math.min(1, Math.max(0, u.util));
      b.mat.color.copy(GPO).lerp(new THREE.Color(r / 255, g / 255, bl / 255), t);
      const glow = 0.12 * (t / 0.55); // 0.12 at full utilisation, as before
      b.mat.emissive.setRGB((r / 255) * glow, (g / 255) * glow, (bl / 255) * glow);
      for (const m of b.meshes) m.visible = !u.broken;
    });
    // side rails buckle outward around the failed station, then settle with a permanent set
    if (st.bulge) {
      const { zf, span, e } = st.bulge;
      for (const rail of enc.rails) {
        const web = rail.web; if (!web || !web.userData.rail) continue;
        const { base0, sign } = web.userData.rail;
        const pa = web.geometry.attributes.position;
        for (let v = 0, n = pa.count; v < n; v++) {
          pa.array[v * 3] = base0[v * 3] + sign * railBulge(base0[v * 3 + 2], zf, e, span);
        }
        pa.needsUpdate = true; web.geometry.computeVertexNormals();
      }
      bulged = true;
    } else if (bulged) {
      for (const rail of enc.rails) {
        const web = rail.web; if (!web || !web.userData.rail) continue;
        const pa = web.geometry.attributes.position;
        pa.array.set(web.userData.rail.base0); pa.needsUpdate = true; web.geometry.computeVertexNormals();
      }
      bulged = false;
    }
    // top cover panel at the failure lifts off as a rigid body; all other panels sit on the trestles
    enc.coverPanels.forEach((p, k) => {
      const on = !!st.cover && st.cover.popped && st.cover.panel === k && st.cover.pose;
      if (on) { p.pivot.position.set(...st.cover.pose.pos); p.pivot.rotation.set(...st.cover.pose.rot); }
      else { p.pivot.position.copy(p.c0); p.pivot.rotation.set(0, 0, 0); }
    });
    // fragments (built on first failure from the pose list; they tile the broken block's footprint)
    if (st.fragments.length && !frags.length) {
      frags = st.fragments.map((f) => { const m = new THREE.Mesh(new THREE.BoxGeometry(...f.size), fragMat); m.castShadow = true; group.add(m); return m; });
    }
    frags.forEach((m, k) => {
      const f = st.fragments[k];
      m.visible = !!f;
      if (f) { m.position.set(...f.pos); m.rotation.set(...f.rot); }
    });
    // flash, light, sparks, smoke
    const fl = st.flash, o = st.origin;
    const on = st.failed && fl.i > 0.003;
    flash.visible = glow.visible = on;
    if (on) {
      flash.position.set(...o); glow.position.set(...o);
      const sz = 0.25 + 1.9 * fl.i; flash.scale.set(sz, sz, 1); glow.scale.set(sz * 2.6, sz * 2.6, 1);
      flash.material.opacity = Math.min(1, fl.i * 1.3); glow.material.opacity = 0.5 * fl.i;
      flash.material.color.setRGB(0.8 + 0.2 * fl.mix, 0.88 - 0.38 * fl.mix, 1 - 0.85 * fl.mix);
      glow.material.color.setRGB(0.4 + 0.6 * fl.mix, 0.63 - 0.2 * fl.mix, 1 - 0.9 * fl.mix);
    }
    if (light) {
      light.intensity = st.failed ? 5 * fl.i : 0;
      if (st.failed) { light.position.set(o[0], o[1] + 0.1, o[2]); light.color.setRGB(0.8 + 0.2 * fl.mix, 0.88 - 0.38 * fl.mix, 1 - 0.85 * fl.mix); }
    }
    if (sparks) {
      sparks.visible = st.failed;
      if (st.failed) {
        fillSparks(sparkPos, sparkCol, budget.sparks, st.e, o);
        sparks.geometry.attributes.position.needsUpdate = true; sparks.geometry.attributes.color.needsUpdate = true;
      }
    }
    if (smokes.length) {
      const pf = st.failed ? smokePuffs(st.e, o, smokes.length) : null;
      smokes.forEach((s, k) => {
        const p = pf && pf[k];
        s.visible = !!p && p.opacity > 0.004;
        if (s.visible) { s.position.set(...p.pos); s.scale.set(p.size, p.size, 1); s.material.opacity = p.opacity; }
      });
    }
  };
  return {
    update, labels, setCover: enc.setCover,
    box: new THREE.Box3(new THREE.Vector3(-0.3, 0, -2.2), new THREE.Vector3(W + 0.3, base + H + 0.5, L + 0.6)),
    center: new THREE.Vector3(W / 2, base + H / 2, L / 2 - 0.3),
  };
}
