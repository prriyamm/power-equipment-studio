// Large power transformers (100-250 MVA) through the System engine, checked against independent hand
// calculations: IEC 60909 I″k at the secondary bus and a two-bus load flow solved by fixed-point iteration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseSystem } from "../src/engine/system.js";

const SQ3 = Math.sqrt(3);
const cMax = (kv) => (kv <= 1 ? 1.05 : 1.1);
const cx = (re, im) => ({ re, im });
const add = (a, b) => cx(a.re + b.re, a.im + b.im), sub = (a, b) => cx(a.re - b.re, a.im - b.im);
const mul = (a, b) => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
const conj = (a) => cx(a.re, -a.im), abs = (a) => Math.hypot(a.re, a.im);
const zOf = (mag, xr) => { const r = mag / Math.sqrt(1 + xr * xr); return cx(r, r * xr); };

const single = ({ mva, hv, lv, z, xr, mva_sc, uxr, loadPct, pf }) => ({
  name: `${mva} MVA`, base_mva: 100,
  equipment: [
    { id: "UTIL", type: "utility", kv: hv, mva_sc, xr: uxr, gx: 0, gy: 0 },
    { id: "T", type: "transformer", kva: mva * 1000, hv_kv: hv, lv_kv: lv, z_pct: z, xr, gx: 6, gy: 0 },
    { id: "BUS", type: "switchgear", kv: lv, bus_a: 12000, sc_ka: 200, gx: 12, gy: 0 },
    { id: "LOAD", type: "load", kw: (mva * 1000 * loadPct) / 100 * pf, pf, gx: 18, gy: 0 },
  ],
  connectors: [
    { id: "a", kind: "direct", from: "UTIL.out", to: "T.hv" },
    { id: "b", kind: "direct", from: "T.lv", to: "BUS.bus" },
    { id: "c", kind: "direct", from: "BUS.bus", to: "LOAD.in" },
  ],
});

test("100-250 MVA sweep: secondary I″k, bus voltage and secondary current match hand calculations", () => {
  const base = 100, xr = 45, uxr = 30, pf = 0.9, loadPct = 80;
  let n = 0;
  for (const [hv, lv] of [[230, 34.5], [138, 13.8], [345, 69]]) {
    for (const mva of [100, 150, 200, 250]) {
      for (const z of [8, 12, 14]) {
        for (const mva_sc of [1e9, 10000]) {
          const a = analyseSystem(single({ mva, hv, lv, z, xr, mva_sc, uxr, loadPct, pf }));
          assert.ok(a.ok, a.message);
          // I″k = c·I_base / |Z_Q + Z_T|, Z_Q = c_Q·base/S″kQ (IEC basis), Z_T = z·base/S_rT
          const Zq = zOf((cMax(hv) * base) / mva_sc, uxr), Zt = zOf(((z / 100) * base) / mva, xr);
          const ik = (cMax(lv) * (base / (SQ3 * lv))) / abs(add(Zq, Zt));
          assert.ok(Math.abs(a.equipment.BUS.ik_ka / ik - 1) < 1e-9, `${mva} MVA ${hv}/${lv} z${z}: ${a.equipment.BUS.ik_ka} vs ${ik}`);
          // load flow: slack 1∠0 at the HV terminal, V2 = 1 - Z_T·conj(S/V2)
          const S = cx((mva * loadPct / 100 * pf) / base, (mva * loadPct / 100 * Math.sin(Math.acos(pf))) / base);
          let V = cx(1, 0);
          for (let i = 0; i < 200; i++) V = sub(cx(1, 0), mul(Zt, conj(div(S, V))));
          assert.ok(Math.abs(a.equipment.BUS.v_pu - abs(V)) < 1e-7, `${mva} MVA z${z}: V ${a.equipment.BUS.v_pu} vs ${abs(V)}`);
          const iLv = (abs(div(S, V)) * base * 1000) / (SQ3 * lv);
          assert.ok(Math.abs(a.equipment.T.i_lv_a / iLv - 1) < 1e-6, `${mva} MVA z${z}: I ${a.equipment.T.i_lv_a} vs ${iLv}`);
          n++;
        }
      }
    }
  }
  assert.equal(n, 72);
});

test("150 MVA 230/34.5 kV: ±5 % HV tap moves the light-load secondary voltage by 1/1.05 and 1/0.95", () => {
  const at = (tap) => {
    const s = single({ mva: 150, hv: 230, lv: 34.5, z: 11, xr: 45, mva_sc: 1e9, uxr: 30, loadPct: 1, pf: 0.9 });
    if (tap) s.equipment[1].tap_pct = tap;
    return analyseSystem(s).equipment.BUS.v_pu;
  };
  const v0 = at(0);
  assert.ok(Math.abs(at(5) - v0 / 1.05) < 2e-3);
  assert.ok(Math.abs(at(-5) - v0 / 0.95) < 2e-3);
});
