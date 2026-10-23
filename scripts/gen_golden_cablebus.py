"""Generate tests/golden/cablebus.json from the Python pecalc cable bus modules.

Usage: python3 scripts/gen_golden_cablebus.py
Set PECALC_ROOT to the pecalc `calculations` directory and PECALC_EXAMPLES to the
`examples` directory if they are not at the defaults below.

Covers cablebus.analyse (LV and MV, Cu/Al, 1-12 conductors per phase, 1-4 tiers, every ampacity
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
    dict(LV, fault_ka=65.0, support_condition="continuous"), dict(LV, fault_ka=65.0, support_condition="pinned"),
    dict(LV, fault_ka=65.0, support_condition="fixed", support_span_m=0.6),
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
# pecalc #12: ICEA P-32-382 conductor short-circuit withstand (needs fault_ka and fault_clearing_s).
extras += [
    dict(LV, fault_ka=50.0, fault_clearing_s=0.5),                                  # 228.94 kA, pass
    dict(LV, size="4/0", conductors_per_phase=1, current_a=300.0, fault_ka=20.0, fault_clearing_s=1.0),  # fail
    dict(LV, material="Al", size="500", conductors_per_phase=4, tiers=2, fault_ka=65.0, fault_clearing_s=0.25,
         insulation_temp_c=75, terminal_temp_c=75, insulation_sc_limit_c=150.0),
    dict(LV, fault_ka=100.0, fault_clearing_s=0.033, x_over_r=25.0),
    dict(LV, fault_ka=42.0),                                                        # no clearing time: skipped
    dict(LV, fault_clearing_s=0.5),                                                 # no fault current: skipped
    dict(LV, fault_ka=50.0, fault_clearing_s=0.0),                                  # error
    dict(LV, fault_ka=50.0, fault_clearing_s=-0.1),                                 # error
    dict(DS, shield_bonding="both_ends", fault_ka=40.0, fault_clearing_s=0.5),
    dict(mvb, fault_ka=40.0, fault_clearing_s=2.0, material="Al", size="500", conductors_per_phase=2),
]
# Shield standing voltage with single-point bonding and the bonding comparison (sheath). Flat ABC hand case:
# 100 mm centres, shield mean radius 20 mm, 1000 A at unity pf -> outer shields 154.269 V/km, middle 121.349 V/km.
SH = dict(voltage_v=15000.0, current_a=1000.0, power_factor=1.0, conductors_per_phase=1, pattern="ABC",
          cable_od_mm=40.0, spacing_mm=100.0, cable_ampacity_a=1200.0, shield_mean_diameter_mm=40.0,
          shield_area_mm2=16.0, length_m=100.0)
extras += [
    dict(SH, shield_bonding="single_point"),                                          # normal load only
    dict(SH, shield_bonding="single_point", fault_ka=20.0),                           # with through-fault
    dict(SH, shield_bonding="both_ends"),                                             # both-ends unchanged + sheath
    dict(SH, shield_bonding="single_point", shield_voltage_limit_v=25.0),             # limit pass
    dict(SH, shield_bonding="single_point", shield_voltage_limit_v=10.0),             # limit fail
    dict(SH, shield_bonding="single_point", shield_section_length_m=30.0, fault_ka=20.0, shield_voltage_limit_v=10.0),
    dict(SH, shield_bonding="both_ends", fault_ka=20.0, shield_voltage_limit_v=10.0),  # comparison only, no check
    dict(SH, shield_bonding="single_point", frequency_hz=50.0, power_factor=0.85),
    dict(SH, shield_bonding="single_point", shield_area_mm2=None),                    # both-ends not compared
    dict(SH, shield_bonding="single_point", shield_mean_diameter_mm=None, shield_area_mm2=None),  # not computed
    dict(SH, shield_bonding="none", shield_voltage_limit_v=25.0),
    dict(SH, shield_bonding="single_point", shield_section_length_m=0.0),              # error
    dict(SH, shield_bonding="single_point", shield_section_length_m=150.0),            # error
    dict(SH, shield_bonding="single_point", shield_voltage_limit_v=-1.0),              # error
    dict(mvb, shield_bonding="single_point", length_m=60.0, fault_ka=40.0, enclosure_width_mm=800.0,
         enclosure_height_mm=150.0, shield_voltage_limit_v=25.0),                    # 15 kV 2000 A job
    dict(mvb, shield_bonding="both_ends", length_m=200.0, fault_ka=40.0, shield_section_length_m=50.0),
    dict(mvb, shield_bonding="single_point", conductors_per_phase=6, tiers=2, current_a=4000.0, length_m=150.0,
         enclosure_width_mm=900.0, enclosure_height_mm=300.0, shield_voltage_limit_v=50.0),
    dict(DS, shield_bonding="single_point", fault_ka=40.0, shield_voltage_limit_v=25.0),
]
# Cable bus review: termination on Table 310.16 for every method, default terminal temperature, tier spacing,
# NOT CHECKED withstand, shield limit note, 600 V wall note, validation, ambient at the conductor rating.
LV480 = dict(voltage_v=480.0, current_a=2000.0, conductors_per_phase=4, size="500", material="Cu")
extras += [
    dict(LV480), dict(LV480, terminal_temp_c=75), dict(LV480, terminal_temp_c=90), dict(LV480, terminal_temp_c=60),
    dict(LV480, terminal_temp_c=75, ampacity_method="datasheet", cable_ampacity_a=700.0),
    dict(LV480, ampacity_method="datasheet", cable_ampacity_a=700.0),
    dict(LV480, ampacity_method="calculated", insulation_mm=2.03, insulation="XHHW"),
    dict(LV480, code="CEC", allow_placeholder_data=True),
    dict(LV480, code="CEC", allow_placeholder_data=True, terminal_temp_c=90),
    dict(LV480, code="CEC"),                                                         # placeholder data, refused
    dict(LV480, material="Al", conductors_per_phase=6),
    dict(LV480, size="2000", conductors_per_phase=2, current_a=900.0),
    dict(voltage_v=2000.0, current_a=1500.0, conductors_per_phase=3, size="750"),
    dict(voltage_v=1000.0, current_a=1000.0, conductors_per_phase=2, size="750"),   # 600 V wall note
    dict(voltage_v=1000.0, current_a=1000.0, conductors_per_phase=2, size="750", cable_od_mm=40.0),
    dict(voltage_v=1000.0, current_a=1000.0, conductors_per_phase=2, size="750", cable_od_mm=10.0),   # error
    dict(voltage_v=600.0, current_a=1000.0, conductors_per_phase=2, size="750"),
    mv_inputs(15000, 3, 1, "750", current_a=2000.0, shield_bonding="single_point", length_m=100.0),
    mv_inputs(15000, 3, 1, "750", current_a=2000.0, shield_bonding="single_point", length_m=100.0,
              shield_voltage_limit_v=1000.0),
    mv_inputs(15000, 3, 1, "750", current_a=2000.0, shield_bonding="single_point", length_m=100.0,
              terminal_temp_c=75),
    mv_inputs(15000, 3, 1, "750", current_a=2000.0, shield_bonding="single_point", length_m=100.0, ambient_c=90.0),
    dict(voltage_v=600.0, current_a=500.0, conductors_per_phase=1, cable_type="dlo_2000v",
         cable_id="southwire_dlo_2000v:444.4", insulation_temp_c=90),               # no Table 310.16 row
    dict(voltage_v=600.0, current_a=2000.0, conductors_per_phase=6, tiers=2, size="500", tier_spacing_mm=40.0),
    dict(voltage_v=600.0, current_a=2000.0, conductors_per_phase=6, tiers=2, size="500"),
    dict(voltage_v=600.0, current_a=2000.0, conductors_per_phase=6, tiers=2, size="500", terminal_temp_c=90,
         ampacity_method="datasheet", cable_ampacity_a=700.0, tier_spacing_mm=40.0),
    dict(voltage_v=600.0, current_a=1000.0, conductors_per_phase=3, size="500"),
    dict(voltage_v=600.0, current_a=1000.0, conductors_per_phase=3, size="500", fault_ka=50.0),
    dict(voltage_v=600.0, current_a=1000.0, conductors_per_phase=3, size="500", fault_ka=10.0, fault_clearing_s=0.1),
    dict(LV480, ambient_c=90.0), dict(LV480, ambient_c=90.0, ampacity_method="datasheet", cable_ampacity_a=600.0),
    dict(LV480, ambient_c=100.0, ampacity_method="calculated", insulation_mm=2.03),
    dict(LV480, current_a=0.0), dict(LV480, current_a=-100.0), dict(LV480, length_m=0.0),
    dict(LV480, frequency_hz=-60.0), dict(LV480, tiers=0), dict(LV480, conductors_per_phase=0),
    dict(LV480, conductors_per_phase=1.5), dict(LV480, fault_ka=-5.0), dict(LV480, voltage_v=0.0),
]
for e in extras:
    vectors.append(run_analyse(e))

# 4 tiers (conductors per phase a multiple of 4: every tier holds complete A-B-C sets), LV and MV, with enclosures
# and faults; plus the errors for counts that cannot be split into 4 tiers.
four = [
    dict(voltage_v=600.0, current_a=2500.0, conductors_per_phase=4, tiers=4, size="750"),
    dict(voltage_v=600.0, current_a=5000.0, conductors_per_phase=8, tiers=4, size="750", length_m=61.0,
         enclosure_width_mm=500.0, enclosure_height_mm=400.0, fault_ka=65.0, x_over_r=15.0),
    dict(voltage_v=600.0, current_a=6000.0, conductors_per_phase=12, tiers=4, size="750", material="Al",
         enclosure_width_mm=700.0, enclosure_height_mm=400.0, covers_continuous=True),
    dict(voltage_v=600.0, current_a=5000.0, conductors_per_phase=8, tiers=4, size="750", pattern="ABCCBA/ABCCBA/ABCCBA/ABCCBA"),
    dict(voltage_v=600.0, current_a=5000.0, conductors_per_phase=8, tiers=4, size="750", spacing_mm=70.0,
         tier_spacing_mm=95.0, enclosure_width_mm=600.0, enclosure_height_mm=450.0),
    mv_inputs(15000, 4, 4, "750", current_a=3000.0, shield_bonding="single_point", length_m=60.0,
              enclosure_width_mm=600.0, enclosure_height_mm=700.0, fault_ka=40.0, shield_voltage_limit_v=25.0),
    mv_inputs(15000, 8, 4, "500", current_a=4000.0, shield_bonding="both_ends", length_m=60.0),
    dict(voltage_v=600.0, conductors_per_phase=6, tiers=4), dict(voltage_v=600.0, conductors_per_phase=3, tiers=4),
    dict(voltage_v=600.0, conductors_per_phase=5, tiers=4), dict(voltage_v=600.0, conductors_per_phase=4, tiers=4,
                                                                 pattern="ABC/ABC/ABC"),
]
for k, e in enumerate(four):
    vectors.append(run_analyse(e, svg_full=(k in (1, 4))))

# 5b. Cable library (DLO 2000 V): standard-size DLO on the code table, non-standard sizes on the printed
# free-air rating, the 1111 kcmil row with its unstated basis, and the refusals (voltage over rating etc.).
DLO = dict(voltage_v=600.0, current_a=1200.0, conductors_per_phase=2, cable_type="dlo_2000v")
dlo_cases = [
    dict(DLO, size="4/0", cable_id="southwire_dlo_2000v:4/0"),                                   # table (standard size)
    dict(DLO, size="4/0", cable_id="southwire_dlo_2000v:4/0", ampacity_method="datasheet"),       # printed 405 A
    dict(DLO, size="4/0", cable_id="southwire_dlo_2000v:4/0", ampacity_method="calculated"),      # error
    dict(DLO, size="2", cable_id="southwire_dlo_2000v:2", current_a=150.0, conductors_per_phase=1, ambient_c=50.0),
    dict(DLO, size="8", cable_id="southwire_dlo_2000v:8", current_a=200.0),                       # parallel minimum fails
    dict(DLO, size="444.4", cable_id="southwire_dlo_2000v:444.4", current_a=1500.0, conductors_per_phase=3,
         ambient_c=40.0),                                                                       # non-standard, datasheet
    dict(DLO, size="444.4", cable_id="southwire_dlo_2000v:444.4", current_a=1500.0, conductors_per_phase=3,
         ambient_c=40.0, fault_ka=42.0, x_over_r=15.0, fault_clearing_s=0.5, length_m=61.0),
    dict(DLO, size="444.4", cable_id="southwire_dlo_2000v:444.4", current_a=1500.0, conductors_per_phase=3,
         ambient_c=40.0, enclosure_width_mm=700.0, enclosure_height_mm=300.0, covers_continuous=True),
    dict(DLO, size="444.4", cable_id="southwire_dlo_2000v:444.4", current_a=1500.0, conductors_per_phase=3,
         cable_ampacity_a=600.0, cable_ampacity_ambient_c=30.0, ambient_c=40.0),                   # user rating
    dict(DLO, size="777.7", cable_id="southwire_dlo_2000v:777.7", current_a=2000.0, conductors_per_phase=3,
         tiers=1, ambient_c=40.0),
    dict(DLO, size="1111", cable_id="awc_dlo_2000v:1111", current_a=1500.0, conductors_per_phase=3,
         ambient_c=40.0),                                                                       # basis not stated
    dict(DLO, size="444.4", cable_id="southwire_dlo_2000v:444.4", current_a=1500.0, conductors_per_phase=3,
         voltage_v=2400.0),                                                                    # error: above 2000 V
    dict(DLO, size="444.4", cable_id="southwire_dlo_2000v:444.4", current_a=1500.0, conductors_per_phase=3,
         material="Al"),                                                                       # error: copper only
    dict(DLO, size="444.4", cable_id="southwire_dlo_2000v:444.4", current_a=1500.0, conductors_per_phase=3,
         insulation_temp_c=75),                                                                # error: 90 C only
    dict(DLO, size="444.4", cable_id="southwire_dlo_2000v:9999", current_a=1500.0),              # error: unknown size
    dict(DLO, size="444.4", current_a=1500.0),                                                   # error: no cable_id
    dict(DLO, size="444.4", cable_id="southwire_dlo_2000v:444.4", current_a=1500.0, conductors_per_phase=3,
         insulation_mm=2.41),                                                                  # error: construction given
    dict(voltage_v=600.0, current_a=1200.0, conductors_per_phase=2, size="750", cable_type="standard",
         cable_id="southwire_dlo_2000v:444.4"),                                                # error: id with standard
]
for k, e in enumerate(dlo_cases):
    vectors.append(run_analyse(e, svg_full=(k == 5)))

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
    dict(voltage_v=600.0, current_a=6000.0, top_n=12), dict(voltage_v=600.0, current_a=5000.0, tier_options=[4]),
    dict(voltage_v=600.0, current_a=3000.0, tier_options=[1, 2, 3]),
    dict(voltage_v=15000.0, current_a=3500.0, **MVD, fault_ka=40.0, tier_options=[2, 4]),
    # Cable bus review: termination cap, clearing time, shield limit, ranking after the block check, validation.
    dict(voltage_v=600.0, current_a=2000.0, sizes=["500"], top_n=20),
    dict(voltage_v=600.0, current_a=2000.0, terminal_temp_c=90),
    dict(voltage_v=600.0, current_a=2000.0, terminal_temp_c=60),
    dict(voltage_v=600.0, current_a=1000.0, fault_ka=100.0, sizes=["500"], fault_clearing_s=0.05),
    dict(voltage_v=600.0, current_a=1000.0, fault_ka=100.0, sizes=["500"], fault_clearing_s=5.0),
    dict(voltage_v=600.0, current_a=1000.0, fault_ka=100.0, sizes=["500"]),
    dict(voltage_v=480.0, current_a=2000.0, fault_ka=100.0, x_over_r=20.0, fault_clearing_s=0.5),
    dict(voltage_v=480.0, current_a=2000.0, fault_ka=100.0, x_over_r=20.0, block_rated_load_n=500.0),
    dict(voltage_v=480.0, current_a=2000.0, fault_ka=100.0, x_over_r=20.0, block_rated_load_n=500.0, top_n=2),
    dict(voltage_v=15000.0, current_a=2000.0, **MVD, shield_voltage_limit_v=0.01),
    dict(voltage_v=15000.0, current_a=2000.0, **MVD, shield_voltage_limit_v=1000.0),
    dict(voltage_v=1000.0, current_a=1000.0, sizes=["750"]),
    dict(voltage_v=1000.0, current_a=1000.0, sizes=["750"], insulation_mm=3.0),
    dict(voltage_v=480.0, current_a=0.0), dict(voltage_v=480.0, current_a=2000.0, length_m=-1.0),
    dict(voltage_v=480.0, current_a=2000.0, frequency_hz=0.0), dict(voltage_v=480.0, current_a=2000.0, tier_options=[0]),
    dict(voltage_v=480.0, current_a=2000.0, tier_options=[]), dict(voltage_v=480.0, current_a=2000.0, fault_ka=-1.0),
    dict(voltage_v=480.0, current_a=2000.0, max_per_phase=0),
    dict(voltage_v=480.0, current_a=2000.0, fault_ka=10.0, fault_clearing_s=-1.0),
    dict(voltage_v=15000.0, current_a=2000.0, **MVD, shield_voltage_limit_v=-5.0),
    dict(voltage_v=480.0, current_a=2000.0, ambient_c=90.0),
    dict(voltage_v=600.0, current_a=2000.0, ampacity_method="calculated", insulation_mm=2.03, insulation="XHHW",
         ambient_c=95.0),
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
