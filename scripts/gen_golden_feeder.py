"""Generate tests/golden/feeder.json from the Python pecalc sizing and lugs modules.

Usage: python3 scripts/gen_golden_feeder.py
Set PECALC_ROOT to the pecalc `calculations` directory and PECALC_EXAMPLES to the
`examples` directory if they are not at the defaults below.
"""
import itertools
import json
import math
import os
import sys
from dataclasses import asdict
from pathlib import Path

ROOT = os.environ.get("PECALC_ROOT", str(Path.home() / "Projects/power-equipment-engineering/calculations"))
EXAMPLES = Path(os.environ.get("PECALC_EXAMPLES", str(Path(ROOT).parent / "examples")))
sys.path.insert(0, ROOT)

from pecalc.ampacity import DataStatusError  # noqa: E402
from pecalc.lugs import LugInput, default_terminal_temp, select_lugs, stud_for  # noqa: E402
from pecalc.sizing import FeederInput, size_feeder  # noqa: E402

FLOAT_FIELDS = ("voltage_v", "continuous_a", "noncontinuous_a", "length_m", "ambient_c", "power_factor",
                "max_vd_pct", "frequency_hz", "conductor_temp_for_vd_c", "fault_ka", "fault_clearing_s",
                "insulation_sc_limit_c", "circuit_current_a")


def floats(d):
    """Python str(float) is used inside note strings, so pass float values as floats."""
    return {k: float(v) if k in FLOAT_FIELDS and v is not None else v for k, v in d.items()}


def clean(x):
    if isinstance(x, float) and not math.isfinite(x):
        return "Infinity" if x > 0 else "-Infinity" if x < 0 else "NaN"
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    return x


def run_feeder(inputs):
    inputs = floats(inputs)
    try:
        r = size_feeder(FeederInput(**inputs))
        d = asdict(r)
        for o in [d["recommended"]] + d["alternatives"]:
            if o:
                o["passed"] = all(c["passed"] for c in o["checks"])
        if r.lugs is not None:
            d["lugs"]["passed"] = r.lugs.passed
        return {"kind": "feeder", "inputs": inputs, "result": clean(d)}
    except (ValueError, KeyError, DataStatusError) as e:
        return {"kind": "feeder", "inputs": inputs, "error": str(e)}


def run_lug(inputs):
    inputs = floats(inputs)
    try:
        r = select_lugs(LugInput(**inputs))
        d = asdict(r)
        d["passed"] = r.passed
        return {"kind": "lug", "inputs": inputs, "result": clean(d)}
    except (ValueError, KeyError) as e:
        return {"kind": "lug", "inputs": inputs, "error": str(e)}


