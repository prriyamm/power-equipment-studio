/* Procedural equipment models for the System 3D view, described as plain primitive records so the
   description is pure (no THREE, no DOM) and testable in node. system3d.jsx turns the records into one
   InstancedMesh per (geometry, material) pair, so draw calls stay flat as the package grows.

   World axes follow the site view: three.x = gx, three.y = height, three.z = gy; one unit ≈ 3 ft.
   Equipment fronts face +z. Primitive record:
     { g: "box" | "cyl" | "cyl28" | "sphere" | "torus" | "prism", m: material key,
       p: [x, y, z] centre, s: [sx, sy, sz] scale, dir?: unit vector the local +y axis maps to,
       rotY?: radians about +y, c?: base colour override (hex), paint?: true when an overlay recolours it,
       shade?: overlay brightness factor, id, kind: "eq" | "con" }
   Unit geometries are centred at the origin: box 1×1×1, cylinders radius 1 × height 1 along y,
   sphere radius 1, torus radius 1 about y, prism a unit gable (triangle in x-y, extruded along z). */
import { dims, siteRoutes, fullCon } from "./systemGeometry.js";
import { buildLineup } from "../engine/gear.js";

export const MAT_SPEC = {
  eq: { color: 0x6f7b87 }, door: { color: 0x56626e }, edge: { color: 0x2a333c }, tank: { color: 0x4f6f5a }, fin: { color: 0x5b7e66 },
  porcelain: { color: 0x8b5a3a, roughness: 0.3 }, brass: { color: 0xc9a24f, metalness: 0.7, roughness: 0.35 },
  motor: { color: 0x3f6894 }, bldg: { color: 0x77808a }, roof: { color: 0x6b4f3c },
  window: { color: 0x284a63, metalness: 0.1, roughness: 0.15, emissive: 0x0b2233 },
  gen: { color: 0xc9a248 }, tray: { color: 0xb4bec7, metalness: 0.55, roughness: 0.4 }, pole: { color: 0x6b5440 },
  phA: { color: 0xe05a4f }, phB: { color: 0xe8c35a }, phC: { color: 0x5aa0e0 },
  cover: { color: 0xb4bec7, metalness: 0.5, roughness: 0.45, transparent: true, opacity: 0.28 },
  duct: { color: 0x3b4a56, transparent: true, opacity: 0.55 }, concrete: { color: 0x5d6670, roughness: 0.9 },
  card: { color: 0xd9dde0, roughness: 0.5 }, trip: { color: 0x1e5a40, emissive: 0x0a2418 }, meter: { color: 0x0e151b, roughness: 0.2 },
  line: { color: 0x93a8b8, basic: true }, lampOn: { color: 0xff4040, basic: true }, lampOff: { color: 0x40d080, basic: true },
};
export const GEOMETRIES = ["box", "cyl", "cyl28", "sphere", "dot", "torus", "prism"];
// cable line colour by loading (kept from the original view: the cable itself always hints at its loading)
export const loadHex = (pct) => (pct == null ? 0x93a8b8 : pct > 100 ? 0xff5f5f : pct > 80 ? 0xff8b4a : 0x4cc38a);

const PAINT = { paint: true };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* Primitive emitter bound to one element. */
export function emitter(out, id, kind) {
  const add = (o) => { o.id = id; o.kind = kind; out.push(o); return o; };
  const api = {
    // corner-anchored box (like the original boxAt)
    box: (m, x, y, z, w, h, d, o) => add({ g: "box", m, p: [x + w / 2, y + h / 2, z + d / 2], s: [w, h, d], ...o }),
    boxC: (m, p, s, o) => add({ g: "box", m, p: [...p], s: [...s], ...o }),
    // vertical cylinder standing on (x, y, z)
    cylY: (m, x, y, z, r, h, o) => add({ g: "cyl", m, p: [x, y + h / 2, z], s: [r, h, r], ...o }),
    // cylinder between two points
    cyl: (m, a, b, r, o) => {
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(...d);
      if (len < 1e-6) return null;
      const dir = d.map((v) => v / len);
      return add({ g: "cyl", m, p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], s: [r, len, r], ...(Math.abs(dir[1] - 1) > 1e-9 ? { dir } : {}), ...o });
    },
    sphere: (m, x, y, z, r, o) => add({ g: "sphere", m, p: [x, y, z], s: [r, r, r], ...o }),
    dot: (m, x, y, z, r, o) => add({ g: "dot", m, p: [x, y, z], s: [r, r, r], ...o }),
    torus: (m, x, y, z, r, axis = [0, 1, 0], o) => add({ g: "torus", m, p: [x, y, z], s: [r, r, r], ...(axis[1] !== 1 ? { dir: axis } : {}), ...o }),
    prism: (m, p, s, rotY, o) => add({ g: "prism", m, p: [...p], s: [...s], ...(rotY ? { rotY } : {}), ...o }),
  };
  return api;
}

