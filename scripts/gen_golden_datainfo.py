"""Generate tests/golden/pecalc_data.json: the pecalc data fingerprint and the data tables it describes.

Usage: PECALC_ROOT=<path to pecalc `calculations`> python3 scripts/gen_golden_datainfo.py

Python hashes its canonical JSON text (int and float are different there), which JavaScript cannot reproduce
byte for byte. So the fingerprint is not recomputed in JS: it is a constant (src/engine/pecalc/datainfo.js,
PECALC_DATA_FINGERPRINT) and tests/datainfo.test.mjs checks that every data file copied into
src/engine/pecalc/data/ deep-equals the parsed JSON recorded here, so the constant describes the copied data.
After a pecalc data change: copy the data files, run this script, and update the two constants in datainfo.js.
"""
import json
import os
import sys
from pathlib import Path

ROOT = os.environ.get("PECALC_ROOT", str(Path.home() / "Projects/power-equipment-engineering/calculations"))
sys.path.insert(0, ROOT)

from pecalc import __version__  # noqa: E402
from pecalc.datainfo import DATA_DIR, data_fingerprint, data_tables  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
COPIED = HERE / "src" / "engine" / "pecalc" / "data"

data = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in sorted(DATA_DIR.glob("*.json"))
        if (COPIED / p.name).exists()}
missing = sorted(p.name for p in DATA_DIR.glob("*.json") if p.name not in data)
out = {
    "_meta": {"source": "pecalc.datainfo (Python)", "generator": "scripts/gen_golden_datainfo.py",
              "not_copied": missing},
    "pecalc_version": __version__,
    "data_fingerprint": data_fingerprint(),
    "tables": data_tables(),
    "data": data,
}
dest = HERE / "tests" / "golden" / "pecalc_data.json"
dest.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8", newline="\n")
print(f"wrote {dest}: pecalc {out['pecalc_version']}, data {out['data_fingerprint']}, "
      f"{len(data)} data files ({len(missing)} not copied)")
