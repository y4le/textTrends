/**
 * Slice-2 H browser proof: every evidence path carries a snapshot-bound open
 * intent into the lazy canonical reader; rapid navigation delivers stale
 * worker results physically out of order without relabeling the current page.
 */

import { expect, test, type Page, type Worker } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  submitAndAwaitFreshResults,
  trace,
} from './helpers.ts';

const CORPUS = Array.from({ length: 900 }, (_, index) =>
  index === 50
    ? '<em>'
    : index === 450
      ? 'wolf'
      : `w${String(index).padStart(4, '0')}`,
).join(' ');

async function importCorpus(
  page: Page,
  name: string,
  text: string,
  expectedReady: number,
): Promise<void> {
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

async function awaitFreshReader(page: Page, mark: number): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await trace(page);
      const queries = snapshot.events.filter(
        (event) =>
          event.seq > mark
          && event.direction === 'to-worker'
          && event.t === 'query'
          && event.op === 'reader-page',
      );
      if (queries.length === 0) return 'no reader query';
      const delivered = snapshot.events.some(
        (event) =>
          event.seq > mark
          && event.direction === 'from-worker'
          && event.t === 'result'
          && queries.some((query) => query.job === event.job),
      );
      return delivered ? 'answered' : 'waiting';
    }, { timeout: 30_000 })
    .toBe('answered');
}

async function awaitReaderBurst(page: Page, mark: number, expected: number): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await trace(page);
      const queries = snapshot.events.filter(
        (event) =>
          event.seq > mark
          && event.direction === 'to-worker'
          && event.t === 'query'
          && event.op === 'reader-page',
      );
      const jobs = new Set(queries.map((event) => event.job));
      const results = snapshot.events.filter(
        (event) =>
          event.seq > mark
          && event.direction === 'from-worker'
          && event.t === 'result'
          && jobs.has(event.job),
      );
      return jobs.size >= expected && results.length === jobs.size
        ? 'answered'
        : `${results.length}/${jobs.size}`;
    }, { timeout: 30_000 })
    .toBe('answered');
}

async function installReaderResultGate(worker: Worker): Promise<void> {
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
      releaseNewest(): void;
      release(): void;
    }
    interface Scope {
      __ttReaderGate?: Gate;
      postMessage: (message: unknown, transfer?: Transferable[]) => void;
    }
    const scope = globalThis as unknown as Scope;
    if (scope.__ttReaderGate) return;
    const original = scope.postMessage.bind(scope);
    const send = (item: Held) => {
      if (item.transfer && item.transfer.length > 0) original(item.message, item.transfer);
      else original(item.message);
    };
    const gate: Gate = {
      armed: false,
      held: [],
      arm() {
        if (this.held.length > 0) throw new Error('release held reader pages before rearming');
        this.armed = true;
      },
      heldCount() {
        return this.held.length;
      },
      releaseNewest() {
        const item = this.held.pop();
        if (item) send(item);
      },
      release() {
        this.armed = false;
        const held = this.held.splice(0);
        for (const item of held) send(item);
      },
    };
    scope.__ttReaderGate = gate;
    scope.postMessage = (message: unknown, transfer?: Transferable[]) => {
      const candidate = message as { t?: string; data?: { op?: string } };
      if (gate.armed && candidate.t === 'result' && candidate.data?.op === 'reader-page') {
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
      __ttReaderGate?: { arm(): void };
    }).__ttReaderGate;
    if (!gate) throw new Error('reader gate is not installed');
    gate.arm();
  });

const gateHeld = (worker: Worker) =>
  worker.evaluate(() =>
    (globalThis as unknown as {
      __ttReaderGate?: { heldCount(): number };
    }).__ttReaderGate?.heldCount() ?? -1,
  );

const gateRelease = (worker: Worker) =>
  worker.evaluate(() => {
    const gate = (globalThis as unknown as {
      __ttReaderGate?: { release(): void };
    }).__ttReaderGate;
    if (!gate) throw new Error('reader gate is not installed');
    gate.release();
  });

const gateReleaseNewest = (worker: Worker) =>
  worker.evaluate(() => {
    const gate = (globalThis as unknown as {
      __ttReaderGate?: { releaseNewest(): void };
    }).__ttReaderGate;
    if (!gate) throw new Error('reader gate is not installed');
    gate.releaseNewest();
  });

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await importCorpus(page, 'reader.txt', CORPUS, 1);
  await submitAndAwaitFreshResults(page, 'wolf');
});

test('compact Reader replaces Lens navigation without covering its controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const lens = page.getByRole('navigation', { name: 'Analysis lenses' });
  await expect(lens).toBeVisible();

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page
    .getByRole('table', { name: 'Concordance' })
    .getByRole('button', { name: 'wolf', exact: true })
    .click();
  await awaitFreshReader(page, mark);

  const drawer = page.getByRole('dialog', { name: /Reader: reader/ });
  await expect(drawer).toBeVisible();
  await expect(lens).toHaveCount(0);
  const close = drawer.getByRole('button', { name: 'close', exact: true });
  await expect(close).toBeVisible();
  await close.click();
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Analysis lenses' }),
  ).toBeVisible();
});

