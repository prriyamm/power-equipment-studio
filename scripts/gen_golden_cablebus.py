"""Generate tests/golden/cablebus.json from the Python pecalc cable bus modules.

Usage: python3 scripts/gen_golden_cablebus.py
Set PECALC_ROOT to the pecalc `calculations` directory and PECALC_EXAMPLES to the
`examples` directory if they are not at the defaults below.

Covers cablebus.analyse (LV and MV, Cu/Al, 1-6 conductors per phase, 1-3 tiers, every ampacity
method, shield bonding variants, enclosures, faults), candidate_patterns, cablebus_design.design_options
and drawing.cablebus_svg. SVG strings are stored as a SHA-256 hash, with a few full examples.
"""
import hashlib
import itertools
import json
import math
import os
import random
import sys
from dataclasses import asdict
from pathlib import Path

ROOT = os.environ.get("PECALC_ROOT", str(Path.home() / "Projects/power-equipment-engineering/calculations"))
EXAMPLES = Path(os.environ.get("PECALC_EXAMPLES", str(Path(ROOT).parent / "examples")))
sys.path.insert(0, ROOT)

from pecalc.cablebus import CableBusInput, analyse, candidate_patterns, datasheet_shield_derating  # noqa: E402
from pecalc.cablebus_design import DesignRequest, design_options  # noqa: E402
from pecalc.drawing import cablebus_svg  # noqa: E402


def clean(x):
    """JSON-safe: non-finite floats become strings (parsed back by the JS test)."""
    if isinstance(x, float) and not math.isfinite(x):
        return "Infinity" if x > 0 else "-Infinity" if x < 0 else "NaN"
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    return x


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


# Typical MV cable wall (conductor screen + insulation, mm) by system voltage; entered as design inputs.
MV_WALL = {4160: 4.5, 6900: 5.6, 13800: 7.2, 15000: 7.2, 25000: 9.0, 34500: 10.9}
FULL_SVG_EVERY = 40     # keep the full SVG string for every n-th enclosure case


def run_analyse(inputs, svg_full=False):
    try:
        inp = CableBusInput(**inputs)
        r = analyse(inp)
        d = asdict(r)
        d["passed"] = r.passed
        out = {"kind": "analyse", "inputs": inputs, "result": clean(d)}
        if inp.enclosure_width_mm:
            svg = cablebus_svg(inp, r)
            out["svg_sha256"] = sha(svg)
            out["svg_len"] = len(svg)
            if svg_full:
                out["svg"] = svg
        return out
    except Exception as e:  # noqa: BLE001 - ValueError, KeyError, DataStatusError, ZeroDivisionError
        return {"kind": "analyse", "inputs": inputs, "error": str(e), "error_type": type(e).__name__}


def mv_inputs(v, n, tiers, size, **kw):
    d = dict(voltage_v=float(v), conductors_per_phase=n, tiers=tiers, size=size, insulation="EPR",
             insulation_mm=MV_WALL[v], shield_mm=0.13, jacket_mm=2.0)
    d.update(kw)
    return d


vectors = []
rng = random.Random(20260101)

# 1. LV 600 V sweep: current x size x material x layout, table method (code free-air ampacity).
LAYOUTS = [(1, 1), (2, 1), (2, 2), (3, 1), (3, 3), (4, 1), (4, 2), (5, 1), (6, 1), (6, 2), (6, 3)]
combos = list(itertools.product([600.0, 1000.0, 1600.0, 2000.0, 3000.0, 4000.0, 5000.0],
                                ["250", "500", "750", "1000"], ["Cu", "Al"], LAYOUTS))
