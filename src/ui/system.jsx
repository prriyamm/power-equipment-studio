/* System workspace: the package drawn as equipment on an isometric site plan.
   Utility → switchgear → transformer → cable bus → switchgear → MCC → motors,
   with live load-flow and short-circuit results on every piece. */
const { useState, useMemo, useEffect, useRef, useCallback } = React;
import {
  analyseSystem, EQUIPMENT, CONNECTORS, NODE_KINDS, EXAMPLE_SYSTEM, CONDUCTOR_SIZES, tableAmpacity, AMPACITY_STATUS, motorKw,
} from "../engine/system.js";
import { Btn, Pill, Section, Field, NumField, Tile, Icon, cx, fmt, clone } from "./common.jsx";
import { bus } from "./bus.js";
import { dims, siteRoutes } from "./systemGeometry.js";
import { Site3D } from "./system3d.jsx";
import { SystemSld } from "./systemSld.jsx";
import { GearLineupModal } from "./gearLineup.jsx";
import { designChecks } from "../engine/designchecks.js";
import { CoordinationView } from "./tccView.jsx";
import { useHistory, ProjectMenu } from "./systemProject.jsx";
import { ArcFlashSection } from "./systemArcFlash.jsx";
import { MotorStartSection, ProfileSection } from "./systemStudies.jsx";
import { ReportButton, svgToString } from "./reportButton.jsx";
import { planPush, applyPush, PUSH_MODULES, STUDY_LABELS } from "../engine/designPush.js";

/* System-side styles for design pushes coming back from the module workspaces. */
const CSS = `
.sys-push { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 8px 16px 0; }
.sys-push .sys-push-studies { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.sys-push .ml-auto { margin-left: auto; }
`;

/* ------------------------------------------------------------ projection */
const U = 34;                                  // px per grid unit (one unit ≈ 3 ft)
const C30 = Math.cos(Math.PI / 6), S30 = 0.5;
const iso = (x, y, z = 0) => [(x - y) * U * C30, (x + y) * U * S30 - z * U];
const P = (pts) => pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
const unIso = (sx, sy) => { const a = sx / (U * C30), b = sy / (U * S30); return [(a + b) / 2, (b - a) / 2]; };

/* --------------------------------------------------------- iso primitives */
function Box({ x, y, z = 0, w, d, h, tone = "eq", className, stroke = true }) {
  const x1 = x + w, y1 = y + d, z1 = z + h;
  const top = [iso(x, y, z1), iso(x1, y, z1), iso(x1, y1, z1), iso(x, y1, z1)];
  const left = [iso(x, y1, z), iso(x1, y1, z), iso(x1, y1, z1), iso(x, y1, z1)];
  const right = [iso(x1, y1, z), iso(x1, y, z), iso(x1, y, z1), iso(x1, y1, z1)];
  const sw = stroke ? 0.8 : 0;
  return (
    <g className={className}>
      <polygon points={P(left)} fill={`var(--${tone}-l)`} stroke="var(--eq-edge)" strokeWidth={sw} strokeLinejoin="round" />
      <polygon points={P(right)} fill={`var(--${tone}-r)`} stroke="var(--eq-edge)" strokeWidth={sw} strokeLinejoin="round" />
      <polygon points={P(top)} fill={`var(--${tone}-t)`} stroke="var(--eq-edge)" strokeWidth={sw} strokeLinejoin="round" />
    </g>
  );
}
// rectangles on the two visible vertical faces: left face is y = y1 (u along +x), right face is x = x1 (u along −y from the front corner)
const faceL = (b, u0, v0, u1, v1) => P([iso(b.x + u0, b.y1, v0), iso(b.x + u1, b.y1, v0), iso(b.x + u1, b.y1, v1), iso(b.x + u0, b.y1, v1)]);
const faceR = (b, u0, v0, u1, v1) => P([iso(b.x1, b.y1 - u0, v0), iso(b.x1, b.y1 - u1, v0), iso(b.x1, b.y1 - u1, v1), iso(b.x1, b.y1 - u0, v1)]);
const ptL = (b, u, v) => iso(b.x + u, b.y1, v);

function ellipseYZ(x, cy, cz, r, n = 28) { const pts = []; for (let i = 0; i < n; i++) { const t = (2 * Math.PI * i) / n; pts.push(iso(x, cy + r * Math.cos(t), cz + r * Math.sin(t))); } return pts; }
function ellipseXY(cx0, cy0, z, r, n = 24) { const pts = []; for (let i = 0; i < n; i++) { const t = (2 * Math.PI * i) / n; pts.push(iso(cx0 + r * Math.cos(t), cy0 + r * Math.sin(t), z)); } return pts; }
function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// vertical cylinder (bushing / stack / capacitor can)
function VCyl({ x, y, z, r, h, fill = "var(--porcelain)", sheds = 0 }) {
  const bottom = ellipseXY(x, y, z, r), topE = ellipseXY(x, y, z + h, r);
  const body = hull([...bottom, ...topE]);
  return (
    <g>
      <polygon points={P(body)} fill={fill} stroke="var(--eq-edge)" strokeWidth="0.6" />
      {Array.from({ length: sheds }, (_, i) => <polygon key={i} points={P(ellipseXY(x, y, z + ((i + 1) * h) / (sheds + 1), r * 1.45))} fill={fill} stroke="var(--eq-edge)" strokeWidth="0.5" />)}
      <polygon points={P(topE)} fill="var(--eq-t)" stroke="var(--eq-edge)" strokeWidth="0.6" />
    </g>
  );
}

/* ---------------------------------------------------------- equipment art */
function SwitchgearArt({ e, x, y, res, energized }) {
  const { w, d, h } = dims(e); const mv = e.kv > 1;
  const b = { x, y, x1: x + w, y1: y + d };
  const sw = w / e.sections;
  const lamp = energized ? "var(--crit)" : "var(--ok)";
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={h} />
      {/* top vent strip */}
      <polygon points={P([iso(x + 0.1, y + 0.2, h), iso(x + w - 0.1, y + 0.2, h), iso(x + w - 0.1, y + 0.5, h), iso(x + 0.1, y + 0.5, h)])} fill="var(--eq-l)" opacity="0.6" />
      {Array.from({ length: e.sections }, (_, i) => {
        const u0 = i * sw + 0.06, u1 = (i + 1) * sw - 0.06;
        const comps = mv ? [[h * 0.55, h - 0.12, "relay"], [0.12, h * 0.52, "brk"]] : [[h * 0.68, h - 0.1, "brk"], [h * 0.36, h * 0.65, "brk"], [0.1, h * 0.33, i === 0 ? "brk" : "aux"]];
        return (
          <g key={i}>
            {comps.map(([v0, v1, kind], j) => (
              <g key={j}>
                <polygon points={faceL(b, u0, v0, u1, v1)} fill="var(--door)" stroke="var(--eq-edge)" strokeWidth="0.7" />
                {kind === "brk" && <>
                  <polygon points={faceL(b, u0 + sw * 0.28, v0 + (v1 - v0) * 0.3, u1 - sw * 0.28, v0 + (v1 - v0) * 0.62)} fill="var(--eq-l)" stroke="var(--eq-edge)" strokeWidth="0.5" />
                  <circle cx={ptL(b, u1 - 0.12, v0 + (v1 - v0) * 0.5)[0]} cy={ptL(b, u1 - 0.12, v0 + (v1 - v0) * 0.5)[1]} r="1.6" fill={lamp} />
                </>}
                {kind === "relay" && [0.25, 0.5, 0.75].map((f) => { const p = ptL(b, u0 + (u1 - u0) * f, v0 + (v1 - v0) * 0.62); return <rect key={f} x={p[0] - 2.5} y={p[1] - 3.5} width="5" height="5" fill="var(--eq-l)" stroke="var(--info)" strokeWidth="0.5" />; })}
              </g>
            ))}
          </g>
        );
      })}
      {/* side panel louvers */}
      {[0.3, 0.42, 0.54].map((v) => <polygon key={v} points={faceR(b, d * 0.25, h * v, d * 0.75, h * v + 0.05)} fill="var(--eq-edge)" opacity="0.7" />)}
    </g>
  );
}

function MccArt({ e, x, y }) {
  const { w, d, h } = dims(e); const b = { x, y, x1: x + w, y1: y + d }; const sw = w / e.sections;
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={h} />
      {Array.from({ length: e.sections }, (_, i) => Array.from({ length: 6 }, (_, j) => {
        const u0 = i * sw + 0.05, u1 = (i + 1) * sw - 0.22, v0 = 0.12 + j * ((h - 0.3) / 6), v1 = v0 + (h - 0.3) / 6 - 0.04;
        const p = ptL(b, u1 - 0.08, (v0 + v1) / 2);
        return <g key={i + "-" + j}><polygon points={faceL(b, u0, v0, u1, v1)} fill="var(--door)" stroke="var(--eq-edge)" strokeWidth="0.5" /><circle cx={p[0]} cy={p[1]} r="1.1" fill="var(--eq-edge)" /></g>;
      }))}
      {Array.from({ length: e.sections }, (_, i) => <polygon key={"w" + i} points={faceL(b, (i + 1) * sw - 0.2, 0.1, (i + 1) * sw - 0.04, h - 0.1)} fill="var(--eq-l)" stroke="var(--eq-edge)" strokeWidth="0.5" />)}
    </g>
  );
}

function TransformerArt({ e, x, y, res }) {
  const { w, d, h } = dims(e);
  const fins = 7, fy0 = y + 0.25, fstep = (d - 0.5) / (fins - 1);
  const hot = res && res.loading_pct > 100;
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={h} tone="tank" />
      {/* cooling radiators on the right face and back of the left face */}
      {Array.from({ length: fins }, (_, i) => <Box key={"r" + i} x={x + w} y={fy0 + i * fstep} z={0.25} w={0.42} d={0.05} h={h - 0.55} tone="fin" stroke={false} />)}
      {Array.from({ length: fins }, (_, i) => <Box key={"l" + i} x={x + 0.25 + i * ((w - 0.5) / (fins - 1))} y={y + d} z={0.25} w={0.05} d={0.36} h={h - 0.55} tone="fin" stroke={false} />)}
      {/* HV bushings (porcelain, sheds) and LV bushings on the lid */}
      {[0.3, 0.75, 1.2].map((f) => <VCyl key={"hv" + f} x={x + 0.4} y={y + f + 0.15} z={h} r={0.09} h={0.75} sheds={3} />)}
      {[0.35, 0.8, 1.25].map((f) => <VCyl key={"lv" + f} x={x + w - 0.4} y={y + f + 0.1} z={h} r={0.11} h={0.38} fill="var(--brass)" />)}
      {/* nameplate */}
      <polygon points={faceL({ x, y, x1: x + w, y1: y + d }, 0.35, h * 0.45, 0.9, h * 0.72)} fill="var(--door)" stroke="var(--eq-edge)" strokeWidth="0.5" />
      {hot && <polygon points={P([iso(x, y, h), iso(x + w, y, h), iso(x + w, y + d, h), iso(x, y + d, h)])} fill="var(--crit)" opacity="0.25" />}
    </g>
  );
}

