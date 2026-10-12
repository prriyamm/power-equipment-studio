/* Example packages for the System workspace. Positions are iso grid units (one unit ≈ 3 ft);
 * every piece keeps at least 1.5 units of clearance from its neighbours. Ratings are example inputs. */
import { EXAMPLE_SYSTEM } from "./system.js";

const pvc = { raceway: "pvc", insulation_c: 90 };

/* ------------------------------------------------ double-ended substation */
const DOUBLE_ENDED = {
  name: "Double-ended substation",
  base_mva: 10,
  equipment: [
    { id: "UTIL", type: "utility", name: "Utility 13.8 kV", kv: 13.8, mva_sc: 350, xr: 15, gx: 0, gy: 0 },
    { id: "SWGR-MV", type: "switchgear", name: "15 kV switchgear", kv: 13.8, bus_a: 1200, sc_ka: 25, sections: 4, gx: 3, gy: 0 },
    { id: "T1", type: "transformer", name: "T1 2000 kVA", kva: 2000, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7, gx: 3, gy: 6 },
    { id: "T2", type: "transformer", name: "T2 2000 kVA", kva: 2000, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7, gx: 9, gy: 6 },
    { id: "LV-A", type: "switchgear", name: "480 V lineup A", kv: 0.48, bus_a: 3000, sc_ka: 100, sections: 4, gx: 0, gy: 11 },
    { id: "LV-B", type: "switchgear", name: "480 V lineup B", kv: 0.48, bus_a: 3000, sc_ka: 100, sections: 4, gx: 9, gy: 11 },
    { id: "LOAD-A1", type: "load", name: "Process load A1", kw: 600, pf: 0.9, gx: 0, gy: 16 },
    { id: "LOAD-A2", type: "load", name: "Process load A2", kw: 500, pf: 0.9, gx: 4.5, gy: 16 },
    { id: "LOAD-B1", type: "load", name: "Process load B1", kw: 650, pf: 0.9, gx: 9, gy: 16 },
    { id: "M-B1", type: "motor", name: "Pump 250 hp", hp: 250, gx: 13.5, gy: 16 },
  ],
  connectors: [
    { id: "C-UTIL", kind: "cable", from: "UTIL.out", to: "SWGR-MV.bus", size: "4/0", length_ft: 150, ...pvc },
    { id: "C-T1", kind: "cable", from: "SWGR-MV.bus", to: "T1.hv", size: "2/0", length_ft: 100, ...pvc },
    { id: "C-T2", kind: "cable", from: "SWGR-MV.bus", to: "T2.hv", size: "2/0", length_ft: 100, ...pvc },
    { id: "CB-A", kind: "cablebus", from: "T1.lv", to: "LV-A.bus", size: "750", sets: 3, length_ft: 40 },
    { id: "CB-B", kind: "cablebus", from: "T2.lv", to: "LV-B.bus", size: "750", sets: 3, length_ft: 40 },
    { id: "TIE", kind: "cablebus", from: "LV-A.bus", to: "LV-B.bus", size: "750", sets: 3, length_ft: 30 },
    { id: "C-LA1", kind: "cable", from: "LV-A.bus", to: "LOAD-A1.in", size: "500", sets: 3, length_ft: 120 },
    { id: "C-LA2", kind: "cable", from: "LV-A.bus", to: "LOAD-A2.in", size: "500", sets: 2, length_ft: 140 },
    { id: "C-LB1", kind: "cable", from: "LV-B.bus", to: "LOAD-B1.in", size: "500", sets: 3, length_ft: 120 },
    { id: "C-MB1", kind: "cable", from: "LV-B.bus", to: "M-B1.in", size: "500", sets: 1, length_ft: 150 },
  ],
};

