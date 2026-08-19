import { describe, expect, it } from 'vitest';
import { StandardEbooksClient } from '../src/index.js';

const enabled = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
  ?.env.STANDARD_EBOOKS_LIVE_TEST === '1';

describe.skipIf(!enabled)('live Standard Ebooks integration', () => {
  it('downloads and extracts Frankenstein in a browser-compatible path', async () => {
    const client = new StandardEbooksClient();
    const book = await client.downloadEbookText('mary-shelley_frankenstein');

    expect(book.source.kind).toBe('release');
    expect(book.metadata.title).toBe('Frankenstein');
    expect(book.metadata.authors).toContain('Mary Shelley');
    expect(book.sections.length).toBeGreaterThan(25);
    expect(book.sections.filter(({ partition }) => partition === 'bodymatter').length).toBeGreaterThan(20);
    expect(book.text.length).toBeGreaterThan(300_000);
    expect(book.sections.some(({ title }) => title === 'Chapter I')).toBe(true);
  }, 30_000);
});
