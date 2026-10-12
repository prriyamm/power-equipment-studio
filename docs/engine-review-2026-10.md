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

## Fixed

| # | file:line | Claim | Evidence | Status |
|---|---|---|---|---|
| F1 | src/engine/system.js:173 | The utility source impedance had no voltage factor. `Z_Q = Un²/S″kQ`, but IEC 60909-0 gives `Z_Q = c_Q·Un²/S″kQ`. The solver applies `c` again at the fault, so a fault at the utility bus came out `c_Q`× too high (+10 % at MV). | Utility 500 MVA at 13.8 kV: the engine gave 23.010 kA. The correct value is S/(√3·U) = 20.918 kA. | fixed. Tests in `tests/system.test.mjs`: the utility-bus fault, and a finite utility plus 2500 kVA transformer at 480 V (hand value 50.128 kA). |
| F2 | src/engine/designchecks.js:72 | The cable bus design check took its voltage from `analysis.equipment[<from id>].kv`. For a transformer that is the HV terminal (first terminal), so a run from `T.lv` was checked at the primary voltage. | Example system: CB-1 (480 V) was checked at 13 800 V, and CB-2 (4.16 kV) at 13 800 V. That triggered the MV insulation build and a wrong voltage-drop base. | fixed. The check now uses the kV of the run's own bus. Test in `tests/designchecks.test.mjs`. |
| F3 | src/engine/gear.js:59 / :75 | The 215.3 check limit was `I·1.25·cont`, which drops the non-continuous share. The trip sizing on the line above used `I·(1 + 0.25·cont)`. | At `continuous: 0.5` the limit was 0.625·I, so a trip below the load current would pass. The correct limit is 1.125·I. | fixed. Test in `tests/gear.test.mjs`. |
| F4 | src/engine/gear.js:23, :72 | There was no NEC 240.4(D) small-conductor limit. With 90 °C ampacity, 240.4(B) alone allowed a 30 A trip on 12 AWG Cu. | 12 AWG Cu at 90 °C is 30 A. A 20 A load gets a 25–30 A trip, which passed. 240.4(D) caps 12 Cu at 20 A. | fixed. The limits (Cu 14/12/10 = 15/20/30 A, Al 12/10 = 15/25 A) are entered from memory and marked UNVERIFIED in the source. Test in `tests/gear.test.mjs`. |
| F5 | src/engine/arcflash.js:96 | Above 600 V the arc-flash boundary was found where the *interpolated* energy reaches 1.2 cal/cm². IEEE 1584-2018 instead computes AFB_600, AFB_2700 and AFB_14300 from each level's own equation, then interpolates the distances with the same three-point scheme as Iarc and E. E is not linear in D, so the two methods differ. | The new test derives the per-level AFB in closed form, lg AFB = (lg(5.0208·50/(12.552·T)) − A)/k12, and interpolates. The engine now matches to 1e-6. The coefficients remain PLACEHOLDER; this fixes only how they are applied. | fixed. Test in `tests/arcflash.test.mjs`. |
| F6 | src/engine/pecalc/forces.js:27, :48 | Port divergence: Python raises `ZeroDivisionError` for X/R = 0 (`-3/x_over_r`, `-t/tau`). JS returned `peakFactor(0) = 1.4425`, and cable bus forces of 164.8 lbf/ft with a NaN first peak. | `analyse({fault_ka: 50, x_over_r: 0})` returned numbers in JS and raised in Python. | fixed. JS now throws. Test in `tests/pecalc-core.test.mjs`. |

## Open: engine (JS-only modules)

