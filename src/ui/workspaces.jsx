/* Workspace registry. Add a workspace by adding an entry; Component null shows it as planned. */
import { LoadFlowWorkspace } from "./loadflow.jsx";
import { SystemWorkspace } from "./system.jsx";

export const WORKSPACES = [
  { key: "system", short: "System", title: "System view", icon: "M3 20h18M5 20V9l4-3v14M13 20V4h6v16M15 8h2M15 12h2M15 16h2", Component: SystemWorkspace, default: true,
    detail: "Equipment-level view of the whole package: utility source, transformers, switchgear lineups, cable bus runs and loads, drawn as equipment rather than wires, with live load-flow and fault results on each piece." },
  { key: "loadflow", short: "Flow", title: "Load flow", icon: "M3 12h4l3-8 4 16 3-8h4", Component: LoadFlowWorkspace },
  { key: "cablebus", short: "Cable bus", title: "Cable bus", icon: "M3 8h18v8H3zM7 12h.01M12 12h.01M17 12h.01", Component: null,
    detail: "Cable bus check and designer at any voltage: current sharing, ampacity (table, datasheet, IEC 60287), shield and enclosure losses, magnetic field, fault forces and cross-section drawings." },
  { key: "feeder", short: "Feeder", title: "Feeder & cable", icon: "M4 4c8 0 8 16 16 16M4 4h3M17 20h3", Component: null,
    detail: "Feeder sizing with parallel sets, terminal temperature rules, voltage drop, losses, short-circuit withstand and lug selection." },
  { key: "switchgear", short: "Gear", title: "Switchgear bus", icon: "M4 3h16v18H4zM4 9h16M4 15h16M9 3v18", Component: null,
    detail: "Switchgear and switchboard bus: Rac/Rdc and lamination sharing, temperature rise, short-circuit bracing and support spans." },
  { key: "transformer", short: "Xfmr", title: "Transformer", icon: "M8 12a4 4 0 1 0 0-.01M16 12a4 4 0 1 0 0-.01M2 12h2M20 12h2", Component: null,
    detail: "Preliminary transformer design: core and windings, losses, impedance tuned to a target %Z, efficiency including the DOE test point, fault withstand." },
];
