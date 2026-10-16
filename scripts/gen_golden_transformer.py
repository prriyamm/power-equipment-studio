"""Generate tests/golden/transformer.json from the Python pecalc transformer module.

Usage: python3 scripts/gen_golden_transformer.py
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

from pecalc.transformer import (TransformerInput, design, design_for_impedance,  # noqa: E402
                                doe_efficiency_check, next_standard_kva, rogowski_factor, specific_core_loss)

# Fixed DOE manufacture date for every vector that does not set one, so the golden does not depend on the
# day it is generated or run (doe_date None means "today").
DOE_DATE = "2026-10-16"


def clean(x):
    """JSON-safe: non-finite floats become strings (parsed back by the JS test)."""
    if isinstance(x, float) and not math.isfinite(x):
        return "Infinity" if x > 0 else "-Infinity" if x < 0 else "NaN"
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    return x


def run(kind, inputs):
    inputs = {**inputs, "doe_date": inputs.get("doe_date", DOE_DATE)}
    try:
        inp = TransformerInput(**inputs)
        r = design_for_impedance(inp) if kind == "tuned" else design(inp)
        d = asdict(r)
        d["passed"] = r.passed
        return {"kind": kind, "inputs": inputs, "result": clean(d)}
    except (ValueError, ZeroDivisionError) as e:
        return {"kind": kind, "inputs": inputs, "error": str(e)}


vectors = []
# Sweep: kVA x HV x LV, Cu and Al, liquid and dry.
KVAS = [75, 150, 300, 500, 1000, 1500, 2500, 5000, 7500, 10000]
HVS = [4160, 13800, 25000, 34500]
LVS = [208, 480, 600, 4160]
for kva, hv, lv in itertools.product(KVAS, HVS, LVS):
    if lv >= hv:
        continue
    cond = "Al" if (kva // 25 + hv // 1000 + lv) % 3 == 0 else "Cu"
    kind = "dry" if (kva + lv) % 7 == 0 and kva <= 3000 else "liquid"
    ins = {"kva": float(kva), "hv_v": float(hv), "lv_v": float(lv), "conductor": cond, "kind": kind}
    if cond == "Al":
        ins["k_et"] = 0.37
    vectors.append(run("design", ins))

# Winding connections, frequency, overrides, fill factors, source impedance, edge cases.
extras = [
    {"kva": 1500.0, "hv_connection": "wye", "lv_connection": "wye"},
    {"kva": 1500.0, "hv_connection": "delta", "lv_connection": "delta"},
    {"kva": 2000.0, "frequency_hz": 50.0, "lv_v": 400.0, "hv_v": 11000.0},
    {"kva": 750.0, "kw": 0.2, "lv_hv_duct_mm": 20.0, "end_clearance_mm": 40.0, "phase_gap_mm": 25.0},
    {"kva": 1000.0, "reference_temp_c": 75.0, "power_factor": 0.8, "source_mva": 250.0},
    {"kva": 3000.0, "source_mva": 500.0, "fault_duration_s": 1.0, "conductor_proof_mpa": 150.0},
    {"kva": 1500.0, "window_ratio": 1.5}, {"kva": 1500.0, "window_ratio": 6.0},
    {"kva": 1500.0, "b_max_t": 1.7}, {"kva": 1500.0, "b_max_t": 1.9}, {"kva": 1500.0, "b_max_t": 0.9},
    {"kva": 500.0, "b_max_t": 1.35}, {"kva": 500.0, "b_max_t": 1.65},
    {"kva": 1500.0, "j_lv_a_mm2": 4.5, "j_hv_a_mm2": 2.0},
    {"kva": 1500.0, "lv_fill": 0.5, "hv_fill": 0.35, "stray_loss_frac": 0.2, "building_factor": 1.1},
    {"kva": 1500.0, "kind": "dry", "lv_v": 600.0}, {"kva": 1500.0, "kind": "dry", "lv_v": 4160.0, "hv_v": 13800.0},
    {"kva": 1500.0, "conductor": "Al", "k_et": 0.37, "target_z_pct": 6.0},
    {"kva": 1500.0, "target_z_pct": 5.75}, {"kva": 1500.0, "target_z_pct": 9.5, "z_tolerance_pct": 5.0},
    {"kva": 1500.0, "j_lv_a_mm2": 8.0, "j_hv_a_mm2": 8.0},   # thermal check fails
    {"kva": 1500.0, "window_ratio": 0.3},                       # window too short / winding does not fit
    {"kva": 1500.0, "kind": "froggy"}, {"kva": 1500.0, "conductor": "Fe"},
    # pecalc #10: source impedance added as a phasor with its own X/R.
    {"kva": 1500.0, "source_mva": 50.0, "source_x_over_r": 1.0},
    {"kva": 1500.0, "source_mva": 50.0},
    {"kva": 1500.0, "source_mva": 500.0, "source_x_over_r": 25.0},
    {"kva": 2500.0, "source_mva": 150.0, "source_x_over_r": 4.5, "kind": "dry"},
    # pecalc #10: DOE test point by primary (HV) voltage: liquid 50 %, dry <= 600 V primary 35 %, else 50 %.
    {"kva": 1500.0, "kind": "dry", "hv_v": 13800.0, "lv_v": 480.0, "doe_min_efficiency_pct": 99.0},
    {"kva": 1500.0, "kind": "liquid", "hv_v": 13800.0, "lv_v": 480.0, "doe_min_efficiency_pct": 99.0},
    {"kva": 75.0, "kind": "dry", "hv_v": 480.0, "lv_v": 208.0, "doe_min_efficiency_pct": 98.0},
    {"kva": 150.0, "kind": "dry", "hv_v": 600.0, "lv_v": 208.0, "doe_min_efficiency_pct": 98.5},
    {"kva": 150.0, "kind": "dry", "hv_v": 601.0, "lv_v": 208.0, "doe_min_efficiency_pct": 98.5},
    # pecalc #10 input validation.
    {"kva": 1500.0, "lv_v": 0.0}, {"kva": 1500.0, "hv_v": -1.0}, {"kva": 1500.0, "power_factor": 0.0},
    {"kva": 1500.0, "power_factor": 1.2}, {"kva": 1500.0, "fault_duration_s": -1.0},
    {"kva": 1500.0, "source_x_over_r": 0.0}, {"kva": 1500.0, "source_mva": 0.0}, {"kva": 1500.0, "source_mva": -10.0},
    {"kva": 0.0}, {"kva": -75.0},
]
for e in extras:
    vectors.append(run("design", e))

# DOE efficiency checks (pass and fail around the computed test-point efficiency).
for kva, kind, lv in [(1500.0, "liquid", 480.0), (1500.0, "dry", 480.0), (1500.0, "dry", 4160.0),
                      (500.0, "liquid", 208.0), (5000.0, "liquid", 600.0), (300.0, "dry", 208.0)]:
    base = design(TransformerInput(kva=kva, kind=kind, lv_v=lv, hv_v=13800.0))
    e = base.performance["doe_point"]["efficiency_pct"]
    for off in (-0.3, 0.0, 0.3):
        vectors.append(run("design", {"kva": kva, "kind": kind, "lv_v": lv, "hv_v": 13800.0,
                                      "doe_min_efficiency_pct": round(e + off, 3), "target_z_pct": 6.0}))

# DOE 10 CFR 431.196 built-in check: each table type, each window, pass / fail, interpolated and not-in-table
# kVA, BIL bands, submersible, out of scope.
doe_cases = []
for date in ("2012-06-01", "2020-01-01", "2029-04-23"):
    doe_cases += [
        {"kva": 1500.0, "kind": "liquid", "doe_date": date},                                       # liquid 3-ph
        {"kva": 1500.0, "kind": "liquid", "j_lv_a_mm2": 2.0, "j_hv_a_mm2": 2.0, "doe_date": date},  # lower loss
        {"kva": 75.0, "kind": "dry", "hv_v": 480.0, "lv_v": 208.0, "doe_date": date},              # LV dry
        {"kva": 1000.0, "kind": "dry", "hv_v": 13800.0, "lv_v": 480.0, "bil_kv": 95.0, "doe_date": date},  # MV dry
    ]
doe_cases += [
    {"kva": 400.0, "kind": "liquid", "doe_date": "2029-04-23"},          # Table 6 300-500 kVA step, interpolated
    {"kva": 1200.0, "kind": "liquid", "doe_date": "2020-01-01"},         # interpolated 1000-1500
    {"kva": 1000.0, "kind": "liquid", "doe_date": "2030-01-01", "doe_submersible": True},   # Table 7
    {"kva": 1000.0, "kind": "liquid", "doe_date": "2030-01-01", "doe_submersible": False},  # Table 6
    {"kva": 1500.0, "kind": "dry", "hv_v": 480.0, "lv_v": 208.0, "doe_date": "2020-01-01"},  # LV dry not in table
    {"kva": 112.5, "kind": "dry", "hv_v": 600.0, "lv_v": 208.0, "doe_date": "2020-01-01"},
    {"kva": 500.0, "kind": "dry", "hv_v": 4160.0, "lv_v": 480.0, "bil_kv": 30.0, "doe_date": "2020-01-01"},
    {"kva": 500.0, "kind": "dry", "hv_v": 34500.0, "lv_v": 480.0, "bil_kv": 150.0, "doe_date": "2020-01-01"},
    {"kva": 75.0, "kind": "dry", "hv_v": 34500.0, "lv_v": 480.0, "bil_kv": 150.0, "doe_date": "2020-01-01"},  # blank
    {"kva": 500.0, "kind": "dry", "hv_v": 4160.0, "lv_v": 480.0, "bil_kv": 10.0, "doe_date": "2020-01-01"},   # BIL < 20
    {"kva": 500.0, "kind": "dry", "hv_v": 4160.0, "lv_v": 480.0, "doe_date": "2020-01-01"},   # BIL missing
    {"kva": 1500.0, "kind": "liquid", "doe_date": "2009-12-31"},         # before the first window
    {"kva": 7500.0, "kind": "liquid", "hv_v": 34500.0, "doe_date": "2020-01-01"},   # outside 431.192 kVA range
    {"kva": 1500.0, "kind": "liquid", "frequency_hz": 50.0, "doe_date": "2020-01-01"},
    {"kva": 1500.0, "kind": "liquid", "doe_date": "2020-13"},            # bad date
]
for e in doe_cases:
    vectors.append(run("design", e))
statuses = {v["result"]["doe"]["status"] for v in vectors if "result" in v}
assert {"pass", "fail", "not_in_table", "needs_input", "not_covered"} <= statuses, statuses

# Direct doe_efficiency_check calls (single-phase rows, all categories and windows; not reachable from the
# 3-phase design).
doe_direct = []
for args, kw in [
    (("liquid", 1, 50.0, None, 99.05, "2020-01-01"), {}),
    (("liquid", 1, 60.0, None, 99.2, "2029-04-23"), {}),
    (("liquid", 1, 5.0, None, 99.2, "2020-01-01"), {}),
    (("lv_dry", 1, 60.0, None, 98.5, "2020-01-01"), {}),
    (("lv_dry", 1, 333.0, None, 99.3, "2012-01-01"), {}),
    (("lv_dry", 1, 500.0, None, 99.3, "2030-01-01"), {}),
    (("lv_dry", 3, 75.0, None, 98.0, "2006-12-31"), {}),
    (("mv_dry", 1, 15.0, 110.0, 99.0, "2020-01-01"), {}),
    (("mv_dry", 1, 60.0, 110.0, 99.0, "2020-01-01"), {}),
    (("mv_dry", 1, 100.0, 45.0, 98.9, "2010-01-01"), {}),
    (("mv_dry", 3, 4000.0, 60.0, 99.5, "2029-04-23"), {}),
    (("mv_dry", 3, 4000.0, 60.0, 99.5, "2020-01-01"), {}),
    (("liquid", 3, 1000.0, None, None, "2020-01-01"), {}),
    (("liquid", 3, 1000.0, None, 99.5, None), {"today": "2029-04-23"}),
    (("liquid", 3, 1000.0, None, 99.5, "2020-01-01"), {"primary_v": 46000.0}),
    (("liquid", 3, 1000.0, None, 99.5, "2020-01-01"), {"secondary_v": 4160.0}),
    (("oil", 3, 1000.0, None, 99.5, "2020-01-01"), {}),
    (("liquid", 2, 1000.0, None, 99.5, "2020-01-01"), {}),
    (("liquid", 3, 0.0, None, 99.5, "2020-01-01"), {}),
]:
    try:
        doe_direct.append({"args": list(args), "kwargs": kw, "result": clean(doe_efficiency_check(*args, **kw))})
    except ValueError as e:
        doe_direct.append({"args": list(args), "kwargs": kw, "error": str(e)})

# Target %Z tuning (bisection; the JS test uses a looser tolerance here).
for kva, hv, lv, z in [(75, 4160, 208, 3.0), (300, 13800, 480, 5.0), (500, 13800, 480, 5.75),
                       (1000, 13800, 480, 5.75), (1500, 13800, 480, 5.75), (1500, 13800, 480, 6.5),
                       (2500, 25000, 600, 6.0), (2500, 34500, 480, 7.0), (5000, 25000, 4160, 6.5),
                       (7500, 34500, 4160, 7.5), (10000, 34500, 4160, 8.0), (1500, 13800, 480, 1.0),
                       (1500, 13800, 480, 40.0)]:
    vectors.append(run("tuned", {"kva": float(kva), "hv_v": float(hv), "lv_v": float(lv), "target_z_pct": float(z)}))
vectors.append(run("tuned", {"kva": 1500.0}))   # target missing
vectors.append(run("tuned", {"kva": 2000.0, "conductor": "Al", "k_et": 0.37, "target_z_pct": 6.0, "source_mva": 500.0,
                             "doe_min_efficiency_pct": 99.0}))

# The shipped example.
ex = json.loads((EXAMPLES / "transformer-1500kva.json").read_text())
ex_inputs = {k: float(v) for k, v in ex["inputs"].items()}
ex_inputs["doe_date"] = DOE_DATE
example = run("tuned" if ex["options"].get("tune_impedance") else "design", ex_inputs)
example["file"] = "examples/transformer-1500kva.json"

helpers = {
    "rogowski": [[h, w, rogowski_factor(h, w)] for h, w in [(10, 1), (1, 1), (5, 1), (0.9, 0.12), (2.4, 0.2)]],
    "core_loss": [[b, specific_core_loss(b)] for b in (0.5, 1.0, 1.1, 1.2, 1.35, 1.55, 1.8, 1.9, 2.0)],
    "next_standard_kva": [[k, g, next_standard_kva(k, g)] for k, g in
                          [(1180, 1.25), (300, 1.0), (301, 1.0), (10, 1.0), (4000, 1.0), (9000, 1.1)]],
}
try:
    next_standard_kva(10001)
except ValueError as e:
    helpers["next_standard_kva_error"] = [10001, str(e)]

out = {"_meta": {"source": "pecalc.transformer (Python)", "generator": "scripts/gen_golden_transformer.py"},
       "vectors": vectors, "example": example, "helpers": helpers, "doe_direct": doe_direct}
dest = Path(__file__).resolve().parent.parent / "tests/golden/transformer.json"
dest.write_text(json.dumps(out, indent=1) + "\n")
n_err = sum("error" in v for v in vectors)
print(f"wrote {dest}: {len(vectors)} vectors ({n_err} expected errors) + example + helpers")