test('KWIC opens the lazy reader; navigation, semantic edits, and snapshot replacement stay fenced', async ({ page }) => {
  const table = page.getByRole('table', { name: 'Concordance' });
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const kwicOpen = table.getByRole('button', { name: 'wolf', exact: true });
  await kwicOpen.click();
  await awaitFreshReader(page, mark);

  const drawer = page.getByRole('dialog', { name: /Reader: reader/ });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-reader-page="400:800"]')).toBeVisible();
  await expect(drawer.getByText('tokens 401–800 of 900')).toBeVisible();

  await expect.poll(() => page.workers().length).toBe(1);
  const worker = page.workers()[0]!;
  await installReaderResultGate(worker);
  await gateArm(worker);
  const navigationMark = (await trace(page)).events.at(-1)?.seq ?? -1;

  // The middle page exposes both directions. Hold the completed Next page,
  // then supersede it with Previous while no old prose is mounted.
  await drawer.getByRole('button', { name: 'next' }).click();
  await expect(drawer.locator('[data-reader-page]')).toHaveCount(0);
  await expect.poll(() => gateHeld(worker)).toBe(1);
  await drawer.getByRole('button', { name: 'previous' }).click();
  await expect.poll(() => gateHeld(worker)).toBe(2);
  // Deliver the CURRENT Previous page first, then the stale Next page after
  // it has rendered. The final assertion now fails without store-side guards.
  await gateReleaseNewest(worker);
  await expect(drawer.locator('[data-reader-page="0:400"]')).toBeVisible();
  await expect.poll(() => gateHeld(worker)).toBe(1);
  await gateRelease(worker);
  await awaitReaderBurst(page, navigationMark, 2);
  await expect(drawer.locator('[data-reader-page="0:400"]')).toBeVisible();
  await expect(drawer.getByText('tokens 1–400 of 900')).toBeVisible();

  // Literal source markup remains literal selectable text, never an element.
  await expect(drawer.getByText(/<em>/)).toBeVisible();
  await expect(drawer.locator('em')).toHaveCount(0);

  // A semantic member edit reissues the current page's highlight projection.
  // Force is intentional: the non-modal drawer visually covers the notebook
  // while leaving it mounted; this test targets store/query coordination.
  await page.getByRole('button', { name: 'Edit members: wolf' }).click({ force: true });
  const editor = page.getByRole('group', { name: 'Edit members: wolf' });
  await editor.getByLabel(/Add member to wolf/).fill('w0100', { force: true });
  await editor.getByRole('button', { name: 'add', exact: true }).click({ force: true });
  const semanticMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await editor.getByRole('button', { name: 'Apply changes to wolf' }).click({ force: true });
  await awaitFreshReader(page, semanticMark);
  await expect(drawer.locator('[data-reader-mark]').filter({ hasText: 'w0100' })).toBeVisible();

  // Publishing another snapshot closes the token-coordinate reader.
  await importCorpus(page, 'replacement.txt', 'replacement words for a new snapshot', 2);
  await expect(page.getByRole('dialog', { name: /Reader:/ })).toHaveCount(0);
});

test('exact barcode, passage, and pin evidence all open the reader', async ({ page }) => {
  // Exact barcode tick at wolf@450 opens directly (density aggregates instead
  // centre KWIC, whose nearest real row supplies its reader link).
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  let mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await canvas.click({ position: { x: box.width * (450.5 / 900), y: 3 } });
  await awaitFreshReader(page, mark);
  let drawer = page.getByRole('dialog', { name: /Reader: reader/ });
  await expect(drawer.locator('[data-reader-page="400:800"]')).toBeVisible();
  await drawer.getByRole('button', { name: 'close' }).click();

  // Keyboard scrub produces a source passage with its own explicit link.
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  const passageOpen = page.getByRole('button', { name: 'Open passage in reader' });
  await expect(passageOpen).toBeVisible();
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await passageOpen.click();
  await awaitFreshReader(page, mark);
  drawer = page.getByRole('dialog', { name: /Reader: reader/ });
  await expect(drawer.locator('[data-reader-page="0:400"]')).toBeVisible();
  await drawer.getByRole('button', { name: 'close' }).click();
  await expect(passageOpen).toBeFocused();

  // P at the same cursor captures the resident passage synchronously; its
  // immutable anchor opens under the current track set.
  await scrubber.focus();
  await scrubber.press('p');
  const pinOpen = page.getByRole('button', { name: /Open pinned evidence at token 1 in reader/ });
  await expect(pinOpen).toBeVisible();
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await pinOpen.click();
  await awaitFreshReader(page, mark);
  await expect(page.getByRole('dialog', { name: /Reader: reader/ }).locator('[data-reader-page="0:400"]')).toBeVisible();
});
