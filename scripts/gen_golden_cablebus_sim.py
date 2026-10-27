"""Generate tests/golden/cablebus_sim.json from the Python pecalc cablebus_sim module.

Usage: PECALC_ROOT=<pecalc worktree>/calculations python scripts/gen_golden_cablebus_sim.py
Covers simulate() (short circuit + temperature rise) over LV/MV, Cu/Al, tiers, shield bonding, enclosure on/off,
closing angles, rating inputs set/unset, plus the stand-alone helpers (I2t closed form, adiabatic temperature,
steady-state cable, enclosure balance, first-peak sweep). Bus patterns are fixed to the one Python selects so that
mirror-image ties cannot differ between the ports.
"""
import json
import math
import os
import sys
from dataclasses import asdict
from pathlib import Path

ROOT = os.environ.get("PECALC_ROOT", str(Path.home() / "Projects/power-equipment-engineering/calculations"))
sys.path.insert(0, ROOT)

from pecalc import conductors as cond  # noqa: E402
from pecalc.cablebus import CableBusInput, analyse  # noqa: E402
from pecalc.cablebus_sim import (SimInput, enclosure_surface_temperature, equivalent_short_time_ka,  # noqa: E402
                                 first_peak_current, heat_capacity_j_per_m_k, i2t_closed_form, simulate,
                                 steady_state_cable)
from pecalc.thermal import CableConstruction  # noqa: E402


def clean(x):
    if isinstance(x, float) and not math.isfinite(x):
        return "Infinity" if x > 0 else "-Infinity" if x < 0 else "NaN"
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    return x


# Base buses pinned to asymmetric CSA 273 Figure 3 arrangements (4-1, 3-1): a mirror-symmetric layout has tied
# worst cables, which floating-point noise can order differently in the two ports.
LV = dict(voltage_v=600.0, current_a=3000.0, conductors_per_phase=4, size="750", fault_ka=50.0,
          fault_clearing_s=0.5, x_over_r=15.0, enclosure_width_mm=800.0, enclosure_height_mm=120.0,
          pattern="ABCABC/CABCAB")
MV = dict(voltage_v=15000.0, current_a=1500.0, conductors_per_phase=3, size="750", pattern="ABCAB/CABC.", insulation="EPR",
          insulation_mm=7.2, shield_mm=0.13, jacket_mm=2.0, fault_ka=31.5, fault_clearing_s=0.25, x_over_r=20.0,
          spacing_mm=100.0)
RATED = dict(tested_momentary_peak_ka=140.0, tested_short_time_ka=63.0, tested_short_time_s=2.0,
             tested_block_load_n=5000.0, tested_force_n_per_m=4000.0, rise_limit_conductor_k=50.0,
             rise_limit_enclosure_k=45.0, rise_limit_termination_k=65.0, termination_rise_k=50.0)
FAIL = dict(tested_momentary_peak_ka=100.0, tested_short_time_ka=20.0, tested_short_time_s=1.0,
            tested_block_load_n=1000.0, tested_force_n_per_m=1000.0, rise_limit_conductor_k=20.0,
            rise_limit_enclosure_k=10.0, rise_limit_termination_k=30.0, termination_rise_k=50.0)

CASES = [
    dict(bus=LV, cycles=2),
    dict(bus=LV, cycles=5, **RATED),
    dict(bus=LV, cycles=2, closing_angle_deg=0.0, **FAIL),
    dict(bus=LV, cycles=2, closing_angle_deg=45.0, initial_temp_c=60.0, load_scale=0.6),
    dict(bus=LV, cycles=2, closing_angle_deg=135.0, load_scale=1.2, enclosure_emissivity=0.9, block_material="GPO-1"),
    dict(bus=dict(LV, conductors_per_phase=1, current_a=700.0, x_over_r=0.05, pattern="ABC"), cycles=2,
         closing_angle_deg=0.0),
    dict(bus=dict(LV, conductors_per_phase=4, tiers=2, enclosure_height_mm=200.0, x_over_r=25.0), cycles=2, **RATED),
    dict(bus=dict(LV, material="Al", size="500", conductors_per_phase=6, tiers=2, pattern="auto", enclosure_height_mm=200.0,
                  insulation_temp_c=75, terminal_temp_c=75, insulation_sc_limit_c=150.0, fault_ka=65.0,
                  fault_clearing_s=0.25), cycles=2, **RATED),
    dict(bus=dict(LV, frequency_hz=50.0, fault_ka=42.0, x_over_r=10.0, ambient_c=30.0), cycles=2),
    dict(bus=dict(LV, fault_clearing_s=None), cycles=2, **RATED),
    dict(bus=dict(LV, fault_ka=None), cycles=2, **RATED),
    dict(bus={k: v for k, v in LV.items() if not k.startswith("enclosure")}, cycles=2, **RATED),
    dict(bus=dict(LV, covers_continuous=True), cycles=2),
    dict(bus=MV, cycles=2),
    dict(bus=dict(MV, shield_bonding="both_ends", shield_area_mm2=16.0, shield_mean_diameter_mm=38.0), cycles=2,
         **RATED),
    dict(bus=dict(MV, shield_bonding="single_point", enclosure_width_mm=900.0, enclosure_height_mm=200.0),
         cycles=2),
    dict(bus=dict(MV, cable_ampacity_a=900.0, ampacity_method="datasheet", shield_bonding="both_ends"), cycles=2),
    dict(bus=dict(LV, spacing_mm=60.0), cycles=2),
    # 3 tiers (Figure 3) and 4 tiers (user pattern, outside Figure 3)
    dict(bus=dict(LV, pattern="ACAC/BBBB/CACA", enclosure_height_mm=300.0), cycles=2, **RATED),
    dict(bus=dict(LV, pattern="+ABCA/BCABC/+ABC.", enclosure_height_mm=300.0, x_over_r=25.0), cycles=2),
    dict(bus=dict(LV, conductors_per_phase=8, pattern="ABCCBA/ABCCBA/ABCCBA/ABCCBA", enclosure_height_mm=400.0,
                  x_over_r=25.0), cycles=2, **RATED),
    dict(bus=dict(LV, pattern="ABC/CAB/BCA/ABC", enclosure_height_mm=300.0, fault_clearing_s=None), cycles=2),
    # errors
    dict(bus=LV, cycles=0.0),
    dict(bus=LV, load_scale=0.0),
    dict(bus=LV, tested_short_time_ka=-1.0),
    dict(bus=LV, enclosure_emissivity=1.5),
    dict(bus=LV, rise_limit_conductor_k=-5.0),
    dict(bus=dict(LV, x_over_r=-1.0)),
    dict(bus=dict(LV, fault_clearing_s=0.0)),
    dict(bus=dict(LV, voltage_v=0.0)),
]


