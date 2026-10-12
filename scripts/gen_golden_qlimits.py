"""Reference for Q-limit enforcement: PYPOWER runpf on case14 with ENFORCE_Q_LIMS=1.
Run: uv run --with pypower --with numpy --with scipy python scripts/gen_golden_qlimits.py
Writes tests/golden/qlimits_case14.json."""
import json
import os

import inspect
import re

import pypower.runpf as _runpf_mod
from pypower.api import case14, ppoption
from pypower.idx_bus import BUS_I, BUS_TYPE, VM, VA
from pypower.idx_gen import GEN_BUS, QG, QMAX, QMIN

# PYPOWER 5.1.x predates numpy's ban on float indices: runpf crashes when ENFORCE_Q_LIMS=1.
# Patch only the integer casts of the bus index (no change to the algorithm) and rebuild runpf.
_src = inspect.getsource(_runpf_mod)
_src = re.sub(r"gen\[([^\]]*?), GEN_BUS\](?!\.astype)", r"gen[\1, GEN_BUS].astype(int)", _src)
_src = _src.replace("== PV | \n", "== PV) | (\n").replace("bus[gen[:, GEN_BUS].astype(int), BUS_TYPE] == PV) | (", "bus[gen[:, GEN_BUS].astype(int), BUS_TYPE] == PV) | (")
_src = _src.replace("gen[limited[i], GEN_BUS]", "gen[limited[i], GEN_BUS].astype(int)")
_src = _src.replace("all(infeas == remaining)", "np_array_equal(infeas, remaining)")
_runpf_mod.np_array_equal = __import__("numpy").array_equal
exec(compile(_src, "runpf_patched", "exec"), _runpf_mod.__dict__)
runpf = _runpf_mod.runpf


def solve(lims=None):
    ppc = case14()
    lims = {1: (-9999.0, 9999.0), **(lims or {})}
    if lims:
        for g in ppc["gen"]:
            if int(g[GEN_BUS]) in lims:
                g[QMIN], g[QMAX] = lims[int(g[GEN_BUS])]
    opt = ppoption(VERBOSE=0, OUT_ALL=0, ENFORCE_Q_LIMS=1, PF_TOL=1e-10)
    return runpf(ppc, opt)


def dump(res, ok, limits):
    bus, gen = res["bus"], res["gen"]
    gbuses = {int(g[GEN_BUS]) for g in gen}
    return {
        "success": bool(ok),
        "q_limits": {str(k): list(v) for k, v in limits.items()},
        "v": [float(x) for x in bus[:, VM]],
        "angle_deg": [float(x) for x in bus[:, VA]],
        "bus_type": [int(x) for x in bus[:, BUS_TYPE]],  # 1 PQ, 2 PV, 3 ref
        "switched_to_pq": [int(b) for b, t in zip(bus[:, BUS_I], bus[:, BUS_TYPE]) if t == 1 and int(b) in gbuses],
        "gen_q": {str(int(g[GEN_BUS])): float(g[QG]) for g in gen},
    }


base = case14()
lims = {int(g[GEN_BUS]): (float(g[QMIN]), float(g[QMAX])) for g in base["gen"]}
# slack (bus 1) limits are not enforced by this solver: widen them so PYPOWER does not re-assign the slack
lims[1] = (-9999.0, 9999.0)
res, ok = solve()
out = dump(res, ok, lims)
# stressed variant: lower Qmax at buses 2 and 3 so more than one bus switches
stress = {2: (-40.0, 30.0), 3: (0.0, 15.0)}
res2, ok2 = solve(stress)
out2 = dump(res2, ok2, {**lims, **stress})
here = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(here, "..", "tests", "golden", "qlimits_case14.json")
with open(path, "w") as f:
    json.dump({"source": "PYPOWER runpf, ENFORCE_Q_LIMS=1, case14", "case14_limits": out, "stressed": out2}, f, indent=1)
print(out["switched_to_pq"], out2["switched_to_pq"])