/* ---------------------------------- industrial plant, 4.16 kV motors + generator */
const INDUSTRIAL = {
  name: "Industrial plant with standby generator",
  base_mva: 10,
  equipment: [
    { id: "UTIL", type: "utility", name: "Utility 13.8 kV", kv: 13.8, mva_sc: 500, xr: 15, gx: 0, gy: 0 },
    { id: "SWGR-MV", type: "switchgear", name: "15 kV switchgear", kv: 13.8, bus_a: 1200, sc_ka: 40, sections: 3, gx: 3, gy: 0 },
    { id: "T1", type: "transformer", name: "T1 2500 kVA (480 V)", kva: 2500, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7, gx: 3, gy: 6 },
    { id: "T2", type: "transformer", name: "T2 5000 kVA (4.16 kV)", kva: 5000, hv_kv: 13.8, lv_kv: 4.16, z_pct: 6.5, xr: 10, gx: 9, gy: 6 },
    { id: "SWGR-LV", type: "switchgear", name: "480 V switchgear", kv: 0.48, bus_a: 4000, sc_ka: 65, sections: 5, gx: 0, gy: 11 },
    { id: "GEN-1", type: "generator", name: "Standby generator 1000 kVA", kv: 0.48, kva: 1000, pf: 0.8, p_kw: 300, v_pu: 1.0, gx: -5, gy: 11 },
    { id: "SWGR-5", type: "switchgear", name: "4.16 kV motor bus", kv: 4.16, bus_a: 1200, sc_ka: 40, sections: 3, gx: 10, gy: 11 },
    { id: "LOAD-1", type: "load", name: "Plant lighting and process", kw: 700, pf: 0.9, gx: 0, gy: 16 },
    { id: "MCC-1", type: "mcc", name: "MCC-1", kv: 0.48, bus_a: 800, sc_ka: 42, sections: 3, gx: 4.5, gy: 16 },
    { id: "M-MCC", type: "motor", name: "Pump 100 hp", hp: 100, gx: 4.5, gy: 20 },
    { id: "CAP-1", type: "capacitor", name: "300 kvar bank", kvar: 300, gx: 6.6, gy: 11 },
    { id: "M1", type: "motor", name: "Compressor 1000 hp", hp: 1000, eff: 0.96, pf: 0.9, load_factor: 0.8, gx: 10, gy: 17 },
    { id: "M2", type: "motor", name: "Mill 1250 hp", hp: 1250, eff: 0.96, pf: 0.9, load_factor: 0.8, gx: 14, gy: 17 },
    { id: "M3", type: "motor", name: "Blower 800 hp", hp: 800, eff: 0.955, pf: 0.89, load_factor: 0.8, gx: 18, gy: 17 },
  ],
  connectors: [
    { id: "C-UTIL", kind: "cable", from: "UTIL.out", to: "SWGR-MV.bus", size: "4/0", length_ft: 200, ...pvc },
    { id: "C-T1", kind: "cable", from: "SWGR-MV.bus", to: "T1.hv", size: "2/0", length_ft: 120, ...pvc },
    { id: "C-T2", kind: "cable", from: "SWGR-MV.bus", to: "T2.hv", size: "4/0", length_ft: 120, ...pvc },
    { id: "CB-1", kind: "cablebus", from: "T1.lv", to: "SWGR-LV.bus", size: "750", sets: 4, length_ft: 40 },
    { id: "CB-2", kind: "cablebus", from: "T2.lv", to: "SWGR-5.bus", size: "750", sets: 1, length_ft: 40, insulation_c: 90 },
    { id: "C-GEN", kind: "cable", from: "GEN-1.out", to: "SWGR-LV.bus", size: "500", sets: 2, length_ft: 60 },
    { id: "C-LOAD", kind: "cable", from: "SWGR-LV.bus", to: "LOAD-1.in", size: "500", sets: 3, length_ft: 150 },
    { id: "C-MCC", kind: "cable", from: "SWGR-LV.bus", to: "MCC-1.bus", size: "500", sets: 1, length_ft: 180 },
    { id: "C-MM", kind: "cable", from: "MCC-1.bus", to: "M-MCC.in", size: "2/0", length_ft: 80 },
    { id: "C-CAP", kind: "cable", from: "SWGR-LV.bus", to: "CAP-1.in", size: "500", sets: 2, length_ft: 30 },
    { id: "C-M1", kind: "cable", from: "SWGR-5.bus", to: "M1.in", size: "1/0", length_ft: 300, insulation_c: 90 },
    { id: "C-M2", kind: "cable", from: "SWGR-5.bus", to: "M2.in", size: "2/0", length_ft: 350, insulation_c: 90 },
    { id: "C-M3", kind: "cable", from: "SWGR-5.bus", to: "M3.in", size: "1/0", length_ft: 400, insulation_c: 90 },
  ],
};

