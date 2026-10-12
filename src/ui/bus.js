// Tiny pub-sub so workspaces can hand work to each other (System → Load flow, System → Cable bus).
// A message sent before its listener mounts is held until the first listener subscribes.
const listeners = new Map();
const pending = new Map();
export const bus = {
  on(topic, fn) {
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic).add(fn);
    if (pending.has(topic)) { const msgs = pending.get(topic); pending.delete(topic); msgs.forEach((m) => fn(m)); }
    return () => listeners.get(topic).delete(fn);
  },
  emit(topic, msg) {
    const set = listeners.get(topic);
    if (set && set.size) set.forEach((fn) => fn(msg));
    else pending.set(topic, [...(pending.get(topic) || []), msg]);
  },
};
