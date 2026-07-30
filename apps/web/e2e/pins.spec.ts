/**
 * Slice-2 F browser proof. Passage results are completed in the real worker
 * but withheld at postMessage, so two pin requests overlap and a removed pin's
 * late result physically arrives after removal.
 */

import { expect, test, type Page, type Worker } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  submitAndAwaitFreshResults,
  trace,
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

test('click pins are independent, removed late evidence stays removed, and snapshots clear pins', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await importCorpus(page, 'pins.txt', CORPUS, 1);
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

  // Hover starts the shared scrub request, then each no-drag click starts its
  // own pin request. With all passage results held, both cards must coexist.
  await page.mouse.move(point(1).x, point(1).y);
  await expect.poll(() => gateHeld(worker)).toBeGreaterThanOrEqual(1);
  await page.mouse.click(point(1).x, point(1).y);
  await page.mouse.click(point(9).x, point(9).y);
  const pane = page.getByRole('region', { name: 'Pinned evidence' });
  await expect(pane.locator('article')).toHaveCount(2);
  await expect(pane.getByText('capturing passage…')).toHaveCount(2);
  await expect.poll(() => gateHeld(worker)).toBeGreaterThanOrEqual(3);

  // Duplicate location focuses rather than appending, even while pending.
  await page.mouse.click(point(9).x, point(9).y);
  await expect(pane.locator('article')).toHaveCount(2);
  await expect(pane.getByText(/already pinned; focused the existing evidence/i)).toBeVisible();

  // Remove A while its completed worker result is still withheld. Releasing
  // that result cannot resurrect the card; B independently becomes ready.
  await pane.locator('article').first().getByRole('button', { name: 'remove' }).click();
  await expect(pane.locator('article')).toHaveCount(1);
  await gateRelease(worker);
  await expect.poll(() => gateHeld(worker)).toBe(0);
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
  await expect(page.getByRole('region', { name: 'Pinned evidence' })).toHaveCount(1);
  await expect(page.getByText('pins · token 10')).toBeVisible();
});
