/** Resolve a finite set of lazy modules once, sharing concurrent loads and
 * allowing a new load after rejection. No rendering or navigation policy. */
export function createModuleCache<Key extends string, Value>(loaders: Readonly<Record<Key, () => Promise<Value>>>) {
  const resolved = new Map<Key, Value>();
  const inFlight = new Map<Key, Promise<Value>>();
  return {
    resolved: (key: Key): Value | undefined => resolved.get(key),
    load(key: Key): Promise<Value> {
      if (resolved.has(key)) return Promise.resolve(resolved.get(key)!);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const request = Promise.resolve().then(loaders[key]).then((loaded) => {
        resolved.set(key, loaded);
        return loaded;
      }).finally(() => { inFlight.delete(key); });
      inFlight.set(key, request);
      return request;
    },
  };
}
