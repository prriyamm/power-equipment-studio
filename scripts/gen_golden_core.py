#!/usr/bin/env python3
"""Generate tests/golden/core.json: input -> output vectors for the ported pecalc core modules
(conductors, ampacity, impedance, forces, field, thermal).

Usage:  PECALC_PATH=/path/to/power-equipment-engineering/calculations python3 scripts/gen_golden_core.py

PECALC_PATH is the directory that contains the `pecalc` package (default: a sibling checkout at
../power-equipment-engineering/calculations). Standard library only.

numpy note: pecalc.impedance.solve_complex uses numpy only when a system has more than 40 unknowns.
Every vector here stays at or below 40 unknowns, so Python always takes the hand-written Gaussian
elimination path, which is the path the JS port implements. The script asserts this.

Encoding: complex -> {"__c": [re, im]}; inf/nan -> {"__f": "inf" | "-inf" | "nan"}; tuples -> lists.
A call that raises is recorded as {"error": {"type": ..., "message": ...}}.
"""
import cmath
import json
import math
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = os.environ.get("PECALC_PATH") or str(HERE.parent.parent / "power-equipment-engineering" / "calculations")
sys.path.insert(0, ROOT)

from pecalc import ampacity as amp  # noqa: E402
from pecalc import conductors as cond  # noqa: E402
from pecalc import field as fld  # noqa: E402
from pecalc import forces as frc  # noqa: E402
from pecalc import impedance as imp  # noqa: E402
from pecalc import thermal as thm  # noqa: E402
from pecalc import validate as val  # noqa: E402
from pecalc import reactance_derived as rxd  # noqa: E402



def enc(x):
    if isinstance(x, complex):
        return {"__c": [enc(x.real), enc(x.imag)]}
    if isinstance(x, float):
        if math.isnan(x):
            return {"__f": "nan"}
        if math.isinf(x):
            return {"__f": "inf" if x > 0 else "-inf"}
        return x
    if isinstance(x, (list, tuple)):
        return [enc(v) for v in x]
    if isinstance(x, dict):
        return {str(k): enc(v) for k, v in x.items()}
    return x


V = {}


def rec(fn, inputs, call):
    entry = {"in": enc(inputs)}
    try:
        entry["out"] = enc(call())
    except Exception as e:  # noqa: BLE001 - record any error type/message
        entry["error"] = {"type": type(e).__name__, "message": str(e)}
    V.setdefault(fn, []).append(entry)


def cx(z):
    return complex(z)


# ---------------------------------------------------------------- conductors
ALL = list(cond.SIZES)
for s in ["500", "500 kcmil", "#2", "2 AWG", "4/0", " 750 MCM ", "123", "", "1/0 awg", 4, "abc'd"]:
    rec("normalize_size", {"size": s}, lambda s=s: cond.normalize_size(s))
for s in ALL:
    rec("size_label", {"size": s}, lambda s=s: cond.size_label(s))
    rec("size_index", {"size": s}, lambda s=s: cond.size_index(s))
    rec("area_mm2", {"size": s}, lambda s=s: cond.area_mm2(s))
    rec("diameter_mm", {"size": s}, lambda s=s: cond.diameter_mm(s))
    rec("insulation_mm", {"size": s}, lambda s=s: cond.insulation_mm(s))
    rec("cable_od_mm", {"size": s}, lambda s=s: cond.cable_od_mm(s))
    rec("gmr_mm", {"size": s}, lambda s=s: cond.gmr_mm(s))
    for m in ("Cu", "Al"):
        for t in (20.0, 75.0, 90.0):
            rec("rdc_ohm_per_m", {"size": s, "material": m, "temp_c": t},
                lambda s=s, m=m, t=t: cond.rdc_ohm_per_m(s, m, t))
rec("rdc_ohm_per_m", {"size": "500", "material": "Cu"}, lambda: cond.rdc_ohm_per_m("500", "Cu"))
rec("rdc_ohm_per_m", {"size": "500", "material": "Fe"}, lambda: cond.rdc_ohm_per_m("500", "Fe"))
for s in ["14", "6", "1/0", "4/0", "350", "500", "750", "1000", "2000"]:
    for m in ("Cu", "Al"):
        for t in (75.0, 90.0):
            for f in (50.0, 60.0):
                for sp in (None, cond.cable_od_mm(s), 2 * cond.cable_od_mm(s)):
                    rec("rac_ohm_per_m", {"size": s, "material": m, "temp_c": t, "freq": f, "spacing_mm": sp},
                        lambda s=s, m=m, t=t, f=f, sp=sp: cond.rac_ohm_per_m(s, m, t, f, spacing_mm=sp))
    for gmd in (30.0, 60.0, 150.0):
        for f in (50.0, 60.0):
            rec("reactance_ohm_per_m", {"size": s, "gmd_mm": gmd, "freq": f},
                lambda s=s, gmd=gmd, f=f: cond.reactance_ohm_per_m(s, gmd, f))
