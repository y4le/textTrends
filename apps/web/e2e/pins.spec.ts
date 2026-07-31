/**
 * Slice-2 F browser proof. Passage results are completed in the real worker
 * but withheld at postMessage, so two pin requests overlap and a removed pin's
 * late result physically arrives after removal.
 */

import { expect, test, type Page, type Worker } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  gotoPlace,
  SHERLOCK,
  submitAndAwaitFreshResults,
  trace,
  USER_DATA_DB,
} from './helpers.ts';
import { TREND_LABEL_SPACE } from '../src/lib/trend-geometry.ts';

const CORPUS = 'alpha wolf beta gamma fox delta wolf eta theta wolf iota omega\n';
const REPLACEMENT = 'replacement text changes the snapshot identity\n';

async function importCorpus(
  page: Page,
  name: string,
  text: string,
  expectedReady: number,
): Promise<void> {
  await gotoPlace(page, 'corpus');
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByLabel(/Create project from files|Add files/).setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(text, 'utf-8'),
  });
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => {
      const snapshot = await trace(page);
      return snapshot.events.some(
        (event) =>
          event.seq > mark
          && event.direction === 'from-worker'
          && event.t === 'snapshot-published'
          && event.readyCount === expectedReady,
      );
    }, { timeout: 30_000 })
    .toBe(true);
  await awaitReadyCount(page, expectedReady);
}

async function quarantineFirstDurablePin(page: Page): Promise<void> {
  await page.evaluate(async ({ dbName, project }) => {
    interface StoredPin {
      readonly id: string;
      readonly note: string;
      readonly anchor: {
        readonly doc: string;
        readonly text: string;
        readonly chars: { readonly start: number; readonly end: number };
      };
      readonly captured: readonly unknown[];
    }
    interface StoredResearch {
      readonly pins: readonly StoredPin[];
      readonly [key: string]: unknown;
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction('research', 'readwrite');
      const store = tx.objectStore('research');
      await new Promise<void>((resolve, reject) => {
        const request = store.get(project);
        request.onsuccess = () => {
          const research = request.result as StoredResearch | undefined;
          const pin = research?.pins[0];
          if (!research || !pin) {
            tx.abort();
            reject(new Error('a durable pin was not saved before quarantine'));
            return;
          }
          const replacement = pin.anchor.text === '0'.repeat(64)
            ? '1'.repeat(64)
            : '0'.repeat(64);
          store.put({
            ...research,
            pins: [{
              ...pin,
              note: 'Marginal note, not a document title',
              anchor: { ...pin.anchor, text: replacement },
            }, ...research.pins.slice(1)],
          });
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('research mutation aborted'));
      });
    } finally {
      db.close();
    }
  }, { dbName: USER_DATA_DB, project: 'builtin/sherlock' });
}

async function installPassageResultGate(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    interface Held {
      message: unknown;
      transfer?: Transferable[];
    }
    interface Gate {
      armed: boolean;
      held: Held[];
      arm(): void;
      heldCount(): number;
      release(): void;
    }
    interface Scope {
      __ttPinGate?: Gate;
      postMessage: (message: unknown, transfer?: Transferable[]) => void;
    }
    const scope = globalThis as unknown as Scope;
    if (scope.__ttPinGate) return;
    const original = scope.postMessage.bind(scope);
    const send = (item: Held) => {
      if (item.transfer && item.transfer.length > 0) original(item.message, item.transfer);
      else original(item.message);
    };
    const gate: Gate = {
      armed: false,
      held: [],
      arm() {
        if (this.held.length > 0) throw new Error('release held passage results before rearming');
        this.armed = true;
      },
      heldCount() {
        return this.held.length;
      },
      release() {
        this.armed = false;
        const held = this.held.splice(0);
        for (const item of held) send(item);
      },
    };
    scope.__ttPinGate = gate;
    scope.postMessage = (message: unknown, transfer?: Transferable[]) => {
      const candidate = message as { t?: string; data?: { op?: string } };
      if (gate.armed && candidate.t === 'result' && candidate.data?.op === 'passage') {
        gate.held.push({ message, ...(transfer ? { transfer } : {}) });
        return;
      }
      send({ message, ...(transfer ? { transfer } : {}) });
    };
  });
}

const gateArm = (worker: Worker) =>
  worker.evaluate(() => {
    const gate = (globalThis as unknown as {
      __ttPinGate?: { arm(): void };
    }).__ttPinGate;
    if (!gate) throw new Error('pin result gate is not installed');
    gate.arm();
  });

