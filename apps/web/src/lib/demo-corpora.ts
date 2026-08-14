import { hashSourceBytes } from '@texttrends/core';
import type { LocalFileInput } from './local-library.ts';
import {
  builtinCorpusOption,
  demoCorpusFixtures,
  type BuiltinCorpusId,
  type BuiltinCorpusOption,
} from './project.ts';

export interface DemoCorpusFile extends LocalFileInput {
  readonly title: string;
}

export interface LoadedDemoCorpus {
  readonly option: BuiltinCorpusOption;
  readonly files: readonly DemoCorpusFile[];
}

const DEMO_FETCH_TIMEOUT_MS = 60_000;

function sourceUrl(option: BuiltinCorpusOption, doc: string): string {
  const file = `${doc}.txt`;
  const path = [option.sourceDirectory, file]
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${import.meta.env.BASE_URL ?? '/'}corpora/${path}`;
}

/** Fetch and verify the entire demo before returning any file for persistence
 * or activation. A broken response therefore cannot create a partial corpus. */
export async function fetchDemoCorpus(
  id: BuiltinCorpusId,
  signal?: AbortSignal,
): Promise<LoadedDemoCorpus> {
  const option = builtinCorpusOption(id);
  if (option === undefined) throw new RangeError(`unknown demo corpus '${id}'`);
  const controller = new AbortController();
  let timeoutError: Error | null = null;
  const timeout = setTimeout(() => {
    timeoutError = new Error('The demo download timed out. Check your connection and retry.');
    controller.abort(timeoutError);
  }, DEMO_FETCH_TIMEOUT_MS);
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  try {
    const files = await Promise.all(demoCorpusFixtures(id).map(async (fixture): Promise<DemoCorpusFile> => {
      const response = await fetch(sourceUrl(option, fixture.doc), { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`could not load “${fixture.title}” (HTTP ${response.status})`);
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== fixture.bytes) {
        throw new Error(`“${fixture.title}” did not match the demo manifest (wrong size)`);
      }
      const hash = await hashSourceBytes(new Uint8Array(bytes));
      if (hash !== fixture.sourceHash) {
        throw new Error(`“${fixture.title}” did not match the demo manifest (wrong content)`);
      }
      return {
        title: fixture.title,
        name: `${fixture.title}.txt`,
        size: bytes.byteLength,
        type: 'text/plain',
        lastModified: 0,
        arrayBuffer: async () => bytes.slice(0),
      };
    }));
    return { option, files };
  } catch (error) {
    controller.abort(error);
    throw timeoutError ?? error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