for rdc in (1e-4, 5e-4, 3e-3):
    for sp in (None, 40.0, 100.0):
        rec("ac_factors", {"rdc": rdc, "freq": 60.0, "d_mm": 25.0, "spacing_mm": sp},
            lambda rdc=rdc, sp=sp: cond.ac_factors(rdc, 60.0, 25.0, sp))
V["conductors_constants"] = enc({
    "SIZES": list(cond.SIZES), "AREA_CMIL": cond.AREA_CMIL, "DIAMETER_IN": cond.DIAMETER_IN,
    "MATERIALS": cond.MATERIALS, "STRANDING_FACTOR": cond.STRANDING_FACTOR, "MU0": cond.MU0,
    "FT": cond.FT, "INCH": cond.INCH, "CMIL_TO_MM2": cond.CMIL_TO_MM2,
})

# ------------------------------------------------------------------ ampacity
for code in ("NEC", "CEC"):
    for inst in ("raceway", "free_air"):
        for m in ("Cu", "Al"):
            for s in ALL:
                for col in (60, 75, 90):
                    rec("table_ampacity", {"code": code, "installation": inst, "material": m, "size": s, "temp_col": col},
                        lambda code=code, inst=inst, m=m, s=s, col=col: amp.table_ampacity(code, inst, m, s, col))
    for inst in ("raceway", "free_air", "bogus"):
        rec("table_info", {"code": code, "installation": inst},
            lambda code=code, inst=inst: vars(amp.table_info(code, inst)))
    for allow in (False, True):
        rec("check_status", {"code": code, "allow_placeholder_data": allow},
            lambda code=code, allow=allow: amp.check_status(code, allow))
for args in [("XYZ", "raceway", "Cu", "500", 75), ("NEC", "buried", "Cu", "500", 75), ("NEC", "raceway", "Cu", "500", 80),
             ("NEC", "raceway", "Fe", "500", 75), ("NEC", "raceway", "Cu", "7", 75)]:
    rec("table_ampacity", dict(zip(("code", "installation", "material", "size", "temp_col"), args)),
        lambda a=args: amp.table_ampacity(*a))
rec("check_status", {"code": "XYZ", "allow_placeholder_data": False}, lambda: amp.check_status("XYZ", False))
for tc in (60, 75, 90):
    for ta in (-10.0, 0.0, 10.0, 21.0, 30.0, 35.0, 40.0, 45.0, 50.0, 55.0, 60.0, 70.0, 74.9, 75.0, 89.0, 90.0, 95.0):
        rec("ambient_factor", {"ambient_c": ta, "conductor_temp_c": tc}, lambda ta=ta, tc=tc: amp.ambient_factor(ta, tc))
rec("ambient_factor", {"ambient_c": 40.0, "conductor_temp_c": 90, "rated_ambient_c": 40.0},
    lambda: amp.ambient_factor(40.0, 90, 40.0))
rec("ambient_factor", {"ambient_c": 20.0, "conductor_temp_c": 75, "rated_ambient_c": 20.0},
    lambda: amp.ambient_factor(20.0, 75, 20.0))
for code in ("NEC", "CEC"):
    for n in list(range(1, 50)) + [100, 10**6]:
        rec("ccc_factor", {"code": code, "current_carrying": n}, lambda code=code, n=n: amp.ccc_factor(code, n))
rec("ccc_factor", {"code": "XYZ", "current_carrying": 3}, lambda: amp.ccc_factor("XYZ", 3))
V["ampacity_constants"] = enc({"COLUMNS": list(amp.COLUMNS), "CODES": list(amp.CODES),
                               "INSTALLATIONS": list(amp.INSTALLATIONS), "CLAUSES": amp.CLAUSES,
                               "PARALLEL_MIN": amp.PARALLEL_MIN})


# ----------------------------------------------------------------- impedance
def cj(c):
    return {"x_mm": c.x_mm, "y_mm": c.y_mm, "group": c.group, "r_ohm_per_m": c.r_ohm_per_m, "gmr_mm": c.gmr_mm,
            "tube_radius_mm": c.tube_radius_mm}


def conds_from(lst):
    return [imp.Conductor(d["x_mm"], d["y_mm"], d["group"], d["r_ohm_per_m"], d["gmr_mm"],
                          tube_radius_mm=d.get("tube_radius_mm")) for d in lst]


