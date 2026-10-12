/* Projection-independent geometry of the System view: equipment footprints,
   terminal anchor points and connector routes, in grid units (x, y on the pad, z up). */
import { EQUIPMENT, CONNECTORS, NODE_KINDS } from "../engine/system.js";

// footprint (w along x, d along y, h up) in grid units
export function dims(e) {
  switch (e.type) {
    case "switchgear": { const mv = e.kv > 1; return { w: e.sections * (mv ? 1.2 : 1.0), d: mv ? 2.4 : 1.8, h: mv ? 3.0 : 2.6 }; }
    case "mcc": return { w: e.sections * 0.8, d: 0.9, h: 2.6 };
    case "panel": return { w: 0.9, d: 0.45, h: 2.0 };
    case "transformer": return { w: 2.0, d: 1.8, h: 1.9 };
    case "motor": return { w: 2.0, d: 1.0, h: 1.1 };
    case "load": return { w: 2.6, d: 2.2, h: 1.7 };
    case "capacitor": return { w: 1.2, d: 0.9, h: 1.7 };
    case "generator": return { w: 2.8, d: 1.3, h: 1.5 };
    case "utility": return { w: 1.0, d: 1.0, h: 4.2 };
    default: return { w: 1, d: 1, h: 1 };
  }
}

/* ------------------------------------------------------------- terminals */
// Connection points: cable bus lands on top (overhead), cable enters from below (duct bank).
export function anchor(e, termName, kind, slot = 0.5) {
  const { w, d, h } = dims(e); const x = e.gx, y = e.gy;
  const top = kind === "cablebus";
  switch (e.type) {
    case "transformer": {
      const hv = termName === "hv";
      return top ? [x + (hv ? 0.4 : w - 0.4), y + d / 2, h + (hv ? 0.75 : 0.4)] : [x + (hv ? 0.4 : w - 0.4), y + d / 2, 0];
    }
    case "utility": return top ? [x + 0.5, y + 0.5, 3.6] : [x + 0.65, y + 0.5, 0];
    case "switchgear": case "mcc": case "panel": return [x + w * slot, y + d * 0.35, top ? h : 0];
    case "motor": return top ? [x + 0.92, y + d / 2, 1.3] : [x + 0.92, y + d / 2, 0];
    default: return [x + w / 2, y + d / 2, top ? h : 0];
  }
}

export function routeConnector(c, eqMap, slots) {
  const [fa, ft] = c.from.split("."), [ta, tt] = c.to.split(".");
  const A = eqMap[fa], B = eqMap[ta];
  if (!A || !B) return null;
  const pa = anchor(A, ft, c.kind, slots[c.id + ":from"] ?? 0.5), pb = anchor(B, tt, c.kind, slots[c.id + ":to"] ?? 0.5);
  if (c.kind === "cablebus") {
    const zt = Math.max(dims(A).h, dims(B).h, pa[2], pb[2]) + 0.9;
    return { overhead: true, zt, pts: [pa, [pa[0], pa[1], zt], [pb[0], pa[1], zt], [pb[0], pb[1], zt], pb] };
  }
  if (c.kind === "direct") return { pts: [pa, pb], direct: true };
  return { overhead: false, pts: [pa, [pa[0], pb[1], 0], pb] };
}


// Spread connectors that land on the same gear across its sections, ordered by where the far end sits.
export function connectorSlots(sys, eqMap) {
  const per = {};
  sys.connectors.forEach((c) => ["from", "to"].forEach((k) => {
    const id = c[k].split(".")[0]; const e = eqMap[id]; if (!e || !NODE_KINDS.has(e.type)) return;
    const other = eqMap[c[k === "from" ? "to" : "from"].split(".")[0]];
    (per[id] ||= []).push({ key: c.id + ":" + k, ox: other ? other.gx - other.gy : 0 });
  }));
  const out = {};
  for (const list of Object.values(per)) { list.sort((a, b) => a.ox - b.ox); list.forEach((s, i) => (out[s.key] = (i + 0.5) / list.length)); }
  return out;
}
export const fullEq = (e) => ({ ...EQUIPMENT[e.type].defaults, ...e });
export const fullCon = (c) => ({ ...CONNECTORS[c.kind].defaults, ...c });
export function siteRoutes(sys) {
  const eqMap = Object.fromEntries(sys.equipment.map((e) => [e.id, fullEq(e)]));
  const slots = connectorSlots(sys, eqMap);
  const routes = Object.fromEntries(sys.connectors.map((c) => [c.id, routeConnector(fullCon(c), eqMap, slots)]));
  return { eqMap, slots, routes };
}