rng.shuffle(combos)
for k, (cur, size, mat, (n, t)) in enumerate(combos[:110]):
    ins = dict(voltage_v=600.0, current_a=cur, size=size, material=mat, conductors_per_phase=n, tiers=t,
               length_m=float(rng.choice([15, 30, 61, 100])))
    if k % 2 == 0:
        ins["enclosure_width_mm"] = float(rng.choice([450, 600, 760, 915, 1100]))
        ins["enclosure_height_mm"] = float(rng.choice([200, 300, 400]))
        ins["enclosure_alloy"] = rng.choice(["6063-T6", "6061-T6", "1350"])
        ins["covers_continuous"] = bool(k % 4 == 0)
    if k % 5 == 0:
        ins["ampacity_method"] = "table"
    if k % 3 == 0:
        ins["fault_ka"] = float(rng.choice([25, 42, 65, 100]))
        ins["x_over_r"] = float(rng.choice([6, 15, 25]))
    vectors.append(run_analyse(ins, svg_full=(k % FULL_SVG_EVERY == 0)))

# 2. The named reference concepts and edge cases from the Python test-suite.
vectors += [run_analyse(i, svg_full=True) for i in [
    dict(voltage_v=600.0, current_a=4000.0, conductors_per_phase=6, tiers=2, size="750"),
    dict(voltage_v=600.0, current_a=4000.0, conductors_per_phase=6, tiers=2, size="750", length_m=61.0,
         enclosure_width_mm=560.0, enclosure_height_mm=200.0),
    dict(voltage_v=600.0, current_a=3000.0, conductors_per_phase=4, tiers=2, size="750",
         enclosure_width_mm=457.2, enclosure_height_mm=203.2),
]]
vectors += [run_analyse(i) for i in [
    dict(voltage_v=600.0, current_a=4000.0, conductors_per_phase=6, tiers=2, size="750", length_m=61.0,
         enclosure_width_mm=200.0, enclosure_height_mm=200.0),                       # too small
    dict(voltage_v=15000.0, current_a=2000.0, conductors_per_phase=2),               # MV without construction
    dict(voltage_v=600.0, size="3/4"), dict(voltage_v=600.0, pattern="AABBCC"),
    dict(voltage_v=600.0, conductors_per_phase=2, tiers=4), dict(voltage_v=600.0, conductors_per_phase=1, tiers=2),
    dict(voltage_v=600.0, conductors_per_phase=2, pattern="ABC/CBA"), dict(voltage_v=600.0, pattern="ABCXYZ"),
    dict(voltage_v=600.0, ampacity_method="magic"), dict(voltage_v=600.0, ampacity_method="datasheet"),
    dict(voltage_v=600.0, ampacity_method="calculated"),
    dict(voltage_v=600.0, code="CEC"),                                                # placeholder table data
    dict(voltage_v=600.0, code="CEC", allow_placeholder_data=True),
    dict(voltage_v=600.0, code="CEC", allow_placeholder_data=True, material="Al", size="500"),
    dict(voltage_v=600.0, code="XYZ", ampacity_method="datasheet", cable_ampacity_a=400.0),
    dict(voltage_v=4160.0, ampacity_method="table"),
    dict(voltage_v=600.0, enclosure_width_mm=900.0, enclosure_alloy="2024"),
    dict(voltage_v=600.0, shield_bonding="both_ends"),
    dict(voltage_v=600.0, size="2000", conductors_per_phase=1, current_a=300.0),
    dict(voltage_v=600.0, size="2", conductors_per_phase=3, current_a=100.0),         # below parallel minimum
    dict(voltage_v=600.0, material="Fe"),
]]

# 3. Example file (15 kV, 2000 A, 3 x 750 kcmil EPR, both-ends bonded shields, enclosure, 40 kA).
ex = json.loads((EXAMPLES / "cablebus-15kv-2000a.json").read_text())
ex_inputs = {k: (float(v) if isinstance(v, (int, float)) and k not in ("conductors_per_phase", "tiers") else v)
             for k, v in ex["inputs"].items()}
example = run_analyse(ex_inputs, svg_full=True)
example["file"] = "examples/cablebus-15kv-2000a.json"

