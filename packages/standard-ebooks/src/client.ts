import {
  assertValidPartitions,
  DEFAULT_MAX_EXTRACTED_BYTES,
  decodeUtf8,
  EpubError,
  parseEpub,
  parsePackage,
  selectEbookSections,
  type EpubDocument,
  type ParsedPackage,
} from '@texttrends/epub';
import { downloadEbookArchive } from './archive.js';
import { catalogPages, listCatalog } from './catalog.js';
import { mapConcurrent } from './concurrency.js';
import { describeError, isAbortError, StandardEbooksError } from './errors.js';
import { fetchChecked, readResponseBytes } from './http.js';
import { validateRepositoryName } from './repository-name.js';
import type {
  CatalogOptions,
  DownloadEbookOptions,
  EbookCatalog,
  EbookCatalogPage,
  EbookRepository,
  EbookSource,
  EbookText,
  EbookWarning,
  StandardEbooksClientOptions,
} from './types.js';

const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_REPOSITORY_CONCURRENCY = 6;
const RAW_DOCUMENT_LIMIT = 8 * 1024 * 1024;

interface SourcePackage {
  readonly url: string;
  readonly byteLength: number;
  readonly parsed: ParsedPackage;
}

interface LoadedBook {
  readonly package: ParsedPackage;
  readonly documents: readonly EpubDocument[];
  readonly source: EbookSource;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return selected;
}


function placeholderRepository(name: string, organization: string): EbookRepository {
  return {
    name,
    fullName: `${organization}/${name}`,
    defaultBranch: 'master',
    repositoryUrl: `https://github.com/${organization}/${name}`,
    description: '',
    title: name,
    author: '',
    translator: null,
    archived: false,
    pushedAt: null,
    updatedAt: null,
  };
}

function releaseUrl(base: string, identifier: string, repositoryName: string): string {
  let identifierUrl: URL;
  try {
    identifierUrl = new URL(identifier);
  } catch (error) {
    throw new StandardEbooksError('INVALID_RESPONSE', 'OPF identifier is not a valid URL', {
      cause: error,
    });
  }
  if (!identifierUrl.pathname.startsWith('/ebooks/')) {
    throw new StandardEbooksError(
      'INVALID_RESPONSE',
      `OPF identifier is not a Standard Ebooks ebook URL: ${identifier}`,
    );
  }
  const root = new URL(base);
  const path = identifierUrl.pathname.replace(/\/$/u, '');
  const url = new URL(`${path}/downloads/${encodeURIComponent(repositoryName)}.epub`, root);
  url.searchParams.set('source', 'download');
  return url.href;
}