function MotorArt({ e, x, y, res }) {
  const { w, d } = dims(e);
  const r = d * 0.42, cy = y + d / 2, cz = r + 0.18;
  const back = ellipseYZ(x + 0.25, cy, cz, r), front = ellipseYZ(x + w - 0.2, cy, cz, r);
  const body = hull([...back, ...front]);
  const ribs = [0.45, 0.65, 0.85, 1.05, 1.25, 1.45].map((u) => ellipseYZ(x + u, cy, cz, r * 1.04, 20).slice(5, 15));
  const shaft = ellipseYZ(x + w + 0.05, cy, cz, 0.06, 12);
  return (
    <g>
      <Box x={x + 0.15} y={y + 0.05} w={w - 0.3} d={d - 0.1} h={0.16} tone="eq" />
      <polygon points={P(hull([...ellipseYZ(x, cy, cz, r * 0.96), ...ellipseYZ(x + 0.3, cy, cz, r * 0.96)]))} fill="var(--motor-l)" stroke="var(--eq-edge)" strokeWidth="0.6" />
      <polygon points={P(body)} fill="var(--motor-r)" stroke="var(--eq-edge)" strokeWidth="0.7" />
      {ribs.map((pts, i) => <polyline key={i} points={P(pts)} fill="none" stroke="var(--motor-l)" strokeWidth="1" />)}
      <polygon points={P(front)} fill="var(--motor-t)" stroke="var(--eq-edge)" strokeWidth="0.7" />
      <polygon points={P(hull([...shaft, ...ellipseYZ(x + w - 0.2, cy, cz, 0.06, 12)]))} fill="var(--brass)" />
      <Box x={x + 0.7} y={cy - 0.22} z={cz + r - 0.05} w={0.45} d={0.44} h={0.3} tone="motor" />
    </g>
  );
}

function LoadArt({ e, x, y }) {
  const { w, d, h } = dims(e);
  const ridge = h + 0.55;
  const roofL = [iso(x, y + d, h), iso(x + w, y + d, h), iso(x + w, y + d / 2, ridge), iso(x, y + d / 2, ridge)];
  const roofR = [iso(x + w, y + d, h), iso(x + w, y, h), iso(x + w, y + d / 2, ridge)];
  const b = { x, y, x1: x + w, y1: y + d };
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={h} tone="bldg" />
      <polygon points={P(roofR)} fill="var(--bldg-r)" stroke="var(--eq-edge)" strokeWidth="0.8" />
      <polygon points={P(roofL)} fill="var(--roof)" stroke="var(--eq-edge)" strokeWidth="0.8" />
      <polygon points={faceL(b, w * 0.38, 0, w * 0.62, h * 0.7)} fill="var(--door)" stroke="var(--eq-edge)" strokeWidth="0.6" />
      {[0.12, 0.72].map((f) => <polygon key={f} points={faceL(b, w * f, h * 0.45, w * (f + 0.16), h * 0.75)} fill="var(--window)" stroke="var(--eq-edge)" strokeWidth="0.5" />)}
      {[0.25, 0.6].map((f) => <polygon key={"r" + f} points={faceR(b, d * f, h * 0.45, d * (f + 0.18), h * 0.75)} fill="var(--window)" stroke="var(--eq-edge)" strokeWidth="0.5" />)}
    </g>
  );
}

function CapacitorArt({ e, x, y }) {
  const { w, d, h } = dims(e); const b = { x, y, x1: x + w, y1: y + d };
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={h} />
      {[0.2, 0.32, 0.44, 0.56, 0.68, 0.8].map((v) => <polygon key={v} points={faceL(b, w * 0.15, h * v, w * 0.85, h * v + 0.04)} fill="var(--eq-edge)" opacity="0.8" />)}
      {[0.3, 0.6, 0.9].map((f) => <VCyl key={f} x={x + f * 1.0 + 0.05} y={y + d / 2} z={h} r={0.12} h={0.35} fill="var(--eq-r)" />)}
    </g>
  );
}

function GeneratorArt({ e, x, y }) {
  const { w, d, h } = dims(e); const b = { x, y, x1: x + w, y1: y + d };
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={h} tone="gen" />
      {[0.1, 0.3, 0.5, 0.7].map((f) => <polygon key={f} points={faceL(b, w * f + 0.05, h * 0.2, w * f + 0.4, h * 0.8)} fill="var(--gen-r)" stroke="var(--eq-edge)" strokeWidth="0.5" />)}
      <VCyl x={x + w - 0.5} y={y + d / 2} z={h} r={0.1} h={0.8} fill="var(--eq-edge)" />
    </g>
  );
}

function UtilityArt({ e, x, y }) {
  const cx0 = x + 0.5, cy0 = y + 0.5, H = 4.0;
  const pole = (dy) => [iso(cx0, cy0 + dy, 0), iso(cx0, cy0 + dy, H)];
  const arm = [iso(cx0, cy0 - 0.7, H - 0.3), iso(cx0, cy0 + 0.7, H - 0.3)];
  const ins = [-0.55, 0, 0.55];
  return (
    <g>
      {[-0.45, 0.45].map((dy) => { const [a, b2] = pole(dy); return <line key={dy} x1={a[0]} y1={a[1]} x2={b2[0]} y2={b2[1]} stroke="var(--pole)" strokeWidth="4" strokeLinecap="round" />; })}
      <line x1={arm[0][0]} y1={arm[0][1]} x2={arm[1][0]} y2={arm[1][1]} stroke="var(--pole)" strokeWidth="3.5" strokeLinecap="round" />
      {ins.map((dy) => <VCyl key={dy} x={cx0} y={cy0 + dy} z={H - 0.25} r={0.06} h={0.3} sheds={2} />)}
      {/* incoming overhead lines from off-site */}
      {ins.map((dy) => { const a = iso(cx0, cy0 + dy, H + 0.05), b2 = iso(cx0 - 4.5, cy0 + dy - 1.2, H + 0.9); return <path key={"l" + dy} d={`M${a[0]},${a[1]} Q${(a[0] + b2[0]) / 2},${(a[1] + b2[1]) / 2 + 10} ${b2[0]},${b2[1]}`} stroke="var(--wire)" strokeWidth="1" fill="none" opacity="0.7" />; })}
      {/* riser down the pole */}
      <line x1={iso(cx0 + 0.15, cy0, 0)[0]} y1={iso(cx0 + 0.15, cy0, 0)[1]} x2={iso(cx0 + 0.15, cy0, H - 0.4)[0]} y2={iso(cx0 + 0.15, cy0, H - 0.4)[1]} stroke="var(--eq-edge)" strokeWidth="2.5" />
    </g>
  );
}

const ART = { switchgear: SwitchgearArt, mcc: MccArt, panel: MccArt, transformer: TransformerArt, motor: MotorArt, load: LoadArt, capacitor: CapacitorArt, generator: GeneratorArt, utility: UtilityArt };

/* ---------------------------------------------------------- connector art */
function CableBusArt({ route, res, selected, animate }) {
  if (res?.open) { animate = false; }
  const W = 0.42, H = 0.2;
  const segs = [];
  for (let i = 0; i < route.pts.length - 1; i++) {
    const [a, b] = [route.pts[i], route.pts[i + 1]];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) {
      // vertical riser
      if (Math.abs(a[2] - b[2]) < 1e-6) continue;
      segs.push(<Box key={i} x={a[0] - W / 2} y={a[1] - 0.12} z={Math.min(a[2], b[2])} w={W} d={0.24} h={Math.abs(a[2] - b[2])} tone="tray" />);
    } else if (Math.abs(a[1] - b[1]) < 1e-9) {
      const x0 = Math.min(a[0], b[0]) - W / 2, x1 = Math.max(a[0], b[0]) + W / 2;
      segs.push(<Box key={i} x={x0} y={a[1] - W / 2} z={a[2] - H} w={x1 - x0} d={W} h={H} tone="tray" />);
    } else {
      const y0 = Math.min(a[1], b[1]) - W / 2, y1 = Math.max(a[1], b[1]) + W / 2;
      segs.push(<Box key={i} x={a[0] - W / 2} y={y0} z={a[2] - H} w={W} d={y1 - y0} h={H} tone="tray" />);
    }
  }
  const color = loadColor(res?.loading_pct);
  // phase conductors visible through the ventilated top
  const phase = ["var(--ph-a)", "var(--ph-b)", "var(--ph-c)"];
  const path = route.pts.slice(1, -1);
  const offsetLine = (off) => {
    const pts = path.map((p, i) => {
      const n = path[i + 1] || p, pr = path[i - 1] || p;
      const dx = (n[0] - pr[0]), dy = (n[1] - pr[1]);
      const horiz = Math.abs(dx) > Math.abs(dy);
      return iso(p[0] + (horiz ? 0 : off), p[1] + (horiz ? off : 0), p[2] + 0.01);
    });
    return pts;
  };
  const flowPts = route.pts.map((p) => iso(p[0], p[1], p[2] + 0.02));
  const ordered = res && res.dir < 0 ? [...flowPts].reverse() : flowPts;
  return (
    <g>
      {selected && <polyline points={P(route.pts.map((p) => iso(...p)))} fill="none" stroke="var(--accent)" strokeWidth="14" opacity="0.25" strokeLinejoin="round" />}
      {segs}
      {[-0.11, 0, 0.11].map((off, i) => <polyline key={i} points={P(offsetLine(off))} fill="none" stroke={phase[i]} strokeWidth="1.3" opacity="0.85" />)}
      {animate && res && <polyline points={P(ordered)} className="flow" stroke={color} style={{ animationDuration: flowSpeed(res.loading_pct) }} />}
    </g>
  );
}

