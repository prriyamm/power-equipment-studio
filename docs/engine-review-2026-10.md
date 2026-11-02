# Engine correctness review, October 2026

An independent, adversarial review of `src/engine/` and `src/engine/pecalc/`. Method:

- Read every engine module line by line.
- Hand-calculate reference cases and compare them with engine output:
  - a closed-form 2-bus load flow;
  - infinite-bus and finite-source transformer faults;
  - a fault at the utility bus;
  - IEC 60287 ampacity;
  - parallel-conductor and three-phase fault forces;
  - Rdc and Rac;
  - feeder voltage drop;
  - the ICEA withstand;
  - transformer FLA, Isc and DOE efficiency;
  - bus bending stress;
  - a Biot-Savart field point.
- For the pecalc ports, run differential tests against the Python `pecalc`: 800 random `size_feeder` cases, plus cable bus, switchgear and transformer runs on paths the golden vectors do not reach.

Status values:

- **fixed**: the bug is fixed in this PR and a regression test with a hand derivation guards it.
- **open**: confirmed or strongly suspected, but not changed here. This covers Python bugs, which the ports must keep reproducing, and changes that would need a design decision.
- **needs-standard**: cannot be confirmed without a licensed copy of the code or standard.

Python bugs are reported only. The JS ports still match `tests/golden/` exactly.

Update after the pecalc PR #9 / #10 port: several P rows below were fixed in the Python engine (power-equipment-engineering #9 and #10) and ported to `src/engine/pecalc/`, with the golden vectors regenerated. Those rows say **fixed in pecalc #9 / #10 / ported**.

## Fixed