export class StandardEbooksClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #githubToken: string | null;
  readonly #organization: string;
  readonly #apiBase: string;
  readonly #rawBase: string;
  readonly #standardEbooksBase: string;

  constructor(options: StandardEbooksClientOptions = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('A Fetch API implementation is required');
    }
    this.#fetch = fetchImpl;
    this.#githubToken = options.githubToken ?? null;
    this.#organization = options.githubOrganization ?? 'standardebooks';
    this.#apiBase = (options.githubApiBase ?? 'https://api.github.com').replace(/\/$/u, '');
    this.#rawBase = (options.githubRawBase ?? 'https://raw.githubusercontent.com').replace(/\/$/u, '');
    this.#standardEbooksBase = (options.standardEbooksBase ?? 'https://standardebooks.org').replace(/\/$/u, '');
  }

  catalogPages(options: CatalogOptions = {}): AsyncGenerator<EbookCatalogPage, void, void> {
    return catalogPages(
      {
        fetch: this.#fetch,
        githubToken: this.#githubToken,
        organization: this.#organization,
        apiBase: this.#apiBase,
      },
      options,
    );
  }

  listEbooks(options: CatalogOptions = {}): Promise<EbookCatalog> {
    return listCatalog(
      {
        fetch: this.#fetch,
        githubToken: this.#githubToken,
        organization: this.#organization,
        apiBase: this.#apiBase,
      },
      options,
    );
  }

  async #sourcePackage(repository: EbookRepository, signal: AbortSignal | undefined): Promise<SourcePackage> {
    const url = `${this.#rawBase}/${encodeURIComponent(this.#organization)}/${encodeURIComponent(repository.name)}/${encodeURIComponent(repository.defaultBranch)}/src/epub/content.opf`;
    const response = await fetchChecked(this.#fetch, url, { method: 'GET', signal: signal ?? null });
    const bytes = await readResponseBytes(response, RAW_DOCUMENT_LIMIT, 'Source OPF', { signal });
    const xml = decodeUtf8(bytes, 'Source OPF');
    return { url, byteLength: bytes.byteLength, parsed: parsePackage(xml, 'Source OPF') };
  }

  async #release(
    repository: EbookRepository,
    sourcePackage: SourcePackage,
    options: DownloadEbookOptions,
  ): Promise<LoadedBook> {
    const maximumDownload = positiveInteger(
      options.maxDownloadBytes,
      DEFAULT_MAX_DOWNLOAD_BYTES,
      'maxDownloadBytes',
    );
    const maximumExtracted = positiveInteger(
      options.maxExtractedTextBytes,
      DEFAULT_MAX_EXTRACTED_BYTES,
      'maxExtractedTextBytes',
    );
    if (sourcePackage.byteLength > maximumExtracted) {
      throw new EpubError(
        'CAP_EXCEEDED',
        `Repository OPF is ${sourcePackage.byteLength} bytes; the limit is ${maximumExtracted} bytes`,
      );
    }
    const url = releaseUrl(this.#standardEbooksBase, sourcePackage.parsed.metadata.identifier, repository.name);
    const response = await fetchChecked(this.#fetch, url, {
      method: 'GET',
      signal: options.signal ?? null,
    });
    const bytes = await readResponseBytes(response, maximumDownload, 'EPUB download', {
      signal: options.signal,
    });
    const epub = parseEpub(bytes, maximumExtracted);
    return {
      package: epub.package,
      documents: epub.documents,
      source: {
        kind: 'release',
        url,
        repository: repository.fullName,
        ref: repository.defaultBranch,
      },
    };
  }

  async #repository(
    repository: EbookRepository,
    sourcePackage: SourcePackage,
    options: DownloadEbookOptions,
  ): Promise<LoadedBook> {
    const concurrency = positiveInteger(
      options.repositoryConcurrency,
      DEFAULT_REPOSITORY_CONCURRENCY,
      'repositoryConcurrency',
    );
    const maximumExtracted = positiveInteger(
      options.maxExtractedTextBytes,
      DEFAULT_MAX_EXTRACTED_BYTES,
      'maxExtractedTextBytes',
    );
    if (sourcePackage.byteLength > maximumExtracted) {
      throw new EpubError(
        'CAP_EXCEEDED',
        `Repository OPF is ${sourcePackage.byteLength} bytes; the limit is ${maximumExtracted} bytes`,
      );
    }
    const fetched = await mapConcurrent(
      sourcePackage.parsed.spine,
      concurrency,
      async (spineItem): Promise<{ readonly document: EpubDocument; readonly byteLength: number }> => {
        const url = new URL(spineItem.item.href, sourcePackage.url).href;
        const response = await fetchChecked(this.#fetch, url, {
          method: 'GET',
          signal: options.signal ?? null,
        });
        const bytes = await readResponseBytes(response, RAW_DOCUMENT_LIMIT, spineItem.item.href, {
          signal: options.signal,
        });
        return {
          byteLength: bytes.byteLength,
          document: {
            idref: spineItem.idref,
            href: spineItem.item.href,
            linear: spineItem.linear,
            source: decodeUtf8(bytes, spineItem.item.href),
          },
        };
      },
    );
    const extractedBytes = fetched.reduce(
      (total, item) => total + item.byteLength,
      sourcePackage.byteLength,
    );
    if (extractedBytes > maximumExtracted) {
      throw new EpubError(
        'CAP_EXCEEDED',
        `Repository OPF/XHTML is ${extractedBytes} bytes; the limit is ${maximumExtracted} bytes`,
      );
    }
    const documents = fetched.map((item) => item.document);
    return {
      package: sourcePackage.parsed,
      documents,
      source: {
        kind: 'repository',
        url: repository.repositoryUrl,
        repository: repository.fullName,
        ref: repository.defaultBranch,
      },
    };
  }

  async downloadEbookText(
    repositoryOrName: EbookRepository | string,
    options: DownloadEbookOptions = {},
  ): Promise<EbookText> {
    const repository =
      typeof repositoryOrName === 'string'
        ? placeholderRepository(validateRepositoryName(repositoryOrName), this.#organization)
        : repositoryOrName;
    validateRepositoryName(repository.name);
    const partitions = options.partitions ?? ['bodymatter'];
    assertValidPartitions(partitions);
    if (options.source !== undefined && options.source !== 'release' && options.source !== 'repository') {
      throw new RangeError('source must be "release" or "repository"');
    }
    const sourcePackage = await this.#sourcePackage(repository, options.signal);
    const requestedSource = options.source ?? 'release';
    const warnings: EbookWarning[] = [];
    let loaded: LoadedBook;
    if (requestedSource === 'repository') {
      loaded = await this.#repository(repository, sourcePackage, options);
    } else {
      try {
        loaded = await this.#release(repository, sourcePackage, options);
      } catch (error) {
        if (
          isAbortError(error)
          || options.fallbackToRepository === false
          || error instanceof RangeError
          || (error instanceof EpubError && error.code === 'CAP_EXCEEDED')
        ) {
          throw error;
        }
        warnings.push({
          code: 'release-fallback',
          message: `Official EPUB unavailable; loaded current repository source instead (${describeError(error)})`,
        });
        loaded = await this.#repository(repository, sourcePackage, options);
      }
    }
    const selection = selectEbookSections(loaded.documents, partitions);
    return {
      repository: {
        ...repository,
        title: loaded.package.metadata.title,
        author: loaded.package.metadata.authors.join(' and '),
        translator:
          loaded.package.metadata.translators.length === 0
            ? repository.translator
            : loaded.package.metadata.translators.join(' and '),
      },
      metadata: loaded.package.metadata,
      sections: selection.sections,
      text: selection.text,
      selectedPartitions: [...partitions],
      source: loaded.source,
      warnings,
    };
  }

  /**
   * Download an ebook's SOURCE from GitHub (the OPF + every spine XHTML, all
   * from raw.githubusercontent.com — a CORS-accessible origin, UNLIKE the
   * standardebooks.org release download) and package the fetched bytes into a
   * deterministic EPUB-shaped ingestion archive (OPF + spine XHTML only — no
   * CSS, images, or fonts). The result is not a general-purpose EPUB; its
   * contract is that this library's ingest path (`parseEpub`/`extractEpub`)
   * parses it and extracts text identically to the fetched source, with no
   * server-side proxy and no CORS barrier. Delegates to
   * {@link downloadEbookArchive} — the single archive implementation.
   */
  async downloadEpubArchive(
    repositoryOrName: EbookRepository | string,
    options: { readonly signal?: AbortSignal; readonly repositoryConcurrency?: number; readonly maxExtractedTextBytes?: number } = {},
  ): Promise<{ readonly bytes: Uint8Array; readonly repository: EbookRepository; readonly metadata: EbookText['metadata'] }> {
    const repository =
      typeof repositoryOrName === 'string'
        ? placeholderRepository(validateRepositoryName(repositoryOrName), this.#organization)
        : repositoryOrName;
    validateRepositoryName(repository.name);
    const archive = await downloadEbookArchive(repository.name, {
      fetch: this.#fetch,
      githubOrganization: this.#organization,
      githubRawBase: this.#rawBase,
      ref: repository.defaultBranch,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.repositoryConcurrency === undefined
        ? {}
        : { repositoryConcurrency: options.repositoryConcurrency }),
      ...(options.maxExtractedTextBytes === undefined
        ? {}
        : { maxExtractedTextBytes: options.maxExtractedTextBytes }),
    });
    return {
      bytes: archive.bytes,
      repository: {
        ...repository,
        title: archive.metadata.title,
        author: archive.metadata.authors.join(' and '),
      },
      metadata: archive.metadata,
    };
  }
}
