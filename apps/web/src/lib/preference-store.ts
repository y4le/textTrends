export type PreferenceScope = 'local' | 'session';

export type PreferenceReader = Pick<Storage, 'getItem'>;
export type PreferenceWriter = Pick<Storage, 'setItem' | 'removeItem'>;

export interface PreferenceDescriptor {
  readonly key: string;
  readonly scope: PreferenceScope;
  readonly legacyKeys: readonly string[];
}

export interface PreferenceCodec<T> extends Omit<PreferenceDescriptor, 'legacyKeys'> {
  readonly legacyKeys?: readonly string[];
  parse(value: unknown): T | null;
  serialize(value: T): unknown | null;
}

export interface Preference<T> extends PreferenceDescriptor {
  load(storage: PreferenceReader | null): T | null;
  save(storage: PreferenceWriter | null, value: T): void;
  clear(storage: Pick<Storage, 'removeItem'> | null): void;
}

export function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(record).sort().join('\u001f') === [...expected].sort().join('\u001f');
}

export function definePreference<T>(codec: PreferenceCodec<T>): Preference<T> {
  const legacyKeys = Object.freeze([...(codec.legacyKeys ?? [])]);
  const keys = Object.freeze([codec.key, ...legacyKeys]);
  return Object.freeze({
    key: codec.key,
    scope: codec.scope,
    legacyKeys,
    load(storage: PreferenceReader | null): T | null {
      if (storage === null) return null;
      try {
        const raw = storage.getItem(codec.key);
        return raw === null ? null : codec.parse(JSON.parse(raw) as unknown);
      } catch {
        return null;
      }
    },
    save(storage: PreferenceWriter | null, value: T): void {
      if (storage === null) return;
      try {
        const serialized = codec.serialize(value);
        if (serialized === null) return;
        storage.setItem(codec.key, JSON.stringify(serialized));
        for (const key of legacyKeys) storage.removeItem(key);
      } catch {
        // Preferences remain live in memory when browser storage is unavailable.
      }
    },
    clear(storage: Pick<Storage, 'removeItem'> | null): void {
      if (storage === null) return;
      try {
        for (const key of keys) storage.removeItem(key);
      } catch {
        // A reset caller reports broader storage failures at its own boundary.
      }
    },
  });
}

export function browserStorage<S extends PreferenceScope>(
  target: Pick<Window, `${S}Storage`>,
  scope: S,
): Storage | null {
  try {
    return target[`${scope}Storage`];
  } catch {
    return null;
  }
}