function CableArt({ route, res, selected, animate, sets = 1 }) {
  const open = !!res?.open;
  const color = open ? "var(--faint)" : loadColor(res?.loading_pct);
  const ground = route.pts.map((p) => [p[0], p[1], 0]);
  const W = Math.min(0.18 + sets * 0.05, 0.5);
  const segs = [];
  for (let i = 0; i < ground.length - 1; i++) {
    const [a, b] = [ground[i], ground[i + 1]];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) continue;
    const horiz = Math.abs(a[1] - b[1]) < 1e-9;
    const pts = horiz
      ? [iso(Math.min(a[0], b[0]) - W / 2, a[1] - W / 2), iso(Math.max(a[0], b[0]) + W / 2, a[1] - W / 2), iso(Math.max(a[0], b[0]) + W / 2, a[1] + W / 2), iso(Math.min(a[0], b[0]) - W / 2, a[1] + W / 2)]
      : [iso(a[0] - W / 2, Math.min(a[1], b[1]) - W / 2), iso(a[0] + W / 2, Math.min(a[1], b[1]) - W / 2), iso(a[0] + W / 2, Math.max(a[1], b[1]) + W / 2), iso(a[0] - W / 2, Math.max(a[1], b[1]) + W / 2)];
    segs.push(<polygon key={i} points={P(pts)} fill="var(--duct)" stroke="var(--duct-edge)" strokeWidth="0.8" strokeDasharray="3 2" />);
  }
  const flow = ground.map((p) => iso(...p));
  const ordered = res && res.dir < 0 ? [...flow].reverse() : flow;
  return (
    <g>
      {selected && <polyline points={P(flow)} fill="none" stroke="var(--accent)" strokeWidth="12" opacity="0.28" strokeLinejoin="round" />}
      {segs}
      <polyline points={P(flow)} fill="none" stroke={color} strokeWidth="1.6" opacity="0.9" strokeLinejoin="round" strokeDasharray={open ? "5 4" : undefined} />
      {animate && res && !open && <polyline points={P(ordered)} className="flow" stroke="var(--fg)" style={{ animationDuration: flowSpeed(res.loading_pct) }} />}
    </g>
  );
}

const loadColor = (pct) => (pct == null ? "var(--wire)" : pct > 100 ? "var(--crit)" : pct > 80 ? "var(--high)" : "var(--ok)");
const flowSpeed = (pct) => `${Math.max(0.45, 2.4 - 1.8 * Math.min(1, (pct ?? 30) / 100))}s`;

/* ---------------------------------------------------------- depth sorting */
function depthOrder(items) {
  // a must be drawn after b when a lies wholly in front of b along x or y
  const n = items.length, after = items.map(() => []);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    const a = items[i], b = items[j];
    const inFront = (a.x0 >= b.x1 - 1e-6 && a.y1 > b.y0) || (a.y0 >= b.y1 - 1e-6 && a.x1 > b.x0);
    if (inFront) after[i].push(j);
  }
  const seen = new Array(n).fill(0), out = [];
  const visit = (i) => { if (seen[i]) return; seen[i] = 1; for (const j of after[i]) visit(j); out.push(items[i]); };
  items.map((it, i) => [it.x0 + it.y0, i]).sort((p, q) => p[0] - q[0]).forEach(([, i]) => visit(i));
  return out;
}

/* ------------------------------------------------------------- tag cards */
function statusOf(e, r) {
  if (!r) return "muted";
  if (r.deenergized) return "off";
  const bad = (r.loading_pct ?? 0) > 100 || (r.sc_duty_pct ?? 0) > 100;
  const warn = r.vflag !== "ok" || (r.loading_pct ?? 0) > 80 || (r.sc_duty_pct ?? 0) > 90;
  return bad ? "crit" : warn ? "warn" : "ok";
}
function tagLines(e, r) {
  if (!r) return [e.name || e.id];
  if (r.deenergized) return [e.name || e.id, "De-energized"];
  const v = `${r.v_pu.toFixed(3)} pu`;
  switch (e.type) {
    case "switchgear": case "mcc": case "panel":
      return [e.name || e.id, `${fmtKv(e.kv)} · ${v}`, `${fmt(r.bus_i_a, 0)} A  ${fmt(r.loading_pct, 0)}% of ${e.bus_a} A`, `Ik ${fmt(r.ik_ka, 1)} / ${e.sc_ka} kA`];
    case "transformer": return [e.name || e.id, `${fmt(r.s_kva, 0)} kVA · ${fmt(r.loading_pct, 0)}%`, `LV ${r.v_lv_pu?.toFixed(3)} pu · ${fmt(r.loss_kw, 1)} kW loss`];
    case "utility": return [e.name || e.id, `${fmt(r.p_kw, 0)} kW · ${fmt(r.q_kvar, 0)} kvar`, `Ik ${fmt(r.ik_ka, 1)} kA`];
    case "motor": return [e.name || e.id, `${fmt(r.i_a, 0)} A · ${v}`];
    case "load": return [e.name || e.id, `${fmt(r.p_kw, 0)} kW · ${v}`];
    case "capacitor": return [e.name || e.id, `${fmt(r.q_kvar, 0)} kvar · ${v}`];
    case "generator": return [e.name || e.id, `${fmt(r.p_kw, 0)} kW · ${fmt(r.loading_pct, 0)}%`];
    default: return [e.name || e.id];
  }
}
const fmtKv = (kv) => (kv < 1 ? `${Math.round(kv * 1000)} V` : `${kv} kV`);

function Tag({ x, y, lines, tone, selected }) {
  const w = Math.max(92, ...lines.map((l, i) => l.length * (i ? 5.6 : 6.4))) + 14, h = 8 + lines.length * 12.5;
  return (
    <g transform={`translate(${x - w / 2},${y - h - 10})`} className="tag" pointerEvents="none">
      <line x1={w / 2} y1={h} x2={w / 2} y2={h + 10} stroke="var(--faint)" strokeWidth="0.8" />
      <rect width={w} height={h} rx="4" fill="var(--tag-bg)" stroke={selected ? "var(--accent)" : "var(--line)"} strokeWidth={selected ? 1.4 : 0.8} />
      <rect width="3" height={h} rx="1.5" fill={tone === "crit" ? "var(--crit)" : tone === "warn" ? "var(--high)" : tone === "ok" ? "var(--ok)" : "var(--faint)"} opacity={tone === "off" ? 0.6 : 1} />
      {lines.map((l, i) => <text key={i} x="9" y={14 + i * 12.5} className={i ? "tag-sub" : "tag-title"}>{l}</text>)}
    </g>
  );
}

