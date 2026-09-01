/**
 * Shared helpers for the real-browser suite. Assertions read the sanitized
 * protocol trace exposed by the e2e build (`window.__ttE2E`) and raw
 * IndexedDB from page context; nothing here touches app internals.
 */

import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { SHERLOCK } from '../src/lib/project.ts';
import { PLACE_HEADING, type Place } from '../src/lib/places.ts';
import { ARTIFACT_DB_NAME } from '../src/worker/idb-store.ts';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';
import type { TraceSnapshot, ProtocolTraceEvent } from '../src/lib/trace.ts';

export { SHERLOCK };
export const DOC_COUNT = SHERLOCK.length;
// The REAL database-name constants — a rename in src can never strand these
// helpers on a stale string literal.
export const DB_NAME = ARTIFACT_DB_NAME;
export const WORKSPACE_DB_NAME = LOCAL_LIBRARY_DB_NAME;

export const READY_TEXT = `${DOC_COUNT}/${DOC_COUNT} texts ready`;

/**
 * Change place through the rendered workbench tabs, preserving the running
 * worker/session.
 */
export async function gotoPlace(page: Page, place: Place): Promise<void> {
  const link = page
    .getByRole('navigation', { name: 'Workbench sections' })
    .getByRole('link', { name: PLACE_HEADING[place], exact: true });
  if ((await link.getAttribute('aria-current')) !== 'page') await link.click();
  await expect(page).toHaveURL(new RegExp(`[?&]p=${place}(?:&|#|$)`));
}

/** Activate a shared Reader command from the presentation that actually fit:
 * directly from wide rails, or through the compact controls sheet. */
export async function activateReaderCommand(
  page: Page,
  reader: Locator,
  accessibleName: string,
): Promise<Locator> {
  const layout = reader.locator('.reader-read-layout');
  await expect(layout).toHaveAttribute('data-reader-layout', /^(bar|rails)$/);
  if (await layout.getAttribute('data-reader-layout') === 'rails') {
    const command = reader.getByRole('button', { name: accessibleName, exact: true });
    await command.click();
    return command;
  }
  const trigger = reader.getByRole('button', { name: /Open Reader controls for/ });
  await trigger.click();
  await page.getByRole('dialog', { name: 'Reader controls', exact: true })
    .getByRole('button', { name: accessibleName, exact: true }).click();
  return trigger;
}

/** Tests that construct a bespoke corpus opt out of the ordinary additive demo
 * inputs explicitly. Starter terms remain, matching a user who clears texts
 * without discarding their notebook. */
export async function clearDemoInputs(page: Page): Promise<void> {
  const active = page.getByRole('region', { name: 'Active inputs' });
  await expect(active).toBeVisible();
  for (const book of SHERLOCK) {
    const remove = active
      .getByRole('button', { name: `Remove ${book.title} from active inputs`, exact: true })
      .first();
    if ((await remove.count()) > 0) await remove.click();
    await expect(remove).toHaveCount(0);
  }
}