const gateHeld = (worker: Worker) =>
  worker.evaluate(() =>
    (globalThis as unknown as {
      __ttPinGate?: { heldCount(): number };
    }).__ttPinGate?.heldCount() ?? -1,
  );

const gateRelease = (worker: Worker) =>
  worker.evaluate(() => {
    const gate = (globalThis as unknown as {
      __ttPinGate?: { release(): void };
    }).__ttPinGate;
    if (!gate) throw new Error('pin result gate is not installed');
    gate.release();
  });

test('explicit pins are independent, removed late evidence stays removed, and snapshots clear pins', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await importCorpus(page, 'pins.txt', CORPUS, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  await expect.poll(() => page.workers().length).toBe(1);
  const worker = page.workers()[0]!;
  await installPassageResultGate(worker);
  await gateArm(worker);

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  const box = (await scrubber.boundingBox())!;
  const plotWidth = box.width - TREND_LABEL_SPACE;
  const point = (token: number) => ({
    x: box.x + plotWidth * ((token + 0.5) / 12),
    y: box.y + 80,
  });
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  // Hover starts the shared scrub request. Chart activation only reads; the
  // explicit Evidence-line Pin action starts each independently owned request.
  // With all passage results held, both cards must coexist.
  await page.mouse.move(point(1).x, point(1).y);
  await expect.poll(() => gateHeld(worker)).toBeGreaterThanOrEqual(1);
  await page.mouse.click(point(1).x, point(1).y);
  await page.getByRole('button', { name: 'Pin passage at token 2' }).click();
  await page.mouse.click(point(9).x, point(9).y);
  await page.getByRole('button', { name: 'Pin passage at token 10' }).click();
  await gotoPlace(page, 'findings');
  const pane = page.getByRole('region', { name: 'Pinned evidence' });
  await expect(pane.locator('article')).toHaveCount(2);
  await expect(pane.getByText('capturing passage…')).toHaveCount(2);
  await expect.poll(() => gateHeld(worker)).toBeGreaterThanOrEqual(3);

  // Duplicate location focuses rather than appending, even while pending.
  await gotoPlace(page, 'trends');
  await page.getByRole('button', { name: 'Pin passage at token 10' }).click();
  await gotoPlace(page, 'findings');
  await expect(pane.locator('article')).toHaveCount(2);
  await expect(pane.getByText(/already pinned; focused the existing evidence/i)).toBeVisible();

  // Remove A while its completed worker result is still withheld. Releasing
  // that result cannot resurrect the card; B independently becomes ready.
  await pane.locator('.findings-record-trigger').first().click();
  await pane.locator('article').first().getByRole('button', { name: 'remove' }).click();
  await expect(pane.locator('article')).toHaveCount(1);
  await gateRelease(worker);
  await expect.poll(() => gateHeld(worker)).toBe(0);
  await pane.locator('.findings-record-trigger').click();
  await expect(pane.getByRole('button', { name: /Open pinned evidence/ })).toBeVisible();
  await expect(pane.locator('article')).toHaveCount(1);

  // Job-correlate the proof: at least the held scrub + two independent pin
  // passage requests were posted after the mark, and their result messages
  // physically reached the client after release.
  await expect
    .poll(async () => {
      const snapshot = await trace(page);
      const jobs = new Set(
        snapshot.events
          .filter(
            (event) =>
              event.seq > mark
              && event.direction === 'to-worker'
              && event.t === 'query'
              && event.op === 'passage',
          )
          .map((event) => event.job),
      );
      const delivered = snapshot.events.filter(
        (event) =>
          event.seq > mark
          && event.direction === 'from-worker'
          && event.t === 'result'
          && jobs.has(event.job),
      ).length;
      return jobs.size >= 3 && delivered >= 3 ? 'correlated' : `${jobs.size}/${delivered}`;
    }, { timeout: 30_000 })
    .toBe('correlated');

  // A new snapshot clears transient token coordinates, then durable character
  // anchors restore evidence whose document TextHash is unchanged.
  await importCorpus(page, 'replacement.txt', REPLACEMENT, 2);
  await gotoPlace(page, 'findings');
  const pinnedEvidence = page.getByRole('region', { name: 'Pinned evidence' });
  await expect(pinnedEvidence).toHaveCount(1);
  await expect(pinnedEvidence.getByText('pins · token 10')).toBeVisible();
});