/* Split a gear footprint width into lineup sections. Section widths follow buildLineup's
   width_in proportionally (the site footprint itself stays dims(e).w so routes and anchors match). */
export function lineupLayout(lineup, w, fallbackSections = 1, per = 3) {
  let secs;
  if (lineup?.sections?.length) {
    secs = lineup.sections.map((s) => ({ width: s.width_in, main: !!s.main,
      cubicles: s.cubicles.map((c) => ({ pos: c.pos, size: c.size, kind: c.kind, tag: c.tag, open: !!c.open })) }));
    per = lineup.geometry?.perSection ?? per;
  } else {
    secs = Array.from({ length: Math.max(1, fallbackSections | 0) }, () => ({ width: 1, main: false,
      cubicles: Array.from({ length: per }, (_, p) => ({ pos: p, size: 1, kind: "feeder", tag: "", open: false })) }));
  }
  const tot = secs.reduce((a, s) => a + s.width, 0) || 1;
  let x = 0;
  return { per, sections: secs.map((s) => { const sw = (s.width / tot) * w; const o = { ...s, x0: x, w: sw }; x += sw; return o; }) };
}

/* ------------------------------------------------------------- equipment */
function switchgear(b, e, ctx) {
  const { w, d, h } = dims(e); const x = e.gx, z = e.gy, mv = e.kv > 1;
  const L = lineupLayout(ctx.lineup, w, e.sections, mv ? 2 : 3);
  b.box("edge", x - 0.02, 0, z - 0.02, w + 0.04, 0.08, d + 0.04);
  b.box("eq", x, 0.08, z, w, h - 0.08, d - 0.03, PAINT);
  b.box("eq", x - 0.03, h, z - 0.03, w + 0.06, 0.05, d + 0.06, { paint: true, shade: 0.85 });
  const top = h * (mv ? 0.2 : 0.17), fz = z + d - 0.03, cubTop = h - top, cubBot = 0.14, cubH = (cubTop - cubBot) / L.per;
  for (const s of L.sections) {
    const x0 = x + s.x0, sw = s.w;
    if (s.x0 > 1e-6) b.box("edge", x0 - 0.012, 0.08, fz, 0.024, h - 0.08, 0.035);
    b.box("door", x0 + 0.04, cubTop + 0.03, fz, sw - 0.08, top - 0.08, 0.03, { paint: true, shade: 0.8 });
    if (s.main) for (const f of [0.32, 0.68]) b.cyl("meter", [x0 + sw * f, cubTop + top / 2, fz + 0.03], [x0 + sw * f, cubTop + top / 2, fz + 0.07], Math.min(0.08, sw * 0.12));
    else b.box("card", x0 + sw * 0.3, cubTop + top * 0.45, fz + 0.03, sw * 0.4, top * 0.18, 0.01);
    if (mv) for (let k = 0; k < 3; k++) b.box("edge", x0 + sw * 0.2, cubTop + 0.1 + k * 0.07, fz + 0.03, sw * 0.6, 0.025, 0.012);
    for (const c of s.cubicles) {
      const y0 = cubTop - (c.pos + c.size) * cubH, ch = c.size * cubH;
      b.box("door", x0 + 0.04, y0 + 0.025, fz, sw - 0.08, ch - 0.05, 0.03, { paint: true, shade: 0.8 });
      if (c.kind === "spare") { b.box("edge", x0 + sw * 0.35, y0 + ch * 0.45, fz + 0.03, sw * 0.3, 0.04, 0.01); continue; }
      const bw = Math.min(sw * 0.6, 0.55), bh = Math.min(ch * 0.5, 0.45), bx = x0 + (sw - bw) / 2, by = y0 + ch * 0.28;
      b.box("edge", bx, by, fz + 0.03, bw, bh, 0.03);
      b.box("trip", bx + bw * 0.56, by + bh * 0.5, fz + 0.06, bw * 0.34, bh * 0.34, 0.012);
      b.box("brass", bx + bw * 0.1, by + bh * 0.16, fz + 0.06, bw * 0.32, 0.04, 0.03);
      b.dot(ctx.energized && !c.open ? "lampOn" : "lampOff", x0 + sw - 0.12, y0 + ch - 0.12, fz + 0.065, 0.03);
    }
  }
  return { top: [x + w / 2, h + 0.35, z + d / 2] };
}