# 4. MV: voltage class x construction x bonding x layout, calculated and datasheet methods.
mv = list(itertools.product([4160, 6900, 13800, 15000, 25000, 34500], ["500", "750", "1000", "1500"],
                            ["Cu", "Al"], [(2, 1), (3, 1), (3, 3), (4, 2), (6, 2), (6, 3)],
                            ["none", "single_point", "both_ends"]))
rng.shuffle(mv)
for k, (v, size, mat, (n, t), bond) in enumerate(mv[:110]):
    cur = float(rng.choice([800, 1200, 2000, 3000, 4000, 5000]))
    ins = mv_inputs(v, n, t, size, material=mat, current_a=cur, shield_bonding=bond,
                    length_m=float(rng.choice([20, 61, 120])), ambient_c=float(rng.choice([30, 40, 50])))
    if k % 3 == 1:   # datasheet method
        ins["ampacity_method"] = "datasheet"
        ins["cable_ampacity_a"] = float(rng.choice([350, 500, 700, 900]))
        ins["cable_ampacity_ambient_c"] = float(rng.choice([30, 40]))
        ins["cable_od_mm"] = float(rng.choice([38, 45, 52]))
        if bond == "both_ends":
            ins["shield_area_mm2"] = 16.0
            ins["shield_mean_diameter_mm"] = 38.0
    if k % 2 == 0:
        ins["enclosure_width_mm"] = float(rng.choice([800, 1000, 1200]))
        ins["enclosure_height_mm"] = float(rng.choice([250, 400, 500]))
    if k % 4 == 0:
        ins["fault_ka"] = float(rng.choice([25, 40, 63]))
        ins["x_over_r"] = float(rng.choice([10, 15, 30]))
    vectors.append(run_analyse(ins))