def gj(groups):
    return {n: {"kind": g.kind, "current": g.current} for n, g in groups.items()}


def flat(pattern, size="750", mat="Cu", temp=90.0, pitch_od=2.0, y=0.0):
    r = cond.rac_ohm_per_m(size, mat, temp)
    g = cond.gmr_mm(size)
    p = pitch_od * cond.cable_od_mm(size)
    return [cj(imp.Conductor(i * p, y, ph, r, g)) for i, ph in enumerate(pattern)]


def trefoil(size="500", s=60.0, per_phase=1):
    r = cond.rac_ohm_per_m(size, "Cu", 90)
    g = cond.gmr_mm(size)
    out = []
    for k in range(per_phase):
        ox = k * 3 * s
        out += [imp.Conductor(ox, 0, "A", r, g), imp.Conductor(ox + s, 0, "B", r, g),
                imp.Conductor(ox + s / 2, s * math.sqrt(3) / 2, "C", r, g)]
    return [cj(c) for c in out]


def stacked(per_phase, size="600", pitch=120.0):
    """Phases side by side, each phase a vertical stack of `per_phase` conductors."""
    r = cond.rac_ohm_per_m(size, "Cu", 90)
    g = cond.gmr_mm(size)
    out = []
    for ph_i, ph in enumerate("ABC"):
        for k in range(per_phase):
            out.append(cj(imp.Conductor(ph_i * pitch, k * pitch, ph, r, g)))
    return out


def shielded(size="500", s=80.0, shield_r=1.2e-4):
    """Three cores each with a concentric bonded shield at the same position, plus a neutral phase group."""
    r = cond.rac_ohm_per_m(size, "Cu", 90)
    g = cond.gmr_mm(size)
    tube = cond.diameter_mm(size) / 2 + 3.0
    out = []
    for k, ph in enumerate("ABC"):
        out.append({"x_mm": k * s, "y_mm": 0.0, "group": ph, "r_ohm_per_m": r, "gmr_mm": g, "tube_radius_mm": None})
        out.append({"x_mm": k * s, "y_mm": 0.0, "group": "S" + ph, "r_ohm_per_m": shield_r, "gmr_mm": tube,
                    "tube_radius_mm": tube})
    return out


LAYOUTS = {
    "1pp_flat": flat("ABC"),
    "2pp_ABCCBA": flat("ABCCBA"),
    "2pp_ABCABC": flat("ABCABC"),
    "2pp_ABCABC_Al": flat("ABCABC", size="500", mat="Al", temp=75.0),
    "3pp_ABCABCABC": flat("ABCABCABC", pitch_od=1.5),
    "3pp_ABCCBAABC": flat("ABCCBAABC"),
    "4pp_ABCCBAABCCBA": flat("ABCCBAABCCBA", size="400"),
    "1pp_trefoil": trefoil(),
    "2pp_trefoil": trefoil("350", 50.0, 2),
    "2pp_stacked": stacked(2),
    "3pp_stacked": stacked(3, "500", 100.0),
    "4pp_stacked": stacked(4, "300", 90.0),
}


def groups_for(layout, i_rms, pf, lagging=True, neutral=False, bonded=()):
    g = imp.balanced_three_phase(i_rms, pf, lagging)
    for n in bonded:
        g[n] = imp.Group(n, "bonded")
    if neutral:
        g["N"] = imp.Group("N", "phase", 0j)
    return g


CASES = []  # (name, layout, i, pf, lagging, freq, soil)
for name in LAYOUTS:
    CASES.append((name, 1500.0, 0.9, True, 60.0, 100.0))
CASES += [("1pp_flat", 800.0, 1.0, True, 50.0, 30.0), ("2pp_ABCABC", 3000.0, 0.8, False, 60.0, 500.0),
          ("3pp_ABCABCABC", 4500.0, 0.95, True, 50.0, 100.0), ("4pp_ABCCBAABCCBA", 6000.0, 0.85, True, 60.0, 100.0),
          ("2pp_stacked", 2000.0, 0.7, True, 60.0, 10.0)]

for name, i_rms, pf, lag, f, soil in CASES:
    cs = LAYOUTS[name]
    groups = groups_for(cs, i_rms, pf, lag)
    inp = {"layout": name, "conductors": cs, "groups": gj(groups), "freq": f, "soil_ohm_m": soil}

    def call(cs=cs, groups=groups, f=f, soil=soil):
        r = imp.solve_sharing(conds_from(cs), groups, f, soil)
        n = len(cs)
        return {
            "currents": r.currents, "group_drop_v_per_m": r.group_drop_v_per_m, "losses_w_per_m": r.losses_w_per_m,
            "share_pct": [r.share_pct(i) for i in range(n)],
            "group_loss_phase": r.group_loss_w_per_m("phase"), "group_loss_bonded": r.group_loss_w_per_m("bonded"),
            "members": {p: r.group_members(p) for p in "ABC"},
        }
    rec("solve_sharing", inp, call)

