/**
 * Slice-2 E acceptance: linked range selection is one committed set of
 * half-open document spans shared by every detail consumer. The worker gate
 * deliberately lets selection A finish inside the worker but withholds its
 * messages until selection B has settled, proving the browser store rejects
 * stale late delivery rather than merely relying on worker cancellation.
 */

import { expect, test, type Page, type Worker } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, gotoPlace, submitAndAwaitFreshResults, trace } from './helpers.ts';
import { TREND_LABEL_SPACE } from '../src/lib/trend-geometry.ts';

// 12 tokens; wolf at 1, 6, and 9.
const CORPUS = 'alpha wolf beta gamma fox delta wolf eta theta wolf iota omega\n';
const REPLACEMENT = 'a replacement document with no matching animal\n';
const DETAIL_OPS = new Set(['trend', 'dispersion', 'kwic']);

async function importCorpus(
  page: Page,
  name: string,
  text: string,
  expectedReady = 1,
): Promise<void> {
  await gotoPlace(page, 'catalog');
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

async function installDetailResultGate(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    interface Held {
      message: unknown;
      transfer?: Transferable[];
    }
    interface Gate {
      armed: boolean;
      expected: number;
      held: Held[];
      arm(expected: number): void;
      heldCount(): number;
      release(): void;
    }
    interface Scope {
      __ttSelectionGate?: Gate;
      postMessage: (message: unknown, transfer?: Transferable[]) => void;
    }
    const scope = globalThis as unknown as Scope;
    if (scope.__ttSelectionGate) return;
    const original = scope.postMessage.bind(scope);
    const send = (held: Held) => {
      if (held.transfer && held.transfer.length > 0) original(held.message, held.transfer);
      else original(held.message);
    };
    const gate: Gate = {
      armed: false,
      expected: 0,
      held: [],
      arm(expected) {
        if (this.held.length > 0) throw new Error('release held results before rearming');
        this.expected = expected;
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
    scope.__ttSelectionGate = gate;
    scope.postMessage = (message: unknown, transfer?: Transferable[]) => {
      const candidate = message as { t?: string; data?: { op?: string } };
      const detail = candidate.t === 'result'
        && ['trend', 'dispersion', 'kwic'].includes(candidate.data?.op ?? '');
      if (gate.armed && detail && gate.held.length < gate.expected) {
        gate.held.push({ message, ...(transfer ? { transfer } : {}) });
        if (gate.held.length === gate.expected) gate.armed = false;
        return;
      }
      send({ message, ...(transfer ? { transfer } : {}) });
    };
  });
}

const gateArm = (worker: Worker, expected = 3) =>
  worker.evaluate((n) => {
    const gate = (globalThis as unknown as {
      __ttSelectionGate?: { arm(expected: number): void };
    }).__ttSelectionGate;
    if (!gate) throw new Error('selection result gate is not installed');
    gate.arm(n);
  }, expected);

const gateHeld = (worker: Worker) =>
  worker.evaluate(() =>
    (globalThis as unknown as {
      __ttSelectionGate?: { heldCount(): number };
    }).__ttSelectionGate?.heldCount() ?? -1,
  );

const gateRelease = (worker: Worker) =>
  worker.evaluate(() => {
    const gate = (globalThis as unknown as {
      __ttSelectionGate?: { release(): void };
    }).__ttSelectionGate;
    if (!gate) throw new Error('selection result gate is not installed');
    gate.release();
  });

async function awaitDetailBurst(page: Page, mark: number): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await trace(page);
      const queries = snapshot.events.filter(
        (event) =>
          event.seq > mark
          && event.direction === 'to-worker'
          && event.t === 'query'
          && DETAIL_OPS.has(event.op ?? ''),
      );
      const latestByOp = new Map<string, number>();
      for (const event of queries) {
        if (event.op !== undefined) latestByOp.set(event.op, event.job as number);
      }
      const jobs = new Set(latestByOp.values());
      const results = snapshot.events.filter(
        (event) =>
          event.seq > mark
          && event.direction === 'from-worker'
          && event.t === 'result'
          && event.job !== undefined
          && jobs.has(event.job),
      );
      const ops = new Set(queries.map((event) => event.op));
      return queries.length >= 3
        && results.length === jobs.size
        && ['trend', 'dispersion', 'kwic'].every((op) => ops.has(op))
        ? 'complete detail results'
        : `${queries.length} queries / ${results.length} results`;
    }, { timeout: 30_000 })
    .toBe('complete detail results');
}

async function awaitFreshKwic(page: Page, mark: number): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await trace(page);
      const queries = snapshot.events.filter(
        (event) =>
          event.seq > mark
          && event.direction === 'to-worker'
          && event.t === 'query'
          && event.op === 'kwic',
      );
      return snapshot.events.some(
        (event) =>
          event.seq > mark
          && event.direction === 'from-worker'
          && event.t === 'result'
          && queries.some((query) => query.job === event.job),
      );
    }, { timeout: 30_000 })
    .toBe(true);
}