function mcc(b, e, ctx) {
  const { w, d, h } = dims(e); const x = e.gx, z = e.gy, n = Math.max(1, e.sections | 0), sw = w / n, fz = z + d - 0.03;
  b.box("edge", x - 0.02, 0, z - 0.02, w + 0.04, 0.08, d + 0.04);
  b.box("eq", x, 0.08, z, w, h - 0.08, d - 0.03, PAINT);
  b.box("eq", x - 0.03, h, z - 0.03, w + 0.06, 0.05, d + 0.06, { paint: true, shade: 0.85 });
  const top = h - 0.34, bot = 0.4, rows = 6, rh = (top - bot) / rows;
  b.box("door", x + 0.03, top + 0.03, fz, w - 0.06, 0.26, 0.03, { paint: true, shade: 0.8 });
  b.box("door", x + 0.03, 0.12, fz, w - 0.06, bot - 0.16, 0.03, { paint: true, shade: 0.8 });
  for (let i = 0; i < n; i++) {
    const x0 = x + i * sw, bw = sw * 0.74;
    if (i) b.box("edge", x0 - 0.012, 0.08, fz, 0.024, h - 0.08, 0.035);
    b.box("door", x0 + bw + 0.02, bot, fz, sw - bw - 0.05, top - bot, 0.03, { paint: true, shade: 0.72 });
    for (let j = 0; j < rows; j++) {
      const y0 = bot + j * rh;
      b.box("door", x0 + 0.03, y0 + 0.015, fz, bw - 0.03, rh - 0.03, 0.03, { paint: true, shade: 0.8 });
      b.box("edge", x0 + bw * 0.12, y0 + rh * 0.35, fz + 0.03, bw * 0.18, rh * 0.3, 0.035);
      b.dot(ctx.energized ? "lampOn" : "lampOff", x0 + bw * 0.8, y0 + rh * 0.62, fz + 0.04, 0.022);
    }
  }
  return { top: [x + w / 2, h + 0.35, z + d / 2] };
}

function panel(b, e, ctx) {
  const { w, d, h } = dims(e); const x = e.gx, z = e.gy;
  // free-standing unistrut frame carrying a surface-mounted panelboard
  for (const xx of [x + 0.06, x + w - 0.12]) b.box("tray", xx, 0, z + 0.02, 0.06, h + 0.05, 0.06);
  b.box("tray", x + 0.02, 0, z, w - 0.04, 0.03, d);
  b.box("tray", x + 0.02, h - 0.02, z + 0.02, w - 0.04, 0.06, 0.06);
  b.box("tray", x + 0.02, 0.3, z + 0.02, w - 0.04, 0.06, 0.06);
  const px = x + 0.14, pw = w - 0.28, py = 0.42, ph = h - 0.62, pz = z + 0.08, pd = d - 0.2;
  b.box("eq", px, py, pz, pw, ph, pd, PAINT);
  b.box("door", px - 0.02, py - 0.02, pz + pd, pw + 0.04, ph + 0.04, 0.02, { paint: true, shade: 0.88 });
  b.box("door", px + 0.04, py + 0.05, pz + pd + 0.02, pw - 0.08, ph - 0.1, 0.015, { paint: true, shade: 0.78 });
  b.box("edge", px + 0.01, py + 0.1, pz + pd + 0.02, 0.02, ph - 0.2, 0.02);
  b.box("brass", px + pw - 0.1, py + ph * 0.48, pz + pd + 0.035, 0.035, 0.12, 0.03);
  b.box("card", px + 0.09, py + ph * 0.56, pz + pd + 0.036, pw * 0.38, ph * 0.26, 0.004);
  b.dot(ctx.energized ? "lampOn" : "lampOff", px + pw * 0.75, py + ph - 0.08, pz + pd + 0.04, 0.025);
  for (const f of [0.3, 0.5, 0.7]) b.cylY("tray", px + pw * f, py + ph, pz + pd * 0.5, 0.03, h + 0.25 - py - ph);
  return { top: [x + w / 2, h + 0.35, z + d / 2] };
}