/* ================================================================ SITE VIEW */
function SiteView({ sys, analysis, selection, setSelection, tool, onMove, onMoveEnd, onConnect, showTags, animate, fitSignal }) {
  const wrapRef = useRef(null), svgRef = useRef(null);
  const [size, setSize] = useState({ w: 1000, h: 640 });
  const [view, setView] = useState({ x: -600, y: -100, w: 1400 });
  const drag = useRef(null);
  const [pending, setPending] = useState(null);
  useEffect(() => { const el = wrapRef.current; const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 1000, h: el.clientHeight || 640 })); ro.observe(el); return () => ro.disconnect(); }, []);
  useEffect(() => { if (tool !== "connect") setPending(null); }, [tool]);
  const vh = view.w * (size.h / size.w);
  const eqMap = useMemo(() => Object.fromEntries(sys.equipment.map((e) => [e.id, { ...EQUIPMENT[e.type].defaults, ...e }])), [sys.equipment]);

  const { slots, routes } = useMemo(() => siteRoutes(sys), [sys.equipment, sys.connectors]); // eslint-disable-line
  const fit = useCallback(() => {
    const pts = [];
    for (const e of Object.values(eqMap)) { const { w, d, h } = dims(e); [[e.gx, e.gy, 0], [e.gx + w, e.gy, 0], [e.gx, e.gy + d, 0], [e.gx + w, e.gy + d, 0], [e.gx, e.gy, h + 1.5]].forEach((p) => pts.push(iso(...p))); }
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs) - 90, x1 = Math.max(...xs) + 90, y0 = Math.min(...ys) - 110, y1 = Math.max(...ys) + 50;
    const asp = size.h / size.w; let w = x1 - x0; if ((y1 - y0) / w > asp) w = (y1 - y0) / asp;
    setView({ x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - (w * asp) / 2, w });
  }, [eqMap, size]);
  useEffect(() => { fit(); }, [fitSignal, Math.round(size.w / 60), Math.round(size.h / 60)]); // eslint-disable-line

  const toSvg = (ev) => { const svg = svgRef.current, pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; const p = pt.matrixTransform(svg.getScreenCTM().inverse()); return [p.x, p.y]; };
  useEffect(() => {
    const svg = svgRef.current;
    const onWheel = (ev) => { ev.preventDefault(); const [wx, wy] = toSvg(ev); const f = Math.exp(ev.deltaY * 0.0015); setView((v) => { const w = Math.min(5000, Math.max(300, v.w * f)), r = w / v.w; return { x: wx - (wx - v.x) * r, y: wy - (wy - v.y) * r, w }; }); };
    svg.addEventListener("wheel", onWheel, { passive: false }); return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const onEqDown = (ev, id) => {
    ev.stopPropagation();
    if (tool === "connect") { if (!pending) setPending(id); else if (pending !== id) { onConnect(pending, id); setPending(null); } return; }
    setSelection({ kind: "eq", id });
    const [sx, sy] = toSvg(ev); const e = eqMap[id];
    drag.current = { mode: "eq", id, start: unIso(sx, sy), ox: e.gx, oy: e.gy, moved: false };
    svgRef.current.setPointerCapture(ev.pointerId);
  };
  const onBgDown = (ev) => { drag.current = { mode: "pan", sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y, moved: false }; svgRef.current.setPointerCapture(ev.pointerId); };
  const onMoveEv = (ev) => {
    const d = drag.current; if (!d) return;
    if (d.mode === "eq") {
      const [sx, sy] = toSvg(ev); const [gx, gy] = unIso(sx, sy);
      const nx = Math.round((d.ox + gx - d.start[0]) * 2) / 2, ny = Math.round((d.oy + gy - d.start[1]) * 2) / 2;
      if (Math.abs(gx - d.start[0]) + Math.abs(gy - d.start[1]) > 0.2) d.moved = true;
      if (d.moved) onMove(d.id, nx, ny);
    } else {
      const s = view.w / size.w; if (Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) > 3) d.moved = true;
      setView((v) => ({ ...v, x: d.ox - (ev.clientX - d.sx) * s, y: d.oy - (ev.clientY - d.sy) * s }));
    }
  };
  const onUp = () => { const d = drag.current; drag.current = null; if (d?.mode === "eq") onMoveEnd?.(); if (d?.mode === "pan" && !d.moved) setSelection(null); };

  const items = Object.values(eqMap).map((e) => { const { w, d } = dims(e); return { e, x0: e.gx, y0: e.gy, x1: e.gx + w, y1: e.gy + d }; });
  const ordered = depthOrder(items);
  const res = analysis?.equipment || {}, cres = analysis?.connectors || {};
  const ok = analysis?.ok;
  // ground grid extents
  const xs = items.flatMap((i) => [i.x0, i.x1]), ys = items.flatMap((i) => [i.y0, i.y1]);
  const gx0 = Math.floor(Math.min(0, ...xs)) - 3, gx1 = Math.ceil(Math.max(10, ...xs)) + 3, gy0 = Math.floor(Math.min(0, ...ys)) - 3, gy1 = Math.ceil(Math.max(8, ...ys)) + 3;
  const grid = [];
  for (let gx = gx0; gx <= gx1; gx++) grid.push(<line key={"x" + gx} x1={iso(gx, gy0)[0]} y1={iso(gx, gy0)[1]} x2={iso(gx, gy1)[0]} y2={iso(gx, gy1)[1]} className={gx % 5 ? "g-minor" : "g-major"} />);
  for (let gy = gy0; gy <= gy1; gy++) grid.push(<line key={"y" + gy} x1={iso(gx0, gy)[0]} y1={iso(gx0, gy)[1]} x2={iso(gx1, gy)[0]} y2={iso(gx1, gy)[1]} className={gy % 5 ? "g-minor" : "g-major"} />);
  const pad = [iso(gx0, gy0), iso(gx1, gy0), iso(gx1, gy1), iso(gx0, gy1)];
  const conSel = (id) => selection?.kind === "con" && selection.id === id;
  const ground = sys.connectors.filter((c) => c.kind !== "cablebus" && routes[c.id] && !routes[c.id].direct);
  const overhead = sys.connectors.filter((c) => c.kind === "cablebus" && routes[c.id]);
  const zoomBy = (f) => setView((v) => { const w = Math.min(5000, Math.max(300, v.w * f)); return { x: v.x + v.w / 2 - w / 2, y: v.y + (v.w * size.h / size.w) / 2 - (w * size.h / size.w) / 2, w }; });

  return (
    <div ref={wrapRef} className={cx("canvas-wrap site", `tool-${tool}`)}>
      <svg ref={svgRef} className="canvas" viewBox={`${view.x} ${view.y} ${view.w} ${vh}`} onPointerDown={onBgDown} onPointerMove={onMoveEv} onPointerUp={onUp} onPointerCancel={onUp} role="img" aria-label="Isometric site view of the electrical package">
        <polygon points={P(pad)} className="site-pad" />
        {grid}
        {/* underground duct banks first, equipment occludes them */}
        {ground.map((c) => (
          <g key={c.id} className="con" onPointerDown={(ev) => { ev.stopPropagation(); if (tool === "select") setSelection({ kind: "con", id: c.id }); }}>
            <polyline points={P(routes[c.id].pts.map((p) => iso(p[0], p[1], 0)))} className="con-hit" />
            <CableArt route={routes[c.id]} res={ok && cres[c.id]} selected={conSel(c.id)} animate={animate} sets={c.sets ?? 1} />
          </g>
        ))}
        {ordered.map(({ e }) => {
          const A = ART[e.type]; const r = ok ? res[e.id] : null;
          const sel = selection?.kind === "eq" && selection.id === e.id;
          const { w, d } = dims(e);
          const shadow = [iso(e.gx + 0.15, e.gy + 0.25), iso(e.gx + w + 0.35, e.gy + 0.25), iso(e.gx + w + 0.35, e.gy + d + 0.35), iso(e.gx + 0.15, e.gy + d + 0.35)];
          return (
            <g key={e.id} className={cx("eq", sel && "is-sel", pending === e.id && "is-pending")} onPointerDown={(ev) => onEqDown(ev, e.id)}>
              <polygon points={P(shadow)} className="eq-shadow" />
              {sel && <polygon points={P([iso(e.gx - 0.15, e.gy - 0.15), iso(e.gx + w + 0.15, e.gy - 0.15), iso(e.gx + w + 0.15, e.gy + d + 0.15), iso(e.gx - 0.15, e.gy + d + 0.15)])} className="sel-ring" />}
              <g opacity={r?.deenergized ? 0.5 : 1}>{A ? <A e={e} x={e.gx} y={e.gy} res={r} energized={!!r && !r.deenergized} /> : <Box x={e.gx} y={e.gy} w={w} d={d} h={1} />}</g>
            </g>
          );
        })}
        {overhead.map((c) => (
          <g key={c.id} className="con" onPointerDown={(ev) => { ev.stopPropagation(); if (tool === "select") setSelection({ kind: "con", id: c.id }); }}>
            <CableBusArt route={routes[c.id]} res={ok && cres[c.id]} selected={conSel(c.id)} animate={animate} />
          </g>
        ))}
        {/* connector labels */}
        {showTags && ok && sys.connectors.map((c) => {
          const rt = routes[c.id], r = cres[c.id]; if (!rt || !r || rt.direct) return null;
          const openLbl = r.open;
          const pts = rt.pts; let best = 0, bi = 0;
          for (let i = 0; i < pts.length - 1; i++) { const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); if (L > best) { best = L; bi = i; } }
          const m = pts[bi], n = pts[bi + 1];
          const p = iso((m[0] + n[0]) / 2, (m[1] + n[1]) / 2, rt.overhead ? m[2] + 0.1 : 0);
          return (
            <g key={"l" + c.id} transform={`translate(${p[0]},${p[1]})`} pointerEvents="none">
              <text className="con-label" textAnchor="middle" y="-6">{c.id}</text>
              {openLbl ? <text className="con-label sub" textAnchor="middle" y="6" fill="var(--ok)">OPEN</text>
                : <text className="con-label sub" textAnchor="middle" y="6" fill={loadColor(r.loading_pct)}>{fmt(r.i_a, 0)} A · {r.loading_pct == null ? "—" : fmt(r.loading_pct, 0) + "%"}</text>}
            </g>
          );
        })}
        {showTags && ordered.map(({ e }) => {
          const { w, d, h } = dims(e); const r = ok ? res[e.id] : null;
          const p = iso(e.gx + w / 2, e.gy + d / 2, h + (e.type === "transformer" ? 0.8 : 0.15));
          return <Tag key={"t" + e.id} x={p[0]} y={p[1]} lines={tagLines(e, r)} tone={statusOf(e, r)} selected={selection?.kind === "eq" && selection.id === e.id} />;
        })}
      </svg>
      <div className="canvas-hud left">
        {tool === "connect" && <span>{pending ? `From ${pending}. Click the equipment to connect to.` : "Click the source equipment."} <kbd>Esc</kbd> to stop.</span>}
        {tool === "select" && <span className="hidden sm:inline">Drag equipment to move it on the pad. Drag the ground to pan, scroll to zoom.</span>}
      </div>
      <div className="canvas-hud right">
        <button className="hud-btn" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom in">+</button>
        <button className="hud-btn" onClick={() => zoomBy(1.25)} aria-label="Zoom out">−</button>
        <button className="hud-btn" onClick={fit} aria-label="Fit to view"><Icon name="fit" size={14} /></button>
      </div>
      <div className="legend">
        <span><i style={{ background: "var(--ok)" }} />≤ 80 %</span>
        <span><i style={{ background: "var(--high)" }} />80–100 %</span>
        <span><i style={{ background: "var(--crit)" }} />&gt; 100 %</span>
        <span><i className="lg-tray" />cable bus (overhead)</span>
        <span><i className="lg-duct" />cable in duct bank</span>
      </div>
    </div>
  );
}

/* ============================================================== INSPECTOR */
const EQ_FIELDS = {
  utility: [["kv", "Voltage", "kV"], ["mva_sc", "Short-circuit", "MVA"], ["xr", "X/R", ""], ["v_pu", "Voltage setpoint", "pu"]],
  generator: [["kv", "Voltage", "kV"], ["kva", "Rating", "kVA"], ["p_kw", "Output", "kW"], ["v_pu", "V setpoint", "pu"], ["xd2", "X″d", "pu"], ["xr", "X/R", ""]],
  transformer: [["kva", "Rating", "kVA"], ["hv_kv", "HV", "kV"], ["lv_kv", "LV", "kV"], ["z_pct", "Impedance", "%Z"], ["xr", "X/R", ""], ["tap_pct", "Tap", "%"]],
  switchgear: [["kv", "Voltage", "kV"], ["bus_a", "Bus rating", "A"], ["sc_ka", "SC rating", "kA"], ["sections", "Sections", ""]],
  mcc: [["kv", "Voltage", "kV"], ["bus_a", "Bus rating", "A"], ["sc_ka", "SC rating", "kA"], ["sections", "Sections", ""]],
  panel: [["kv", "Voltage", "kV"], ["bus_a", "Bus rating", "A"], ["sc_ka", "SC rating", "kA"]],
  motor: [["hp", "Rating", "hp"], ["eff", "Efficiency", ""], ["pf", "Power factor", ""], ["load_factor", "Load factor", ""], ["lrc", "Locked rotor", "× FLA"], ["xr", "X/R", ""]],
  load: [["kw", "Demand", "kW"], ["pf", "Power factor", ""]],
  capacitor: [["kvar", "Rating", "kvar"]],
};

function DesignCheckBlock({ dc, stale }) {
  if (!dc) return null;
  const title = { cablebus: "Cable bus design check", bus: "Bus design check", transformer: "Transformer design check" }[dc.kind];
  return (
    <div className="res-block" style={stale ? { opacity: 0.55 } : undefined}>
      <div className="flex items-center justify-between mb-2"><div className="label">{title}</div>{stale ? <Pill tone="warn" title="The model changed; the check is re-running">Stale</Pill> : <Pill tone={dc.passed ? "ok" : "crit"}>{dc.passed ? "Pass" : "Fail"}</Pill>}</div>
      {dc.error ? <p className="text-crit text-[12.5px]">{dc.error}</p> : <>
        <p className="text-muted text-[12.5px] mb-2">{dc.summary}</p>
        <ul className="flex flex-col gap-1 text-[12.5px]">{dc.checks.map((k, i) => (
          <li key={i} className="flex justify-between gap-2"><span className={k.passed ? "" : "text-crit"}>{k.passed ? "✓" : "✗"} {k.name}</span><span className="font-mono text-muted whitespace-nowrap">{k.value} / {k.limit} {k.unit}</span></li>
        ))}</ul>
      </>}
    </div>
  );
}