vectors = []
# Sweep: voltage x load x material, alternating continuous / non-continuous, ambient, grouping, lengths.
VOLTS = [(120.0, 1), (208.0, 3), (240.0, 1), (240.0, 3), (480.0, 3), (600.0, 3)]
LOADS = [15, 30, 60, 100, 200, 400, 800, 1200, 2000, 3000, 4000]
AMBS = [20.0, 30.0, 40.0, 50.0]
LENS = [5.0, 30.48, 75.0, 150.0, 300.0]
PFS = [0.8, 0.85, 0.95, 1.0]
n = 0
for (v, ph), amps, mat in itertools.product(VOLTS, LOADS, ("Cu", "Al")):
    if ph == 1 and amps > 400:
        continue
    ins = {"voltage_v": v, "phases": ph, "material": mat, "length_m": LENS[n % 5],
           "ambient_c": AMBS[n % 4], "power_factor": PFS[n % 4],
           "current_carrying_per_raceway": (3, 6, 9, 12)[n % 4]}
    if n % 3 == 0:
        ins["continuous_a"] = float(amps)
    elif n % 3 == 1:
        ins["noncontinuous_a"] = float(amps)
    else:
        ins["continuous_a"] = amps * 0.6
        ins["noncontinuous_a"] = amps * 0.4
    if n % 5 == 0:
        ins["installation"] = "free_air"
    if n % 7 == 0:
        ins["insulation_temp_c"] = 75
    if n % 11 == 0:
        ins["terminal_temp_c"] = 60 if amps < 800 else 90
    if n % 4 == 0:
        ins["fault_ka"] = (10.0, 22.0, 42.0, 65.0)[(n // 4) % 4]
        ins["fault_clearing_s"] = (0.05, 0.1, 0.5, 1.0)[(n // 4) % 4]
    if n % 6 == 0:
        ins["conduit"] = ("pvc", "aluminum", "steel")[(n // 6) % 3]
    vectors.append(run_feeder(ins))
    n += 1

# Forced sets, max sets, 100 % rated, thermoplastic limit, 50 Hz, VD temperature, tight VD.
extras = [
    {"continuous_a": 400.0, "length_m": 30.48, "sets": 1},
    {"continuous_a": 400.0, "length_m": 30.48, "sets": 2},
    {"continuous_a": 400.0, "length_m": 30.48, "sets": 3},
    {"continuous_a": 100.0, "length_m": 10.0, "sets": 2},
    {"continuous_a": 200.0, "length_m": 100.0, "sets": 1, "power_factor": 1.0},
    {"continuous_a": 800.0, "hundred_percent_rated": True},
    {"continuous_a": 800.0, "hundred_percent_rated": False},
    {"continuous_a": 400.0, "max_sets": 1},
    {"continuous_a": 4000.0, "max_sets": 2},
    {"continuous_a": 4000.0, "max_sets": 12},
    {"continuous_a": 400.0, "insulation_sc_limit_c": 150.0, "insulation_temp_c": 75, "fault_ka": 30.0, "fault_clearing_s": 0.2},
    {"continuous_a": 400.0, "frequency_hz": 50.0, "voltage_v": 400.0},
    {"continuous_a": 400.0, "conductor_temp_for_vd_c": 90.0, "max_vd_pct": 2.0, "length_m": 200.0},
    {"continuous_a": 400.0, "max_vd_pct": 0.5, "length_m": 500.0},
    {"continuous_a": 400.0, "ambient_c": 85.0},
    {"continuous_a": 400.0, "ambient_c": 90.0},
    {"continuous_a": 400.0, "ambient_c": 95.0},
    {"continuous_a": 250.0, "current_carrying_per_raceway": 24, "ambient_c": 45.0},
    {"continuous_a": 250.0, "current_carrying_per_raceway": 45},
    {"continuous_a": 100.0, "terminal_temp_c": 75},
    {"continuous_a": 100.0, "terminal_temp_c": 90},
    {"continuous_a": 100.0},
    {"continuous_a": 101.0},
    {"continuous_a": 600.0, "material": "Al", "fault_ka": 50.0, "fault_clearing_s": 0.5},
    {"continuous_a": 600.0, "material": "Al", "installation": "free_air", "ambient_c": 50.0},
    {"continuous_a": 15.0, "voltage_v": 120.0, "phases": 1, "length_m": 40.0},
    {"continuous_a": 400.0, "fault_ka": 100.0, "fault_clearing_s": 2.0},
    {"continuous_a": 400.0, "fault_ka": 0.0, "fault_clearing_s": 2.0},
    {"noncontinuous_a": 90.0, "continuous_a": 10.0},
    {"continuous_a": 3.0},
    # CEC: placeholder data is refused unless allowed.
    {"code": "CEC", "continuous_a": 100.0},
    {"code": "CEC", "continuous_a": 400.0, "allow_placeholder_data": True},
    {"code": "CEC", "continuous_a": 400.0, "allow_placeholder_data": True, "sets": 2, "material": "Al"},
    {"code": "CEC", "continuous_a": 800.0, "allow_placeholder_data": True, "hundred_percent_rated": True, "ambient_c": 40.0},
    {"code": "CEC", "continuous_a": 1200.0, "allow_placeholder_data": True, "current_carrying_per_raceway": 12,
     "installation": "free_air", "fault_ka": 25.0, "fault_clearing_s": 0.5},
    # Errors.
    {"code": "IEC", "continuous_a": 100.0},
    {"material": "Fe", "continuous_a": 100.0},
    {"continuous_a": 0.0},
    {"continuous_a": -5.0},
    {"continuous_a": 100.0, "voltage_v": 4160.0},
    {"continuous_a": 100.0, "installation": "buried"},
    {"continuous_a": 100.0, "conduit": "wood"},
    {"continuous_a": 100.0, "installation": "free_air", "conduit": "wood"},
    {"continuous_a": 100.0, "terminal_temp_c": 80},
    {"continuous_a": 100.0, "insulation_temp_c": 105},
]
for e in extras:
    vectors.append(run_feeder(e))

# The shipped example.
ex = json.loads((EXAMPLES / "feeder-480v-400a.json").read_text())
example = run_feeder(ex["inputs"])
example["file"] = "examples/feeder-480v-400a.json"

# Lug cases.
lug_vectors = []
for size, amps in [("14", 15), ("10", 30), ("8", 40), ("6", 65), ("4", 85), ("2", 115), ("1", 130), ("1/0", 150),
                   ("4/0", 230), ("250", 255), ("500", 380), ("750", 475), ("1000", 545), ("2000", 700)]:
    for mat in ("Cu", "Al"):
        for term in ("bus", "stud", "breaker"):
            lug_vectors.append(run_lug({"size": size, "material": mat, "circuit_current_a": amps, "termination": term}))
lug_vectors += [run_lug(x) for x in [
    {"size": "500", "sets_per_phase": 4, "circuit_current_a": 1600, "neutral": True, "ground_size": "3/0", "pad_positions": 2},
    {"size": "750", "sets_per_phase": 6, "circuit_current_a": 4000, "pad_positions": 2},
    {"size": "750", "sets_per_phase": 4, "circuit_current_a": 2000, "pad_positions": 2, "pad_two_sided": False},
    {"size": "750", "sets_per_phase": 2, "circuit_current_a": 2000, "pad_positions": 1, "pad_two_sided": False},
    {"size": "750", "sets_per_phase": 3, "circuit_current_a": 2000, "pad_positions": 1, "termination": "breaker"},
    {"size": "4", "sets_per_phase": 2, "circuit_current_a": 150},
    {"size": "500", "neutral": True, "neutral_size": "250", "circuit_current_a": 400, "material": "Al"},
    {"size": "500", "equipment_terminal_temp_c": 90, "circuit_current_a": 90},
    {"size": "500", "equipment_terminal_temp_c": 60, "circuit_current_a": 400, "code": "CEC"},
    {"size": "1", "circuit_current_a": 400, "code": "CEC"},
    {"size": "500", "circuit_current_a": 100},
    {"size": "500", "circuit_current_a": 100.5},
    {"size": "#2", "circuit_current_a": 100},
    {"size": "500 kcmil", "circuit_current_a": 400, "phases": 1, "sets_per_phase": 2},
    {"size": "3/0", "ground_size": "6", "circuit_current_a": 200, "sets_per_phase": 2, "termination": "stud"},
    {"size": "9999", "circuit_current_a": 100},
    {"size": "500", "ground_size": "abc", "circuit_current_a": 100},
    {"size": "500", "neutral": True, "neutral_size": "zz", "circuit_current_a": 100},
]]
# The feeder example's lug case.
lug_vectors.append(run_lug({"size": "900", "circuit_current_a": 400.0, "equipment_terminal_temp_c": 75}))

helpers = {
    "default_terminal_temp": [[c, a, s, list(default_terminal_temp(c, a, s))] for c, a, s in
                              [("NEC", 90, "4"), ("NEC", 400, "500"), ("CEC", 400, "1"), ("NEC", 100, "500"),
                               ("NEC", 101, "2"), ("NEC", 101, "1/0"), ("CEC", 50, "250")]],
    "stud_for": [[s, list(stud_for(s))] for s in ("14", "8", "6", "2", "1", "1/0", "500", "2000", "#4", "250 kcmil")],
}

out = {"_meta": {"source": "pecalc.sizing + pecalc.lugs (Python)", "generator": "scripts/gen_golden_feeder.py"},
       "vectors": vectors, "lug_vectors": lug_vectors, "example": example, "helpers": helpers}
dest = Path(__file__).resolve().parent.parent / "tests/golden/feeder.json"
dest.write_text(json.dumps(out, indent=1) + "\n")
n_err = sum("error" in v for v in vectors + lug_vectors)
print(f"wrote {dest}: {len(vectors)} feeder + {len(lug_vectors)} lug vectors ({n_err} expected errors) + example + helpers")