function transformer(b, e) {
  const { w, d, h } = dims(e); const x = e.gx, z = e.gy, zc = z + d / 2;
  const base = 0.14, tx0 = x + 0.15, tx1 = x + w - 0.15, tz0 = z + 0.45, tz1 = z + d - 0.45;
  for (const zz of [tz0 + 0.04, tz1 - 0.14]) b.box("edge", x + 0.05, 0, zz, w - 0.1, base, 0.1);
  b.box("tank", tx0, base, tz0, tx1 - tx0, h - base - 0.06, tz1 - tz0, PAINT);
  b.box("tank", tx0 - 0.04, h - 0.06, tz0 - 0.04, tx1 - tx0 + 0.08, 0.06, tz1 - tz0 + 0.08, { paint: true, shade: 0.9 });
  // radiator banks on both long faces: headers, fins, and the pipe stubs into the tank
  const nFin = clamp(Math.round((e.kva ?? 2500) / 400) + 3, 5, 12), finH = (h - base) * 0.72, fy = base + (h - base) * 0.12;
  const fx0 = tx0 + 0.18, fx1 = tx1 - 0.18;
  const fans = /AF|FA|ONAF|OFAF/i.test(e.cooling || "");
  for (const side of [-1, 1]) {
    const zf = side < 0 ? tz0 - 0.42 : tz1 + 0.03, zd = 0.39, zm = zf + zd / 2, face = side < 0 ? tz0 : tz1;
    for (let i = 0; i < nFin; i++) {
      const xf = fx0 + (i * (fx1 - fx0 - 0.035)) / Math.max(1, nFin - 1);
      b.box("fin", xf, fy, zf, 0.035, finH, zd, { paint: true, shade: 1.08 });
    }
    for (const yy of [fy + 0.04, fy + finH - 0.04]) {
      b.cyl("fin", [fx0 - 0.04, yy, zm], [fx1 + 0.04, yy, zm], 0.035, { paint: true, shade: 0.95 });
      for (const xx of [fx0 + 0.05, fx1 - 0.05]) b.cyl("fin", [xx, yy, zm], [xx, yy, face], 0.03, { paint: true, shade: 0.95 });
    }
    if (fans) for (const f of [0.3, 0.7]) {
      const fxm = fx0 + (fx1 - fx0) * f;
      b.torus("edge", fxm, fy - 0.03, zm, 0.17);
      b.sphere("edge", fxm, fy - 0.03, zm, 0.04);
    }
  }
  // HV porcelain bushings (anchor: x + 0.4, top at h + 0.75), with sheds and brass caps
  for (const dz of [-0.28, 0, 0.28]) {
    b.cylY("porcelain", x + 0.4, h, zc + dz, 0.06, 0.72);
    for (let k = 1; k <= 4; k++) b.cylY("porcelain", x + 0.4, h + (k * 0.72) / 5, zc + dz, 0.105, 0.025);
    b.cylY("brass", x + 0.4, h + 0.72, zc + dz, 0.035, 0.05);
  }
  // LV bushings (anchor: x + w - 0.4, top at h + 0.4) with spade terminals, plus the X0 neutral
  for (const dz of [-0.28, 0, 0.28]) {
    b.cylY("porcelain", x + w - 0.4, h, zc + dz, 0.08, 0.26, { shade: 1 });
    b.cylY("porcelain", x + w - 0.4, h + 0.12, zc + dz, 0.12, 0.025);
    b.box("brass", x + w - 0.44, h + 0.26, zc + dz - 0.06, 0.08, 0.14, 0.12);
  }
  b.cylY("porcelain", x + w - 0.72, h, zc + 0.28, 0.05, 0.18);
  b.box("brass", x + w - 0.745, h + 0.18, zc + 0.24, 0.05, 0.08, 0.08);
  // accessories: nameplate, liquid-temperature gauge, drain valve, pressure relief, lifting lugs, tap changer
  b.box("card", tx1, base + 0.55, zc - 0.15, 0.012, 0.24, 0.3);
  b.cyl("meter", [tx1, h * 0.72, zc + 0.24], [tx1 + 0.05, h * 0.72, zc + 0.24], 0.07);
  b.cyl("brass", [tx0, base + 0.12, zc], [tx0 - 0.12, base + 0.12, zc], 0.03);
  b.cylY("edge", tx0 + 0.3, h, zc + 0.36, 0.045, 0.09);
  for (const [xx, zz] of [[tx0 + 0.02, tz0 - 0.06], [tx1 - 0.08, tz0 - 0.06], [tx0 + 0.02, tz1], [tx1 - 0.08, tz1]]) b.box("edge", xx, h - 0.16, zz, 0.06, 0.12, 0.06);
  b.box("edge", tx0 - 0.04, h * 0.55, zc - 0.32, 0.04, 0.14, 0.14);
  if ((e.kva ?? 0) >= 5000) {
    b.cyl("tank", [tx0 + 0.25, h + 0.6, tz0 + 0.1], [tx1 - 0.25, h + 0.6, tz0 + 0.1], 0.15, { paint: true });
    for (const xx of [tx0 + 0.35, tx1 - 0.35]) b.cylY("edge", xx, h, tz0 + 0.1, 0.025, 0.46);
  }
  return { top: [x + w / 2, h + 0.95, z + d / 2] };
}

