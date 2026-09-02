import { EpubError } from './errors.js';
import type { EbookCollection, EbookContributor, EbookMetadata } from './types.js';
import { namespacedDescendants, normalizedText, parseXml } from './xml.js';

const OPF_NS = 'http://www.idpf.org/2007/opf';
const DC_NS = 'http://purl.org/dc/elements/1.1/';

const opfDescendants = (parent: Document | Element, localName: string): Element[] =>
  namespacedDescendants(parent, OPF_NS, localName);
const dcDescendants = (parent: Document | Element, localName: string): Element[] =>
  namespacedDescendants(parent, DC_NS, localName);

export interface ManifestItem {
  readonly id: string;
  readonly href: string;
  readonly mediaType: string;
  readonly properties: readonly string[];
}

export interface SpineItem {
  readonly idref: string;
  readonly item: ManifestItem;
  readonly linear: boolean;
}

export interface ParsedPackage {
  readonly metadata: EbookMetadata;
  readonly spine: readonly SpineItem[];
}

function refinements(metadataElement: Element): Map<string, Map<string, string[]>> {
  const result = new Map<string, Map<string, string[]>>();
  for (const meta of opfDescendants(metadataElement, 'meta')) {
    const target = meta.getAttribute('refines');
    const property = meta.getAttribute('property');
    if (target === null || !target.startsWith('#') || property === null) continue;
    const byProperty = result.get(target.slice(1)) ?? new Map<string, string[]>();
    const values = byProperty.get(property) ?? [];
    const value = normalizedText(meta);
    if (value !== '') values.push(value);
    byProperty.set(property, values);
    result.set(target.slice(1), byProperty);
  }
  return result;
}

function refinedValues(
  refinementMap: Map<string, Map<string, string[]>>,
  id: string,
  property: string,
): readonly string[] {
  return refinementMap.get(id)?.get(property) ?? [];
}

function firstMeta(metadataElement: Element, property: string): string | null {
  const match = opfDescendants(metadataElement, 'meta').find(
    (meta) => meta.getAttribute('property') === property && meta.getAttribute('refines') === null,
  );
  const value = normalizedText(match ?? null);
  return value === '' ? null : value;
}

function firstDcText(metadataElement: Element, localName: string): string | null {
  const value = normalizedText(dcDescendants(metadataElement, localName)[0] ?? null);
  return value === '' ? null : value;
}

function canonicalIdentifier(packageElement: Element, metadataElement: Element, label: string): string {
  const uniqueIdentifierId = packageElement.getAttribute('unique-identifier');
  if (uniqueIdentifierId === null || uniqueIdentifierId === '') {
    throw new EpubError('INVALID_EPUB', `${label} declares no unique-identifier`);
  }
  const match = dcDescendants(metadataElement, 'identifier').find(
    (element) => element.getAttribute('id') === uniqueIdentifierId,
  );
  const value = normalizedText(match ?? null);
  if (match === undefined || value === '') {
    throw new EpubError(
      'INVALID_EPUB',
      `${label} unique-identifier ${JSON.stringify(uniqueIdentifierId)} does not resolve to a dc:identifier`,
    );
  }
  return value;
}

