import { describe, expect, it, vi } from 'vitest';
import { StandardEbooksClient } from '../src/index.js';
import { githubRepository } from './fixtures.js';

describe('catalog enumeration', () => {
  it('paginates, filters non-books, and reports rate limits', async () => {
    const progress: number[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const page = url.searchParams.get('page');
      expect(url.searchParams.get('per_page')).toBe('100');
      if (page === '1') {
        return new Response(JSON.stringify([
          githubRepository(
            'a-author_a-book',
            'Epub source for the Standard Ebooks edition of A Book, by A. Author',
          ),
          {
            ...githubRepository('tools', 'A collection of ebook production tools'),
            description: 'A collection of ebook production tools',
          },
        ]), {
          headers: {
            link: '<https://api.github.test/orgs/standardebooks/repos?page=2>; rel="next"',
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '59',
            'x-ratelimit-reset': '1735689600',
          },
        });
      }
      return new Response(JSON.stringify([
        githubRepository(
          'b-author_b-book_t-translator',
          'Epub source for the Standard Ebooks edition of B Book, by B. Author. Translated by T. Translator',
        ),
      ]), {
        headers: {
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '58',
          'x-ratelimit-reset': '1735689600',
        },
      });
    });
    const client = new StandardEbooksClient({
      fetch: fetchMock,
      githubApiBase: 'https://api.github.test',
    });

    const catalog = await client.listEbooks({
      onPage: ({ page }) => {
        progress.push(page);
      },
    });

    expect(progress).toEqual([1, 2]);
    expect(catalog.pagesFetched).toBe(2);
    expect(catalog.repositoriesSeen).toBe(3);
    expect(catalog.books.map((book) => book.name)).toEqual([
      'a-author_a-book',
      'b-author_b-book_t-translator',
    ]);
    expect(catalog.books[1]).toMatchObject({
      title: 'B Book',
      author: 'B. Author',
      translator: 'T. Translator',
    });
    expect(catalog.rateLimit.remaining).toBe(58);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