# 5. Method / bonding / geometry variants on LV and MV bases.
LV = dict(voltage_v=600.0, current_a=2000.0, size="750", conductors_per_phase=3)
extras = [
    dict(LV, ampacity_method="calculated", insulation_mm=2.03),
    dict(LV, ampacity_method="calculated", insulation_mm=2.03, insulation="XHHW", ambient_c=30.0),
    dict(LV, ampacity_method="datasheet", cable_ampacity_a=600.0),
    dict(LV, ampacity_method="datasheet", cable_ampacity_a=600.0, ambient_c=95.0),
    dict(LV, ampacity_method="datasheet", cable_ampacity_a=600.0, cable_ampacity_ambient_c=30.0, ambient_c=50.0),
    dict(LV, ambient_c=95.0), dict(LV, ambient_c=20.0), dict(LV, insulation_temp_c=75, terminal_temp_c=75),
    dict(LV, insulation_temp_c=60, terminal_temp_c=60), dict(LV, terminal_temp_c=75),
    dict(LV, spacing_mm=30.0), dict(LV, spacing_mm=80.0, tier_spacing_mm=95.0, tiers=1),
    dict(LV, conductors_per_phase=4, tiers=2, spacing_mm=70.0, tier_spacing_mm=110.0),
    dict(LV, pattern="ABCCBA", conductors_per_phase=2), dict(LV, pattern="ABCABC", conductors_per_phase=2),
    dict(LV, pattern="ABCCBA/CBAABC", conductors_per_phase=4, tiers=2),
    dict(LV, pattern="ABCCBA/ABCCBA", conductors_per_phase=4, tiers=2),
    dict(LV, pattern="abcabc/cbacba", conductors_per_phase=4, tiers=2),
    dict(LV, frequency_hz=50.0), dict(LV, power_factor=1.0), dict(LV, power_factor=0.7),
    dict(LV, voltage_v=208.0), dict(LV, voltage_v=2000.0), dict(LV, voltage_v=2001.0, cable_od_mm=40.0,
                                                                  cable_ampacity_a=700.0),
    dict(LV, max_vd_pct=0.1), dict(LV, max_vd_pct=1.0, length_m=300.0),
    dict(LV, cable_od_mm=40.0, cable_ampacity_a=650.0),
    dict(LV, fault_ka=65.0), dict(LV, fault_ka=100.0, x_over_r=30.0, support_span_m=0.6),
    dict(LV, fault_ka=10.0, x_over_r=3.0, frequency_hz=50.0),
    dict(LV, field_distances_m=[0.5, 2.0, 3.0]), dict(LV, field_distances_m=[]),
    dict(LV, current_a=4000.0, conductors_per_phase=6, tiers=3, enclosure_width_mm=560.0, enclosure_height_mm=400.0,
         enclosure_filaments=10), dict(LV, enclosure_width_mm=700.0, enclosure_filaments=2, covers_continuous=True),
    dict(LV, enclosure_width_mm=700.0, enclosure_height_mm=60.0),
    dict(LV, enclosure_width_mm=700.0, enclosure_temp_c=80.0, side_thickness_mm=9.5, cover_thickness_mm=4.0,
         covers_continuous=True),
    dict(LV, code="CEC", allow_placeholder_data=True, material="Al", size="500", conductors_per_phase=4),
    dict(LV, code="CEC", allow_placeholder_data=True, ampacity_method="datasheet", cable_ampacity_a=500.0,
         material="Al", size="1/0"),
    dict(LV, material="Al", size="1/0", conductors_per_phase=2),
    dict(LV, size="500 kcmil"), dict(LV, size="#2", conductors_per_phase=3), dict(LV, size="4/0"),
]
mvb = mv_inputs(15000, 3, 1, "750", current_a=2000.0)
extras += [
    mv_inputs(15000, 2, 1, "750", current_a=2000.0, shield_bonding="single_point", length_m=60.0),
    mv_inputs(15000, 3, 1, "750", current_a=2000.0, shield_bonding="single_point", length_m=60.0),
    mv_inputs(15000, 3, 1, "750", current_a=2000.0, shield_bonding="both_ends", length_m=60.0),
    dict(mvb, shield_bonding="both_ends", shield_area_mm2=20.0, shield_mean_diameter_mm=35.0),
    dict(mvb, shield_bonding="both_ends", shield_temp_c=100.0),
    dict(mvb, shield_bonding="both_ends", shield_mm=0.0),                      # missing shield data
    dict(mvb, shield_bonding="both_ends", conductors_per_phase=6, tiers=2, current_a=4000.0,
         enclosure_width_mm=900.0, enclosure_height_mm=300.0),
    dict(mvb, ampacity_method="table"), dict(mvb, ampacity_method="calculated", insulation_mm=None),
    dict(mvb, jacket_mm=0.0), dict(mvb, shield_mm=0.0, jacket_mm=0.0), dict(mvb, insulation="XLPE"),
    dict(mvb, insulation="PVC"), dict(mvb, insulation="BAD"), dict(mvb, jacket="XLPE", jacket_mm=3.0),
    dict(mvb, ambient_c=95.0), dict(mvb, spacing_mm=200.0), dict(mvb, spacing_mm=90.0),
    dict(mvb, frequency_hz=50.0, current_a=1500.0),
    dict(mvb, fault_ka=40.0, enclosure_width_mm=800.0, enclosure_height_mm=150.0, shield_bonding="both_ends",
         length_m=61.0),
]
# pecalc #9: phase-invariant voltage drop. The same physical bus with the phases relabelled must give the same
# vd_pct (PR #9 table), also with both-ends-bonded shields.
LV750 = dict(voltage_v=600.0, size="750", material="Cu", tiers=1)
for p in ("ABC", "BCA", "CAB", "ACB"):
    extras.append(dict(LV750, current_a=600.0, conductors_per_phase=1, length_m=150.0, pattern=p))