# Shielded cables: bonded sheaths (circulating currents), and a neutral phase group carrying zero current.
sh = shielded()
for kw in ({"i": 1000.0, "pf": 0.9}, {"i": 400.0, "pf": 1.0}):
    groups = groups_for(sh, kw["i"], kw["pf"], True, bonded=("SA", "SB", "SC"))
    rec("solve_sharing", {"layout": "shielded_3core", "conductors": sh, "groups": gj(groups), "freq": 60.0, "soil_ohm_m": 100.0},
        lambda groups=groups: (lambda r: {
            "currents": r.currents, "group_drop_v_per_m": r.group_drop_v_per_m, "losses_w_per_m": r.losses_w_per_m,
            "group_loss_phase": r.group_loss_w_per_m("phase"), "group_loss_bonded": r.group_loss_w_per_m("bonded"),
            "share_pct": [r.share_pct(i) for i in range(len(sh))],
        })(imp.solve_sharing(conds_from(sh), groups)))
neutral_layout = flat("ABCN")
g = groups_for(neutral_layout, 1000.0, 0.9, True, neutral=True)
rec("solve_sharing", {"layout": "flat_with_neutral", "conductors": neutral_layout, "groups": gj(g), "freq": 60.0,
                      "soil_ohm_m": 100.0},
    lambda: (lambda r: {"currents": r.currents, "group_drop_v_per_m": r.group_drop_v_per_m,
                        "losses_w_per_m": r.losses_w_per_m,
                        "share_pct": [r.share_pct(i) for i in range(4)]})(imp.solve_sharing(conds_from(neutral_layout), g)))
# Error cases.
bad = flat("ABC")
rec("solve_sharing", {"layout": "undefined_group", "conductors": bad, "groups": gj({"A": imp.Group("A", "phase", 1 + 0j)}),
                      "freq": 60.0, "soil_ohm_m": 100.0},
    lambda: imp.solve_sharing(conds_from(bad), {"A": imp.Group("A", "phase", 1 + 0j)}))
same = [{"x_mm": 0.0, "y_mm": 0.0, "group": "A", "r_ohm_per_m": 1e-4, "gmr_mm": 5.0, "tube_radius_mm": None},
        {"x_mm": 0.0, "y_mm": 0.0, "group": "B", "r_ohm_per_m": 1e-4, "gmr_mm": 5.0, "tube_radius_mm": None}]
gg = {"A": imp.Group("A", "phase", 100 + 0j), "B": imp.Group("B", "phase", -100 + 0j)}
rec("solve_sharing", {"layout": "same_position", "conductors": same, "groups": gj(gg), "freq": 60.0, "soil_ohm_m": 100.0},
    lambda: imp.solve_sharing(conds_from(same), gg))
# A phase group with no members and a bonded group: singular system.
gs = {"A": imp.Group("A", "phase", 100 + 0j), "X": imp.Group("X", "phase", 5 + 0j)}
one = [same[0]]
rec("solve_sharing", {"layout": "empty_phase_group", "conductors": one, "groups": gj(gs), "freq": 60.0, "soil_ohm_m": 100.0},
    lambda: imp.solve_sharing(conds_from(one), gs))

for name in ("1pp_flat", "2pp_ABCCBA", "shielded_3core"):
    cs = LAYOUTS.get(name) or sh
    for f, soil in ((60.0, 100.0), (50.0, 20.0)):
        rec("impedance_matrix", {"layout": name, "conductors": cs, "freq": f, "soil_ohm_m": soil},
            lambda cs=cs, f=f, soil=soil: imp.impedance_matrix(conds_from(cs), f, soil))
for f, soil in ((60.0, 100.0), (50.0, 100.0), (60.0, 1.0), (60.0, 2500.0)):
    rec("earth_depth_m", {"freq": f, "soil_ohm_m": soil}, lambda f=f, soil=soil: imp.earth_depth_m(f, soil))
for i_rms, pf, lag, names in [(1000.0, 1.0, True, ["A", "B", "C"]), (1500.0, 0.9, True, ["A", "B", "C"]),
                              (1500.0, 0.9, False, ["R", "Y", "B"]), (250.0, 0.0, True, ["A", "B", "C"]),
                              (250.0, 1.5, True, ["A", "B", "C"]), (250.0, -2.0, False, ["A", "B", "C"])]:
    rec("balanced_three_phase", {"i_rms": i_rms, "pf": pf, "lagging": lag, "names": names},
        lambda i_rms=i_rms, pf=pf, lag=lag, names=names: {n: {"kind": g.kind, "current": g.current} for n, g in
                                                           imp.balanced_three_phase(i_rms, pf, lag, tuple(names)).items()})