| # | file:line | Claim | Evidence | Status |
|---|---|---|---|---|
| O1 | src/engine/loadflow.js:156 | Line charging at a tapped branch is not divided by \|τ\|². MATPOWER uses `Yff = (ys + j·b/2)/\|τ\|²`. | Mirrors Python `loadflow/solver.py:96`, which is byte-compatible by design. It has no effect when b = 0 on tapped branches (IEEE 14 and all System models). | open (Python behaviour; a convention choice) |
| O2 | src/engine/loadflow.js:361 | `balance_residual_pu` compares ΣP with branch losses only. Bus `shunt_g` losses are not counted, so the residual is non-zero whenever `shunt_g` ≠ 0. | Diagnostic only. | open |
| O3 | src/engine/shortcircuit.js:74 | Peak κ uses R/X of the Thevenin impedance (IEC method B without the 1.15 factor) in meshed networks. | Exact for radial networks. Meshed MV cases are slightly underestimated. | open |
| O4 | src/engine/system.js:177, :200 | The IEC 60909 impedance correction factors K_T (network transformers) and K_G (generators) are not applied. The method label says "IEC 60909-0". | K_T = 0.95·c_max/(1 + 0.6·x_T). For a 5.75 % unit this is 0.95·1.05/1.0345 = 0.964, i.e. LV I″k about 3.7 % higher than computed. | needs-standard (confirm against IEC 60909-0:2016 before applying) |
| O5 | src/engine/lfshortcircuit.js:22 | Buses without `kv` default to 1.0 kV, which selects c_max = 1.05 (LV). Per-unit transmission cases should probably use 1.10. | Affects `ik_pu` by 4.8 %. | open |
| O6 | src/engine/arcflash.js:177 + system.js:173 | After F1, at the utility bus Ibf = I″k/c = S/(c·√3·U). That is correct under IEC (S″kQ includes c). If the utility quotes an ANSI E/Z figure, Ibf is 1/c low. | Convention question for the user's utility data. | open |
| O7 | src/engine/arcflash.js:56 | The shallow-enclosure test uses only depth ≤ 203.2 mm and Voc ≤ 600 V. 1584-2018 also requires height and width < 508 mm, and the EES rules differ per configuration (VCB / VCBB / HCB). | Recall only. | needs-standard |
| O8 | src/engine/arcflash.js:140 | The Ibf validity warning uses 35 kA above 2.7 kV. The recalled range for 601 V–15 kV is 0.2–65 kA. | Recall only. | needs-standard |
| O9 | src/engine/arcflash.js:162 | Banner bypass check: the System UI always shows the PLACEHOLDER notice and `Data PLACEHOLDER` pill (`src/ui/systemArcFlash.jsx:36-37`). No report or export path emits arc-flash results. However, the engine API `arcFlash()` never refuses PLACEHOLDER data: it only tags `data_status`. `pecalc/ampacity.js` does refuse unless `allow_placeholder_data`. | Any future consumer (report, export) could print energies without the banner. | open (recommend gating with an explicit allow flag) |
| O10 | src/engine/system.js:219, gear.js:72 | Feeder and cable bus ampacity uses the insulation-temperature column (90 °C when set) with no NEC 110.14(C) termination limit (60/75 °C). The 240.4(B) check therefore uses 90 °C ampacity. | Example: 500 kcmil Cu 90 °C = 430 A vs 380 A at 75 °C. | open |
| O11 | src/engine/motorstart.js:70 | For autotransformer starts, the motor-terminal criterion compares the *bus* voltage with 80 %. The actual motor terminal voltage is tap × bus voltage. | Design decision about which criterion applies to reduced-voltage starts. | open |
| O12 | src/engine/loadprofile.js:41, :46 | `factor` reports the base profile even for equipment on its own profile. `loss_pct` is NaN when the total load is zero. | Cosmetic. | open |
| O13 | src/engine/system.js:213 | Cable bus Rac uses touching-cable proximity (spacing = OD), but cable bus has maintained spacing. | Small (+1–2 % R), conservative. | open |

## Open: pecalc (Python bugs, ports kept identical)

