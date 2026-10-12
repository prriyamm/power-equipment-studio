// Tiny pub-sub so workspaces can hand work to each other (System → Load flow, System → Cable bus,
// modules → System for design pushes).
// emit: a message sent before its listener mounts is held until the first listener subscribes.
// retain: state-like topics (e.g. the current System model) keep only the latest value; a new listener
// gets it immediately, and nothing piles up while no one listens.
const listeners = new Map();
const pending = new Map();
const retained = new Map();
export const bus = {
  on(topic, fn) {
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic).add(fn);
    if (retained.has(topic)) fn(retained.get(topic));
    if (pending.has(topic)) { const msgs = pending.get(topic); pending.delete(topic); msgs.forEach((m) => fn(m)); }
    return () => listeners.get(topic).delete(fn);
  },
  emit(topic, msg) {
    const set = listeners.get(topic);
    if (set && set.size) set.forEach((fn) => fn(msg));
    else pending.set(topic, [...(pending.get(topic) || []), msg]);
  },
  retain(topic, msg) {
    retained.set(topic, msg);
    listeners.get(topic)?.forEach((fn) => fn(msg));
  },
  peek(topic) { return retained.get(topic); },
};