function motor(b, e) {
  const { w, d } = dims(e); const x = e.gx, z = e.gy, zc = z + d / 2, r = d * 0.42, cy = r + 0.18;
  b.box("edge", x + 0.1, 0, z + 0.05, w - 0.2, 0.08, d - 0.1);
  for (const xx of [x + 0.38, x + w - 0.75]) b.box("motor", xx, 0.08, zc - r * 0.85, 0.24, cy - 0.08 - r * 0.6, r * 1.7, { paint: true, shade: 0.85 });
  b.cyl("motor", [x + 0.27, cy, zc], [x + w - 0.24, cy, zc], r, { g: "cyl28", paint: true });
  for (let i = 0; i < 5; i++) b.torus("motor", x + 0.45 + i * 0.22, cy, zc, r * 1.03, [1, 0, 0], { paint: true, shade: 0.9 });
  b.cyl("edge", [x + 0.05, cy, zc], [x + 0.27, cy, zc], r * 0.96, { g: "cyl28" });
  for (const k of [0.62, 0.32]) b.torus("tray", x + 0.045, cy, zc, r * k, [1, 0, 0]);
  b.cyl("motor", [x + w - 0.24, cy, zc], [x + w - 0.14, cy, zc], r * 0.78, { g: "cyl28", paint: true, shade: 0.85 });
  b.cyl("brass", [x + w - 0.14, cy, zc], [x + w + 0.12, cy, zc], 0.055);
  b.cyl("edge", [x + w + 0.02, cy, zc], [x + w + 0.12, cy, zc], 0.1);
  b.box("motor", x + 0.7, cy + r - 0.06, zc - 0.22, 0.45, 0.3, 0.44, { paint: true, shade: 0.9 });
  b.box("card", x + 1.2, cy - 0.1, zc + r * 0.93, 0.22, 0.12, 0.01);
  b.torus("edge", x + w / 2 + 0.1, cy + r + 0.06, zc, 0.06, [0, 0, 1]);
  b.cylY("tray", x + 1.24, 0.08, zc - 0.12, 0.035, cy + r - 0.08);
  b.cyl("tray", [x + 1.24, cy + r + 0.0, zc - 0.12], [x + 1.15, cy + r + 0.0, zc - 0.12], 0.035);
  return { top: [x + w / 2, 1.45, z + d / 2] };
}