function EqInspector({ e, r, update, remove, rename, scShown, openLineup, dc, dcStale, goModule }) {
  const full = { ...EQUIPMENT[e.type].defaults, ...e };
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [e.id]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><div className="label">{EQUIPMENT[e.type].label}</div><div className="text-xl font-mono truncate">{e.id}</div></div>
        <Pill tone={statusOf(e, r) === "crit" ? "crit" : statusOf(e, r) === "warn" ? "warn" : statusOf(e, r) === "off" ? "muted" : r ? "ok" : "muted"}>{r ? (r.deenergized ? "De-energized" : statusOf(e, r) === "crit" ? "Overloaded" : statusOf(e, r) === "warn" ? "Check" : "OK") : "No result"}</Pill>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Tag"><input id="eq-id" className="num-input" defaultValue={e.id} key={e.id} onBlur={(ev) => rename(e.id, ev.target.value.trim())} onKeyDown={(ev) => ev.key === "Enter" && ev.currentTarget.blur()} /></Field>
        <Field label="Name"><input id="eq-name" className="num-input" value={e.name ?? ""} onChange={(ev) => update(e.id, { name: ev.target.value })} /></Field>
        {EQ_FIELDS[e.type].map(([k, l, u]) => (
          <Field key={k} label={l} unit={u}><NumField id={`eq-${k}`} value={e[k]} placeholder={String(full[k])} onCommit={(v) => update(e.id, { [k]: v })} /></Field>
        ))}
        {e.type === "utility" && <Field label="SC level basis" hint="IEC: S″kQ includes c (IEC 60909). ANSI: plain E/Z bolted value."><select id="eq-scbasis" className="num-input" value={full.sc_basis} onChange={(ev) => update(e.id, { sc_basis: ev.target.value })}><option value="IEC">IEC (S″kQ)</option><option value="ANSI">ANSI (E/Z)</option></select></Field>}
        {e.type === "motor" && <Field label="Fault contribution"><select id="eq-contrib" className="num-input" value={full.contributes ? "yes" : "no"} onChange={(ev) => update(e.id, { contributes: ev.target.value === "yes" })}><option value="yes">Included</option><option value="no">Excluded</option></select></Field>}
      </div>
      {r?.deenergized && <div className="notice notice-info">No supply reaches {e.id}. Close the feeder breaker or tie upstream to energize it.</div>}
      {r && !r.deenergized && (
        <div className="res-block">
          <div className="label mb-2">Load flow{scShown && " · short circuit"}</div>
          <dl className="kv">
            <dt>Voltage</dt><dd style={{ color: r.vflag === "ok" ? "var(--ok)" : r.vflag === "low" ? "var(--low)" : "var(--high)" }}>{r.v_pu.toFixed(4)} pu · {fmtKv(r.v_kv)}</dd>
            <dt>Angle</dt><dd>{r.angle.toFixed(2)}°</dd>
            {r.bus_i_a != null && <><dt>Bus current</dt><dd>{fmt(r.bus_i_a, 0)} A ({fmt(r.loading_pct, 1)} %)</dd></>}
            {r.s_kva != null && <><dt>Through</dt><dd>{fmt(r.s_kva, 0)} kVA ({fmt(r.loading_pct, 1)} %)</dd></>}
            {r.i_hv_a != null && <><dt>HV / LV current</dt><dd>{fmt(r.i_hv_a, 1)} / {fmt(r.i_lv_a, 0)} A</dd></>}
            {r.loss_kw != null && <><dt>Losses</dt><dd>{fmt(r.loss_kw, 2)} kW</dd></>}
            {r.p_kw != null && <><dt>P</dt><dd>{fmt(r.p_kw, 1)} kW</dd></>}
            {r.q_kvar != null && <><dt>Q</dt><dd>{fmt(r.q_kvar, 1)} kvar</dd></>}
            {r.i_a != null && <><dt>Current</dt><dd>{fmt(r.i_a, 1)} A</dd></>}
            {r.ik_ka != null && <><dt>I″k (3φ)</dt><dd className={r.sc_duty_pct > 100 ? "text-crit" : ""}>{fmt(r.ik_ka, 2)} kA{r.sc_duty_pct != null && ` · ${fmt(r.sc_duty_pct, 0)} % of ${full.sc_ka} kA`}</dd></>}
            {r.ip_ka != null && <><dt>Peak ip</dt><dd>{fmt(r.ip_ka, 2)} kA · X/R {fmt(r.xr_fault, 1)}</dd></>}
            {r.lv_ik_ka != null && <><dt>LV terminal I″k</dt><dd>{fmt(r.lv_ik_ka, 2)} kA</dd></>}
            {r.contribution_ka != null && <><dt>Motor contribution</dt><dd>{fmt(r.contribution_ka, 2)} kA</dd></>}
          </dl>
        </div>
      )}
      <DesignCheckBlock dc={dc} stale={dcStale} />
      {NODE_KINDS.has(e.type) && openLineup && <Btn kind="primary-soft" onClick={() => openLineup(e.id)}>Lineup elevation & breaker schedule</Btn>}
      {goModule && NODE_KINDS.has(e.type) && <Btn kind="primary-soft" onClick={() => goModule("switchgear", e)} title="Open this bus in the Switchgear workspace, linked for Apply to System">Design bus in Switchgear</Btn>}
      {goModule && e.type === "transformer" && <Btn kind="primary-soft" onClick={() => goModule("transformer", e)} title="Open this transformer in the Transformer workspace, linked for Apply to System">Design in Transformer</Btn>}
      <div className="flex gap-2">
        {!confirm ? <Btn kind="danger" onClick={() => setConfirm(true)}><Icon name="trash" size={14} />Delete</Btn>
          : <><Btn kind="danger-solid" onClick={() => remove(e.id)}>Delete {e.id} and its connections</Btn><Btn onClick={() => setConfirm(false)}>Cancel</Btn></>}
      </div>
    </div>
  );
}