test('repeated chart activation reads without creating durable evidence', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  const box = (await scrubber.boundingBox())!;
  const plotWidth = box.width - TREND_LABEL_SPACE;
  const visited = new Set<string>();
  for (let index = 0; index < 10; index++) {
    await page.mouse.click(
      box.x + 4 + ((plotWidth - 8) * index) / 9,
      box.y + 80,
    );
    const label = await page
      .getByRole('button', { name: /Pin passage at token/ })
      .getAttribute('aria-label');
    if (label) visited.add(label);
  }
  expect(visited.size).toBeGreaterThan(1);

  const scope = page.getByRole('region', { name: 'Scope' });
  await expect(scope.getByText('0 of 8 pinned', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Pinned evidence' })).toHaveCount(0);

  // Retention is now an explicit verb on the Evidence line. Reader exposes
  // the same verb; repeating it at the same anchor focuses rather than adds.
  const pin = page.getByRole('button', { name: /Pin passage at token/ });
  await expect(pin).toBeVisible();
  await pin.click();
  await expect(scope.getByText('1 of 8 pinned', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open passage in reader' }).click();
  const reader = page.getByRole('dialog', { name: /Reader:/ });
  const readerPin = reader.getByRole('button', { name: /Pin reader passage at token/ });
  await expect(readerPin).toBeVisible();
  await readerPin.click();
  await expect(reader.getByRole('status')).toContainText(
    'That position is already pinned; focused the existing evidence.',
  );
  await reader.getByRole('button', { name: 'back', exact: true }).click();
  await expect(scope.getByText('1 of 8 pinned', { exact: true })).toBeVisible();
});

test('at capacity Pin stays reachable and announces the refusal', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  for (let index = 0; index < 8; index++) {
    await scrubber.press('p');
    await scrubber.press('ArrowRight');
  }

  const scope = page.getByRole('region', { name: 'Scope' });
  await expect(scope.getByText('8 of 8 pinned', { exact: true })).toBeVisible();
  const pin = page.getByRole('button', { name: /Pin passage at token/ });
  await expect(pin).toHaveAttribute('aria-disabled', 'true');
  await pin.focus();
  await expect(pin).toBeFocused();
  await pin.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Pinned evidence is limited to 8 — remove one first.',
  );
  await expect(scope.getByText('8 of 8 pinned', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open passage in reader' }).click();
  const reader = page.getByRole('dialog', { name: /Reader:/ });
  const readerPin = reader.getByRole('button', { name: /Pin reader passage at token/ });
  await expect(readerPin).toHaveAttribute('aria-disabled', 'true');
  await readerPin.focus();
  await expect(readerPin).toBeFocused();
  await readerPin.press('Enter');
  await expect(reader.getByRole('alert')).toContainText(
    'Pinned evidence is limited to 8 — remove one first.',
  );
  await expect(reader.getByRole('button', { name: 'dismiss', exact: true })).toBeVisible();
  await reader.getByRole('button', { name: 'manage pins', exact: true }).click();
  await expect(reader).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]p=findings(?:&|$)/);
  await expect(page.getByRole('region', { name: 'Pinned evidence' }))
    .toContainText('8 of 8 pinned');
});

test('a quarantined anchor keeps note and document facts distinct and routes repair', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('p');
  await gotoPlace(page, 'findings');
  await expect(page.getByText('research changes waiting to save')).toBeVisible();
  await expect(page.getByText('research state saved locally')).toBeVisible({
    timeout: 30_000,
  });

  await quarantineFirstDurablePin(page);
  await page.reload();
  await awaitAllReady(page);

  const anchors = page.getByRole('region', { name: 'Anchors needing review' });
  const row = anchors.locator('.findings-record-trigger');
  await expect(row).toContainText('Marginal note, not a document title');
  await expect(row).toContainText(SHERLOCK[0]!.doc);
  await row.click();
  const detail = page.getByRole('region', {
    name: `Anchor needing review: ${SHERLOCK[0]!.doc}`,
  });
  await expect(detail.locator('dl > div').first().locator('dt')).toHaveText('document');
  await expect(detail.locator('dl > div').first().locator('dd')).toHaveText(SHERLOCK[0]!.doc);
  await expect(detail.locator('dl > div').first().locator('dd'))
    .not.toHaveText('Marginal note, not a document title');

  await detail.getByRole('button', { name: 'repair sources in Corpus' }).click();
  await expect(page).toHaveURL(/[?&]p=corpus(?:&|$)/);
  await page.goBack();
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: 'remove record' }).click();
  await expect(anchors).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Pinned evidence' })).toBeFocused();
});
