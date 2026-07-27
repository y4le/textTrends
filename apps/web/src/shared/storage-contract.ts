/**
 * The neutral storage vocabulary shared by BOTH worker storage classes and the
 * wire — deliberately only the shapes whose meaning is identical across them.
 * The two stores' FAILURE POLICIES stay visibly different by design (artifact
 * cache: degrade to miss/memory; durable user data: typed refusal) and must
 * never be merged behind these types.
 */

/** A cache/storage read: hit, miss, or a present-but-invalid record. What a
 *  `corrupt` read MEANS is the caller's policy (the artifact cache treats it
 *  as a miss + warning; the durable store reports it, never deletes). */
export type CacheRead<T> =
  | { readonly kind: 'miss' }
  | { readonly kind: 'hit'; readonly value: T }
  | { readonly kind: 'corrupt'; readonly reason: string };

/** Artifact-CACHE health degradation — cold recomputes, never data loss.
 *  The wire's `StorageWarningCodeV4` aliases this vocabulary. */
export type StorageWarningCode = 'CACHE_UNAVAILABLE' | 'CACHE_READ_FAILED' | 'CACHE_WRITE_FAILED' | 'CACHE_CORRUPT';

/** The result of opening a storage backend that may be blocked by another tab
 *  or unavailable in this browsing context. Generic over the store interface,
 *  so the engine's provider view and the concrete opener share ONE shape by
 *  construction instead of two structurally-synced-by-comment twins. */
export type StorageOpen<S> =
  | { readonly kind: 'ok'; readonly store: S }
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };
