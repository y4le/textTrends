/**
 * Shared helpers for the real-browser suite. Assertions read the sanitized
 * protocol trace exposed by the e2e build (`window.__ttE2E`) and raw
 * IndexedDB from page context; nothing here touches app internals.
 */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { SHERLOCK } from '../src/lib/project.ts';
import { PLACE_HEADING, type Place } from '../src/lib/places.ts';
import { ARTIFACT_DB_NAME } from '../src/worker/idb-store.ts';
import type { TraceSnapshot, ProtocolTraceEvent } from '../src/lib/trace.ts';

export { SHERLOCK };
export const DOC_COUNT = SHERLOCK.length;
// The REAL database-name constants — a rename in src can never strand these
// helpers on a stale string literal.
export const DB_NAME = ARTIFACT_DB_NAME;

export const READY_TEXT = `${DOC_COUNT}/${DOC_COUNT} books ready`;

/**
 * Change place through the rendered workbench organs, preserving the running
 * worker/session. Catalog lives in Scope; the analyses live in Lens.
 */
export async function gotoPlace(page: Page, place: Place): Promise<void> {
  if (place === 'catalog') {
    await page
      .getByRole('region', { name: 'Scope' })
      .getByRole('button')
      .first()
      .click();
  } else {
    await page
      .getByRole('navigation', { name: 'Analysis lenses' })
      .getByRole('link', { name: PLACE_HEADING[place], exact: true })
      .click();
  }
  await expect(page).toHaveURL(new RegExp(`[?&]p=${place}(?:&|#|$)`));
}

/** Wait for the header to report `n/n books ready` (a user project's count). */
export async function awaitReadyCount(page: Page, n: number, timeout = 60_000): Promise<void> {
  await expect(page.getByText(`${n}/${n} books ready`, { exact: true })).toBeVisible({ timeout });
}

/** Clear the disposable artifact stores. Awaits transaction completion before
 * returning so a reload never races the eviction. */
export async function clearArtifactStores(page: Page): Promise<void> {
  await page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const stores = [...db.objectStoreNames];
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(stores, 'readwrite');
        for (const s of stores) tx.objectStore(s).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, DB_NAME);
}

export async function trace(page: Page): Promise<TraceSnapshot> {
  return page.evaluate(() => {
    const facade = (window as unknown as { __ttE2E?: { trace(): unknown } }).__ttE2E;
    if (!facade) throw new Error('e2e facade missing — was the app built with --mode e2e?');
    return facade.trace() as never;
  });
}

/**
 * Simulate the resizes-visual browser model. Playwright cannot summon an OS
 * keyboard, so this shadows only the VisualViewport values our app consumes
 * and dispatches the same resize event. The layout viewport stays unchanged.
 */
export async function simulateKeyboard(page: Page, occludedPixels: number): Promise<void> {
  await page.evaluate((occlusion) => {
    const visual = window.visualViewport;
    if (!visual) throw new Error('VisualViewport is unavailable');
    const scope = window as unknown as {
      __ttViewportSimulation?: {
        occlusion: number;
        scale: number;
      };
    };
    if (!scope.__ttViewportSimulation) {
      const state = { occlusion: 0, scale: 1 };
      scope.__ttViewportSimulation = state;
      Object.defineProperties(visual, {
        height: {
          configurable: true,
          get: () => Math.max(0, window.innerHeight - state.occlusion),
        },
        offsetTop: {
          configurable: true,
          get: () => 0,
        },
        scale: {
          configurable: true,
          get: () => state.scale,
        },
      });
    }
    scope.__ttViewportSimulation.occlusion = Math.max(0, occlusion);
    visual.dispatchEvent(new Event('resize'));
  }, occludedPixels);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/** Simulate only VisualViewport.scale so the pinch-zoom guard is testable. */
export async function simulatePinchZoom(page: Page, scale: number): Promise<void> {
  const installed = await page.evaluate(() =>
    Boolean((window as unknown as { __ttViewportSimulation?: unknown }).__ttViewportSimulation));
  if (!installed) await simulateKeyboard(page, 0);
  await page.evaluate((nextScale) => {
    const visual = window.visualViewport;
    const state = (window as unknown as {
      __ttViewportSimulation?: {
        occlusion: number;
        scale: number;
      };
    }).__ttViewportSimulation;
    if (!visual || !state) throw new Error('viewport simulation is not installed');
    state.scale = nextScale;
    visual.dispatchEvent(new Event('resize'));
  }, scale);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

export function events(snapshot: TraceSnapshot, filter: Partial<ProtocolTraceEvent>): ProtocolTraceEvent[] {
  return snapshot.events.filter((e) =>
    Object.entries(filter).every(([k, v]) => e[k as keyof ProtocolTraceEvent] === v),
  );
}

/** Wait for the app to report every book ready. */
export async function awaitAllReady(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.getByText(READY_TEXT, { exact: true })).toBeVisible({ timeout });
}

/** Remove every notebook group through the UI (the notebook is append-only;
 *  specs that want a FRESH comparison clear it first). */
export async function clearNotebook(page: Page): Promise<void> {
  const removeButtons = page.getByRole('button', { name: /^Remove / });
  while ((await removeButtons.count()) > 0) await removeButtons.first().click();
}

/** Open the cross-width quick-add layer and return its text field. */
export async function openQuickAdd(page: Page) {
  const input = page.getByRole('textbox', {
    name: 'Add terms to the notebook, comma-separated',
  });
  if (!(await input.isVisible())) {
    await page.getByRole('button', {
      name: 'Add terms to the notebook, comma-separated',
    }).click();
  }
  await expect(input).toBeVisible();
  return input;
}

/**
 * Submit a comparison and wait for EVERY query posted after the action to
 * deliver its result — an assertion must never pass on pre-action evidence
 * (a chip renders from store intent immediately), and a multi-series
 * comparison posts one trend job per series plus KWIC, all of which the
 * comparison render waits on (review rounds 1–2). Returns the fresh result
 * events; the LAST one's `at` stamp is the burst's delivery-settlement
 * time. A fresh job that errors or cancels stalls the poll into a visible
 * timeout failure.
 */
export async function submitAndAwaitFreshResults(page: Page, terms: string): Promise<ProtocolTraceEvent[]> {
  // The notebook is APPEND-ONLY (slice-1 commit C): "submit a comparison"
  // now means clear the notebook, then quick-add the terms. Removals happen
  // BEFORE the trace mark so their superseded (cancelled, never-delivering)
  // bursts can't stall the fresh-results poll.
  await clearNotebook(page);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const input = await openQuickAdd(page);
  await input.fill(terms);
  await input.press('Enter');
  let fresh: ProtocolTraceEvent[] = [];
  await expect
    .poll(
      async () => {
        const t = await trace(page);
        const freshQueries = t.events.filter(
          (e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'query',
        );
        if (freshQueries.length === 0) return 'no fresh query posted';
        const trendJobs = freshQueries.filter((q) => q.op === 'trend');
        if (trendJobs.length === 0) return 'no fresh trend job posted';
        const jobs = new Set(freshQueries.map((q) => q.job));
        fresh = t.events.filter(
          (e) => e.seq > mark && e.direction === 'from-worker' && e.t === 'result' && jobs.has(e.job),
        );
        return fresh.length === jobs.size ? 'all fresh results' : `${fresh.length}/${jobs.size} fresh results`;
      },
      { timeout: 30_000, message: `fresh queries for '${terms}' did not all deliver` },
    )
    .toBe('all fresh results');
  return fresh;
}

/** Record all corpus asset requests from now on. */
export function trackCorpusRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/corpora/')) urls.push(request.url());
  });
  return urls;
}