# Direct complex solves (hand elimination path; n <= 40).
import random  # noqa: E402

rnd = random.Random(12345)
for n in (1, 2, 3, 5, 8, 13, 21, 34):
    a = [[complex(rnd.uniform(-1, 1), rnd.uniform(-1, 1)) for _ in range(n)] for _ in range(n)]
    for i in range(n):
        a[i][i] += complex(2.0, 0.5)
    b = [complex(rnd.uniform(-5, 5), rnd.uniform(-5, 5)) for _ in range(n)]
    rec("solve_complex", {"a": a, "b": b}, lambda a=a, b=b: imp.solve_complex(a, b))
# A system that needs row swaps (zero on the diagonal).
rec("solve_complex", {"a": [[0j, 1 + 1j], [2 + 0j, 3j]], "b": [1 + 0j, 2 + 0j]},
    lambda: imp.solve_complex([[0j, 1 + 1j], [2 + 0j, 3j]], [1 + 0j, 2 + 0j]))
rec("solve_complex", {"a": [[1 + 0j, 2 + 0j], [2 + 0j, 4 + 0j]], "b": [1 + 0j, 2 + 0j]},
    lambda: imp.solve_complex([[1 + 0j, 2 + 0j], [2 + 0j, 4 + 0j]], [1 + 0j, 2 + 0j]))
V["impedance_constants"] = enc({"MU0_2PI": imp.MU0_2PI})


# -------------------------------------------------------------------- forces
def shares_for(cs, groups, f=60.0, soil=100.0):
    r = imp.solve_sharing(conds_from(cs), groups, f, soil)
    out = []
    for i, c in enumerate(cs):
        g = groups[c["group"]]
        # fraction of the phase current; shields/bonded groups are ignored by fault_forces
        out.append(r.currents[i] / g.current if g.kind == "phase" and g.current else 1.0 + 0j)
    return out


for xr in (1.0, 3.0, 8.0, 15.0, 30.0, 0.5, 0.0, -1.0):
    rec("peak_factor", {"x_over_r": xr, "freq": 60.0}, lambda xr=xr: frc.peak_factor(xr))
flat3 = [{"x_mm": 0.0, "y_mm": 0.0, "group": "A", "r_ohm_per_m": 1e-4, "gmr_mm": 5.0},
         {"x_mm": 300.0, "y_mm": 0.0, "group": "B", "r_ohm_per_m": 1e-4, "gmr_mm": 5.0},
         {"x_mm": 600.0, "y_mm": 0.0, "group": "C", "r_ohm_per_m": 1e-4, "gmr_mm": 5.0}]
tref3 = [{"x_mm": 0.0, "y_mm": 0.0, "group": "A", "r_ohm_per_m": 1e-4, "gmr_mm": 5.0},
         {"x_mm": 100.0, "y_mm": 0.0, "group": "B", "r_ohm_per_m": 1e-4, "gmr_mm": 5.0},
         {"x_mm": 50.0, "y_mm": 86.6025403784, "group": "C", "r_ohm_per_m": 1e-4, "gmr_mm": 5.0}]
FCASES = [("flat3", flat3, None, 50.0, 15.0, {}), ("flat3", flat3, None, 100.0, 30.0, {}),
          ("flat3", flat3, None, 25.0, 8.0, {"freq": 50.0}),
          ("flat3", flat3, None, 65.0, 12.0, {"cycles": 2.0, "steps_per_cycle": 48, "angle_steps": 12}),
          ("trefoil3", tref3, None, 40.0, 20.0, {}),
          ("2pp_ABCCBA", LAYOUTS["2pp_ABCCBA"], 1500.0, 50.0, 15.0, {}),
          ("2pp_ABCABC", LAYOUTS["2pp_ABCABC"], 1500.0, 50.0, 15.0, {}),
          ("3pp_ABCABCABC", LAYOUTS["3pp_ABCABCABC"], 2000.0, 65.0, 20.0, {}),
          ("4pp_stacked", LAYOUTS["4pp_stacked"], 2000.0, 80.0, 12.0, {}),
          ("shielded_3core", sh, 1000.0, 30.0, 10.0, {})]