function generator(b, e) {
  const { w, d, h } = dims(e); const x = e.gx, z = e.gy, zc = z + d / 2, fz = z + d - 0.05;
  // skid with belly fuel tank, sound-attenuated enclosure, radiator grille, exhaust and control panel
  b.box("edge", x, 0, z, w, 0.12, d);
  b.box("door", x + 0.1, 0.12, z + 0.08, w - 0.2, 0.26, d - 0.16, { paint: true, shade: 0.55 });
  b.box("gen", x + 0.04, 0.38, z + 0.05, w - 0.08, h - 0.38, d - 0.1, PAINT);
  b.box("gen", x, h, z + 0.02, w, 0.05, d - 0.04, { paint: true, shade: 0.85 });
  const nDoor = 3, dw = (w - 0.9) / nDoor;
  for (let i = 0; i < nDoor; i++) {
    const x0 = x + 0.55 + i * dw;
    b.box("gen", x0 + 0.03, 0.46, fz, dw - 0.06, h - 0.58, 0.02, { paint: true, shade: 0.9 });
    b.box("edge", x0 + dw - 0.14, 0.46 + (h - 0.58) * 0.5, fz + 0.02, 0.05, 0.12, 0.025);
    for (let k = 0; k < 3; k++) b.box("edge", x0 + 0.1, h - 0.36 + k * 0.07, fz + 0.02, dw - 0.2, 0.025, 0.012);
  }
  // radiator end: grille bars on the -x face
  for (let k = 0; k < 7; k++) b.box("edge", x + 0.02, 0.48 + k * ((h - 0.62) / 7), z + 0.15, 0.03, 0.04, d - 0.3);
  // discharge hood and exhaust: muffler on the roof, stack with rain cap
  b.cyl("tray", [x + w - 1.1, h + 0.2, zc], [x + w - 0.3, h + 0.2, zc], 0.15, { g: "cyl28" });
  for (const xx of [x + w - 1.0, x + w - 0.4]) b.box("edge", xx, h + 0.05, zc - 0.12, 0.05, 0.08, 0.24);
  b.cylY("tray", x + w - 0.3, h + 0.2, zc, 0.07, 0.62);
  b.cylY("edge", x + w - 0.3, h + 0.82, zc, 0.1, 0.03);
  // control panel and output breaker box on the +x end
  b.box("eq", x + w - 0.04, 0.7, zc - 0.3, 0.1, 0.5, 0.36, { paint: true, shade: 0.75 });
  b.box("meter", x + w + 0.06, 0.82, zc - 0.22, 0.01, 0.2, 0.2);
  b.box("eq", x + w - 0.04, 0.3, zc + 0.12, 0.12, 0.34, 0.28, { paint: true, shade: 0.75 });
  return { top: [x + w / 2, h + 0.5, z + d / 2] };
}

function load(b, e) {
  const { w, d, h } = dims(e); const x = e.gx, z = e.gy;
  b.box("bldg", x, 0, z, w, h, d, PAINT);
  b.prism("roof", [x + w / 2, h + 0.275, z + d / 2], [d, 0.55, w + 0.1], Math.PI / 2);
  b.box("door", x + w * 0.4, 0, z + d, w * 0.2, h * 0.7, 0.03);
  for (const f of [0.12, 0.72]) b.box("window", x + w * f, h * 0.45, z + d, w * 0.16, h * 0.3, 0.03);
  b.box("eq", x + w - 0.35, 0.6, z + d, 0.25, 0.4, 0.08, { paint: true, shade: 0.8 });
  return { top: [x + w / 2, h + 0.85, z + d / 2] };
}

function capacitor(b, e) {
  const { w, d, h } = dims(e); const x = e.gx, z = e.gy;
  b.box("edge", x - 0.02, 0, z - 0.02, w + 0.04, 0.08, d + 0.04);
  b.box("eq", x, 0.08, z, w, h - 0.08, d, PAINT);
  for (const f of [0.3, 0.6, 0.9]) { b.cylY("eq", x + f + 0.05, h, z + d / 2, 0.11, 0.35, { paint: true, shade: 0.9 }); b.cylY("brass", x + f + 0.05, h + 0.35, z + d / 2, 0.03, 0.06); }
  for (const v of [0.25, 0.4, 0.55, 0.7]) b.box("edge", x + w * 0.15, h * v, z + d, w * 0.7, 0.04, 0.02);
  b.box("card", x + w * 0.35, h * 0.8, z + d, w * 0.3, 0.12, 0.01);
  return { top: [x + w / 2, h + 0.6, z + d / 2] };
}

function utility(b, e) {
  const x = e.gx, z = e.gy, cx = x + 0.5, cz = z + 0.5, H = 4;
  for (const dz of [-0.45, 0.45]) b.cylY("pole", cx, 0, cz + dz, 0.07, H);
  b.box("pole", cx - 0.06, H - 0.36, cz - 0.75, 0.12, 0.12, 1.5);
  for (const dz of [-0.55, 0, 0.55]) {
    b.cylY("porcelain", cx, H - 0.25, cz + dz, 0.05, 0.3);
    for (const k of [1, 2]) b.cylY("porcelain", cx, H - 0.25 + k * 0.1, cz + dz, 0.085, 0.03);
    // overhead line: sampled quadratic Bezier into straight cylinder pieces
    const P0 = [cx, H + 0.05, cz + dz], P1 = [cx - 2.5, H + 0.1, cz + dz - 0.6], P2 = [cx - 5, H + 0.9, cz + dz - 1.2];
    const q = (t) => P0.map((v, j) => (1 - t) * (1 - t) * v + 2 * (1 - t) * t * P1[j] + t * t * P2[j]);
    for (let i = 0; i < 6; i++) b.cyl("tray", q(i / 6), q((i + 1) / 6), 0.012);
  }
  b.cylY("edge", cx, 0.5, cz - 0.45, 0.04, 2.6);
  return { top: [cx, 4.5, cz] };
}