| # | file:line | Claim | Evidence | Status |
|---|---|---|---|---|
| F1 | src/engine/system.js:217 | The utility source impedance had no voltage factor. `Z_Q = Un²/S″kQ`, but IEC 60909-0 gives `Z_Q = c_Q·Un²/S″kQ`. The solver applies `c` again at the fault, so a fault at the utility bus came out `c_Q`× too high (+10 % at MV). | Utility 500 MVA at 13.8 kV: the engine gave 23.010 kA. The correct value is S/(√3·U) = 20.918 kA. | fixed. Tests in `tests/system.test.mjs`: the utility-bus fault, and a finite utility plus 2500 kVA transformer at 480 V (hand value 50.128 kA). |
| F2 | src/engine/designchecks.js:89 | The cable bus design check took its voltage from `analysis.equipment[<from id>].kv`. For a transformer that is the HV terminal (first terminal), so a run from `T.lv` was checked at the primary voltage. | Example system: CB-1 (480 V) was checked at 13 800 V, and CB-2 (4.16 kV) at 13 800 V. That triggered the MV insulation build and a wrong voltage-drop base. | fixed. The check now uses the kV of the run's own bus. Test in `tests/designchecks.test.mjs`. |
| F3 | src/engine/gear.js:63 / :85 | The 215.3 check limit was `I·1.25·cont`, which drops the non-continuous share. The trip sizing on the line above used `I·(1 + 0.25·cont)`. | At `continuous: 0.5` the limit was 0.625·I, so a trip below the load current would pass. The correct limit is 1.125·I. | fixed. Test in `tests/gear.test.mjs`. |
| F4 | src/engine/gear.js:25, :84 | There was no NEC 240.4(D) small-conductor limit. With 90 °C ampacity, 240.4(B) alone allowed a 30 A trip on 12 AWG Cu. | 12 AWG Cu at 90 °C is 30 A. A 20 A load gets a 25–30 A trip, which passed. 240.4(D) caps 12 Cu at 20 A. | fixed. The limits (Cu 14/12/10 = 15/20/30 A, Al 12/10 = 15/25 A) are entered from memory and marked UNVERIFIED in the source. Test in `tests/gear.test.mjs`. Since F21 they are read from the shared pecalc JSON. |
| F5 | src/engine/arcflash.js:99 | Above 600 V the arc-flash boundary was found where the *interpolated* energy reaches 1.2 cal/cm². IEEE 1584-2018 instead computes AFB_600, AFB_2700 and AFB_14300 from each level's own equation, then interpolates the distances with the same three-point scheme as Iarc and E. E is not linear in D, so the two methods differ. | The new test derives the per-level AFB in closed form, lg AFB = (lg(5.0208·50/(12.552·T)) − A)/k12, and interpolates. The engine now matches to 1e-6. The coefficients remain PLACEHOLDER; this fixes only how they are applied. | fixed. Test in `tests/arcflash.test.mjs`. |
| F6 | src/engine/pecalc/forces.js:25, :93 | Port divergence: Python raises `ZeroDivisionError` for X/R = 0 (`-3/x_over_r`, `-t/tau`). JS returned `peakFactor(0) = 1.4425`, and cable bus forces of 164.8 lbf/ft with a NaN first peak. | `analyse({fault_ka: 50, x_over_r: 0})` returned numbers in JS and raised in Python. | fixed. JS now throws. Test in `tests/pecalc-core.test.mjs`. Since the pecalc #10 port, X/R ≤ 0 raises the shared validation message (`x_over_r must be greater than 0, got 0.0`) in both. |
| O6 | src/engine/arcflash.js:191 + system.js:216-217 | After F1, at the utility bus Ibf = I″k/c = S/(c·√3·U). That is correct under IEC (S″kQ includes c). If the utility quotes an ANSI E/Z figure, Ibf is 1/c low. | Convention question for the user's utility data. | fixed. The utility has `sc_basis` ("IEC" default = S″kQ includes c, unchanged; "ANSI" = plain E/Z bolted value, Z_Q = Un²/S so Ibf at the utility bus = S/(√3·U) and I″k = c × that). Inspector select; tests in `tests/arcflash.test.mjs` and `tests/systemio.test.mjs`. |
| O8 | src/engine/arcflash.js:148-149 | The Ibf validity warning uses 35 kA above 2.7 kV. The recalled range for 601 V–15 kV is 0.2–65 kA. | Recall only. | fixed in #24: 0.2–65 kA at every voltage from 601 V to 15 kV. The range is from secondary sources (UNVERIFIED), so still needs-standard. |
| O9 | src/engine/arcflash.js:141-144 | Banner bypass check: the System UI always shows the PLACEHOLDER notice and `Data PLACEHOLDER` pill (`src/ui/systemArcFlash.jsx:39-41`). No report or export path emits arc-flash results. However, the engine API `arcFlash()` never refuses PLACEHOLDER data: it only tags `data_status`. `pecalc/ampacity.js` does refuse unless `allow_placeholder_data`. | Any future consumer (report, export) could print energies without the banner. | fixed in #24. `arcFlash()` throws `DataStatusError` on PLACEHOLDER tables unless `allow_placeholder_data` is true (same rule as `pecalc/ampacity.js`); the System UI has an opt-in toggle, off by default. |
| O10 | src/engine/system.js:91-101, gear.js:78-81 | Feeder and cable bus ampacity uses the insulation-temperature column (90 °C when set) with no NEC 110.14(C) termination limit (60/75 °C). The 240.4(B) check therefore uses 90 °C ampacity. | Example: 500 kcmil Cu 90 °C = 430 A vs 380 A at 75 °C. | fixed. `connectorAmpacity()` in `system.js` takes the lesser of the insulation column and the terminal column (optional `terminal_c` marking, else the pecalc `lugs.js` 60/75 °C default); the terminal column comes from Table 310.16 for cable bus too, as pecalc `cablebus.js` does for NEC (pecalc #22 / web #44; in the System since F7). Loading, 240.4(B)/(C) and the LV cable bus design check use it. MV (> 2 kV) is unchanged. Tests in `tests/system.test.mjs`, `tests/gear.test.mjs`, `tests/designchecks.test.mjs`, `tests/systemio.test.mjs`. |

## Open: engine (JS-only modules)

| # | file:line | Claim | Evidence | Status |
|---|---|---|---|---|
| O1 | src/engine/loadflow.js:156 | Line charging at a tapped branch is not divided by \|τ\|². MATPOWER uses `Yff = (ys + j·b/2)/\|τ\|²`. | Mirrors Python `loadflow/solver.py:96`, which is byte-compatible by design. It has no effect when b = 0 on tapped branches (IEEE 14 and all System models). | open (Python behaviour; a convention choice) |
| O2 | src/engine/loadflow.js:361 | `balance_residual_pu` compares ΣP with branch losses only. Bus `shunt_g` losses are not counted, so the residual is non-zero whenever `shunt_g` ≠ 0. | Diagnostic only. | open |
| O3 | src/engine/shortcircuit.js:74 | Peak κ uses R/X of the Thevenin impedance (IEC method B without the 1.15 factor) in meshed networks. | Exact for radial networks. Meshed MV cases are slightly underestimated. | open |
| O4 | src/engine/system.js:222, :245 | The IEC 60909 impedance correction factors K_T (network transformers) and K_G (generators) are not applied. The method label says "IEC 60909-0". | K_T = 0.95·c_max/(1 + 0.6·x_T). For a 5.75 % unit this is 0.95·1.05/1.0345 = 0.964, i.e. LV I″k about 3.7 % higher than computed. | needs-standard (confirm against IEC 60909-0:2016 before applying) |
| O5 | src/engine/lfshortcircuit.js:22 | Buses without `kv` default to 1.0 kV, which selects c_max = 1.05 (LV). Per-unit transmission cases should probably use 1.10. | Affects `ik_pu` by 4.8 %. | open |
| O7 | src/engine/arcflash.js:59 | The shallow-enclosure test uses only depth ≤ 203.2 mm and Voc ≤ 600 V. 1584-2018 also requires height and width < 508 mm, and the EES rules differ per configuration (VCB / VCBB / HCB). | Recall only. | needs-standard |
| O11 | src/engine/motorstart.js:70 | For autotransformer starts, the motor-terminal criterion compares the *bus* voltage with 80 %. The actual motor terminal voltage is tap × bus voltage. | Design decision about which criterion applies to reduced-voltage starts. | open |
| O12 | src/engine/loadprofile.js:41, :46 | `factor` reports the base profile even for equipment on its own profile. `loss_pct` is NaN when the total load is zero. | Cosmetic. | open |
| O13 | src/engine/system.js:55, :258 | Cable bus Rac uses touching-cable proximity (spacing = OD), but cable bus has maintained spacing. | Small (+1–2 % R), conservative. | open |

## Open: pecalc (Python bugs, ports kept identical)

| # | file:line | Claim | Evidence | Status |
|---|---|---|---|---|
| P1 | pecalc/cablebus.js:631 (cablebus.py:382-384) | Voltage drop uses phase A's 0° voltage as the reference for every phase. The B and C drops are in the absolute frame, so "worst phase" is really phase A, and results depend on phase labels. | Flat 1×750 kcmil/phase, 1000 A, pf 0.9, 100 m. `ABC` gives 4.765 %, but `BCA` (the same layout) gives 2.375 %. The true worst phase is 4.765 % in both cases. The 3 % check flips. | fixed in pecalc #9 / ported. Each phase is measured against its own sending-end voltage (`phaseVoltageDrops`); the check note names the worst phase. Tests in `tests/pecalc-review-fixes.test.mjs` and golden vectors. |
| P2 | pecalc/transformer.js:127 (transformer.py:187) | The DOE test point (50 % vs 35 %) is keyed on `lv_v > 600`. 10 CFR 431 classifies medium-voltage dry-type by primary voltage. | A 1500 kVA dry 13.8 kV/480 V unit is evaluated at 35 % (99.387 %). At 50 % it is 99.349 %. The golden encodes the Python behaviour. | fixed in pecalc #10 / ported. Classified by the HV (primary) voltage: liquid 50 %, dry with primary ≤ 600 V 35 %, otherwise 50 %. |
| P3 | pecalc/sizing.js:122 (sizing.py:135); cablebus.js:131-132; src/engine/system.js:97 | Free-air installations take the 110.14(C) termination check from Table 310.17. The termination ampacity comes from 310.16. | 400 A continuous in free air recommends 2×2/0 Cu: 310.17 75 °C gives 265 ≥ 250, but 310.16 75 °C gives 175 < 250. | fixed. Feeder sizing in pecalc #10 / ported (NEC); now 3×2/0. The cable bus termination check uses Table 310.16 for NEC since pecalc #22 / web #44 (test in `tests/pecalc-review-sync.test.mjs`), and the System connector ampacity since F7. CEC is unchanged. |
| P4 | pecalc/sizing.js (sizing.py) | Feeder sizing has no 240.4(D) check, so it can recommend 14 AWG Cu for 20 A at a 75 °C terminal. | Hand case `{noncontinuous_a: 20, terminal_temp_c: 75}` gives 14 AWG. | fixed in pecalc #10 / ported; now 12 AWG. Limits in `pecalc/data/nec_240_4d_small_conductors.json` (UNVERIFIED) match `gear.js` (F4); the feeder checks the minimum OCPD rating, gear checks the chosen trip. |
| P5 | pecalc/data/reactance_nec_table9.json, sizing.js:71-76 (sizing.py:103) | Table 9 has no 700/800/900/1250–2000 kcmil rows. These sizes fall back to a geometric trefoil reactance that ignores the conduit type. | X in Ω/km, PVC: 600 = 0.128, 700 = 0.0827, 750 = 0.1247. That is 35–48 % low in the gap sizes, so voltage drop is understated. | fixed in pecalc #10 / ported. Feeder sizing uses the DERIVED values from `src/engine/reactanceDerived.js` (same method and values as pecalc `reactance_derived.py`) and warns when the recommended size uses one. |
| P6 | pecalc/transformer.js:372 (transformer.py:200) | IEC 60076-5 starting winding temperature θ0 is set to t_ref (85 °C). Recall: θ0 = ambient + rated average rise = 105 °C for liquid-filled units. | Default 1500 kVA: θ1 = 132.2 °C vs 155.2 °C, about 23 K non-conservative. | needs-standard |
| P7 | pecalc/transformer.js:374 (transformer.py:202) | The 250 °C Cu / 200 °C Al short-circuit limit is used for dry-type too, where IEC 60076-5 limits depend on insulation class. Only the LV winding current density is checked. | Recall only. | needs-standard |
| P8 | pecalc/thermal.js:26-33 (thermal.py:212) | EPR thermal resistivity is 5.0 K·m/W. Recalled IEC 60287-2-1 Table 1 value is 3.5 (5.0 is butyl rubber). | 15 kV 750 kcmil EPR: 895 A vs 954 A (conservative). | partly fixed in pecalc #10 / ported: EPR is 3.5 K·m/W up to 3 kV rated voltage and 5.0 above (UNVERIFIED, secondary sources), so the 15 kV case is unchanged. Still needs-standard. |
| P9 | pecalc/thermal.js:38 (thermal.py:214) | tan δ values 0.001 (XLPE) and 0.005 (EPR) vs recalled 0.004 / 0.020. The U0 thresholds below which dielectric loss is ignored are not applied. | Wd = 0.05 W/m on the 15 kV case; negligible. | needs-standard |
| P10 | pecalc/cablebus.js:1066 (cablebus.py:433); cablebusSim.js:252, :329 | The cable bus support load is F·L, but switchgear.js uses 1.1·F·L for continuous spans (IEEE 605 interior reaction). | Internally inconsistent; 10 % lower on cable bus. | open. The Simulate tab support block load (`cablebusSim.js`) is also F·L. |
| P11 | pecalc/transformer.js:364-366 (transformer.py:195) | Source and transformer impedance are added as magnitudes, and the source X/R is ignored in κ. | Slight understatement of fault current. | fixed in pecalc #10 / ported. Phasor sum with a new `source_x_over_r` input (default 10, UNVERIFIED typical); κ uses the combined X/R. |
| P12 | pecalc/sizing.js:97, :222-225, :240 (sizing.py:115,171,174); ampacity.js:89-92 | Port divergence on invalid input. Python raises; JS returns Infinity or NaN and reports "no size passes". Cases: `voltage_v = 0`, `power_factor > 1`, negative clearing time, short-circuit limit below operating temperature, degenerate `ambientFactor`. | Differential test. | fixed in pecalc #10 / ported for `voltage_v`, `power_factor`, clearing time and `fault_ka` (shared `validate.js`, same messages as Python). The short-circuit limit and `ambientFactor` cases are unchanged. |
| P13 | pecalc/sizing.js:23, :101, :201 | Note strings print whole-number floats as "2.0" where Python prints an int as "2". | 226 of 800 random cases differ only in note text. JS cannot tell int from float. | open (cosmetic). `pyFloat` (:23) prints Python `str(float)` and the golden feeder vectors (float inputs) match note text exactly in `tests/feeder.test.mjs`; an int-typed Python input (e.g. `fault_clearing_s=1`) still prints "1" where JS prints "1.0". |
| P14 | pecalc/conductors.js:124 (conductors.py:128) | kp = 0.8 is the IEC 60287-1-1 value for dried-and-impregnated conductors. Extruded insulation uses kp = 1. | 500 kcmil Cu Rac +1.7 % with kp = 1. Table 9 gives 0.027 either way. | needs-standard |
| P15 | pecalc/data/ampacity_nec.json | Al 8 AWG 60 °C = 35. Older editions list 30. | Every other 310.16/310.17 row checked matches. | reverted in pecalc #19 / ported (web #44): pecalc #10 set 30 A from public reprints of older editions; the printed NFPA 70-2023 Table 310.16 gives 35 A, so the value is back to 35 A (data still UNVERIFIED). The CEC placeholder copy is unchanged. |
| P16 | pecalc/sizing.js (sizing.py:116) | CEC 8-104 free-air continuous limits may be 70/85 % rather than 80/100 %. | CEC data is PLACEHOLDER. | needs-standard |
| P17 | pecalc/cablebus.js | There is no adiabatic short-time withstand check for the conductor or shield (I²t = K²S²), and no mutual heating between stacked tiers. | Missing checks, not wrong formulas. | conductor withstand added (pecalc #12 / web #31); shield withstand added (optional `ground_fault_ka`, copper shield, 250 °C limit UNVERIFIED); tier mutual heating still open |

## Verified clean (spot list)

- **Load flow Jacobian** (all eight partials) and the tap/phase-shift two-port. Closed-form 2-bus case: V2 = cos δ, sin 2δ = 0.1, matched to 1e-10. The IEEE 14-bus reference also matches.
- **Short circuit:**
  - Infinite-bus transformer fault, 1.05·Ifl/z = 54.911 kA, exact.
  - κ = 1.02 + 0.98e^(−3R/X).
  - c_max of 1.05 (≤ 1 kV) and 1.10.
  - Per-unit bases: Z_b = kV²/MVA, I_b = MVA/(√3·kV).
  - Transformer %Z to the system base.
  - Generator X″d, and motor 1/LRC on the input-kVA base.
- **Motor starting:** the autotransformer line current ∝ tap²; the constant-impedance starting shunt y = mult·kVA/S_base at the starting pf; currents in amperes.
- **TCC:**
  - IEEE C37.112 MI/VI/EI constants.
  - ICEA P-32-382 constants: Cu 0.0297/234, Al 0.0125/228.
  - C57.109 1250/I².
  - LSIG long time at 6×Ir.
  - Voltage referral of currents (I·kV/kV_ref).
- **Gear:** NEC 240.6(A) list; the 240.4(B) and 240.4(C) logic.
- **Data tables:**
  - Chapter 9 Table 9 XL (all rows).
  - Table 310.16/310.17 rows for common sizes.
  - AWG areas and cmil.
  - IEC 60228 resistivities.
- **Arc flash:**
  - Eq. 1 polynomial order.
  - The Voc ≤ 600 V current equation, including the reduced-current scenario (identical to scaling the final Iarc).
  - Energy equation structure, and the 20/T ⇔ 1.2 cal/cm² threshold.
- **pecalc:**
  - Rdc and Rac (IEC 60287 ys/yp).
  - Ambient correction.
  - 310.15(C)(1) adjustment steps.
  - Voltage drop R cos θ + X sin θ with √3.
  - ICEA withstand.
  - IEC 60287 T1–T4 (882.226 A hand vs engine at 1e-10).
  - Fault forces: 2e-7·i²/d, 0.866 and 0.808 factors.
  - N/m→lbf/ft.
  - Beam factors wL²/8, /10, /12 with section modulus b·h²/6.
  - Biot-Savart field.
  - Transformer FLA, Isc and κ.

## Audit follow-up, 2026-10-30

A second audit of the engine, the library examples and the System UI. The fixes are in the "fix/name-and-discrepancies" PR. Rows marked "no test" are UI fixes or have no numeric effect.

### Fixed in this branch

| # | file:line | Claim | Evidence | Status |
|---|---|---|---|---|
| F7 | src/engine/system.js:97 | The System took the cable bus terminal column from Table 310.17 (free air). NEC 110.14(C) rates terminations on Table 310.16, which pecalc `cablebus.js` uses for NEC since pecalc #22 / web #44. | 750 kcmil Cu at 75 °C: 785 A per set (310.17) vs 475 A (310.16). | fixed. Test `O10: NEC 110.14(C) terminal limit on LV connector ampacity` in `tests/system.test.mjs` (cable bus case: 500 kcmil Cu 90 °C, 620 A free air limited to 380 A). |
| F8 | src/engine/system.js:366-396 | Close-coupled throats merge two terminals into one bus, so they had no entry in `analysis.connectors`. The lineup main, the TCC upstream walk and the 240.87 / 450.3 checks treated a closed throat as open. | Example system with CB-1 replaced by a `T1.lv` throat: the SWGR-LV main read 0 A. | fixed. Closed throats report current and direction from the equipment end. Test `regression: a closed close-coupled throat is reported, so the lineup and the TCC walk see it energized` in `tests/system.test.mjs`. |
| F9 | src/engine/system.js:197-206, :218 | Zero or negative source data (utility MVA or X/R; generator kVA, X″d or X/R; motor hp, eff, pf, LRC or X/R) made every bus fault current NaN while the load flow converged and `ok` stayed true. | Test cases: motor `hp: 0`, `lrc: 0`; generator `xr: 0`. | fixed. Compile error naming the field. Test `regression: a zero source parameter is an error, not NaN fault currents` in `tests/system.test.mjs`. |
| F10 | src/engine/system.js:221, :340-342 | A generator on the utility (swing) bus reported the utility's output as its own, with a false overload. | The swing bus generation is the slack's. | fixed. Warning; output and loading reported as null; fault contribution kept. Test `regression: a generator on the utility (swing) bus warns and reports no output or loading` in `tests/system.test.mjs`. |
| F11 | src/engine/gear.js:73-77 | A generator incomer was sized to the bus rating. | Industrial plant: 1000 kVA at 480 V (FLA 1203 A) got a 4000 A main. | fixed. Sized from the generator FLA: 1600 A. Test `regression: a generator incomer is sized from the generator FLA, not the bus rating` in `tests/gear.test.mjs`. |
| F12 | src/engine/gear.js:66-69 | A feeder to a transformer primary was sized at 125 % of today's load, not of the transformer rating (NEC 450.3), so the lineup and the 450.3 check described different devices. | Example C-T1, 2500 kVA at 13.8 kV (104.6 A): 80 A trip from the load. | fixed. At least 1.25 × rated primary current: 150 A. Test `regression: a feeder to a transformer primary is sized from the transformer rating, not today's load` in `tests/gear.test.mjs`. |
| F13 | src/engine/protchecks.js:184-196; src/ui/tccView.jsx:37 | `lineupTrips` kept the first lineup's trip for a gear-to-gear run, so the TCC, 240.87 and 450.3 results depended on equipment order. The TCC view built its own copy of the map. | Reordering `sys.equipment` changed the trip on the path. | fixed. The source-end feeder trip wins; the TCC view calls the same function. Test `regression: lineupTrips keeps the source-end feeder trip whatever the equipment order` in `tests/protchecks.test.mjs`. |
| F14 | src/engine/transformerLoading.js:154-159 | IEEE C57.91 loading: the peak hot spot and top oil came from the time steps only. An ambient step at an hour boundary raises the start-of-hour point, which the hourly table includes. | The summary peak could sit below the hourly table maximum, and the user limit checks use the summary peak. | fixed. Peaks taken over the hourly rows too. Test `regression: an ambient step at an hour boundary is in the peaks, never below the hourly table` in `tests/transformerLoading.test.mjs`. |
| F15 | src/engine/arcflash.js:195 | `arcFlashStudy` passed `clearing_reduced_ms` as undefined when the equipment had no value. | `arcFlash()` already fell back to the clearing time (:138), so energies were unchanged; the row's recorded input was incomplete. | fixed (no test). Defaults to the clearing time. |
| F16 | src/engine/systemLibrary.js:30-32, :63-64, :95-101 | Library examples had feeders that failed their own 240.4(C) lineup check, data-hall cable bus runs overloaded on the 310.16 terminal basis (F7), and an industrial generator cable below NEC 445.13. | 445.13: 115 % of 1203 A. Data hall: 3608 A FLA at 475 A per 750 kcmil set. | fixed. Resized (data hall transformer runs to 8 sets, generator cable 4×600 kcmil). Test `<key>: every feeder passes its own lineup checks (240.4, 215.3)` in `tests/systemlibrary.test.mjs`. |
| F17 | src/ui/systemSld.jsx:20-22 | The one-line crashed when a device was switched off: a de-energized device has no bus. | `devicesAt[undefined]`. | fixed (no test). De-energized devices are not drawn. |
| F18 | src/ui/system.jsx:887-891, :989 | The Feeder and Cable bus hand-off and the connector inspector took kV and fault level from the end equipment's first terminal, which for a transformer is the HV side. | A run from `T.lv` opened at the primary kV (the UI form of F2). | fixed (no test). Uses the run's own bus, as `designchecks.js` does. |
| F19 | src/ui/system.jsx:740, :825, :916, :949 | The design-push banner survived a project load or reset and offered Undo push after other edits; Delete removed the selection from any view; C57.91 thermal inputs carried over between projects. | UI state. | fixed (no test). Banner cleared on load / reset and shown only while the model is the pushed one; Delete acts on the site view only; the loading section is keyed per project. |
| F20 | src/ui/tccView.jsx:86-87 | The cable damage curve used a 200 °C final temperature for 60/75 °C insulation. ICEA P-32-382 gives 150 °C for thermoplastic. | Withstand time overstated for 60/75 °C cable. | fixed (no test). 250 °C for 90 °C thermoset, 150 °C below. |
| F21 | src/engine/gear.js:14, :25-26 | gear.js had its own copy of the NEC 240.4(D) limits (F4); feeder sizing reads `pecalc/data/nec_240_4d_small_conductors.json` (P4). | Two copies of one table. | fixed. gear.js reads the shared JSON and exposes its status (UNVERIFIED). Test `regression: 240.4(D) caps the OCPD on 12 AWG Cu at 20 A even with 90 °C ampacity` in `tests/gear.test.mjs`. |
| F22 | src/engine/system.js:247, :266 | Compiled load-flow branches had no rating (`rate_a`), so the N-1 screen (contingency.js) and the "Open in Load flow" hand-off could never report a transformer or cable overload. | 2 x 200 MVA 230/69 kV carrying 300 MW: losing one unit put 173 % on the other, but N-1 reported only a voltage violation. | fixed. Transformers carry their MVA rating, cables √3·kV·ampacity. Test `regression: compiled branches carry MVA ratings, so the N-1 screen sees a transformer overload` in `tests/system.test.mjs`. |
| F23 | src/engine/system.js:330 | Gear bus current counted only branch inflows. A utility or generator close-coupled to the gear injects as bus generation, so that bus showed 0 A and could never read as overloaded. | 220 MVA generator on a 20 kV bus: 0 A shown, 5297 A actual. | fixed. Bus generation is added to the inflow. Test `regression: gear fed by a close-coupled source counts the source in its bus current` in `tests/system.test.mjs`. |
| F24 | src/engine/gear.js:80 | Above the largest 240.6(A) rating (6000 A) the trip was null; the frame lookup then took null as 0 and returned a 1200 A frame, and the 215.3 check compared null with the load. | 250 MVA GSU secondary at 20 kV, 4850 A load: trip "-", frame 1200 A. | fixed. A "Standard rating available (240.6(A))" check fails with the required rating, and no frame is assigned. Test `regression: a circuit above the largest 240.6(A) rating fails clearly …` in `tests/gear.test.mjs`. |
| F25 | src/engine/arcflash.js:200 | The arc-flash study printed incident energy (and the UI a WARNING/DANGER label preview) for 34.5-345 kV buses, outside the 208 V-15 kV range of IEEE 1584-2018, with only a warning. | 230 kV yard: 28.3 cal/cm²; 345 kV: 53.2 cal/cm². | fixed. The study row is an error above 15 kV ("use a method that covers this voltage"); `arcFlash()` itself still extrapolates with its warning. Test `regression: the study gives no incident energy above 15 kV` in `tests/arcflash.test.mjs`. |

### Open

| # | file:line | Claim | Evidence | Status |
|---|---|---|---|---|
| O14 | src/engine/designchecks.js:94, :103; src/engine/system.js:328 | The design checks pass the bolted current I″k/c to pecalc; the gear SC duty compares the c-factored I″k with the rating. | Two bases 5 % (LV) or 10 % (MV) apart. The comment at designchecks.js:92-93 refers to this row. | open (design decision: one basis) |
| O15 | src/engine/system.js:67-72, :95 | MV (> 2 kV) cables and cable bus get NEC 310.16 / 310.17 ampacities, which cover ≤ 2000 V. pecalc refuses > 2000 V (`pecalc/sizing.js:252`; `pecalc/cablebus.js:133` for the termination table). | Unit substation C-UTIL, 4/0 Cu at 13.8 kV: 260 A from the 310.16 90 °C column. | open (needs NEC 311.60 tables or a user `ampacity_a`) |
| O16 | src/engine/gear.js:78, :84-85 | Incoming mains (transformer secondary and others) get no conductor-vs-trip check (240.4, 240.21(C)). | Library mains with conductor ampacity below the main trip: unit substation CB-1 1900 A vs 4000 A; double-ended CB-A / CB-B 1425 A vs 2500 A. | open |
| O17 | src/engine/gear.js:56-58, :73-77 | A gear-to-gear tie appears as the main in one lineup (sized to the bus) and as a feeder in the other (sized to the load): two ratings for one device. | Double-ended TIE: main 3000 A in LV-A, feeder 250 A in LV-B. `lineupTrips` (F13) uses the feeder trip. | open |
| O18 | src/engine/system.js:67-72, :259 | System ampacity is the table value at the 30 °C table ambient, with no correction; the cable bus design check runs at 40 °C (`pecalc/cablebus.js:70`). System cable bus impedance uses the Table 9 aluminum-conduit column; pecalc computes it from the spaced geometry (`pecalc/cablebus.js:439-450`). | Loading and design check disagree for the same run. | open |
| O19 | src/engine/system.js:13; src/engine/gear.js:16 | The System uses NEC tables and NEC 240 rules even when `sys.code` is "CEC". Only the protection checks read `sys.code` (`protchecks.js:245`). | CEC project: NEC ampacities and trip rules. | open |
| O20 | src/engine/pecalc/datainfo.js:18-32 | The data fingerprint covers only `pecalc/data`. `src/engine/data/*.json` (C57.91 thermal, IEEE 1584 coefficients, protection code limits, lab test) is not in it. | A change to those tables leaves the fingerprint in reports and project files unchanged. | open |
| O21 | src/engine/gear.js:16 | `NEC_240_6` starts at 15 A. NEC 2023 Table 240.6(A) may list 10 A. | Recall only. | needs-standard |
| O22 | src/engine/pecalc/data/dlo_cables.json:251; src/engine/report.js:168 | pecalc data: the Southwire DLO 1 AWG raceway rating, 150 A, exceeds NEC 310.16 Cu 90 °C, 145 A (`ampacity_nec.json`). The `_meta.status` values MANUFACTURER (`dlo_cables.json`) and EMPTY (`lug_catalog.json`) are outside VERIFIED / UNVERIFIED / PLACEHOLDER / DERIVED; `report.js` treats them as not verified. | Data review. | open (report upstream to pecalc; the copy here stays as-is) |
| O23 | src/engine/pecalc/transformer.js:28; src/engine/pecalc/conductors.js:52 | Aluminium zero-resistance temperature: 225 °C in the transformer model, 228.1 °C in the conductor model. | 0.3 % on the 20 → 85 °C resistance correction. | needs-standard |
| O24 | src/engine/motorstart.js:70, :72 | For every starter the motor row is labelled "motor terminal" but compares the bus voltage. With an autotransformer the terminal voltage is tap × bus (see O11). | Label and criterion disagree for reduced-voltage starts. | open |
| O25 | src/ (58 lines in 22 files) | The code cites IEC methods (IEC 60909, 60287, 60076-5, 60865, 60228) although CLAUDE.md limits scope to US and Canadian standards. | `grep -rnE "IEC ?(60909\|60287\|60076\|60865\|60228)" src` | open. Decision 2026-10-30: keep the existing pecalc-port methods (they must match pecalc) and add no new IEC; replacing them with ANSI / IEEE methods (C37.010 / IEEE 551, IEEE 835 / Neher-McGrath) is future work. |
| O26 | pecalc/transformer.js:439 (transformer.py design) | The preliminary core-type design runs at 100-250 MVA without a scope warning (its standard kVA list ends at 10 MVA). Losses and efficiency are plausible, but high impedance is met by stretching the window: 250 MVA 345/20 kV at 13 % Z gives a 9.07 m window and a 171 t core, and every check still passes. Inner-winding buckling and axial forces are not checked (the design notes say so). | Large-transformer scenario run, 2026-10-30. | open (pecalc behaviour; report upstream, the port must match) |
| O27 | src/engine/gear.js:19, :28 | Lineups above 1 kV size relays and breakers on the NEC 240.6(A) ladder and NEC 240.4 conductor rules, which apply to 1000 V and below; MV frames stop at 3000 A. A 100 MVA 13.8 kV secondary (4184 A) or a 250 MVA 20 kV generator bus therefore always fails "Frame available". | 100 MVA 138/13.8 kV and 250 MVA GSU scenarios. | open (needs C37.04/C37.06 ratings, C37.013 generator breakers and 240.100/240.101 rules for MV) |
| O28 | src/engine/protchecks.js (450.3) | Every 100-250 MVA unit tested has Z of 11-13 %, above the 10 % rows of NEC Table 450.3(A), so the check is "warn, engineering review" for all of them. This is correct for NEC; utility-scale substations are usually governed by NESC and utility practice, which the app does not model. | Scenarios A, C, E. | open (scope note, not a bug) |
