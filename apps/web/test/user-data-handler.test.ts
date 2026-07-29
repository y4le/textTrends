/**
 * The user-data lane (source-persist / project-load / project-save) driven
 * through the SAME engine harness as the lifecycle suite — moved VERBATIM
 * from engine-v4.test.ts (slice-2 ruling §A) so the eventual UserDataHandler
 * extraction (simplification D2) inherits a ready-made behavior suite.
 * Engine ROUTING assertions for these ops stay in engine-v4.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_INDEX_RECIPE, hashIndexRecipe, hashSourceBytes } from '@texttrends/core';
import { UserDataError, type UserDataStore } from '../src/worker/user-data-store.ts';
import { begin, buf, coldIngest, harness, wolfGroup } from './support/engine-harness.ts';
import { buildDocSpec as docSpec } from './support/spec-fixtures.ts';

describe('user-data lane', () => {
  it('source-persist verifies the claimed hash and acknowledges only a durable write', async () => {
    const h = harness();
    const bytes = buf('durable source bytes');
    const sourceHash = await hashSourceBytes(new Uint8Array(bytes));
    await h.send({ t: 'source-persist', job: 1, sourceHash, bytes });
    expect(h.last('source-persisted').sourceHash).toBe(sourceHash);
    expect((await h.userStore.getSource(sourceHash)).kind).toBe('hit');
  });

  it('source-persist rejects a claimed-hash mismatch with SOURCE_MISMATCH and writes nothing', async () => {
    const h = harness();
    await h.send({ t: 'source-persist', job: 1, sourceHash: 'not-the-hash', bytes: buf('bytes') });
    expect(h.last('user-data-error').code).toBe('SOURCE_MISMATCH');
  });

  it('cancellation before the durable write prevents it', async () => {
    const h = harness();
    const bytes = buf('durable source bytes');
    const sourceHash = await hashSourceBytes(new Uint8Array(bytes));
    // The cancel is delivered while the handler is still hashing/awaiting the
    // provider — the checkpoint before the durable write catches it.
    const persistPromise = h.send({ t: 'source-persist', job: 1, sourceHash, bytes });
    await h.send({ t: 'cancel', job: 1 });
    await persistPromise;
    expect(h.all('cancelled').some((m) => m.job === 1)).toBe(true);
    expect((await h.userStore.getSource(sourceHash)).kind).toBe('miss'); // never written
  });

  it('project-load deep-validates the durable manifest and maps a corrupt record to DATA_CORRUPT', async () => {
    const h = harness();
    // Seed a structurally-plausible but invalid manifest (bad hashes).
    await h.userStore.putProject({ schema: 'texttrends/project/1', id: 'p', revision: 1, order: [], docs: [], indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: 'wrong' } as never, 0);
    await h.send({ t: 'project-load', job: 1, project: 'p' });
    expect(h.last('user-data-error').code).toBe('DATA_CORRUPT');
  });

  it('project-save deep-validates BEFORE any durable write: invalid → REQUEST_INVALID, putProject never called', async () => {
    const h = harness();
    // The worker is the SOLE save-admission authority (the session posts
    // without a main-thread deep pass), so this gate is the only one: an
    // invalid manifest must be refused with a correlated typed error, no ack,
    // and — critically — no durable write attempt at all.
    let puts = 0;
    const store: UserDataStore = {
      getProject: () => Promise.resolve({ kind: 'miss' }),
      putProject: () => { puts++; return Promise.reject(new Error('must never be reached')); },
      getSource: () => Promise.resolve({ kind: 'miss' }),
      putSource: () => Promise.resolve(),
      close: () => undefined,
    };
    h.setUserData(() => Promise.resolve({ kind: 'ok', store }));
    // A manifest that satisfies EVERY downstream check (target id matches,
    // revision === expectedRevision + 1) and fails ONLY deep admission (wrong
    // indexRecipeHash) — so deleting or delaying validateProjectManifest must
    // reach putProject and fail this test (mutation-sensitive by construction).
    await h.send({
      t: 'project-save', job: 9, project: 'p',
      manifest: { schema: 'texttrends/project/1', id: 'p', revision: 1, order: [], docs: [], indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: 'wrong' },
      expectedRevision: 0,
    });
    const err = h.last('user-data-error');
    expect(err.code).toBe('REQUEST_INVALID');
    expect(err.job).toBe(9);
    expect(h.all('project-saved').length).toBe(0);
    expect(puts).toBe(0); // validation gated the write, not the other way round
  });

  it('project-load returns project-missing for an absent project', async () => {
    const h = harness();
    await h.send({ t: 'project-load', job: 1, project: 'absent' });
    expect(h.last('project-missing').project).toBe('absent');
  });

  it('a cancel delivered DURING deep manifest validation suppresses project-loaded', async () => {
    const h = harness();
    // A valid manifest so validation SUCCEEDS — the post-validation cancel check
    // (not the earlier post-read check) is what must win here.
    const manifest = {
      schema: 'texttrends/project/1', id: 'p', revision: 1, order: [], docs: [],
      indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: await hashIndexRecipe(DEFAULT_INDEX_RECIPE),
    };
    await h.userStore.putProject(manifest as never, 0);
    // Fire the cancel from INSIDE the first Web Crypto digest — i.e. once
    // validateProjectManifest has begun (past the post-read check) — so the
    // ONLY check that can catch it is the post-validation one.
    let validationEntered = false;
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(((...args: Parameters<typeof realDigest>) => {
      if (!validationEntered) { validationEntered = true; void h.send({ t: 'cancel', job: 1 }); }
      return realDigest(...args);
    }) as typeof crypto.subtle.digest);
    await h.send({ t: 'project-load', job: 1, project: 'p' });
    spy.mockRestore();
    expect(validationEntered).toBe(true); // validation was actually reached
    // The result is suppressed; a cancel acknowledgement is emitted instead.
    expect(h.all('project-loaded').length).toBe(0);
    expect(h.all('cancelled').some((m) => m.job === 1)).toBe(true);
  });

  it('a pre-write read failure on a CANCELLED job surfaces as cancelled, not a storage error', async () => {
    const h = harness();
    // getProject rejects (a cancellable pre-write await); the job is cancelled
    // before it settles, so cancellation must win over the storage error.
    const store: UserDataStore = {
      getProject: () => {
        void Promise.resolve().then(() => h.send({ t: 'cancel', job: 1 }));
        return Promise.reject(new UserDataError('PERSISTENCE_UNAVAILABLE', 'read blew up'));
      },
      putProject: () => Promise.reject(new Error('n/a')),
      getSource: () => Promise.resolve({ kind: 'miss' }),
      putSource: () => Promise.resolve(),
      close: () => undefined,
    };
    h.setUserData(() => Promise.resolve({ kind: 'ok', store }));
    await h.send({ t: 'project-load', job: 1, project: 'p' });
    expect(h.all('cancelled').some((m) => m.job === 1)).toBe(true);
    expect(h.all('user-data-error').length).toBe(0);
  });

  it('durable unavailability yields a precise user-data error while analysis queries keep working', async () => {
    const h = harness();
    h.setUserData(() => Promise.resolve({ kind: 'unavailable', message: 'no durable storage' }));
    await h.send({ t: 'project-load', job: 1, project: 'p' });
    expect(h.last('user-data-error').code).toBe('PERSISTENCE_UNAVAILABLE');
    // Analysis is entirely independent of the durable lane.
    const spec = await docSpec('a', 'the wolf ran far');
    await begin(h, [spec], 'g2');
    await coldIngest(h, 'g2', 'a', 'the wolf ran far', 10);
    const snap = h.last('snapshot-published').snapshot;
    await h.send({ t: 'query', job: 20, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 4 } } });
    const result = h.last('result');
    expect(result.data.op).toBe('trend');
  });
});