for name, cs, i_ref, ka, xr, kw in FCASES:
    if i_ref is None:
        share = [1.0 + 0j] * len(cs)
    else:
        groups = groups_for(cs, i_ref, 0.9, True, bonded=("SA", "SB", "SC") if name == "shielded_3core" else ())
        share = shares_for(cs, groups)
    inp = {"layout": name, "conductors": cs, "share": share, "fault_ka_rms": ka, "x_over_r": xr, "opts": kw}

    def call(cs=cs, share=share, ka=ka, xr=xr, kw=kw):
        r = frc.fault_forces(conds_from(cs), {i: s for i, s in enumerate(share)}, ka, xr, **kw)
        return {"peak_n_per_m": r.peak_n_per_m, "worst_index": r.worst_index, "worst_n_per_m": r.worst_n_per_m,
                "peak_current_ka": r.peak_current_ka, "x_over_r": r.x_over_r, "worst_lbf_per_ft": r.worst_lbf_per_ft,
                "body_peak_n_per_m": r.body_peak_n_per_m, "body_peak_xy": r.body_peak_xy}
    rec("fault_forces", inp, call)
# Bodies: a 2-per-phase stack where each phase's pair is one body.
cs = LAYOUTS["2pp_stacked"]
groups = groups_for(cs, 2000.0, 0.9)
share = shares_for(cs, groups)
bodies = {i: c["group"] + "_bar" for i, c in enumerate(cs)}
rec("fault_forces", {"layout": "2pp_stacked_bodies", "conductors": cs, "share": share, "fault_ka_rms": 60.0,
                     "x_over_r": 14.0, "opts": {"bodies": {str(k): v for k, v in bodies.items()}}},
    lambda: (lambda r: {"peak_n_per_m": r.peak_n_per_m, "worst_index": r.worst_index,
                        "worst_n_per_m": r.worst_n_per_m, "peak_current_ka": r.peak_current_ka,
                        "body_peak_n_per_m": r.body_peak_n_per_m, "body_peak_xy": r.body_peak_xy})(
        frc.fault_forces(conds_from(cs), {i: s for i, s in enumerate(share)}, 60.0, 14.0, bodies=bodies)))
V["forces_constants"] = enc({"N_PER_M_TO_LBF_PER_FT": frc.N_PER_M_TO_LBF_PER_FT})

# --------------------------------------------------------------------- field
g1 = imp.balanced_three_phase(1000.0, 1.0)
flat_f = [{"x_mm": -100.0, "y_mm": 0.0, "group": "A", "r_ohm_per_m": 1e-4, "gmr_mm": 5.0},
          {"x_mm": 0.0, "y_mm": 0.0, "group": "B", "r_ohm_per_m": 1e-4, "gmr_mm": 5.0},
          {"x_mm": 100.0, "y_mm": 0.0, "group": "C", "r_ohm_per_m": 1e-4, "gmr_mm": 5.0}]
cur_f = [g1[p].current for p in "ABC"]
pts = [(0.0, 5000.0), (0.0, 1000.0), (500.0, 1000.0), (-1500.0, 300.0), (0.0, 0.0), (100.0, 0.0), (2000.0, -800.0),
       (50.0, 50.0), (0.0, 200.0)]
for x, y in pts:
    rec("b_rms_ut", {"conductors": flat_f, "currents": cur_f, "x_mm": x, "y_mm": y},
        lambda x=x, y=y: fld.b_rms_ut(conds_from(flat_f), cur_f, x, y))
rec("b_rms_ut", {"conductors": [flat_f[0]], "currents": [1000.0], "x_mm": 0.0, "y_mm": 1000.0},
    lambda: fld.b_rms_ut(conds_from([flat_f[0]]), [1000.0], 0.0, 1000.0))
for name in ("2pp_ABCCBA", "3pp_ABCABCABC", "4pp_stacked", "shielded_3core"):
    cs = LAYOUTS.get(name) or sh
    groups = groups_for(cs, 1500.0, 0.9, True, bonded=("SA", "SB", "SC") if name == "shielded_3core" else ())
    r = imp.solve_sharing(conds_from(cs), groups)
    for x, y in ((0.0, 1000.0), (300.0, 600.0), (-800.0, 1500.0), (0.0, -2000.0)):
        rec("b_rms_ut", {"layout": name, "conductors": cs, "currents": r.currents, "x_mm": x, "y_mm": y},
            lambda cs=cs, r=r, x=x, y=y: fld.b_rms_ut(conds_from(cs), r.currents, x, y))
    rec("profile", {"layout": name, "conductors": cs, "currents": r.currents, "y_mm": 1000.0, "x_from_mm": -1500.0,
                    "x_to_mm": 1500.0, "steps": 41},
        lambda cs=cs, r=r: [vars(p) for p in fld.profile(conds_from(cs), r.currents, 1000.0, -1500.0, 1500.0, 41)])