function parseMetadata(packageElement: Element, metadataElement: Element, label: string): EbookMetadata {
  const refinementMap = refinements(metadataElement);
  const titleElements = dcDescendants(metadataElement, 'title');
  const titleByType = (type: string): string | null => {
    const match = titleElements.find((element) => {
      const id = element.getAttribute('id');
      return id !== null && refinedValues(refinementMap, id, 'title-type').includes(type);
    });
    const value = normalizedText(match ?? null);
    return value === '' ? null : value;
  };

  const title = titleByType('main') ?? normalizedText(titleElements[0] ?? null);
  if (title === '') throw new EpubError('INVALID_EPUB', 'The OPF package has no title');
  const subtitle = titleByType('subtitle');
  const fullTitle = titleByType('expanded') ?? (subtitle === null ? title : `${title}: ${subtitle}`);

  const contributors: EbookContributor[] = dcDescendants(metadataElement, 'contributor')
    .map((element) => {
      const name = normalizedText(element);
      const id = element.getAttribute('id') ?? '';
      return { name, roles: refinedValues(refinementMap, id, 'role') };
    })
    .filter((contributor) => contributor.name !== '');

  const collections: EbookCollection[] = opfDescendants(metadataElement, 'meta')
    .filter(
      (meta) => meta.getAttribute('property') === 'belongs-to-collection' && meta.getAttribute('refines') === null,
    )
    .map((meta) => {
      const id = meta.getAttribute('id') ?? '';
      const positionText = refinedValues(refinementMap, id, 'group-position')[0] ?? null;
      const position = positionText === null ? NaN : Number(positionText);
      return {
        title: normalizedText(meta),
        type: refinedValues(refinementMap, id, 'collection-type')[0] ?? null,
        position: Number.isFinite(position) ? position : null,
      };
    })
    .filter((collection) => collection.title !== '');

  const wordCountText = firstMeta(metadataElement, 'schema:wordCount');
  const parsedWordCount = wordCountText === null ? NaN : Number(wordCountText);
  const repositoryLink = opfDescendants(metadataElement, 'link').find((link) => {
    const relations = (link.getAttribute('rel') ?? '').split(/\s+/u);
    return relations.includes('schema:codeRepository');
  });

  return {
    identifier: canonicalIdentifier(packageElement, metadataElement, label),
    title,
    subtitle,
    fullTitle,
    authors: dcDescendants(metadataElement, 'creator').map(normalizedText).filter((value) => value !== ''),
    translators: contributors
      .filter((contributor) => contributor.roles.includes('trl'))
      .map((contributor) => contributor.name),
    contributors,
    language: firstDcText(metadataElement, 'language'),
    subjects: dcDescendants(metadataElement, 'subject').map(normalizedText).filter((value) => value !== ''),
    description: firstDcText(metadataElement, 'description'),
    rights: firstDcText(metadataElement, 'rights'),
    publishedAt: firstDcText(metadataElement, 'date'),
    modifiedAt: firstMeta(metadataElement, 'dcterms:modified'),
    wordCount: Number.isSafeInteger(parsedWordCount) && parsedWordCount >= 0 ? parsedWordCount : null,
    repositoryUrl: repositoryLink?.getAttribute('href') ?? null,
    collections,
  };
}

export function parsePackage(source: string, label = 'OPF package'): ParsedPackage {
  const document = parseXml(source, label);
  const packageElement = document.documentElement;
  if (packageElement === null || packageElement.localName !== 'package' || packageElement.namespaceURI !== OPF_NS) {
    throw new EpubError('INVALID_EPUB', `${label} root is not an OPF package element`);
  }
  const metadataElement = opfDescendants(packageElement, 'metadata')[0] ?? null;
  const manifestElement = opfDescendants(packageElement, 'manifest')[0] ?? null;
  const spineElement = opfDescendants(packageElement, 'spine')[0] ?? null;
  if (metadataElement === null || manifestElement === null || spineElement === null) {
    throw new EpubError('INVALID_EPUB', `${label} must contain metadata, manifest, and spine elements`);
  }

  const manifest = new Map<string, ManifestItem>();
  for (const element of opfDescendants(manifestElement, 'item')) {
    const id = element.getAttribute('id');
    const href = element.getAttribute('href');
    const mediaType = element.getAttribute('media-type');
    if (id === null || href === null || mediaType === null) continue;
    manifest.set(id, {
      id,
      href,
      mediaType,
      properties: (element.getAttribute('properties') ?? '').split(/\s+/u).filter(Boolean),
    });
  }

  const spine: SpineItem[] = [];
  for (const element of opfDescendants(spineElement, 'itemref')) {
    const idref = element.getAttribute('idref');
    if (idref === null) continue;
    const item = manifest.get(idref);
    if (item === undefined) {
      throw new EpubError(
        'INVALID_EPUB',
        `${label} spine references missing manifest item ${JSON.stringify(idref)}`,
      );
    }
    if (item.mediaType !== 'application/xhtml+xml') continue;
    spine.push({ idref, item, linear: element.getAttribute('linear') !== 'no' });
  }

  if (spine.length === 0) throw new EpubError('INVALID_EPUB', `${label} has no XHTML spine items`);
  return { metadata: parseMetadata(packageElement, metadataElement, label), spine };
}
