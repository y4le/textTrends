/** Lightweight demo identities and picker metadata, without runtime project dependencies. */
export const BUILTIN_SHERLOCK_ID = 'builtin/sherlock';
export const BUILTIN_AUSTEN_ID = 'builtin/austen';
export const BUILTIN_BIBLE_ID = 'builtin/bible';
export const BUILTIN_QURAN_ID = 'builtin/quran';
export const BUILTIN_POLITICAL_ARGUMENTS_ID = 'builtin/political-arguments';
export const BUILTIN_SHAKESPEARE_ID = 'builtin/shakespeare';
export const BUILTIN_INAUGURALS_ID = 'builtin/inaugurals';
export const BUILTIN_DARWIN_ORIGIN_ID = 'builtin/darwin-origin';
export const BUILTIN_CLASSIC_NOVELS_ID = 'builtin/classic-novels';
export const BUILTIN_ASOIF_ID = 'builtin/asoif';
export const BUILTIN_LOTR_ID = 'builtin/lotr';

export type BuiltinCorpusId =
  | typeof BUILTIN_SHERLOCK_ID
  | typeof BUILTIN_AUSTEN_ID
  | typeof BUILTIN_BIBLE_ID
  | typeof BUILTIN_QURAN_ID
  | typeof BUILTIN_POLITICAL_ARGUMENTS_ID
  | typeof BUILTIN_SHAKESPEARE_ID
  | typeof BUILTIN_INAUGURALS_ID
  | typeof BUILTIN_DARWIN_ORIGIN_ID
  | typeof BUILTIN_CLASSIC_NOVELS_ID
  | typeof BUILTIN_ASOIF_ID
  | typeof BUILTIN_LOTR_ID;

export interface BuiltinCorpusOption {
  readonly id: BuiltinCorpusId;
  readonly sourceDirectory:
    | 'sherlock'
    | 'austen'
    | 'bible'
    | 'quran'
    | 'political-arguments'
    | 'shakespeare'
    | 'inaugurals'
    | 'darwin-origin'
    | 'standard-ebooks'
    | 'asoif'
    | 'lotr';
  readonly label: string;
  readonly shortLabel: string;
  readonly defaultTerms: string;
}

/** Presentation + bootstrap vocabulary for the bundled demo picker. */
export const BUILTIN_CORPORA: readonly BuiltinCorpusOption[] = [
  { id: BUILTIN_SHERLOCK_ID, sourceDirectory: 'sherlock', label: 'Sherlock Holmes', shortLabel: 'Sherlock', defaultTerms: 'Holmes, Watson, Moriarty' },
  { id: BUILTIN_AUSTEN_ID, sourceDirectory: 'austen', label: 'Jane Austen', shortLabel: 'Austen', defaultTerms: 'family, friend, heart' },
  { id: BUILTIN_BIBLE_ID, sourceDirectory: 'bible', label: 'World English Bible', shortLabel: 'Bible', defaultTerms: 'God, Israel, Jesus' },
  { id: BUILTIN_QURAN_ID, sourceDirectory: 'quran', label: 'Quran — Pickthall translation', shortLabel: 'Quran', defaultTerms: 'Allah, mercy, believe' },
  { id: BUILTIN_POLITICAL_ARGUMENTS_ID, sourceDirectory: 'political-arguments', label: 'Political Arguments', shortLabel: 'Arguments', defaultTerms: 'liberty, property, class' },
  { id: BUILTIN_SHAKESPEARE_ID, sourceDirectory: 'shakespeare', label: 'Shakespeare', shortLabel: 'Shakespeare', defaultTerms: 'thou, thee, you' },
  { id: BUILTIN_INAUGURALS_ID, sourceDirectory: 'inaugurals', label: 'U.S. Inaugural Addresses', shortLabel: 'Inaugurals', defaultTerms: 'union, war, freedom' },
  { id: BUILTIN_DARWIN_ORIGIN_ID, sourceDirectory: 'darwin-origin', label: 'Origin of Species Editions', shortLabel: 'Darwin', defaultTerms: 'evolution, selection, variation' },
  { id: BUILTIN_CLASSIC_NOVELS_ID, sourceDirectory: 'standard-ebooks', label: 'Classic Novels', shortLabel: 'Classics', defaultTerms: 'she, he, God' },
  { id: BUILTIN_ASOIF_ID, sourceDirectory: 'asoif', label: 'A Song of Ice and Fire', shortLabel: 'ASOIF', defaultTerms: 'Jon, Tyrion, Daenerys' },
  { id: BUILTIN_LOTR_ID, sourceDirectory: 'lotr', label: 'The Lord of the Rings', shortLabel: 'LOTR', defaultTerms: 'Frodo, Gandalf, Sauron' },
];

/** Public, rights-documented samples shown in the ordinary Inputs picker. */
export const FEATURED_DEMO_IDS: readonly BuiltinCorpusId[] = [
  BUILTIN_SHERLOCK_ID,
  BUILTIN_AUSTEN_ID,
  BUILTIN_BIBLE_ID,
  BUILTIN_QURAN_ID,
  BUILTIN_POLITICAL_ARGUMENTS_ID,
  BUILTIN_SHAKESPEARE_ID,
  BUILTIN_INAUGURALS_ID,
  BUILTIN_DARWIN_ORIGIN_ID,
  BUILTIN_CLASSIC_NOVELS_ID,
];

export function builtinCorpusOption(id: string): BuiltinCorpusOption | undefined {
  return BUILTIN_CORPORA.find((corpus) => corpus.id === id);
}