for p in ("ABCCBA", "BCAACB", "CABBAC"):
    extras.append(dict(LV750, current_a=1200.0, conductors_per_phase=2, length_m=100.0, pattern=p))
for p in ("ABCCBA", "BCAACB", "CABBAC"):
    extras.append(dict(mvb, shield_bonding="both_ends", conductors_per_phase=2, length_m=120.0, pattern=p))
extras += [dict(LV750, current_a=600.0, conductors_per_phase=1, length_m=150.0, power_factor=0.8),
           dict(LV750, current_a=600.0, conductors_per_phase=1, length_m=150.0, power_factor=1.0),
           dict(LV750, current_a=1200.0, conductors_per_phase=2, length_m=100.0, frequency_hz=50.0, power_factor=0.95)]
# pecalc #9: datasheet ampacity derated for shield circulating current with both-ends bonding (PR #9 example).
DS = dict(voltage_v=15000.0, current_a=2000.0, conductors_per_phase=3, size="750", cable_od_mm=45.0,
          cable_ampacity_a=900.0, shield_area_mm2=16.0, shield_mean_diameter_mm=38.0)
extras += [
    dict(DS, shield_bonding="single_point"),
    dict(DS, shield_bonding="both_ends"),
    dict(DS, shield_bonding="both_ends", cable_ampacity_lambda1_ref=0.1),
    dict(DS, shield_bonding="both_ends", cable_ampacity_lambda1_ref=0.6),          # capped at 1
    dict(DS, shield_bonding="both_ends", cable_ampacity_lambda1_ref=-0.1),         # error
    dict(DS, shield_bonding="both_ends", shield_area_mm2=50.0, current_a=1500.0),  # small derating, no warning
    dict(DS, shield_bonding="both_ends", conductors_per_phase=4, tiers=2, enclosure_width_mm=900.0,
         enclosure_height_mm=300.0, fault_ka=40.0),
    dict(DS, shield_bonding="none"),
]
for e in extras:
    vectors.append(run_analyse(e))

# 6. candidate_patterns
patterns = []
for n, t in itertools.product(range(1, 13), (1, 2, 3, 4, 6)):
    try:
        patterns.append({"n": n, "tiers": t, "patterns": candidate_patterns(n, t)})
    except ValueError as e:
        patterns.append({"n": n, "tiers": t, "error": str(e)})

