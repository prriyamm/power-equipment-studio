"""Generate tests/golden/switchgear.json from the Python pecalc switchgear module.

Usage: python3 scripts/gen_golden_switchgear.py
Set PECALC_ROOT to the pecalc `calculations` directory and PECALC_EXAMPLES to the
`examples` directory if they are not at the defaults below.

Vectors with more than MAX_FILAMENTS filament conductors are skipped: the JS port solves the
dense system by Gaussian elimination (no numpy), so very wide multi-lamination bars are slow there.
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

from pecalc.switchgear import BusInput, analyse_bus, mesh, skin_depth_mm  # noqa: E402

MAX_FILAMENTS = 450
INT_FIELDS = {"bars_per_phase", "filaments_thickness", "filaments_width"}
STR_FIELDS = {"standard", "material", "orientation", "finish", "support_condition"}


def floats(inputs):
    """Numeric inputs as floats (the JS note strings print Python floats, e.g. 65.0)."""
    return {k: (v if k in INT_FIELDS or k in STR_FIELDS or v is None else float(v)) for k, v in inputs.items()}


def clean(x):
    if isinstance(x, float) and not math.isfinite(x):
        return "Infinity" if x > 0 else "-Infinity" if x < 0 else "NaN"
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    return x


def n_filaments(inputs):
    inp = BusInput(**inputs)
    nt, nw = mesh(inp, inp.ambient_c + inp.internal_air_rise_c + inp.max_rise_c)
    return 3 * inp.bars_per_phase * nt * nw


def run(inputs, expect_error=False):
    inputs = floats(inputs)
    if not expect_error and n_filaments(inputs) > MAX_FILAMENTS:
        return None
    try:
        r = analyse_bus(BusInput(**inputs))
        d = asdict(r)
        d["passed"] = r.passed
        return {"inputs": inputs, "result": clean(d)}
    except (ValueError, KeyError, ZeroDivisionError) as e:
        return {"inputs": inputs, "error": str(e)}


vectors = []


def add(inputs, expect_error=False):
    v = run(inputs, expect_error)
    if v is not None:
        vectors.append(v)


# Sweep: current x bars x thickness x width x material x orientation (a deterministic subset).
CURRENTS = [600, 1200, 2000, 3000, 4000, 5000, 6000]
BARS = [1, 2, 3, 4, 6]
THICK = [6.35, 9.53, 12.7]
WIDTH = [50.8, 76.2, 101.6, 152.4, 203.2]
SPACING = [100.0, 150.0, 200.0, 300.0]
for k, (i, b, t, w) in enumerate(itertools.product(CURRENTS, BARS, THICK, WIDTH)):
    if (i // 100 + b + int(t) + int(w // 25) + k) % 5:
        continue
    mat = "Al" if k % 4 == 0 else "Cu"
    orient = "edge_to_edge" if k % 3 == 0 else "face_to_face"
    ins = {"current_a": i, "bars_per_phase": b, "bar_thickness_mm": t, "bar_width_mm": w, "material": mat,
           "orientation": orient, "phase_spacing_mm": SPACING[k % len(SPACING)],
           "finish": ["tin", "bare", "silver", "painted"][k % 4],
           "internal_air_rise_c": [0, 10, 20][k % 3], "ambient_c": [30, 40, 50][k % 3],
           "max_rise_c": [50, 65, 80][k % 3]}
    if k % 2 == 0:
        ins["fault_ka"] = [25, 42, 65, 85, 100][k % 5]
        ins["x_over_r"] = [6.6, 15, 25][k % 3]
        ins["support_span_m"] = [0.3, 0.45, 0.6, 0.9][k % 4]
        ins["support_condition"] = ["continuous", "pinned", "fixed"][k % 3]
    add(ins)

# Fault sweep on fixed bar geometry (kA, X/R, orientation, span condition).
for ka, xr, orient, cond in itertools.product([25, 50, 100], [6.6, 25], ["face_to_face", "edge_to_edge"],
                                             ["continuous", "pinned", "fixed"]):
    add({"current_a": 2000, "bars_per_phase": 2, "fault_ka": ka, "x_over_r": xr, "orientation": orient,
         "support_condition": cond, "phase_spacing_mm": 175.0, "bar_width_mm": 101.6})

# Overrides: yield, support rating (pass and fail), gap, filaments, frequency, standard, voltage.
for extra in [
    {"fault_ka": 65, "yield_mpa": 120.0, "support_rating_n": 8000.0},
    {"fault_ka": 65, "support_rating_n": 1.0e6},
    {"fault_ka": 100, "yield_mpa": 60.0, "support_span_m": 1.2},
    {"bar_gap_mm": 12.7, "bars_per_phase": 3},
    {"bar_gap_mm": 2.0, "bars_per_phase": 3, "fault_ka": 50},
    {"filaments_thickness": 2, "filaments_width": 8},
    {"filaments_thickness": 3, "filaments_width": 12, "bars_per_phase": 3},
    {"frequency_hz": 50.0, "standard": "ANSI C37.20.1", "fault_ka": 50},
    {"frequency_hz": 50.0, "material": "Al", "bars_per_phase": 2},
    {"voltage_v": 480.0, "standard": "ANSI C37.20.2", "current_a": 1600.0, "bars_per_phase": 1},
    {"standard": "ANSI C37.20.3", "current_a": 1200.0, "bars_per_phase": 1, "bar_width_mm": 76.2},
    {"max_rise_c": 30.0, "ambient_c": 35.0, "current_a": 1500.0, "bars_per_phase": 1, "bar_thickness_mm": 10.0,
     "bar_width_mm": 100.0, "phase_spacing_mm": 200.0, "finish": "bare"},
    {"max_rise_c": 30.0, "ambient_c": 35.0, "current_a": 1500.0, "bars_per_phase": 1, "bar_thickness_mm": 10.0,
     "bar_width_mm": 100.0, "phase_spacing_mm": 200.0, "finish": "painted"},
    {"current_a": 8000.0, "bars_per_phase": 2, "fault_ka": 65},            # temperature check fails
    {"current_a": 4000.0, "bars_per_phase": 1, "bar_width_mm": 50.8, "internal_air_rise_c": 30.0},
    {"bars_per_phase": 1, "phase_spacing_mm": 300.0, "fault_ka": 50, "x_over_r": 15.0},
    {"current_a": 600.0, "bars_per_phase": 1, "bar_width_mm": 50.8, "bar_thickness_mm": 6.35, "fault_ka": 25.0},
    {"current_a": 6000.0, "bars_per_phase": 4, "bar_width_mm": 101.6, "bar_thickness_mm": 9.53,
     "phase_spacing_mm": 250.0, "fault_ka": 100.0},
    {"current_a": 6000.0, "bars_per_phase": 6, "bar_width_mm": 76.2, "bar_thickness_mm": 12.7,
     "orientation": "edge_to_edge", "phase_spacing_mm": 300.0, "material": "Al"},
    {"bars_per_phase": 2},
    {"fault_ka": 0.0},
    {"fault_ka": 65.0, "support_span_m": 2.0, "bar_thickness_mm": 6.35, "bars_per_phase": 1},   # stress check fails
]:
    add(extra)

# The shipped example.
ex = json.loads((EXAMPLES / "switchgear-bus-3000a.json").read_text())
example = run(ex["inputs"])
example["file"] = "examples/switchgear-bus-3000a.json"
assert example is not None and "result" in example

# Error cases.
for bad in [{"material": "Fe"}, {"orientation": "diagonal"}, {"finish": "gold"},
            {"fault_ka": 50.0, "support_condition": "cantilever"}, {"phase_spacing_mm": 0.0}]:
    add(bad, expect_error=True)

helpers = {
    "skin_depth_mm": [[m, t, f, skin_depth_mm(m, t, f)] for m, t, f in
                      [("Cu", 20, 60), ("Cu", 105, 60), ("Al", 105, 60), ("Cu", 90, 50), ("Al", 20, 50)]],
    "mesh": [[asdict(BusInput(**floats(i))), t, list(mesh(BusInput(**floats(i)), t))] for i, t in
             [({"bar_thickness_mm": 6.35, "bar_width_mm": 152.4}, 105.0),
              ({"bar_thickness_mm": 12.7, "bar_width_mm": 203.2}, 105.0),
              ({"bar_thickness_mm": 6.35, "bar_width_mm": 50.8}, 60.0),
              ({"filaments_thickness": 3, "filaments_width": 9}, 90.0)]],
}

out = {"_meta": {"source": "pecalc.switchgear (Python)", "generator": "scripts/gen_golden_switchgear.py",
                 "note": "numeric inputs are floats, as the Python note strings print them"},
       "vectors": vectors, "example": example, "helpers": helpers}
dest = Path(__file__).resolve().parent.parent / "tests/golden/switchgear.json"
dest.write_text(json.dumps(out, indent=1) + "\n")
n_err = sum("error" in v for v in vectors)
print(f"wrote {dest}: {len(vectors)} vectors ({n_err} expected errors) + example + helpers")
