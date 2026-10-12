/* System project files: JSON save/load for the equipment-level System model.
 * Equipment and connectors keep only fields that differ from the catalogue defaults;
 * parseSystem restores the defaults and validates strictly. Pure, no DOM. */
import { EQUIPMENT, CONNECTORS, compileSystem } from "./system.js";

export const FORMAT = "power-studio-system";
export const VERSION = 1;

const same = (a, b) => a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-12);
const strip = (obj, defaults, keep) => {
  const out = {};
  for (const k of keep) if (obj[k] !== undefined) out[k] = obj[k];
  const order = [...Object.keys(defaults), ...Object.keys(obj).filter((k) => !(k in defaults))];
  for (const k of order) {
    const v = obj[k];
    if (keep.includes(k) || v === undefined) continue;
    if (k in defaults && same(defaults[k], v)) continue;
    out[k] = v;
  }
  return out;
};

export function toProject(sys) {
  return {
    format: FORMAT, version: VERSION, name: sys.name ?? "Untitled package", base_mva: sys.base_mva ?? 10,
    equipment: (sys.equipment || []).map((e) => strip(e, EQUIPMENT[e.type]?.defaults || {}, ["id", "type", "name", "gx", "gy"])),
    connectors: (sys.connectors || []).map((c) => strip(c, CONNECTORS[c.kind]?.defaults || {}, ["id", "kind", "from", "to"])),
  };
}
export const serializeSystem = (sys) => JSON.stringify(toProject(sys), null, 2) + "\n";

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const STRUCTURAL = /Unknown equipment type|Duplicate equipment id|does not exist|has no terminal|connects a terminal to itself/;

/* Returns a system with defaults restored. Throws Error with a readable message on any problem. */
export function parseSystem(text) {
  let d;
  try { d = typeof text === "string" ? JSON.parse(text) : text; } catch (e) { throw new Error(`Not valid JSON: ${e.message}`); }
  if (!isObj(d)) throw new Error("A system file must be a JSON object.");
  if (d.format !== FORMAT) throw new Error(`Not a Power Studio system file (format should be "${FORMAT}").`);
  if (d.version !== VERSION) throw new Error(`Unsupported system file version ${JSON.stringify(d.version)}; this build reads version ${VERSION}.`);
  if (d.name !== undefined && typeof d.name !== "string") throw new Error('"name" must be a string.');
  const base_mva = d.base_mva ?? 10;
  if (typeof base_mva !== "number" || !(base_mva > 0)) throw new Error('"base_mva" must be a positive number.');
  if (!Array.isArray(d.equipment)) throw new Error('"equipment" must be an array.');
  if (!Array.isArray(d.connectors)) throw new Error('"connectors" must be an array.');

  const equipment = d.equipment.map((e, i) => {
    if (!isObj(e)) throw new Error(`equipment[${i}] must be an object.`);
    if (typeof e.id !== "string" || !e.id || /[.\s]/.test(e.id)) throw new Error(`equipment[${i}] needs a string id without dots or spaces.`);
    if (!EQUIPMENT[e.type]) throw new Error(`Unknown equipment type "${e.type}" on ${e.id}.`);
    for (const k of ["gx", "gy"]) if (typeof e[k] !== "number" || !isFinite(e[k])) throw new Error(`${e.id}: "${k}" must be a number.`);
    const full = { ...EQUIPMENT[e.type].defaults, ...e };
    for (const [k, def] of Object.entries(EQUIPMENT[e.type].defaults)) {
      if (typeof full[k] !== typeof def) throw new Error(`${e.id}: "${k}" must be a ${typeof def}.`);
      if (typeof def === "number" && !isFinite(full[k])) throw new Error(`${e.id}: "${k}" must be a finite number.`);
    }
    if (full.name === undefined) full.name = e.id;
    return full;
  });
  const seen = new Set();
  const connectors = d.connectors.map((c, i) => {
    if (!isObj(c)) throw new Error(`connectors[${i}] must be an object.`);
    if (typeof c.id !== "string" || !c.id) throw new Error(`connectors[${i}] needs a string id.`);
    if (seen.has(c.id)) throw new Error(`Duplicate connector id "${c.id}".`);
    seen.add(c.id);
    if (!CONNECTORS[c.kind]) throw new Error(`Unknown connector kind "${c.kind}" on ${c.id}.`);
    for (const k of ["from", "to"]) if (typeof c[k] !== "string" || !/^[^.\s]+\.[^.\s]+$/.test(c[k])) throw new Error(`${c.id}: "${k}" must look like "EQUIPMENT-ID.terminal".`);
    return { ...CONNECTORS[c.kind].defaults, ...c };
  });
  const sys = { name: d.name ?? "Untitled package", base_mva, equipment, connectors };
  const bad = compileSystem(sys).issues.find((x) => x.level === "error" && STRUCTURAL.test(x.msg));
  if (bad) throw new Error(bad.msg);
  return sys;
}