function ConInspector({ c, r, update, remove, kvAt, goCableBus, goFeeder, dc, dcStale }) {
  const full = { ...CONNECTORS[c.kind].defaults, ...c };
  const table = c.kind === "direct" ? null : tableAmpacity(c.kind, full.size, full.material, full.insulation_c);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><div className="label">{CONNECTORS[c.kind].label}</div><div className="text-xl font-mono truncate">{c.id}</div><div className="text-muted text-[12.5px] font-mono">{c.from} → {c.to}{kvAt ? ` · ${fmtKv(kvAt)}` : ""}</div></div>
        {r && (r.open ? <Pill tone="ok">Breaker open</Pill> : <Pill tone={r.loading_pct > 100 ? "crit" : r.loading_pct > 80 ? "warn" : "ok"}>{r.loading_pct == null ? "No rating" : `${fmt(r.loading_pct, 0)} %`}</Pill>)}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Feeder breaker"><select id="con-closed" className="num-input" value={full.closed === false ? "open" : "closed"} onChange={(ev) => update(c.id, { closed: ev.target.value === "closed" })}><option value="closed">Closed</option><option value="open">Open</option></select></Field>
        <Field label="Kind"><select id="con-kind" className="num-input" value={c.kind} onChange={(ev) => update(c.id, { kind: ev.target.value })}>{Object.entries(CONNECTORS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        {c.kind !== "direct" && <>
          <Field label="Size" unit="AWG/kcmil"><select id="con-size" className="num-input" value={full.size} onChange={(ev) => update(c.id, { size: ev.target.value })}>{CONDUCTOR_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
          <Field label="Material"><select id="con-mat" className="num-input" value={full.material} onChange={(ev) => update(c.id, { material: ev.target.value })}><option value="Cu">Copper</option><option value="Al">Aluminum</option></select></Field>
          <Field label="Sets per phase"><NumField id="con-sets" value={c.sets} placeholder={String(full.sets)} onCommit={(v) => update(c.id, { sets: v })} /></Field>
          <Field label="Length" unit="ft"><NumField id="con-len" value={c.length_ft} placeholder={String(full.length_ft)} onCommit={(v) => update(c.id, { length_ft: v })} /></Field>
          <Field label="Conductor temp" unit="°C"><select id="con-temp" className="num-input" value={full.insulation_c} onChange={(ev) => update(c.id, { insulation_c: Number(ev.target.value) })}>{[60, 75, 90].map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
          {c.kind === "cable" && <Field label="Raceway"><select id="con-race" className="num-input" value={full.raceway} onChange={(ev) => update(c.id, { raceway: ev.target.value })}><option value="steel">Steel conduit</option><option value="aluminum">Aluminum conduit</option><option value="pvc">PVC conduit</option></select></Field>}
          <Field label="Ampacity / set" unit="A" hint={`Table ${c.kind === "cablebus" ? "310.17" : "310.16"}: ${table ?? "—"} A (${AMPACITY_STATUS})`}><NumField id="con-amp" value={c.ampacity_a} placeholder={table != null ? String(table) : "—"} onCommit={(v) => update(c.id, { ampacity_a: v })} /></Field>
        </>}
      </div>
      {r && !r.open && (
        <div className="res-block">
          <div className="label mb-2">Load flow</div>
          <dl className="kv">
            <dt>Current</dt><dd>{fmt(r.i_a, 1)} A</dd>
            <dt>Ampacity</dt><dd>{r.ampacity_a == null ? "—" : `${fmt(r.ampacity_a, 0)} A`}</dd>
            <dt>Power</dt><dd>{fmt(Math.abs(r.p_kw), 1)} kW, {fmt(r.q_kvar, 1)} kvar</dd>
            <dt>Voltage drop</dt><dd className={Math.abs(r.vd_pct) > 3 ? "text-warn" : ""}>{fmt(r.vd_pct, 2)} %</dd>
            <dt>Losses</dt><dd>{fmt(r.loss_kw, 2)} kW</dd>
            {r.ohms && <><dt>R + jX</dt><dd>{(r.ohms.r * 1000).toFixed(2)} + j{(r.ohms.x * 1000).toFixed(2)} mΩ</dd></>}
          </dl>
        </div>
      )}
      <DesignCheckBlock dc={dc} stale={dcStale} />
      <div className="flex gap-2 flex-wrap">
        {c.kind === "cablebus" && goCableBus && <Btn kind="primary-soft" onClick={() => goCableBus(c)}>Design in Cable bus</Btn>}
        {c.kind === "cable" && goFeeder && <Btn kind="primary-soft" onClick={() => goFeeder(c)} title="Open this run in the Feeder workspace, linked for Apply to System">Design in Feeder</Btn>}
        <Btn kind="danger" onClick={() => remove(c.id)}><Icon name="trash" size={14} />Delete</Btn>
      </div>
    </div>
  );
}

function SystemSummary({ sys, analysis, checks = {} }) {
  const t = analysis?.totals;
  const errs = analysis?.issues?.filter((x) => x.level === "error") || [];
  const flagged = analysis?.ok ? Object.entries(analysis.equipment).filter(([id, r]) => !["ok", "off"].includes(statusOf(sys.equipment.find((e) => e.id === id), r))) : [];
  const off = analysis?.ok ? Object.entries(analysis.equipment).filter(([, r]) => r.deenergized).map(([id]) => id) : [];
  const conFlag = analysis?.ok ? Object.entries(analysis.connectors).filter(([, r]) => (r.loading_pct ?? 0) > 80) : [];
  return (
    <div className="flex flex-col gap-4">
      <div><div className="label">Package</div><div className="text-lg">{sys.name}</div></div>
      {errs.length > 0 && <div className="notice notice-crit">{errs.length} error{errs.length > 1 && "s"}: {errs[0].msg}</div>}
      {t && (
        <dl className="kv">
          <dt>Equipment</dt><dd>{sys.equipment.length} pieces, {sys.connectors.length} runs</dd>
          <dt>Demand</dt><dd>{fmt(t.load_kw, 0)} kW</dd>
          <dt>Losses</dt><dd>{fmt(t.loss_kw, 1)} kW ({fmt((100 * t.loss_kw) / Math.max(t.load_kw, 1e-9), 2)} %)</dd>
          <dt>Voltage range</dt><dd>{t.min_v.toFixed(3)}–{t.max_v.toFixed(3)} pu</dd>
          <dt>Highest I″k</dt><dd>{fmt(t.max_ik_ka, 1)} kA</dd>
        </dl>
      )}
      <div>
        <div className="label mb-2">Attention</div>
        {flagged.length + conFlag.length === 0 ? <p className="text-muted text-[13px]">No overloads, voltage or short-circuit duty issues.</p> : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {flagged.map(([id, r]) => <li key={id}><b className="font-mono">{id}</b> <span className="text-muted">{r.sc_duty_pct > 90 ? `fault duty ${fmt(r.sc_duty_pct, 0)} %` : r.vflag !== "ok" ? `voltage ${r.v_pu.toFixed(3)} pu` : `loading ${fmt(r.loading_pct, 0)} %`}</span></li>)}
            {conFlag.map(([id, r]) => <li key={id}><b className="font-mono">{id}</b> <span className="text-muted">loading {fmt(r.loading_pct, 0)} %</span></li>)}
          </ul>
        )}
      </div>
      {Object.values(checks).length > 0 && (() => { const bad = Object.entries(checks).filter(([, d]) => !d.passed); return (
        <div><div className="label mb-2">Equipment design checks</div>
          {bad.length === 0 ? <p className="text-muted text-[13px]">{Object.keys(checks).length} checks pass (cable bus runs, gear bus, transformers).</p>
            : <ul className="flex flex-col gap-1 text-[13px]">{bad.map(([id, d]) => <li key={id}><b className="font-mono text-crit">{id}</b> <span className="text-muted">{d.error || d.checks.filter((k) => !k.passed).map((k) => k.name).join("; ")}</span></li>)}</ul>}
        </div>); })()}
      {off.length > 0 && <div className="notice notice-info"><b>De-energized:</b> {off.join(", ")}</div>}
      <p className="text-faint text-[12px] leading-relaxed">Load flow: Newton-Raphson on the compiled network. Short circuit: IEC 60909 equivalent source with c<sub>max</sub>, motors included. Ampacity from NEC tables ({AMPACITY_STATUS}). Cable R uses DC resistance at conductor temperature; reactance from NEC Chapter 9 Table 9.</p>
    </div>
  );
}

/* ============================================================== SCHEDULE */
function Schedule({ sys, analysis, select, updateEq, checks = {} }) {
  const res = analysis?.equipment || {}, cres = analysis?.connectors || {};
  return (
    <div className="flex flex-col gap-4 p-4 overflow-auto">
      {Object.keys(checks).length > 0 && (
        <Section title="Equipment design checks" aside={<span className="text-faint text-[12px]">pecalc modules at study currents and fault levels</span>}>
          <div className="table-wrap"><table className="grid-table">
            <thead><tr><th>Tag</th><th>Check</th><th>Design</th><th>Result</th><th>Failing checks</th></tr></thead>
            <tbody>{Object.entries(checks).map(([id, d]) => (
              <tr key={id} className="clickable" onClick={() => select({ kind: sys.connectors.some((c) => c.id === id) ? "con" : "eq", id })}>
                <td className="font-mono">{id}</td><td className="text-muted">{{ cablebus: "Cable bus", bus: "Gear bus", transformer: "Transformer" }[d.kind]}</td>
                <td style={{ fontFamily: "var(--font-ui)" }}>{d.error || d.summary}</td><td>{d.passed ? <Pill tone="ok">Pass</Pill> : <Pill tone="crit">Fail</Pill>}</td>
                <td style={{ whiteSpace: "normal", fontFamily: "var(--font-ui)" }}>{d.checks.filter((k) => !k.passed).map((k) => k.name).join("; ") || "—"}</td>
              </tr>))}</tbody>
          </table></div>
        </Section>
      )}
      <Section title="Equipment schedule">
        <div className="table-wrap"><table className="grid-table">
          <thead><tr><th>Tag</th><th>Type</th><th>Description</th><th className="r">kV</th><th className="r">V<em>pu</em></th><th className="r">Loading</th><th className="r">I″k<em>kA</em></th><th className="r">Rating<em>kA</em></th><th className="r">Duty</th></tr></thead>
          <tbody>{sys.equipment.map((e) => { const r = res[e.id]; const f = { ...EQUIPMENT[e.type].defaults, ...e }; return (
            <tr key={e.id} className="clickable" onClick={() => select({ kind: "eq", id: e.id })}>
              <td className="font-mono">{e.id}</td><td className="text-muted">{EQUIPMENT[e.type].label}</td><td style={{ fontFamily: "var(--font-ui)" }}>{e.name}</td>
              <td className="r">{r && !r.deenergized ? (r.kv < 1 ? r.kv.toFixed(3) : r.kv) : "—"}</td>
              <td className="r">{r?.deenergized ? <span className="text-faint">off</span> : r ? <span className={cx("vchip", `v-${r.vflag}`)}>{r.v_pu.toFixed(4)}</span> : "—"}</td>
              <td className={cx("r", r?.loading_pct > 100 && "text-crit", r?.loading_pct > 80 && r?.loading_pct <= 100 && "text-warn")}>{r?.loading_pct != null ? fmt(r.loading_pct, 0) + " %" : "—"}</td>
              <td className="r">{r?.ik_ka != null ? fmt(r.ik_ka, 2) : "—"}</td><td className="r">{f.sc_ka ?? "—"}</td>
              <td className={cx("r", r?.sc_duty_pct > 100 && "text-crit", r?.sc_duty_pct > 90 && r?.sc_duty_pct <= 100 && "text-warn")}>{r?.sc_duty_pct != null ? fmt(r.sc_duty_pct, 0) + " %" : "—"}</td>
            </tr>); })}</tbody>
        </table></div>
      </Section>
      <Section title="Cable & cable bus schedule">
        <div className="table-wrap"><table className="grid-table">
          <thead><tr><th>Tag</th><th>Kind</th><th>From → To</th><th>Conductors</th><th className="r">Length<em>ft</em></th><th className="r">I<em>A</em></th><th className="r">Ampacity<em>A</em></th><th className="r">Loading</th><th className="r">VD</th><th className="r">Loss<em>kW</em></th></tr></thead>
          <tbody>{sys.connectors.map((c) => { const f = { ...CONNECTORS[c.kind].defaults, ...c }; const r = cres[c.id]; return (
            <tr key={c.id} className="clickable" onClick={() => select({ kind: "con", id: c.id })}>
              <td className="font-mono">{c.id}</td><td className="text-muted">{CONNECTORS[c.kind].label}</td><td>{c.from} → {c.to}</td>
              <td>{c.kind === "direct" ? "—" : `${f.sets} × 3 × ${f.size} ${f.material}`}</td><td className="r">{c.kind === "direct" ? "—" : f.length_ft}</td>
              <td className="r">{r?.open ? <span className="text-ok">open</span> : r ? fmt(r.i_a, 0) : "—"}</td><td className="r">{r?.ampacity_a != null ? fmt(r.ampacity_a, 0) : "—"}</td>
              <td className={cx("r", r?.loading_pct > 100 && "text-crit", r?.loading_pct > 80 && r?.loading_pct <= 100 && "text-warn")}>{r?.loading_pct != null ? fmt(r.loading_pct, 0) + " %" : "—"}</td>
              <td className={cx("r", Math.abs(r?.vd_pct ?? 0) > 3 && "text-warn")}>{r && !r.open ? fmt(r.vd_pct, 2) + " %" : "—"}</td><td className="r">{r && !r.open ? fmt(r.loss_kw, 2) : "—"}</td>
            </tr>); })}</tbody>
        </table></div>
      </Section>
      {analysis?.sc && (
        <Section title="Short circuit · IEC 60909 three-phase bolted" aside={<span className="text-faint text-[12px]">c = 1.05 at ≤ 1 kV, 1.10 above</span>}>
          <div className="table-wrap"><table className="grid-table">
            <thead><tr><th>Bus</th><th>Equipment</th><th className="r">kV</th><th className="r">c</th><th className="r">I″k<em>kA</em></th><th className="r">S″k<em>MVA</em></th><th className="r">X/R</th><th className="r">κ</th><th className="r">ip<em>kA</em></th></tr></thead>
            <tbody>{analysis.sc.buses.map((b, i) => (
              <tr key={b.id}><td className="font-mono">{b.id}</td><td style={{ fontFamily: "var(--font-ui)" }}>{analysis.compiled.busMeta[i].members.join(", ")}</td>
                <td className="r">{b.kv}</td><td className="r">{b.c.toFixed(2)}</td><td className="r">{fmt(b.ik_ka, 2)}</td><td className="r">{fmt(b.sk_mva, 1)}</td><td className="r">{fmt(b.xr, 1)}</td><td className="r">{b.kappa.toFixed(3)}</td><td className="r">{fmt(b.ip_ka, 2)}</td></tr>
            ))}</tbody>
          </table></div>
        </Section>
      )}
      <ArcFlashSection sys={sys} analysis={analysis} updateEq={updateEq} />
      <MotorStartSection sys={sys} />
      <ProfileSection sys={sys} />
    </div>
  );
}

/* Calculation package for the whole system (see engine/report.js). The one-line SVG is included only when that view is mounted. */
function systemReport(sys, analysis, host) {
  if (!analysis?.ok) throw new Error(analysis?.message || "The system is not solved.");
  const res = analysis.equipment, cres = analysis.connectors, t = analysis.totals;
  const eq = sys.equipment.map((e) => ({ e, r: res[e.id], f: { ...EQUIPMENT[e.type].defaults, ...e } }));
  const checks = [];
  for (const { e, r } of eq) {
    if (!r || r.deenergized) continue;
    checks.push({ name: `${e.id} voltage`, value: r.v_pu, limit: "0.95 - 1.05", unit: "pu", pass: r.vflag === "ok", clause: "Voltage band (workspace setting)" });
    if (r.loading_pct != null) checks.push({ name: `${e.id} loading`, value: r.loading_pct, limit: 100, unit: "%", pass: r.loading_pct <= 100, clause: "Equipment rating" });
    if (r.sc_duty_pct != null) checks.push({ name: `${e.id} short-circuit duty`, value: r.sc_duty_pct, limit: 100, unit: "%", pass: r.sc_duty_pct <= 100, clause: "Equipment short-circuit rating vs IEC 60909 Ik" });
  }
  for (const c of sys.connectors) { const r = cres[c.id]; if (r?.loading_pct != null) checks.push({ name: `${c.id} loading`, value: r.loading_pct, limit: 100, unit: "%", pass: r.loading_pct <= 100, clause: "Cable ampacity (NEC table)" }); }
  const attention = [
    ...eq.filter(({ e, r }) => !["ok", "off", "muted"].includes(statusOf(e, r))).map(({ e, r }) =>
      `${e.id}: ${r.sc_duty_pct > 90 ? `fault duty ${fmt(r.sc_duty_pct, 0)} %` : r.vflag !== "ok" ? `voltage ${r.v_pu.toFixed(3)} pu` : `loading ${fmt(r.loading_pct, 0)} %`}`),
    ...Object.entries(cres).filter(([, r]) => (r.loading_pct ?? 0) > 80).map(([id, r]) => `${id}: cable loading ${fmt(r.loading_pct, 0)} %`),
    ...eq.filter(({ r }) => r?.deenergized).map(({ e }) => `${e.id}: de-energized`),
  ];
  const svg = svgToString(host?.querySelector("svg.sld"));
  return {
    title: sys.name || "System study", module: "system", subtitle: "Load flow and IEC 60909 short circuit",
    inputs: [{ label: "Equipment count", value: sys.equipment.length }, { label: "Cable runs", value: sys.connectors.length },
      ...eq.flatMap(({ e, f }) => Object.entries(f).filter(([k, v]) => !["id", "name", "type", "gx", "gy"].includes(k) && ["number", "string"].includes(typeof v)).map(([k, v]) => ({ label: `${e.id} ${k.replace(/_/g, " ")}`, value: v })))],
    results: [{ label: "Demand", value: t.load_kw, unit: "kW" }, { label: "Losses", value: t.loss_kw, unit: "kW" }, { label: "Voltage range", value: `${t.min_v.toFixed(3)} - ${t.max_v.toFixed(3)}`, unit: "pu" }, { label: "Highest Ik", value: t.max_ik_ka, unit: "kA" }],
    checks,
    tables: [
      { title: "Equipment schedule", columns: ["Tag", "Type", "Description", "kV", "V (pu)", "Loading %", "Ik (kA)", "Rating (kA)", "Duty %"],
        rows: eq.map(({ e, r, f }) => [e.id, EQUIPMENT[e.type].label, e.name || "", r?.kv ?? "", r?.v_pu != null ? r.v_pu.toFixed(4) : "", r?.loading_pct != null ? fmt(r.loading_pct, 0) : "", r?.ik_ka != null ? fmt(r.ik_ka, 2) : "", f.sc_ka ?? "", r?.sc_duty_pct != null ? fmt(r.sc_duty_pct, 0) : ""]) },
      { title: "Cable and cable bus schedule", columns: ["Tag", "Kind", "From - To", "Conductors", "Length (ft)", "I (A)", "Ampacity (A)", "Loading %", "VD %", "Loss (kW)"],
        rows: sys.connectors.map((c) => { const f = { ...CONNECTORS[c.kind].defaults, ...c }, r = cres[c.id]; return [c.id, CONNECTORS[c.kind].label, `${c.from} - ${c.to}`,
          c.kind === "direct" ? "-" : `${f.sets} x 3 x ${f.size} ${f.material}`, c.kind === "direct" ? "-" : f.length_ft, r && !r.open ? fmt(r.i_a, 0) : "open", r?.ampacity_a != null ? fmt(r.ampacity_a, 0) : "",
          r?.loading_pct != null ? fmt(r.loading_pct, 0) : "", r && !r.open ? fmt(r.vd_pct, 2) : "", r && !r.open ? fmt(r.loss_kw, 2) : ""]; }) },
      ...(analysis.sc ? [{ title: "Short circuit, IEC 60909 three-phase bolted", columns: ["Bus", "Equipment", "kV", "c", "Ik (kA)", "S''k (MVA)", "X/R", "kappa", "ip (kA)"],
        rows: analysis.sc.buses.map((b, i) => [b.id, analysis.compiled.busMeta[i].members.join(", "), b.kv, b.c.toFixed(2), fmt(b.ik_ka, 2), fmt(b.sk_mva, 1), fmt(b.xr, 1), b.kappa.toFixed(3), fmt(b.ip_ka, 2)]) }] : []),
      { title: "Attention list", columns: ["Item"], rows: attention.length ? attention.map((a) => [a]) : [["No overloads, voltage or short-circuit duty issues."]] },
    ],
    figures: svg ? [{ title: "One-line diagram", svg, dark: true }] : [],
    notes: ["Load flow: Newton-Raphson on the compiled network. Short circuit: IEC 60909 equivalent source with cmax.", "Cable R uses DC resistance at conductor temperature; reactance from NEC Chapter 9 Table 9 (UNVERIFIED).",
      ...(svg ? [] : ["The one-line diagram is omitted: open the One-line view in the System workspace before exporting to include it."])],
    dataStatus: [{ table: "NEC Table 310.16 ampacity", status: AMPACITY_STATUS, source: "Check against a licensed NFPA 70 copy." }, { table: "NEC Chapter 9 Table 9 reactance", status: "UNVERIFIED", source: "Entered from memory." }],
  };
}

/* ============================================================== WORKSPACE */
const ADDABLE = [["transformer", "Transformer"], ["switchgear", "Switchgear"], ["mcc", "MCC"], ["motor", "Motor"], ["load", "Load"], ["capacitor", "Capacitor"], ["generator", "Generator"], ["utility", "Utility"]];

export function SystemWorkspace({ goTo }) {
  const [sys, setSys, history] = useHistory(() => clone(EXAMPLE_SYSTEM));
  const [selection, setSelection] = useState(null);
  const [tool, setTool] = useState("select");
  const [view, setView] = useState(() => (typeof location !== "undefined" && location.hash === "#system-tcc" ? "tcc" : typeof location !== "undefined" && location.hash === "#system-schedule" ? "schedule" : "site"));
  const [showTags, setShowTags] = useState(true);
  const [animate, setAnimate] = useState(true);
  const [motors, setMotors] = useState(true);
  const [fitSignal, setFitSignal] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [lineupFor, setLineupFor] = useState(() => (typeof location !== "undefined" && location.hash === "#system-lineup" ? "SWGR-LV" : null));
  const [mode, setMode] = useState(() => (typeof location !== "undefined" && location.hash.startsWith("#system-3d") ? "3d" : location.hash === "#system-sld" ? "sld" : "iso"));
  const analysis = useMemo(() => analyseSystem(sys, { motors }), [sys, motors]);
  // Equipment design checks (pecalc cable bus / bus / transformer) are heavier: run them after the frame.
  const [checks, setChecks] = useState({});
  // Design pushes from the module workspaces mark the studies stale; each clears when it has re-run on the new model.
  const [pushed, setPushed] = useState(null);         // { module, target, changed, studies: [...] }
  const unstale = (done) => setPushed((p) => (p && p.studies.some((x) => done.includes(x)) ? { ...p, studies: p.studies.filter((x) => !done.includes(x)) } : p));
  useEffect(() => { unstale(["loadflow", "shortcircuit"]); }, [analysis]);
  useEffect(() => { const t = setTimeout(() => { try { setChecks(designChecks(sys, analysis)); } catch (err) { setChecks({}); } unstale(["designchecks"]); }, 220); return () => clearTimeout(t); }, [analysis]); // eslint-disable-line
  const checksStale = !!pushed?.studies.includes("designchecks");

  // Publish the model for the module workspaces (target pickers, diff previews) and take their design pushes.
  const sysRef = useRef(sys); sysRef.current = sys;
  useEffect(() => { bus.retain("system:model", { sys }); }, [sys]);
  useEffect(() => bus.on("system:apply", ({ module, target, design, reply }) => {
    const plan = planPush(sysRef.current, target, design);
    if (!plan.ok || !plan.changed) { reply?.({ ok: false, errors: plan.ok ? [`${plan.target.id} already matches this design.`] : plan.errors, plan }); return; }
    let next;
    try { next = applyPush(sysRef.current, plan); } catch (err) { reply?.({ ok: false, errors: [err.message], plan }); return; }
    setSys(next);                                       // one history entry: a single undo restores the element
    setPushed({ module, target: plan.target, changed: plan.changed, studies: plan.stale });
    setSelection({ kind: plan.target.kind, id: plan.target.id });
    bus.emit("system:stale", { studies: plan.stale, reason: `${PUSH_MODULES[module].label} design applied to ${plan.target.id}` });
    reply?.({ ok: true, plan });
  }), []); // eslint-disable-line

  const updateEq = (id, patch) => setSys((s) => ({ ...s, equipment: s.equipment.map((e) => (e.id === id ? clean({ ...e, ...patch }) : e)) }));
  const updateCon = (id, patch) => setSys((s) => ({ ...s, connectors: s.connectors.map((c) => (c.id === id ? clean({ ...c, ...patch }) : c)) }));
  const move = (id, gx, gy) => setSys((s) => ({ ...s, equipment: s.equipment.map((e) => (e.id === id ? { ...e, gx, gy } : e)) }), { silent: true }); // one history entry per drag, committed on pointer-up
  const removeEq = (id) => { setSys((s) => ({ ...s, equipment: s.equipment.filter((e) => e.id !== id), connectors: s.connectors.filter((c) => !c.from.startsWith(id + ".") && !c.to.startsWith(id + ".")) })); setSelection(null); };
  const removeCon = (id) => { setSys((s) => ({ ...s, connectors: s.connectors.filter((c) => c.id !== id) })); setSelection(null); };
  const renameEq = (oldId, newIdV) => {
    if (!newIdV || newIdV === oldId || /[.\s]/.test(newIdV) || sys.equipment.some((e) => e.id === newIdV)) return;
    const fix = (end) => (end.startsWith(oldId + ".") ? newIdV + end.slice(oldId.length) : end);
    setSys((s) => ({ ...s, equipment: s.equipment.map((e) => (e.id === oldId ? { ...e, id: newIdV } : e)), connectors: s.connectors.map((c) => ({ ...c, from: fix(c.from), to: fix(c.to) })) }));
    setSelection({ kind: "eq", id: newIdV });
  };
  const addEq = (type) => {
    const prefix = { transformer: "T", switchgear: "SWGR-", mcc: "MCC-", motor: "M", load: "LOAD-", capacitor: "CAP-", generator: "GEN-", utility: "UTIL-" }[type];
    let n = 1; while (sys.equipment.some((e) => e.id === prefix + n)) n++;
    const id = prefix + n;
    // free spot: scan the pad for a clear footprint
    const taken = sys.equipment.map((e) => { const d = dims({ ...EQUIPMENT[e.type].defaults, ...e }); return [e.gx - 1, e.gy - 1, e.gx + d.w + 1, e.gy + d.d + 1]; });
    const dd = dims({ ...EQUIPMENT[type].defaults, type });
    let spot = [0, 16];
    outer: for (let gy = 0; gy < 30; gy += 2) for (let gx = 0; gx < 30; gx += 2) {
      if (taken.every(([a, b, c, d]) => gx + dd.w < a || gx > c || gy + dd.d < b || gy > d)) { spot = [gx, gy]; break outer; }
    }
    setSys((s) => ({ ...s, equipment: [...s.equipment, { id, type, name: `${EQUIPMENT[type].label} ${n}`, gx: spot[0], gy: spot[1] }] }));
    setSelection({ kind: "eq", id }); setAddOpen(false);
  };
  const connect = (aId, bId) => {
    const a = sys.equipment.find((e) => e.id === aId), b = sys.equipment.find((e) => e.id === bId);
    const A = { ...EQUIPMENT[a.type].defaults, ...a }, B = { ...EQUIPMENT[b.type].defaults, ...b };
    const kvOf = (e) => e.kv ?? null;
    const pickTerm = (e, other) => {
      if (e.type !== "transformer") return EQUIPMENT[e.type].terminals[0];
      const okv = kvOf(other);
      if (okv != null) return Math.abs(okv - e.hv_kv) < 1e-9 ? "hv" : "lv";
      const used = sys.connectors.filter((c) => c.from.startsWith(e.id + ".") || c.to.startsWith(e.id + ".")).map((c) => (c.from.startsWith(e.id + ".") ? c.from : c.to).split(".")[1]);
      return used.includes("hv") ? "lv" : "hv";
    };
    const ta = pickTerm(A, B), tb = pickTerm(B, A);
    const kind = (A.type === "transformer" && ta === "lv") || (B.type === "transformer" && tb === "lv") ? "cablebus" : "cable";
    let n = 1; while (sys.connectors.some((c) => c.id === `${kind === "cablebus" ? "CB" : "C"}-${n}`)) n++;
    const id = `${kind === "cablebus" ? "CB" : "C"}-${n}`;
    setSys((s) => ({ ...s, connectors: [...s.connectors, { id, kind, from: `${aId}.${ta}`, to: `${bId}.${tb}` }] }));
    setSelection({ kind: "con", id }); setTool("select");
  };
  const goFeeder = (c) => {
    const full = { ...CONNECTORS[c.kind].defaults, ...c }, end = (k) => c[k].split(".")[0];
    const at = analysis.ok ? analysis.equipment[end("from")] : null;
    bus.emit("feeder:open", { connector: full, current_a: analysis.connectors[c.id]?.i_a, kv: at?.kv ?? analysis.equipment[end("to")]?.kv, fault_ka: at?.ik_ka });
    goTo("feeder");
  };
  const goModule = (module, e) => {
    const full = { ...EQUIPMENT[e.type].defaults, ...e }, r = analysis.ok ? analysis.equipment[e.id] : null;
    if (module === "switchgear") bus.emit("switchgear:open", { equipment: full, xr: r?.xr_fault });
    else bus.emit("transformer:open", { equipment: full, source_mva: sys.equipment.find((x) => x.type === "utility")?.mva_sc });
    goTo(module);
  };
  const sendToLoadFlow = () => {
    const c = analysis.compiled;
    const layout = {};
    c.busMeta.forEach((b) => { const e = sys.equipment.find((x) => x.id === b.members[0]); if (e) { const p = iso(e.gx, e.gy); layout[b.id] = [Math.round(p[0] + 600), Math.round(p[1] + 100)]; } });
    bus.emit("loadflow:open", { data: c.lfCase, name: `${sys.name} (buses)`, layout });
    goTo("loadflow");
  };

  useEffect(() => {
    const onKey = (ev) => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) return;
      if (!wsVisible()) return;
      if (ev.key === "Escape") { setTool("select"); setSelection(null); setAddOpen(false); }
      if ((ev.key === "Delete" || ev.key === "Backspace") && selection) { ev.preventDefault(); selection.kind === "eq" ? removeEq(selection.id) : removeCon(selection.id); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  });
  const hostRef = useRef(null);
  const wsVisible = () => !!hostRef.current && hostRef.current.offsetParent !== null;

  const selEq = selection?.kind === "eq" && sys.equipment.find((e) => e.id === selection.id);
  const selCon = selection?.kind === "con" && sys.connectors.find((c) => c.id === selection.id);
  const t = analysis.totals;
  const status = analysis.ok ? { tone: "ok", text: `Solved · ${analysis.lf.iterations} iter` } : { tone: "crit", text: analysis.message || "Not solved" };

  return (
    <div className="ws" ref={hostRef}>
      <style>{CSS}</style>
      <header className="topbar">
        <div className="ws-title">System</div>
        <input id="sys-name" className="num-input" style={{ width: 240, maxWidth: "100%" }} value={sys.name} onChange={(ev) => setSys((s) => ({ ...s, name: ev.target.value }))} aria-label="Package name" />
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          <label className="live-toggle" title="Include induction-motor fault contribution"><input id="sc-motors" type="checkbox" checked={motors} onChange={(ev) => setMotors(ev.target.checked)} /><span>Motor contribution</span></label>
          <ProjectMenu sys={sys} setSys={setSys} history={history} onLoaded={() => { setSelection(null); setFitSignal((x) => x + 1); }} />
          <ReportButton filename="system-calc" disabled={!analysis.ok} getReport={() => systemReport(sys, analysis, hostRef.current)} />
          <Btn onClick={sendToLoadFlow} disabled={!analysis.ok} title="Open the compiled bus model in the Load flow workspace">Open in Load flow</Btn>
          <Btn onClick={() => { setSys(clone(EXAMPLE_SYSTEM)); setSelection(null); setFitSignal((x) => x + 1); }}>Reset example</Btn>
        </div>
      </header>
      <nav className="tabs">
        {[["site", "Site view"], ["schedule", "Schedules & studies"], ["tcc", "Coordination"]].map(([k, l]) => <button key={k} className={cx("tab", view === k && "is-active")} onClick={() => setView(k)}>{l}</button>)}
        <div className="ml-auto flex items-center gap-3 pr-1 text-[12.5px]">
          <Pill tone={status.tone}>{status.text}</Pill>
          {t && <span className="text-muted hidden md:inline">Demand <b className="text-fg font-mono">{fmt(t.load_kw, 0)}</b> kW · Losses <b className="text-fg font-mono">{fmt(t.loss_kw, 1)}</b> kW · Max I″k <b className="text-fg font-mono">{fmt(t.max_ik_ka, 1)}</b> kA</span>}
        </div>
      </nav>
      {pushed && (
        <div className={cx("notice sys-push", pushed.studies.length ? "notice-warn" : "notice-info")} role="status">
          <span><b>{PUSH_MODULES[pushed.module].label} design applied to {pushed.target.id}</b> · {pushed.changed} field{pushed.changed === 1 ? "" : "s"} changed.</span>
          <span className="sys-push-studies">{Object.entries(STUDY_LABELS).map(([k, l]) => <Pill key={k} tone={pushed.studies.includes(k) ? "warn" : "ok"}>{l}: {pushed.studies.includes(k) ? "stale, re-running" : "re-run"}</Pill>)}</span>
          <span className="ml-auto flex gap-1">
            <Btn onClick={() => { history.undo(); setPushed(null); }} title="Undo the push (one step)">Undo push</Btn>
            <Btn onClick={() => setPushed(null)} title="Dismiss"><Icon name="x" size={13} /></Btn>
          </span>
        </div>
      )}
      <main className={cx("main", view === "site" && "is-diagram")}>
        {view === "site" ? (
          <div className="diagram-grid">
            <div className="flex flex-col min-w-0 min-h-0 gap-2">
              <div className="toolbar">
                <div className="seg">
                  <Btn active={mode === "iso"} onClick={() => setMode("iso")} title="Isometric site plan">Iso</Btn>
                  <Btn active={mode === "3d"} onClick={() => { setMode("3d"); setTool("select"); }} title="Orbitable 3D model">3D</Btn>
                  <Btn active={mode === "sld"} onClick={() => { setMode("sld"); setTool("select"); }} title="Auto-generated single-line diagram">One-line</Btn>
                </div>
                <div className="seg">
                  <Btn active={tool === "select"} onClick={() => setTool("select")}><Icon name="select" size={14} />Select</Btn>
                  <Btn active={tool === "connect"} disabled={mode !== "iso"} onClick={() => setTool("connect")}><Icon name="connect" size={14} />Connect</Btn>
                </div>
                <div className="relative">
                  <Btn kind="primary-soft" onClick={() => setAddOpen(!addOpen)}><Icon name="plus" size={14} />Add equipment</Btn>
                  {addOpen && <div className="menu">{ADDABLE.map(([k, l]) => <button key={k} onClick={() => addEq(k)}>{l}</button>)}</div>}
                </div>
                <div className="flex gap-1 flex-wrap ml-auto">
                  <Btn active={showTags} onClick={() => setShowTags(!showTags)}>Tags</Btn>
                  <Btn active={animate} onClick={() => setAnimate(!animate)}><Icon name="play" size={13} />Flow</Btn>
                  <Btn onClick={() => setFitSignal((x) => x + 1)}><Icon name="fit" size={14} />Fit</Btn>
                </div>
              </div>
              {mode === "sld" ? <SystemSld sys={sys} analysis={analysis} selection={selection} setSelection={setSelection} showTags={showTags} /> : mode === "3d" ? <Site3D sys={sys} analysis={analysis} selection={selection} setSelection={setSelection} animate={animate} showTags={showTags} fitSignal={fitSignal} /> :
              <SiteView sys={sys} analysis={analysis} selection={selection} setSelection={setSelection} tool={tool} onMove={move} onMoveEnd={history.checkpoint} onConnect={connect} showTags={showTags} animate={animate} fitSignal={fitSignal} />}
            </div>
            <aside className="panel inspector">
              {selEq ? <EqInspector e={selEq} r={analysis.ok ? analysis.equipment[selEq.id] : null} update={updateEq} remove={removeEq} rename={renameEq} scShown={!!analysis.sc} openLineup={setLineupFor} dc={checks[selEq.id]} dcStale={checksStale} goModule={goModule} />
                : selCon ? <ConInspector c={selCon} r={analysis.ok ? analysis.connectors[selCon.id] : null} update={updateCon} remove={removeCon} dc={checks[selCon.id]} dcStale={checksStale} goFeeder={goFeeder}
                    kvAt={analysis.ok ? analysis.equipment[selCon.from.split(".")[0]]?.kv : null} goCableBus={(c) => { bus.emit("cablebus:open", { connector: { ...CONNECTORS[c.kind].defaults, ...c }, current_a: analysis.connectors[c.id]?.i_a, kv: analysis.equipment[c.to.split(".")[0]]?.kv }); goTo("cablebus"); }} />
                : <SystemSummary sys={sys} analysis={analysis} checks={checks} />}
            </aside>
          </div>
        ) : view === "tcc" ? <CoordinationView sys={sys} analysis={analysis} updateCon={updateCon} /> : <Schedule updateEq={updateEq} checks={checks} sys={sys} analysis={analysis} select={(s) => { setSelection(s); setView("site"); }} />}
      </main>
      {lineupFor && sys.equipment.some((e) => e.id === lineupFor) && <GearLineupModal sys={sys} analysis={analysis} gearId={lineupFor} onClose={() => setLineupFor(null)} />}
    </div>
  );
}

const clean = (o) => { const out = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v; return out; };