test('pointer and keyboard selections share detail results and stale results cannot resurrect', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await importCorpus(page, 'animals.txt', CORPUS);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  await expect.poll(() => page.workers().length).toBe(1);
  const worker = page.workers()[0]!;
  await installDetailResultGate(worker);

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  const box = (await scrubber.boundingBox())!;
  const plotWidth = box.width - TREND_LABEL_SPACE;

  // Pointer selection A: drag token 5 → token 10, committing [5,11). Until
  // pointer-up, the preview is local and no selected query is posted.
  const hoverMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.mouse.move(box.x + plotWidth * (5.5 / 12), box.y + 80);
  await awaitFreshKwic(page, hoverMark);
  await gateArm(worker);
  const beforeDrag = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.mouse.down();
  await page.mouse.move(box.x + plotWidth * (10.5 / 12), box.y + 80, { steps: 8 });
  await expect(page.getByTestId('selection-preview')).toBeVisible();
  expect(
    (await trace(page)).events.filter(
      (event) =>
        event.seq > beforeDrag
        && event.direction === 'to-worker'
        && event.t === 'query'
        && (event.op === 'trend' || event.op === 'dispersion'),
    ),
  ).toHaveLength(0);
  await page.mouse.up();
  await expect(page.getByText(/Selected 6 tokens in/)).toBeVisible();
  await expect.poll(() => gateHeld(worker)).toBe(3);

  // Keyboard selection B: reset the reading cursor, announce selection mode,
  // extend twice, and commit [0,3). Its three jobs flow while A remains held.
  await scrubber.focus();
  await scrubber.press('Home');
  await expect(scrubber).toHaveAttribute('aria-valuenow', '0');
  await scrubber.press('s');
  await expect(page.getByText(/arrows extend · Enter commits · Escape cancels/)).toBeVisible();
  await scrubber.press('ArrowRight');
  await scrubber.press('ArrowRight');
  const bMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scrubber.press('Enter');
  await expect(page.getByText(/Selected 3 tokens in/)).toBeVisible();
  await awaitDetailBurst(page, bMark);

  // Every selected consumer serves B: one wolf inside [0,3), versus three in
  // the corpus. The concordance contains no occurrence outside that range.
  await expect(page.locator('[data-selected-overlay]')).toHaveCount(1);
  await expect(scrubber.locator('canvas[data-selected-layer="ready"]')).toBeVisible();
  await expect(page.getByText('wolf: 3 occurrences · 1 selected')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Query terms' })
    .getByRole('button', { name: 'wolf 1 selected / 3', exact: true })).toBeVisible();
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('table', { name: 'Concordance' }).locator('tbody tr')).toHaveCount(1);
  await gotoPlace(page, 'trends');
  await page.getByRole('button', { name: 'by book' }).click();
  await expect(page.getByTestId('linked-selection')).toBeVisible();
  await expect(page.locator('[data-selected-overlay]')).toHaveCount(1);
  await page.getByRole('button', { name: 'series' }).click();

  // Release A after B is fully rendered. A's results now physically arrive,
  // but identity guards keep B's range and all B-scoped evidence unchanged.
  await gateRelease(worker);
  await expect.poll(() => gateHeld(worker)).toBe(0);
  await expect(page.getByText(/Selected 3 tokens in/)).toBeVisible();
  await expect(page.getByText('wolf: 3 occurrences · 1 selected')).toBeVisible();
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('table', { name: 'Concordance' }).locator('tbody tr')).toHaveCount(1);
  await gotoPlace(page, 'trends');

  // Clear while C is pending. Baseline evidence remains, the selection layers
  // disappear immediately, and releasing C cannot resurrect them.
  await gateArm(worker);
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  for (let i = 0; i < 4; i += 1) await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  await expect.poll(() => gateHeld(worker)).toBe(3);
  const clearMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'clear selection' }).click();
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(page.locator('[data-selected-overlay]')).toHaveCount(0);
  await gateRelease(worker);
  await awaitFreshKwic(page, clearMark);
  await expect(page.getByRole('button', { name: 'clear selection' })).toHaveCount(0);
  await expect(page.getByText('wolf: 3 occurrences', { exact: true })).toBeVisible();

  // A snapshot replacement invalidates the committed range as an identity,
  // not by clamping its old tokens into the new document.
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  await expect(page.getByText(/Selected 2 tokens in/)).toBeVisible();
  await importCorpus(page, 'replacement.txt', REPLACEMENT, 2);
  await gotoPlace(page, 'trends');
  await expect(page.getByRole('button', { name: 'clear selection' })).toHaveCount(0);
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(page.locator('[data-selected-overlay]')).toHaveCount(0);
});
