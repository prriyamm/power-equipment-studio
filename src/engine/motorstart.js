/* Motor starting voltage dip: static (snapshot) study.
 * The starting motor's running load is replaced by a constant-impedance shunt admittance at its bus
 * (Z_LR = 1 / LRC on the motor kVA base, at the starting power factor), then the Newton-Raphson load flow
 * is re-solved. Other motors and loads stay constant-power. Dynamic speed/torque behaviour is not modelled. */
import { compileSystem, EQUIPMENT, motorKva, motorKw } from "./system.js";
import { runLoadFlow } from "./loadflow.js";

const SQRT3 = Math.sqrt(3);

export const STARTERS = {
  dol: { label: "Direct on line" },
  autotransformer_65: { label: "Autotransformer 65 % tap", tap: 0.65 },
  autotransformer_80: { label: "Autotransformer 80 % tap", tap: 0.8 },
  soft_starter_3x: { label: "Soft starter (3 x FLA limit)", max_fla: 3 },
  vfd: { label: "VFD (about 1.1 x FLA)", fla: 1.1 },
};

// Typical criteria only (IEEE 3002.7 / NEMA MG-1 practice); the project specification governs.
export const DEFAULT_CRITERIA = { motor_min_pu: 0.80, bus_max_dip_pct: 15, bus_min_pu: 0.85, status: "typical criteria", refs: "IEEE 3002.7, NEMA MG-1" };

/* Starting line current as a multiple of motor full-load current, and the power factor of that current. */
export function startingDuty(m, starter = "dol") {
  const st = STARTERS[starter];
  if (!st) throw new Error(`Unknown starter "${starter}"`);
  const pf_start = m.start_pf ?? 0.2;
  const lrc = m.lrc;
  if (st.tap) return { mult: lrc * st.tap * st.tap, pf: pf_start };          // line current scales with tap squared
  if (st.max_fla) return { mult: Math.min(lrc, st.max_fla), pf: pf_start };
  if (st.fla) return { mult: Math.min(lrc, st.fla), pf: m.pf };
  return { mult: lrc, pf: pf_start };
}

export function motorStartStudy(sys, motorId, opts = {}) {
  const crit = { ...DEFAULT_CRITERIA, ...(opts.criteria || {}) };
  const fail = (message) => ({ ok: false, message, criteria: crit });
  const c = compileSystem(sys);
  const err = c.issues.find((x) => x.level === "error");
  if (err) return fail(err.msg);
  const m = c.eq.get(motorId);
  if (!m || m.type !== "motor") return fail(`"${motorId}" is not a motor.`);
  const bid = c.busOf(`${motorId}.in`);
  if (bid == null) return fail(`${motorId} is de-energized.`);
  const starter = opts.starter ?? m.starter ?? "dol";
  let duty;
  try { duty = startingDuty(m, starter); } catch (e) { return fail(e.message); }

  const cfg = { vMin: 0.0, vMax: 2 };
  const pre = runLoadFlow(c.lfCase, cfg);
  if (!pre.buses || !pre.converged) return fail("Pre-start load flow did not converge.");

  // starting admittance (pu on system base): |y| = multiple x motor kVA / base, current lags by acos(pf)
  const sbase = c.base_mva * 1000;
  const y = (duty.mult * motorKva(m)) / sbase;
  const g = y * duty.pf, b = -y * Math.sqrt(1 - duty.pf * duty.pf);
  const pRun = (motorKw(m) * m.load_factor) / 1000, qRun = pRun * Math.tan(Math.acos(m.pf));
  const lf = JSON.parse(JSON.stringify(c.lfCase));
  const bus = lf.buses[bid - 1];
  bus.p_load = (bus.p_load ?? 0) - pRun; bus.q_load = (bus.q_load ?? 0) - qRun;
  bus.shunt_g = (bus.shunt_g ?? 0) + g; bus.shunt_b = (bus.shunt_b ?? 0) + b;
  const st = runLoadFlow(lf, cfg);
  if (!st.buses || !st.converged) return fail("Starting load flow did not converge (voltage collapse during start).");

  const kv = c.busMeta[bid - 1].kv, vStart = st.buses[bid - 1].v;
  const kva = y * vStart * vStart * sbase;
  const i_a = (y * vStart * sbase) / (SQRT3 * kv);
  const fla = motorKva(m) / (SQRT3 * kv);
  const rows = c.busMeta.map((meta, i) => {
    const v_pre = pre.buses[i].v, v_start = st.buses[i].v, dip_pct = (100 * (v_pre - v_start)) / v_pre;
    const is_motor = meta.id === bid;
    const pass = is_motor ? v_start >= crit.motor_min_pu : dip_pct <= crit.bus_max_dip_pct && v_start >= crit.bus_min_pu;
    return { bus: meta.id, label: meta.label, members: meta.members, kv: meta.kv, is_motor, v_pre, v_start, dip_pct, pass,
      limit: is_motor ? `motor terminal >= ${(crit.motor_min_pu * 100).toFixed(0)} %` : `dip <= ${crit.bus_max_dip_pct} % and V >= ${crit.bus_min_pu} pu` };
  });
  const mrow = rows.find((r) => r.is_motor);
  const others = rows.filter((r) => !r.is_motor);
  return {
    ok: true, criteria: crit, motor: { id: motorId, bus: bid, kv, starter, starter_label: STARTERS[starter].label, start_pf: duty.pf, fla_a: fla },
    start: { multiple_fla: duty.mult, i_a, i_ka: i_a / 1000, kva, kw: kva * duty.pf, y_pu: y },
    motor_terminal_pu: mrow.v_start, rows,
    pass: { motor: mrow.pass, others: others.every((r) => r.pass), all: rows.every((r) => r.pass) },
    worst_other: others.reduce((w, r) => (!w || r.dip_pct > w.dip_pct ? r : w), null),
  };
}

export const startableMotors = (sys) => (sys.equipment || []).filter((e) => e.type === "motor").map((e) => ({ ...EQUIPMENT.motor.defaults, ...e }));
export const largestMotor = (sys) => startableMotors(sys).sort((a, b) => motorKva(b) - motorKva(a))[0] || null;