rec("profile", {"conductors": flat_f, "currents": cur_f, "y_mm": 500.0, "x_from_mm": -333.3, "x_to_mm": 777.7, "steps": 7},
    lambda: [vars(p) for p in fld.profile(conds_from(flat_f), cur_f, 500.0, -333.3, 777.7, 7)])
for i_rms, s, d in ((1000.0, 0.1, 5.0), (3000.0, 0.3, 2.0), (500.0, 0.05, 10.0)):
    rec("far_field_flat_ut", {"i_rms": i_rms, "spacing_m": s, "distance_m": d},
        lambda i_rms=i_rms, s=s, d=d: fld.far_field_flat_ut(i_rms, s, d))
V["field_constants"] = enc({"LIMITS_UT": fld.LIMITS_UT, "MU0_2PI": fld.MU0_2PI})

# ------------------------------------------------------------------- thermal
CONSTRS = [
    ("1/0", dict(insulation="XHHW", insulation_mm=cond.insulation_mm("1/0"))),
    ("4/0", dict(insulation="XHHW", insulation_mm=cond.insulation_mm("4/0"))),
    ("500", dict(insulation="XHHW", insulation_mm=cond.insulation_mm("500"))),
    ("750", dict(insulation="XHHW", insulation_mm=cond.insulation_mm("750"))),
    ("1000", dict(insulation="RW90", insulation_mm=cond.insulation_mm("1000"), material="Al")),
    ("500", dict(insulation="XLPE", insulation_mm=4.5, shield_mm=0.2, jacket_mm=2.0, jacket="PVC", voltage_v=5000.0)),
    ("750", dict(insulation="EPR", insulation_mm=7.2, voltage_v=15000.0)),
    ("750", dict(insulation="EPR", insulation_mm=7.2, voltage_v=600.0)),
    ("350", dict(insulation="PVC", insulation_mm=2.0, jacket_mm=1.0, jacket="PE", max_temp_c=75.0)),
    ("250", dict(insulation="UNKNOWN_INS", insulation_mm=2.0)),
    ("2", dict(insulation="XLPE", insulation_mm=1.1, max_temp_c=105.0)),
]


def cable_json(size, kw):
    d = {"size": size}
    d.update(kw)
    return d


for size, kw in CONSTRS:
    c = thm.CableConstruction(size, **kw)
    ci = cable_json(size, kw)
    rec("cable_construction_dims", {"cable": ci},
        lambda c=c: {"dc_mm": c.dc_mm, "di_mm": c.di_mm, "da_mm": c.da_mm, "de_mm": c.de_mm,
                     "shield_mean_diameter_mm": c.shield_mean_diameter_mm})
    for f in (50.0, 60.0):
        rec("dielectric_loss", {"cable": ci, "freq": f}, lambda c=c, f=f: thm.dielectric_loss(c, f))
    for amb in (30.0, 40.0, 50.0, 89.0, 90.0, 95.0):
        for inst in ("isolated", "two_touching", "trefoil_touching", "flat_touching"):
            for l1 in (0.0, 0.3):
                rec("free_air_ampacity", {"cable": ci, "ambient_c": amb, "installation": inst, "lambda1": l1,
                                          "freq": 60.0, "spacing_mm": None},
                    lambda c=c, amb=amb, inst=inst, l1=l1: (lambda r: {**vars(r), "summary": r.summary()})(
                        thm.free_air_ampacity(c, amb, inst, l1)))
    # With proximity (spacing) and 50 Hz.
    rec("free_air_ampacity", {"cable": ci, "ambient_c": 35.0, "installation": "trefoil_touching", "lambda1": 0.1,
                              "freq": 50.0, "spacing_mm": 2 * c.de_mm},
        lambda c=c: (lambda r: {**vars(r), "summary": r.summary()})(
            thm.free_air_ampacity(c, 35.0, "trefoil_touching", 0.1, 50.0, spacing_mm=2 * c.de_mm)))
rec("free_air_ampacity", {"cable": cable_json("500", dict(insulation="XHHW", insulation_mm=1.4)), "ambient_c": 40.0,
                          "installation": "buried", "lambda1": 0.0, "freq": 60.0, "spacing_mm": None},
    lambda: thm.free_air_ampacity(thm.CableConstruction("500", insulation="XHHW", insulation_mm=1.4), 40.0, "buried"))
rec("free_air_ampacity", {"cable": cable_json("500", dict(insulation="MICA", insulation_mm=1.4, jacket_mm=1.0)),
                          "ambient_c": 40.0, "installation": "isolated", "lambda1": 0.0, "freq": 60.0,
                          "spacing_mm": None},
    lambda: thm.free_air_ampacity(thm.CableConstruction("500", insulation="MICA", insulation_mm=1.4, jacket_mm=1.0), 40.0))
