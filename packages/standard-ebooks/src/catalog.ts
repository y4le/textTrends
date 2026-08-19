import { StandardEbooksError } from './errors.js';
import { fetchChecked, githubRateLimit } from './http.js';
import type {
  CatalogOptions,
  EbookCatalog,
  EbookCatalogPage,
  EbookRepository,
  FetchLike,
  GitHubRateLimit,
} from './types.js';

const DESCRIPTION_PREFIX = 'Epub source for the Standard Ebooks edition of ';

interface CatalogDependencies {
  readonly fetch: FetchLike;
  readonly githubToken: string | null;
  readonly organization: string;
  readonly apiBase: string;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseDescription(description: string): {
  readonly title: string;
  readonly author: string;
  readonly translator: string | null;
} | null {
  if (!description.startsWith(DESCRIPTION_PREFIX)) return null;
  const remainder = description.slice(DESCRIPTION_PREFIX.length);
  const translatedDelimiter = '. Translated by ';
  const translatedAt = remainder.lastIndexOf(translatedDelimiter);
  const workAndAuthor = translatedAt < 0 ? remainder : remainder.slice(0, translatedAt);
  const translator = translatedAt < 0 ? null : remainder.slice(translatedAt + translatedDelimiter.length).trim();
  const authorAt = workAndAuthor.lastIndexOf(', by ');
  if (authorAt <= 0) return null;
  const title = workAndAuthor.slice(0, authorAt).trim();
  const author = workAndAuthor.slice(authorAt + 5).trim();
  if (title === '' || author === '') return null;
  return { title, author, translator: translator === '' ? null : translator };
}

function parseRepository(value: unknown): EbookRepository | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const description = optionalString(raw.description);
  if (description === null || raw.fork === true) return null;
  const labels = parseDescription(description);
  if (labels === null) return null;

  const name = optionalString(raw.name);
  const fullName = optionalString(raw.full_name);
  const defaultBranch = optionalString(raw.default_branch);
  const repositoryUrl = optionalString(raw.html_url);
  if (name === null || fullName === null || defaultBranch === null || repositoryUrl === null) {
    throw new StandardEbooksError('INVALID_RESPONSE', 'GitHub returned an incomplete ebook repository');
  }
  return {
    name,
    fullName,
    defaultBranch,
    repositoryUrl,
    description,
    ...labels,
    archived: raw.archived === true,
    pushedAt: optionalString(raw.pushed_at),
    updatedAt: optionalString(raw.updated_at),
  };
}

function hasNextPage(link: string | null): boolean {
  if (link === null) return false;
  return link.split(',').some((part) => /;\s*rel="next"\s*$/u.test(part.trim()));
}

export async function* catalogPages(
  dependencies: CatalogDependencies,
  options: CatalogOptions = {},
): AsyncGenerator<EbookCatalogPage, void, void> {
  let pageNumber = 1;
  while (true) {
    const url = new URL(
      `/orgs/${encodeURIComponent(dependencies.organization)}/repos`,
      `${dependencies.apiBase}/`,
    );
    url.searchParams.set('type', 'public');
    url.searchParams.set('sort', 'full_name');
    url.searchParams.set('direction', 'asc');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(pageNumber));

    const headers = new Headers({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    });
    if (dependencies.githubToken !== null) {
      headers.set('authorization', `Bearer ${dependencies.githubToken}`);
    }
    const response = await fetchChecked(dependencies.fetch, url.href, {
      method: 'GET',
      headers,
      signal: options.signal ?? null,
    });
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new StandardEbooksError('INVALID_RESPONSE', 'GitHub catalog response is not valid JSON', {
        url: url.href,
        cause: error,
      });
    }
    if (!Array.isArray(raw)) {
      throw new StandardEbooksError('INVALID_RESPONSE', 'GitHub catalog response is not an array', {
        url: url.href,
      });
    }
    const books = raw.map(parseRepository).filter((book): book is EbookRepository => book !== null);
    const page: EbookCatalogPage = {
      page: pageNumber,
      books,
      repositoriesSeen: raw.length,
      hasNextPage: hasNextPage(response.headers.get('link')),
      rateLimit: githubRateLimit(response.headers),
    };
    if (options.onPage !== undefined) await options.onPage(page);
    yield page;
    if (!page.hasNextPage) break;
    pageNumber++;
    if (pageNumber > 100) {
      throw new StandardEbooksError('INVALID_RESPONSE', 'GitHub catalog exceeded 100 pages');
    }
  }
}

export async function listCatalog(
  dependencies: CatalogDependencies,
  options: CatalogOptions = {},
): Promise<EbookCatalog> {
  const books: EbookRepository[] = [];
  let pagesFetched = 0;
  let repositoriesSeen = 0;
  let rateLimit: GitHubRateLimit = { limit: null, remaining: null, resetAt: null };
  for await (const page of catalogPages(dependencies, options)) {
    books.push(...page.books);
    pagesFetched++;
    repositoriesSeen += page.repositoriesSeen;
    rateLimit = page.rateLimit;
  }
  return { books, pagesFetched, repositoriesSeen, rateLimit };
}