function generic(b, e) {
  const { w, d, h } = dims(e);
  b.box("eq", e.gx, 0, e.gy, w, h, d, PAINT);
  return { top: [e.gx + w / 2, h + 0.3, e.gy + d / 2] };
}

export const BUILDERS = { switchgear, mcc, panel, transformer, motor, generator, load, capacitor, utility };

/* ------------------------------------------------------------ connectors */
export const V3 = (p) => [p[0], p[2], p[1]];

function cablebus(b, c, route) {
  const pts = route.pts.map(V3), W = 0.44, sets = Math.max(1, c.sets ?? 1);
  const nCond = Math.min(3 * sets, 12), phases = ["phA", "phB", "phC"];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], q = pts[i + 1];
    const dx = q[0] - a[0], dy = q[1] - a[1], dz = q[2] - a[2];
    const len = Math.hypot(dx, dy, dz); if (len < 1e-6) continue;
    const mid = [(a[0] + q[0]) / 2, (a[1] + q[1]) / 2, (a[2] + q[2]) / 2];
    if (Math.abs(dy) > 1e-6) { b.boxC("tray", mid, [0.42, len, 0.24], PAINT); continue; }
    const alongX = Math.abs(dx) > 1e-6;
    const S = (l, hgt, wd) => (alongX ? [l, hgt, wd] : [wd, hgt, l]);
    const off = (o, y) => (alongX ? [mid[0], y, mid[2] + o] : [mid[0] + o, y, mid[2]]);
    const y = a[1];
    b.boxC("tray", off(0, y - 0.2), S(len + W, 0.03, W), PAINT);
    for (const o of [-0.21, 0.21]) b.boxC("tray", off(o, y - 0.1), S(len + W, 0.2, 0.025), PAINT);
    b.boxC("cover", off(0, y), S(len + W, 0.02, W), PAINT);
    // ladder rungs
    const nr = Math.max(1, Math.floor(len / 0.6));
    for (let k = 0; k <= nr; k++) {
      const t = -len / 2 + (k * len) / nr;
      b.boxC("tray", alongX ? [mid[0] + t, y - 0.18, mid[2]] : [mid[0], y - 0.18, mid[2] + t], S(0.04, 0.025, W - 0.05), PAINT);
    }
    // conductors: sets × 3 phases laid A-B-C across the tray
    for (let k = 0; k < nCond; k++) {
      const o = -0.18 + (0.36 * (k + 0.5)) / nCond;
      const p0 = alongX ? [Math.min(a[0], q[0]) - W / 2 + 0.02, y - 0.13, mid[2] + o] : [mid[0] + o, y - 0.13, Math.min(a[2], q[2]) - W / 2 + 0.02];
      const p1 = alongX ? [Math.max(a[0], q[0]) + W / 2 - 0.02, y - 0.13, mid[2] + o] : [mid[0] + o, y - 0.13, Math.max(a[2], q[2]) + W / 2 - 0.02];
      b.cyl(phases[k % 3], p0, p1, Math.min(0.035, 0.16 / nCond + 0.008));
    }
    // supports for the overhead run: unistrut posts on footings, every ~3 units
    if (y > 0.6) {
      const ns = Math.max(1, Math.round(len / 3));
      for (let k = 0; k < ns; k++) {
        const t = -len / 2 + ((k + 0.5) * len) / ns;
        const px = alongX ? mid[0] + t : mid[0], pz = alongX ? mid[2] : mid[2];
        const pzz = alongX ? pz : mid[2] + t;
        b.box("tray", px - 0.03, 0.1, pzz - 0.03, 0.06, y - 0.32, 0.06);
        b.boxC("tray", [px, y - 0.235, pzz], S(0.06, 0.04, W + 0.12));
        b.box("concrete", px - 0.1, 0, pzz - 0.1, 0.2, 0.1, 0.2);
      }
    }
  }
}