# pecalc #10: EPR thermal resistivity follows the cable's rated voltage; voltage validation.
for ins, rv in [("EPR", 600.0), ("EPR", 3000.0), ("EPR", 3001.0), ("EPR", 15000.0), ("XLPE", 600.0),
                ("PVC", 600.0), ("UNKNOWN_INS", 600.0)]:
    rec("insulation_resistivity", {"insulation": ins, "rated_voltage_v": rv},
        lambda ins=ins, rv=rv: thm.insulation_resistivity(ins, rv))
for size, kw in [("500", dict(insulation="EPR", insulation_mm=1.65, voltage_v=600.0)),
                 ("500", dict(insulation="EPR", insulation_mm=4.45, voltage_v=15000.0)),
                 ("500", dict(insulation="EPR", insulation_mm=1.65, voltage_v=600.0, rated_voltage_v=5000.0)),
                 ("500", dict(insulation="EPR", insulation_mm=4.45, voltage_v=15000.0, rated_voltage_v=2400.0)),
                 ("500", dict(insulation="EPR", insulation_mm=1.65, voltage_v=0.0)),
                 ("500", dict(insulation="EPR", insulation_mm=1.65, voltage_v=600.0, rated_voltage_v=-1.0))]:
    c = thm.CableConstruction(size, **kw)
    ci = cable_json(size, kw)
    for inst in ("isolated", "trefoil_touching"):
        rec("free_air_ampacity", {"cable": ci, "ambient_c": 40.0, "installation": inst, "lambda1": 0.0,
                                  "freq": 60.0, "spacing_mm": None},
            lambda c=c, inst=inst: (lambda r: {**vars(r), "summary": r.summary()})(thm.free_air_ampacity(c, 40.0, inst)))
    rec("dielectric_loss", {"cable": ci, "freq": 60.0}, lambda c=c: thm.dielectric_loss(c, 60.0))
V["thermal_constants"] = enc({"THERMAL_RESISTIVITY": thm.THERMAL_RESISTIVITY, "DIELECTRIC": thm.DIELECTRIC,
                              "AIR_CONSTANTS": thm.AIR_CONSTANTS, "EPR_LV_RESISTIVITY": thm.EPR_LV_RESISTIVITY,
                              "EPR_LV_MAX_KV": thm.EPR_LV_MAX_KV})

# ------------------------------------------------------------------ validate (pecalc #10)
for fn in ("voltage", "power_factor", "clearing_time", "x_over_r"):
    for value in (480.0, 1.0, 0.5, 1e-9, 0.0, -1.0, -480.0, 1.2, float("inf"), float("-inf"), float("nan"),
                  "480", " 0.85 ", "abc", None, True):
        rec("validate", {"fn": fn, "name": "some_input", "value": value},
            lambda fn=fn, value=value: getattr(val, fn)("some_input", value))

# --------------------------------------------------------- reactance_derived (pecalc #10)
rec("reactance_derived_table", {}, rxd.derived_table)
for s in rxd.DERIVED_SIZES:
    rec("reactance_floor_per_1000ft", {"size": s}, lambda s=s: rxd.floor_per_1000ft(s))
for rw in rxd.RACEWAYS:
    for s in ["14", "1/0", "500", "600", "700", "750", "800", "900", "1000", "1250", "1500", "1750", "2000"]:
        rec("reactance_per_1000ft", {"size": s, "raceway": rw}, lambda s=s, rw=rw: rxd.reactance_per_1000ft(s, rw))
V["reactance_derived_constants"] = enc({"DERIVED_STATUS": rxd.DERIVED_STATUS, "DERIVED_METHOD": rxd.DERIVED_METHOD,
                                        "RACEWAYS": list(rxd.RACEWAYS), "DERIVED_SIZES": list(rxd.DERIVED_SIZES)})

out = HERE.parent / "tests" / "golden" / "core.json"
out.parent.mkdir(parents=True, exist_ok=True)
doc = {"_meta": {"generator": "scripts/gen_golden_core.py",
                 "note": "Vectors produced by the Python pecalc package; complex values are {__c:[re,im]}, "
                         "non-finite floats are {__f:'inf'|'-inf'|'nan'}.",
                 "counts": {k: len(v) for k, v in V.items() if isinstance(v, list)}},
       "vectors": V}
out.write_text(json.dumps(doc, separators=(",", ":"), allow_nan=False))
total = sum(len(v) for v in V.values() if isinstance(v, list))
print(f"wrote {out} ({total} vectors, {out.stat().st_size / 1024:.0f} KB)")