# 7. design_options
MVD = dict(insulation="EPR", insulation_mm=7.2, shield_mm=0.13, jacket_mm=2.0)
REQUESTS = [
    dict(voltage_v=600.0, current_a=4000.0), dict(voltage_v=600.0, current_a=600.0),
    dict(voltage_v=600.0, current_a=1200.0, material="Al"), dict(voltage_v=600.0, current_a=2500.0, top_n=4),
    dict(voltage_v=600.0, current_a=5000.0, sizes=["750", "1000", "1500"], max_per_phase=8),
    dict(voltage_v=600.0, current_a=4000.0, sizes=["500"], top_n=20),
    dict(voltage_v=600.0, current_a=3000.0, fault_ka=65.0, x_over_r=20.0),
    dict(voltage_v=600.0, current_a=4000.0, fault_ka=100.0, x_over_r=30.0, block_rated_load_n=500.0),
    dict(voltage_v=600.0, current_a=2000.0, fault_ka=42.0, block_material="GPO-1", block_safety_factor=3.0),
    dict(voltage_v=600.0, current_a=2000.0, fault_ka=42.0, block_material="XYZ"),
    dict(voltage_v=600.0, current_a=3000.0, tier_options=[1], ambient_c=30.0),
    dict(voltage_v=600.0, current_a=3000.0, tier_options=[2, 3], covers_continuous=True),
    dict(voltage_v=600.0, current_a=3500.0, enclosure_widths_in=[24, 36], enclosure_heights_in=[8, 12]),
    dict(voltage_v=600.0, current_a=800.0, sizes=["250", "350"], max_per_phase=3),
    dict(voltage_v=600.0, current_a=2000.0, ampacity_method="calculated", insulation_mm=2.03, insulation="XHHW"),
    dict(voltage_v=600.0, current_a=2000.0, ampacity_method="datasheet"),             # needs a rating: error
    dict(voltage_v=480.0, current_a=3000.0, frequency_hz=50.0, power_factor=0.8, length_m=120.0, max_vd_pct=2.0),
    dict(voltage_v=600.0, current_a=2000.0, code="CEC", allow_placeholder_data=True, material="Al"),
    dict(voltage_v=600.0, current_a=2000.0, code="CEC"),
    dict(voltage_v=15000.0, current_a=2000.0, **MVD, fault_ka=40.0),
    dict(voltage_v=15000.0, current_a=2000.0, **MVD, fault_ka=40.0, shield_bonding="both_ends"),
    dict(voltage_v=15000.0, current_a=3000.0, **MVD, sizes=["750", "1000", "1500"], shield_bonding="single_point"),
    dict(voltage_v=15000.0, current_a=2000.0),
    dict(voltage_v=5000.0, current_a=1200.0, insulation="EPR", insulation_mm=4.5, shield_mm=0.13, jacket_mm=2.0),
    dict(voltage_v=25000.0, current_a=2500.0, insulation="XLPE", insulation_mm=9.0, shield_mm=0.13, jacket_mm=2.0,
         fault_ka=31.5, support_span_m=0.6),
    dict(voltage_v=34500.0, current_a=1600.0, insulation="EPR", insulation_mm=10.9, shield_mm=0.13, jacket_mm=2.5,
         fault_ka=25.0, material="Al"),
    dict(voltage_v=15000.0, current_a=2000.0, **MVD, ampacity_method="datasheet"),
    dict(voltage_v=600.0, current_a=4000.0, sizes=["bad"]),
    dict(voltage_v=600.0, current_a=100000.0), dict(voltage_v=600.0, current_a=4000.0, max_loading_pct=60.0),
]
designs = []
for rq in REQUESTS:
    try:
        r = design_options(DesignRequest(**rq))
        designs.append({"request": rq, "result": clean(asdict(r))})
    except Exception as e:  # noqa: BLE001
        designs.append({"request": rq, "error": str(e), "error_type": type(e).__name__})

# 8. datasheet_shield_derating (pecalc #9)
derating = []
for lam, ref in [(0.0, 0.0), (0.21, 0.0), (0.21, 0.1), (0.44, 0.0), (0.1, 0.21), (1.5, 0.0), (0.0, 0.3),
                 (-0.1, 0.0), (0.2, -0.05)]:
    try:
        derating.append({"lambda1": lam, "lambda1_ref": ref, "factor": datasheet_shield_derating(lam, ref)})
    except ValueError as e:
        derating.append({"lambda1": lam, "lambda1_ref": ref, "error": str(e)})

out = {"_meta": {"source": "pecalc.cablebus, cablebus_design, drawing (Python)",
                 "generator": "scripts/gen_golden_cablebus.py"},
       "vectors": vectors, "example": example, "patterns": patterns, "designs": designs,
       "datasheet_shield_derating": derating}
dest = Path(__file__).resolve().parent.parent / "tests/golden/cablebus.json"
dest.write_text(json.dumps(out, separators=(",", ":")) + "\n")
n_err = sum("error" in v for v in vectors)
n_svg = sum("svg_sha256" in v for v in vectors)
n_full = sum("svg" in v for v in vectors)
print(f"wrote {dest} ({dest.stat().st_size / 1e6:.2f} MB): {len(vectors)} analyse vectors "
      f"({n_err} expected errors, {n_svg} svg hashes, {n_full} full svgs) + example + {len(patterns)} pattern sets "
      f"+ {len(designs)} design runs ({sum('error' in d for d in designs)} errors)")