function cable(b, c, route, res) {
  const g = route.pts.map(V3).map((p) => [p[0], 0.02, p[2]]);
  const dw = Math.min(0.18 + (c.sets ?? 1) * 0.05, 0.5), base = loadHex(res && !res.open ? res.loading_pct : null);
  for (let i = 0; i < g.length - 1; i++) {
    const a = g[i], q = g[i + 1], dx = q[0] - a[0], dz = q[2] - a[2], len = Math.hypot(dx, dz); if (len < 1e-6) continue;
    const mid = [(a[0] + q[0]) / 2, 0.02, (a[2] + q[2]) / 2];
    b.boxC("duct", mid, Math.abs(dx) > 1e-6 ? [len + dw, 0.04, dw] : [dw, 0.04, len + dw]);
    b.cyl("line", [a[0], 0.06, a[2]], [q[0], 0.06, q[2]], 0.03, { c: base, paint: true });
    if (i > 0) { b.box("concrete", a[0] - 0.2, 0, a[2] - 0.2, 0.4, 0.09, 0.4); b.dot("line", a[0], 0.06, a[2], 0.03, { c: base, paint: true }); }
  }
  for (const p of [g[0], g[g.length - 1]]) b.cylY("tray", p[0], 0, p[2], 0.045, 0.32);
}

/* Particle path for the animated power-flow markers (same rules as the original view). */
export function flowPath(c, route, r) {
  if (!r || r.open) return null;
  let pts = route.pts.map(V3).map((p) => (c.kind === "cablebus" ? [p[0], p[1] + 0.05, p[2]] : [p[0], 0.12, p[2]]));
  if (r.dir < 0) pts = pts.reverse();
  let total = 0; for (let i = 0; i < pts.length - 1; i++) total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]);
  if (total < 1e-6) return null;
  return { id: c.id, pts, total, n: Math.max(2, Math.round(total / 1.4)), speed: (0.25 + 0.9 * Math.min(1, (r.loading_pct ?? 30) / 100)) * (6 / Math.max(total, 1)), loading_pct: r.loading_pct };
}

/* Point at half the polyline length (label anchor for a connector). */
export function midpoint(pts) {
  let total = 0; const seg = [];
  for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(...pts[i + 1].map((v, j) => v - pts[i][j])); seg.push(l); total += l; }
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    if (acc + seg[i] >= total / 2) { const t = seg[i] ? (total / 2 - acc) / seg[i] : 0; return pts[i].map((v, j) => v + (pts[i + 1][j] - v) * t); }
    acc += seg[i];
  }
  return pts[0];
}

/**
 * Whole-site model.
 * @returns { prims, anchors: { eq: {id: [x,y,z]}, con: {id: [x,y,z]} }, flows: [flowPath], extent: {minX,maxX,minZ,maxZ} }
 */
export function buildSiteModel(sys, analysis) {
  const { eqMap, routes } = siteRoutes(sys);
  const ok = !!analysis?.ok, res = (ok && analysis.equipment) || {}, cres = (ok && analysis.connectors) || {};
  const prims = [], anchors = { eq: {}, con: {} }, flows = [];
  const ext = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const e of Object.values(eqMap)) {
    const b = emitter(prims, e.id, "eq");
    const ctx = { energized: ok && !res[e.id]?.deenergized, lineup: null };
    if (e.type === "switchgear") { try { ctx.lineup = buildLineup(sys, ok ? analysis : null, e.id); } catch (err) { ctx.lineup = null; } }
    const out = (BUILDERS[e.type] || generic)(b, e, ctx);
    anchors.eq[e.id] = out.top;
    const { w, d } = dims(e);
    ext.minX = Math.min(ext.minX, e.gx); ext.maxX = Math.max(ext.maxX, e.gx + w); ext.minZ = Math.min(ext.minZ, e.gy); ext.maxZ = Math.max(ext.maxZ, e.gy + d);
  }
  for (const c0 of sys.connectors) {
    const c = fullCon(c0), rt = routes[c.id];
    if (!rt || rt.direct) continue;
    const r = ok ? cres[c.id] : null;
    const b = emitter(prims, c.id, "con");
    if (c.kind === "cablebus") cablebus(b, c, rt); else cable(b, c, rt, r);
    const m = midpoint(rt.pts.map(V3));
    anchors.con[c.id] = [m[0], m[1] + (c.kind === "cablebus" ? 0.35 : 0.3), m[2]];
    const fp = flowPath(c, rt, r); if (fp) flows.push(fp);
  }
  return { prims, anchors, flows, extent: ext };
}

/* Draw-call estimate: one instanced batch per (geometry, material). */
export function batchKeys(prims) {
  const keys = new Set();
  for (const p of prims) keys.add(`${p.g}|${p.m}`);
  return keys;
}