/* ------------------------------------------------------------- data hall */
const DATA_HALL = {
  name: "Data hall, 2 x 3000 kVA",
  base_mva: 10,
  equipment: [
    { id: "UTIL", type: "utility", name: "Utility 13.8 kV", kv: 13.8, mva_sc: 500, xr: 15, gx: 0, gy: 0 },
    { id: "SWGR-MV", type: "switchgear", name: "15 kV switchgear", kv: 13.8, bus_a: 1200, sc_ka: 40, sections: 3, gx: 3, gy: 0 },
    { id: "T1", type: "transformer", name: "T1 3000 kVA", kva: 3000, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7, gx: 2, gy: 6 },
    { id: "T2", type: "transformer", name: "T2 3000 kVA", kva: 3000, hv_kv: 13.8, lv_kv: 0.48, z_pct: 5.75, xr: 7, gx: 10, gy: 6 },
    { id: "LV-A", type: "switchgear", name: "480 V gear A", kv: 0.48, bus_a: 4000, sc_ka: 100, sections: 5, gx: 0, gy: 11 },
    { id: "LV-B", type: "switchgear", name: "480 V gear B", kv: 0.48, bus_a: 4000, sc_ka: 100, sections: 5, gx: 10, gy: 11 },
    { id: "CAP-A", type: "capacitor", name: "600 kvar bank", kvar: 600, gx: -3, gy: 11 },
    { id: "UPS-A1", type: "load", name: "UPS row A1", kw: 1000, pf: 0.95, gx: 0, gy: 17 },
    { id: "UPS-A2", type: "load", name: "UPS row A2", kw: 1000, pf: 0.95, gx: 4.5, gy: 17 },
    { id: "UPS-B1", type: "load", name: "PDU row B1", kw: 1000, pf: 0.95, gx: 10, gy: 17 },
    { id: "UPS-B2", type: "load", name: "PDU row B2", kw: 1000, pf: 0.95, gx: 14.5, gy: 17 },
  ],
  connectors: [
    { id: "C-UTIL", kind: "cable", from: "UTIL.out", to: "SWGR-MV.bus", size: "4/0", length_ft: 150, ...pvc },
    { id: "C-T1", kind: "cable", from: "SWGR-MV.bus", to: "T1.hv", size: "2/0", length_ft: 100, ...pvc },
    { id: "C-T2", kind: "cable", from: "SWGR-MV.bus", to: "T2.hv", size: "2/0", length_ft: 100, ...pvc },
    { id: "CB-A", kind: "cablebus", from: "T1.lv", to: "LV-A.bus", size: "750", sets: 4, length_ft: 40 },
    { id: "CB-B", kind: "cablebus", from: "T2.lv", to: "LV-B.bus", size: "750", sets: 4, length_ft: 40 },
    { id: "CB-A1", kind: "cablebus", from: "LV-A.bus", to: "UPS-A1.in", size: "750", sets: 2, length_ft: 120 },
    { id: "CB-A2", kind: "cablebus", from: "LV-A.bus", to: "UPS-A2.in", size: "750", sets: 2, length_ft: 140 },
    { id: "CB-B1", kind: "cablebus", from: "LV-B.bus", to: "UPS-B1.in", size: "750", sets: 2, length_ft: 120 },
    { id: "CB-B2", kind: "cablebus", from: "LV-B.bus", to: "UPS-B2.in", size: "750", sets: 2, length_ft: 140 },
    { id: "C-CAP", kind: "cable", from: "LV-A.bus", to: "CAP-A.in", size: "500", sets: 3, length_ft: 30 },
  ],
};

export const LIBRARY = [
  { key: "unit-substation", name: "Unit substation", note: "13.8 kV utility, 2.5 MVA to 480 V gear with MCC, motors and a 4.16 kV motor bus.", system: EXAMPLE_SYSTEM },
  { key: "double-ended", name: "Double-ended substation", note: "Two 2000 kVA transformers on one MV bus, 480 V lineups joined by a cable bus tie.", system: DOUBLE_ENDED },
  { key: "industrial-plant", name: "Industrial plant", note: "4.16 kV motor bus (three large motors), 480 V gear with MCC and a standby generator.", system: INDUSTRIAL },
  { key: "data-hall", name: "Data hall", note: "Two 3000 kVA transformers, 480 V gear, cable bus runs to four UPS/PDU rows and a capacitor bank.", system: DATA_HALL },
];
