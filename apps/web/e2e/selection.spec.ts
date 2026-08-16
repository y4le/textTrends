/**
 * Slice-2 E acceptance: linked range selection is one committed set of
 * half-open document spans shared by every detail consumer. The worker gate
 * deliberately lets selection A finish inside the worker but withholds its
 * messages until selection B has settled, proving the browser store rejects
 * stale late delivery rather than merely relying on worker cancellation.
 */

import { expect, test, type Page, type Worker } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, clearDemoInputs, gotoPlace, submitAndAwaitFreshResults, trace } from './helpers.ts';

// 12 tokens; wolf at 1, 6, and 9.
const CORPUS = 'alpha wolf beta gamma fox delta wolf eta theta wolf iota omega\n';
const REPLACEMENT = 'a replacement document with no matching animal\n';
const DETAIL_OPS = new Set(['trend', 'dispersion']);

async function importCorpus(
  page: Page,
  name: string,
  text: string,
  expectedReady = 1,
): Promise<void> {
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByLabel(/Create project from files|Add files/).setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(text, 'utf-8'),
  });
  await expect(page.getByRole('region', { name: 'Inputs', exact: true })).toBeVisible({ timeout: 30_000 });
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
        && ['trend', 'dispersion'].includes(candidate.data?.op ?? '');
      if (gate.armed && detail && gate.held.length < gate.expected) {
        gate.held.push({ message, ...(transfer ? { transfer } : {}) });
        if (gate.held.length === gate.expected) gate.armed = false;
        return;
      }
      send({ message, ...(transfer ? { transfer } : {}) });
    };
  });
}

const gateArm = (worker: Worker, expected = 2) =>
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
      return queries.length >= 2
        && results.length === jobs.size
        && ['trend', 'dispersion'].every((op) => ops.has(op))
        ? 'complete detail results'
        : `${queries.length} queries / ${results.length} results`;
    }, { timeout: 30_000 })
    .toBe('complete detail results');
}

test('pointer and keyboard selections share detail results and stale results cannot resurrect', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await importCorpus(page, 'animals.txt', CORPUS);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  await expect.poll(() => page.workers().length).toBe(1);
  const worker = page.workers()[0]!;
  await installDetailResultGate(worker);

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  const box = (await scrubber.boundingBox())!;
  const plotWidth = box.width;

  // Pointer selection A: drag token 5 → token 10, committing [5,11). Until
  // pointer-up, the preview is local and no selected query is posted.
  const hoverMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.mouse.move(box.x + plotWidth * (5.5 / 12), box.y + 80);
  await page.waitForTimeout(100);
  expect((await trace(page)).events.filter((event) =>
    event.seq > hoverMark
    && event.direction === 'to-worker'
    && event.t === 'query'
    && event.op === 'matches-window')).toEqual([]);
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
  await expect(page.getByRole('button', { name: 'clear selection' })).toBeVisible();
  await expect(page.getByText(/^Selected /)).toHaveCount(0);
  await expect.poll(() => gateHeld(worker)).toBe(2);

  // Keyboard selection B: reset the reading cursor, announce selection mode,
  // extend twice, and commit [0,3). Its two overlay jobs flow while A remains held.
  await scrubber.focus();
  await scrubber.press('Home');
  await expect(scrubber).toHaveAttribute('aria-valuenow', '0');
  await scrubber.press('s');
  await expect(page.getByText(/arrows extend · Enter commits · Escape cancels/)).toBeVisible();
  await scrubber.press('ArrowRight');
  await scrubber.press('ArrowRight');
  const bMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scrubber.press('Enter');
  await expect(page.getByRole('button', { name: 'clear selection' })).toBeVisible();
  await awaitDetailBurst(page, bMark);

  // Every selected consumer serves B: one wolf inside [0,3), versus three in
  // the corpus. Matches remains full-corpus and highlights the one row.
  await expect(page.locator('[data-selected-overlay]')).toHaveCount(1);
  await expect(scrubber.locator('canvas[data-selected-layer="ready"]')).toBeVisible();
  let termTotal = page.getByRole('list', { name: 'Term totals' })
    .getByRole('listitem').filter({ hasText: 'wolf' })
    .locator('[data-term-occurrence-count]');
  await expect(termTotal).toHaveText('1');
  await expect(page.getByRole('group', { name: 'Query terms' })
    .locator('.term-bucket-summary').filter({ hasText: /wolf\s*1 selected \/ 3/ })).toBeVisible();
  await gotoPlace(page, 'matches');
  const matches = page.getByRole('grid', { name: 'Matches' });
  await expect(matches.locator('[role="row"][aria-rowindex]')).toHaveCount(3);
  await expect(matches.locator('[role="row"][data-linked-selection="true"]')).toHaveCount(1);
  await gotoPlace(page, 'trends');
  await expect(page.getByRole('group', { name: 'Trend view' })).toHaveCount(0);
  await expect(page.getByTestId('linked-selection')).toBeVisible();
  await expect(page.locator('[data-selected-overlay]')).toHaveCount(1);

  // Release A after B is fully rendered. A's results now physically arrive,
  // but identity guards keep B's range and all B-scoped evidence unchanged.
  await gateRelease(worker);
  await expect.poll(() => gateHeld(worker)).toBe(0);
  await expect(page.getByRole('button', { name: 'clear selection' })).toBeVisible();
  termTotal = page.getByRole('list', { name: 'Term totals' })
    .getByRole('listitem').filter({ hasText: 'wolf' })
    .locator('[data-term-occurrence-count]');
  await expect(termTotal).toHaveText('1');
  await gotoPlace(page, 'matches');
  await expect(matches.locator('[role="row"][aria-rowindex]')).toHaveCount(3);
  await expect(matches.locator('[role="row"][data-linked-selection="true"]')).toHaveCount(1);
  await gotoPlace(page, 'trends');

  // Clear while C is pending. Baseline evidence remains, the selection layers
  // disappear immediately, and releasing C cannot resurrect them.
  await gateArm(worker);
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  for (let i = 0; i < 4; i += 1) await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  await expect.poll(() => gateHeld(worker)).toBe(2);
  await page.getByRole('button', { name: 'clear selection' }).click();
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(page.locator('[data-selected-overlay]')).toHaveCount(0);
  await gateRelease(worker);
  await expect(page.getByRole('button', { name: 'clear selection' })).toHaveCount(0);
  termTotal = page.getByRole('list', { name: 'Term totals' })
    .getByRole('listitem').filter({ hasText: 'wolf' })
    .locator('[data-term-occurrence-count]');
  await expect(termTotal).toHaveText('3');

  // A snapshot replacement invalidates the committed range as an identity,
  // not by clamping its old tokens into the new document.
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  await expect(page.getByRole('button', { name: 'clear selection' })).toBeVisible();
  await importCorpus(page, 'replacement.txt', REPLACEMENT, 2);
  await gotoPlace(page, 'trends');
  await expect(page.getByRole('button', { name: 'clear selection' })).toHaveCount(0);
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(page.locator('[data-selected-overlay]')).toHaveCount(0);
});
