export type FetchLike = typeof globalThis.fetch;

export type EbookPartition = 'frontmatter' | 'bodymatter' | 'backmatter' | 'unknown';

export interface GitHubRateLimit {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: string | null;
}

export interface EbookRepository {
  /** GitHub repository name, for example `mary-shelley_frankenstein`. */
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly repositoryUrl: string;
  readonly description: string;
  /** Fast catalog label parsed from GitHub's repository description. */
  readonly title: string;
  /** Fast catalog label parsed from GitHub's repository description. */
  readonly author: string;
  readonly translator: string | null;
  readonly archived: boolean;
  readonly pushedAt: string | null;
  readonly updatedAt: string | null;
}

export interface EbookCatalogPage {
  readonly page: number;
  readonly books: readonly EbookRepository[];
  readonly repositoriesSeen: number;
  readonly hasNextPage: boolean;
  readonly rateLimit: GitHubRateLimit;
}

export interface EbookCatalog {
  readonly books: readonly EbookRepository[];
  readonly pagesFetched: number;
  readonly repositoriesSeen: number;
  readonly rateLimit: GitHubRateLimit;
}

export interface CatalogOptions {
  readonly signal?: AbortSignal;
  readonly onPage?: (page: EbookCatalogPage) => void | Promise<void>;
}

export interface EbookContributor {
  readonly name: string;
  /** MARC relator codes from the OPF, such as `trl`. */
  readonly roles: readonly string[];
}

/** One `belongs-to-collection` declaration (a series or a set). */
export interface EbookCollection {
  readonly title: string;
  /** `series` (ordered narrative) or `set` (thematic); null when undeclared. */
  readonly type: string | null;
  /** The `group-position` refinement; null when undeclared or not a number. */
  readonly position: number | null;
}

export interface EbookMetadata {
  readonly identifier: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly fullTitle: string;
  readonly authors: readonly string[];
  readonly translators: readonly string[];
  readonly contributors: readonly EbookContributor[];
  readonly language: string | null;
  readonly subjects: readonly string[];
  readonly description: string | null;
  readonly rights: string | null;
  readonly publishedAt: string | null;
  readonly modifiedAt: string | null;
  readonly wordCount: number | null;
  readonly repositoryUrl: string | null;
  readonly collections: readonly EbookCollection[];
}

export interface TextRange {
  /** Inclusive UTF-16 offset into `EbookText.text`. */
  readonly start: number;
  /** Exclusive UTF-16 offset into `EbookText.text`. */
  readonly end: number;
}

export interface EbookSection {
  readonly order: number;
  readonly id: string;
  readonly href: string;
  readonly title: string;
  readonly partition: EbookPartition;
  readonly semanticTypes: readonly string[];
  readonly linear: boolean;
  readonly text: string;
  readonly includedInText: boolean;
  /** Null when this section is not part of the selected joined text. */
  readonly range: TextRange | null;
}

export interface EbookSource {
  readonly kind: 'release' | 'repository';
  readonly url: string;
  readonly repository: string;
  readonly ref: string;
}

export interface EbookWarning {
  readonly code: 'release-fallback';
  readonly message: string;
}

export interface EbookText {
  readonly repository: EbookRepository;
  readonly metadata: EbookMetadata;
  /** All documents in the EPUB spine, including unselected front/back matter. */
  readonly sections: readonly EbookSection[];
  /** Selected sections joined with blank lines. Defaults to body matter only. */
  readonly text: string;
  readonly selectedPartitions: readonly EbookPartition[];
  readonly source: EbookSource;
  readonly warnings: readonly EbookWarning[];
}

export interface DownloadEbookOptions {
  /** Defaults to the official release EPUB. */
  readonly source?: 'release' | 'repository';
  /** Defaults to true when `source` is `release`. */
  readonly fallbackToRepository?: boolean;
  /** Defaults to `['bodymatter']`. */
  readonly partitions?: readonly EbookPartition[];
  readonly signal?: AbortSignal;
  /** Maximum compressed EPUB size. Defaults to 64 MiB. */
  readonly maxDownloadBytes?: number;
  /** Maximum total extracted OPF/XHTML size. Defaults to 32 MiB. */
  readonly maxExtractedTextBytes?: number;
  /** Concurrent raw XHTML requests for repository mode. Defaults to 6. */
  readonly repositoryConcurrency?: number;
}

export interface StandardEbooksClientOptions {
  readonly fetch?: FetchLike;
  /** Optional user-supplied token. Never embed a token in a deployed static app. */
  readonly githubToken?: string;
  readonly githubOrganization?: string;
  readonly githubApiBase?: string;
  readonly githubRawBase?: string;
  readonly standardEbooksBase?: string;
}