/** Wait for the header's accessible status to report `n/n texts ready`. */
export async function awaitReadyCount(page: Page, n: number, timeout = 60_000): Promise<void> {
  await expect(page.locator('.scope-organ > [role="status"]'))
    .toContainText(`${n}/${n} texts ready`, { timeout });
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

export async function workspaceRecord(page: Page): Promise<unknown> {
  return page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const request = database.transaction('workspace', 'readonly')
          .objectStore('workspace').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, WORKSPACE_DB_NAME);
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

export function workerQueriesAfter(
  traceEvents: TraceSnapshot['events'],
  mark: number,
): ProtocolTraceEvent[] {
  return traceEvents.filter((event) =>
    event.seq > mark && event.direction === 'to-worker' && event.t === 'query');
}

/** Wait for the app to report every Sherlock demo text ready. Demo loading is
 * explicit at cold-test call sites; after that fixture action, an initially
 * empty Inputs workspace moves to Trends by default so analysis specs start
 * from the same place as a warm nonempty workspace. Reload/restart calls omit
 * `loadDemo` and remain pure waits. */
export async function awaitAllReady(
  page: Page,
  options: { readonly loadDemo?: boolean; readonly timeout?: number; readonly placeAfterLoad?: Place } = {},
): Promise<void> {
  const timeout = options.timeout ?? 60_000;
  const ready = page.locator('.scope-organ > [role="status"]');
  if (!options.loadDemo) {
    await expect(ready).toContainText(READY_TEXT, { timeout });
    return;
  }
  if ((await ready.textContent())?.includes(READY_TEXT)) return;
  const navigation = page.getByRole('navigation', { name: 'Workbench sections' });
  await expect(navigation).toBeVisible({ timeout });
  const current = navigation.locator('[aria-current="page"]');
  const original = await current.getAttribute('href');
  const inputs = navigation.getByRole('link', { name: 'Inputs', exact: true });
  if (!(await inputs.getAttribute('aria-current'))) await inputs.click();
  const acquisition = page.getByRole('region', { name: 'Add texts', exact: true });
  await expect(acquisition).toBeVisible({ timeout });
  const showOptions = acquisition.getByRole('button', { name: 'Show options', exact: true });
  if (await showOptions.isVisible()) await showOptions.click();
  const loadDemo = page.locator('.input-sample').getByRole('button', { name: /Sherlock/ });
  await expect(loadDemo).toBeVisible({ timeout });
  if ((await loadDemo.getAttribute('aria-disabled')) !== 'true') await loadDemo.click();
  await expect(ready).toContainText(READY_TEXT, { timeout });
  await expect.poll(() => page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const workspace = await new Promise<unknown>((resolve, reject) => {
        const request = database.transaction('workspace', 'readonly').objectStore('workspace').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return (workspace as { corpus?: { order?: readonly string[] } } | undefined)?.corpus?.order?.length ?? 0;
    } finally {
      database.close();
    }
  }, LOCAL_LIBRARY_DB_NAME), { timeout }).toBe(DOC_COUNT);
  const destination = original && !original.includes('p=inputs')
    ? navigation.locator(`a[href="${original}"]`)
    : navigation.getByRole('link', { name: PLACE_HEADING[options.placeAfterLoad ?? 'trends'], exact: true });
  if ((await destination.getAttribute('aria-current')) !== 'page') await destination.click();
}

/** Remove every notebook group through the UI (the notebook is append-only;
 *  specs that want a FRESH comparison clear it first). */
export async function clearNotebook(page: Page): Promise<void> {
  if ((await page.locator('.term-bar .term-bucket').count()) === 0) return;

  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Manage terms' });
  const managerRemovals = manager.getByRole('button', { name: /^Remove / });
  while ((await managerRemovals.count()) > 0) await managerRemovals.first().click();
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
}

/** Open the inline quick-entry form and return its term field. */
export async function openQuickAdd(page: Page) {
  const input = page.getByRole('textbox', { name: 'New term' });
  if (!(await input.isVisible())) {
    await page.getByRole('button', { name: 'Add term', exact: true }).click();
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
  // now means clear the notebook, then add the terms through quick entry. Removals happen
  // BEFORE the trace mark so their superseded (cancelled, never-delivering)
  // bursts can't stall the fresh-results poll.
  await clearNotebook(page);
  let mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const delivered: ProtocolTraceEvent[] = [];
  const labels = terms.split(',').map((term) => term.trim()).filter(Boolean);
  for (let index = 0; index < labels.length; index++) {
    const input = await openQuickAdd(page);
    await input.fill(labels[index]!);
    await input.press('Enter');
    let fresh: ProtocolTraceEvent[] = [];
    await expect.poll(async () => {
      const snapshot = await trace(page);
      const queries = snapshot.events.filter(
        (event) => event.seq > mark && event.direction === 'to-worker' && event.t === 'query',
      );
      if (!queries.some((event) => event.op === 'trend')) return 'no fresh trend job posted';
      const jobs = new Set(queries.map((event) => event.job));
      fresh = snapshot.events.filter(
        (event) => event.seq > mark && event.direction === 'from-worker'
          && event.t === 'result' && jobs.has(event.job),
      );
      return fresh.length === jobs.size ? 'all fresh results' : `${fresh.length}/${jobs.size} fresh results`;
    }, { timeout: 30_000, message: `fresh queries for '${labels[index]}' did not all deliver` })
      .toBe('all fresh results');
    delivered.push(...fresh);
    mark = (await trace(page)).events.at(-1)?.seq ?? mark;
  }
  return delivered;
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