/**
 * Durability barrier (M6 consult §5): direct page-context IDB polling —
 * production stays best-effort; only the TEST waits. Polls until all
 * records exist, then validates keys, payload classes, and hash agreement
 * with the authoritative manifest.
 */
export async function awaitCacheSettled(page: Page): Promise<void> {
  // Wait for both disposable artifact classes: text and shard. This prevents
  // a reload from racing best-effort writes.
  const manifest = SHERLOCK.map(({ textHash }) => ({ textHash }));
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ dbName, docs }) => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open(dbName);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            try {
              const count = (store: string): Promise<number> =>
                new Promise((resolve, reject) => {
                  const tx = db.transaction(store, 'readonly').objectStore(store).count();
                  tx.onsuccess = () => resolve(tx.result);
                  tx.onerror = () => reject(tx.error);
                });
              const getAll = (store: string): Promise<unknown[]> =>
                new Promise((resolve, reject) => {
                  const tx = db.transaction(store, 'readonly').objectStore(store).getAll();
                  tx.onsuccess = () => resolve(tx.result as unknown[]);
                  tx.onerror = () => reject(tx.error);
                });
              const [texts, shards] = await Promise.all([
                count('texts'), count('shards'),
              ]);
              if (texts < docs.length || shards < docs.length) {
                return `texts=${texts} shards=${shards}`;
              }
              const allShards = await getAll('shards');
              for (const { textHash } of docs) {
                const text = await new Promise<unknown>((resolve, reject) => {
                  const req = db.transaction('texts', 'readonly').objectStore('texts').get(['texttrends/stored-text/1', textHash]);
                  req.onsuccess = () => resolve(req.result);
                  req.onerror = () => reject(req.error);
                });
                const t = text as { schema?: string; hash?: string; text?: string } | undefined;
                if (!t || t.schema !== 'texttrends/stored-text/1' || t.hash !== textHash || typeof t.text !== 'string') {
                  return `text record for ${textHash.slice(0, 8)} malformed`;
                }
                const s = (allShards as { schema?: string; textHash: string; shard?: { tokenTypeIds?: unknown; postings?: { positions?: unknown } } }[]).find((r) => r.textHash === textHash);
                if (!s || s.schema !== 'texttrends/stored-shard/1') return `shard record for ${textHash.slice(0, 8)} missing`;
                if (!(s.shard?.tokenTypeIds instanceof Uint32Array)) return 'tokenTypeIds not a Uint32Array after structured clone';
                if (!(s.shard?.postings?.positions instanceof Uint32Array)) return 'postings.positions not a Uint32Array';
              }
              return 'settled';
            } finally {
              db.close();
            }
          },
          { dbName: DB_NAME, docs: manifest },
        ),
      { timeout: 30_000, message: 'cache never settled' },
    )
    .toBe('settled');
}