| # | file:line | Claim | Evidence | Status |
|---|---|---|---|---|
| P1 | pecalc/cablebus.js:452-457 (cablebus.py:382-384) | Voltage drop uses phase A's 0° voltage as the reference for every phase. The B and C drops are in the absolute frame, so "worst phase" is really phase A, and results depend on phase labels. | Flat 1×750 kcmil/phase, 1000 A, pf 0.9, 100 m. `ABC` gives 4.765 %, but `BCA` (the same layout) gives 2.375 %. The true worst phase is 4.765 % in both cases. The 3 % check flips. | open (Python bug) |
| P2 | pecalc/transformer.js:186 (transformer.py:187) | The DOE test point (50 % vs 35 %) is keyed on `lv_v > 600`. 10 CFR 431 classifies medium-voltage dry-type by primary voltage. | A 1500 kVA dry 13.8 kV/480 V unit is evaluated at 35 % (99.387 %). At 50 % it is 99.349 %. The golden encodes the Python behaviour. | open (Python bug) |
| P3 | pecalc/sizing.js:95 (sizing.py:135); cablebus.js:356 | Free-air installations take the 110.14(C) termination check from Table 310.17. The termination ampacity comes from 310.16. | 400 A continuous in free air recommends 2×2/0 Cu: 310.17 75 °C gives 265 ≥ 250, but 310.16 75 °C gives 175 < 250. | open (Python bug) |
| P4 | pecalc/sizing.js (sizing.py) | Feeder sizing has no 240.4(D) check, so it can recommend 14 AWG Cu for 20 A at a 75 °C terminal. | Hand case `{noncontinuous_a: 20, terminal_temp_c: 75}` gives 14 AWG. | open (Python bug) |
| P5 | pecalc/data/reactance_nec_table9.json, sizing.js:66 (sizing.py:103) | Table 9 has no 700/800/900/1250–2000 kcmil rows. These sizes fall back to a geometric trefoil reactance that ignores the conduit type. | X in Ω/km, PVC: 600 = 0.128, 700 = 0.0827, 750 = 0.1247. That is 35–48 % low in the gap sizes, so voltage drop is understated. | open (Python bug) |
| P6 | pecalc/transformer.js:199 (transformer.py:200) | IEC 60076-5 starting winding temperature θ0 is set to t_ref (85 °C). Recall: θ0 = ambient + rated average rise = 105 °C for liquid-filled units. | Default 1500 kVA: θ1 = 132.2 °C vs 155.2 °C, about 23 K non-conservative. | needs-standard |
| P7 | pecalc/transformer.js:201 (transformer.py:202) | The 250 °C Cu / 200 °C Al short-circuit limit is used for dry-type too, where IEC 60076-5 limits depend on insulation class. Only the LV winding current density is checked. | Recall only. | needs-standard |
| P8 | pecalc/thermal.js:213 (thermal.py:212) | EPR thermal resistivity is 5.0 K·m/W. Recalled IEC 60287-2-1 Table 1 value is 3.5 (5.0 is butyl rubber). | 15 kV 750 kcmil EPR: 895 A vs 954 A (conservative). | needs-standard |
| P9 | pecalc/thermal.js (thermal.py:214) | tan δ values 0.001 (XLPE) and 0.005 (EPR) vs recalled 0.004 / 0.020. The U0 thresholds below which dielectric loss is ignored are not applied. | Wd = 0.05 W/m on the 15 kV case; negligible. | needs-standard |
| P10 | pecalc/cablebus.js:521 (cablebus.py:433) | The cable bus support load is F·L, but switchgear.js uses 1.1·F·L for continuous spans (IEEE 605 interior reaction). | Internally inconsistent; 10 % lower on cable bus. | open |
| P11 | pecalc/transformer.js:194 (transformer.py:195) | Source and transformer impedance are added as magnitudes, and the source X/R is ignored in κ. | Slight understatement of fault current. | open |
| P12 | pecalc/sizing.js:76,131,134 (sizing.py:115,171,174); ampacity.js:91-94 | Port divergence on invalid input. Python raises; JS returns Infinity or NaN and reports "no size passes". Cases: `voltage_v = 0`, `power_factor > 1`, negative clearing time, short-circuit limit below operating temperature, degenerate `ambientFactor`. | Differential test. | open (port: recommend input validation that throws) |
| P13 | pecalc/sizing.js:18,79,140 | Note strings print whole-number floats as "2.0" where Python prints an int as "2". | 226 of 800 random cases differ only in note text. JS cannot tell int from float. | open (cosmetic) |
| P14 | pecalc/conductors.js:114 (conductors.py:128) | kp = 0.8 is the IEC 60287-1-1 value for dried-and-impregnated conductors. Extruded insulation uses kp = 1. | 500 kcmil Cu Rac +1.7 % with kp = 1. Table 9 gives 0.027 either way. | needs-standard |
| P15 | pecalc/data/ampacity_nec.json | Al 8 AWG 60 °C = 35. Older editions list 30. | Every other 310.16/310.17 row checked matches. | needs-standard (data is UNVERIFIED; status unchanged) |
| P16 | pecalc/sizing.js (sizing.py:116) | CEC 8-104 free-air continuous limits may be 70/85 % rather than 80/100 %. | CEC data is PLACEHOLDER. | needs-standard |
| P17 | pecalc/cablebus.js | There is no adiabatic short-time withstand check for the conductor or shield (I²t = K²S²), and no mutual heating between stacked tiers. | Missing checks, not wrong formulas. | open |

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
