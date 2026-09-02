export type EbookPartition = 'frontmatter' | 'bodymatter' | 'backmatter' | 'unknown';

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
  /** Inclusive UTF-16 offset into the joined extracted text. */
  readonly start: number;
  /** Exclusive UTF-16 offset into the joined extracted text. */
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