def run(case):
    case = json.loads(json.dumps(case))
    bus = dict(case["bus"])
    try:
        if bus.get("pattern", "auto") == "auto":
            bus["pattern"] = analyse(CableBusInput(**bus), compare_bonding=False).pattern
        case["bus"] = bus
        sim = SimInput(bus=CableBusInput(**bus), **{k: v for k, v in case.items() if k != "bus"})
        return {"inputs": case, "result": clean(simulate(sim))}
    except Exception as e:  # noqa: BLE001
        case["bus"] = bus
        return {"inputs": case, "error": str(e), "error_type": type(e).__name__}


vectors = [run(c) for c in CASES]

# Stand-alone helpers.
helpers = {
    "i2t": [{"amp": a, "th": th, "t": t, "f": f, "xr": xr, "i2t": i2t_closed_form(a, th, t, f, xr)}
            for a, th, t, f, xr in [(70710.0, 0.0, 0.5, 60.0, 15.0), (30000.0, 0.7, 0.1, 60.0, 12.0),
                                    (50000.0, -1.2, 0.05, 50.0, 25.0), (1e5, 2.0, 1.0, 60.0, 0.5)]],
    "adiabatic": [{"material": m, "area_cmil": a, "t1": t1, "i2t": e,
                   "t2": cond.adiabatic_temperature_c(m, a, t1, e)}
                  for m, a, t1, e in [("Cu", 750000, 90.0, 50000.0 ** 2 * 0.5), ("Al", 500000, 75.0, 3e9),
                                      ("Cu", 250000, 60.0, 1e8)]],
    "equivalent": [{"ka": k, "s": s, "to": d, "eq": equivalent_short_time_ka(k, s, d)}
                   for k, s, d in [(63.0, 2.0, 1.0), (40.0, 3.0, 0.5), (89.0, 1.0, 2.0)]],
    "first_peak": [dict(zip(("ka", "xr", "f"), a), **first_peak_current(*a)) for a in
                   [(50.0, 15.0, 60.0), (65.0, 25.0, 60.0), (42.0, 8.0, 50.0), (50.0, 0.05, 60.0)]],
    "enclosure": [dict(zip(("q", "w", "h", "ta", "eps"), a), **enclosure_surface_temperature(*a)) for a in
                  [(400.0, 800.0, 120.0, 40.0, 0.9), (400.0, 800.0, 120.0, 40.0, 0.3),
                   (150.0, 1000.0, 250.0, 30.0, 0.1), (0.0, 800.0, 120.0, 40.0, 0.3)]],
}
cases_c = [
    (CableConstruction("750", "Cu", "XHHW", 2.03, 0.0, 0.0, "PVC", 600.0, 90.0), 700.0, 40.0, "isolated", 0.0),
    (CableConstruction("500", "Al", "XLPE", 1.65, 0.0, 0.0, "PVC", 600.0, 75.0), 300.0, 30.0, "flat_touching", 0.0),
    (CableConstruction("750", "Cu", "EPR", 7.2, 0.13, 2.0, "PVC", 15000.0, 90.0), 600.0, 40.0, "isolated", 0.25),
    (CableConstruction("1000", "Cu", "XLPE", 9.0, 0.13, 2.5, "PVC", 25000.0, 90.0), 0.0, 40.0, "isolated", 0.0),
]
helpers["steady"] = []
for c, i, ta, inst, lam in cases_c:
    ss = steady_state_cable(c, i, ta, inst, lam, 60.0, 90.0)
    caps = heat_capacity_j_per_m_k(c)
    helpers["steady"].append({"construction": asdict(c), "current_a": i, "ambient_c": ta, "installation": inst,
                              "lambda1": lam, "result": clean(ss), "caps": caps})
out = {"_meta": {"source": "pecalc.cablebus_sim (Python)", "generator": "scripts/gen_golden_cablebus_sim.py"},
       "vectors": vectors, "helpers": clean(helpers)}
dest = Path(__file__).resolve().parent.parent / "tests/golden/cablebus_sim.json"
dest.write_text(json.dumps(out, separators=(",", ":")) + "\n")
print(f"wrote {dest} ({dest.stat().st_size / 1e6:.2f} MB): {len(vectors)} vectors "
      f"({sum('error' in v for v in vectors)} errors)")
