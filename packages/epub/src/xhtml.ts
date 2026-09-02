import type { EbookPartition } from './types.js';
import { descendants, firstDescendant, normalizedText, parseXml, semanticTokens } from './xml.js';

export interface ExtractedXhtml {
  readonly title: string;
  readonly partition: EbookPartition;
  readonly semanticTypes: readonly string[];
  readonly text: string;
}

const SKIPPED_ELEMENTS = new Set(['script', 'style', 'nav']);
const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'tfoot',
  'thead', 'tr', 'ul',
]);
const SKIPPED_SEMANTICS = new Set(['backlink', 'noteref', 'pagebreak']);

function partitionFrom(types: readonly string[]): EbookPartition | null {
  if (types.includes('frontmatter')) return 'frontmatter';
  if (types.includes('bodymatter')) return 'bodymatter';
  if (types.includes('backmatter')) return 'backmatter';
  return null;
}

function shouldSkip(element: Element): boolean {
  if (SKIPPED_ELEMENTS.has(element.localName)) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  if (element.getAttribute('role') === 'doc-noteref') return true;
  return semanticTokens(element).some((token) => SKIPPED_SEMANTICS.has(token));
}

function walkText(node: Node, output: string[]): void {
  if (node.nodeType === 3) {
    output.push((node.nodeValue ?? '').replace(/[\t\r\n\f\v ]+/gu, ' '));
    return;
  }
  if (node.nodeType !== 1) return;
  const element = node as Element;
  if (shouldSkip(element)) return;
  if (element.localName === 'br') {
    output.push('\n');
    return;
  }
  if (element.localName === 'img') {
    const alternateText = element.getAttribute('alt')?.trim();
    if (alternateText) output.push(alternateText);
    return;
  }

  const isBlock = BLOCK_ELEMENTS.has(element.localName);
  if (isBlock) output.push('\n\n');
  for (let index = 0; index < element.childNodes.length; index++) {
    const child = element.childNodes.item(index);
    if (child !== null) walkText(child, output);
  }
  if (isBlock) output.push('\n\n');
}

function cleanExtractedText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function headingText(body: Element): string | null {
  const heading = descendants(body, 'h1')[0]
    ?? descendants(body, 'h2')[0]
    ?? descendants(body, 'h3')[0]
    ?? descendants(body, 'h4')[0]
    ?? descendants(body, 'h5')[0]
    ?? descendants(body, 'h6')[0];
  if (heading === undefined) return null;
  const parts: string[] = [];
  walkText(heading, parts);
  const value = cleanExtractedText(parts.join('')).replace(/\n+/gu, ' ');
  return value === '' ? null : value;
}

export function extractXhtml(source: string, label = 'XHTML document'): ExtractedXhtml {
  const document = parseXml(source, label);
  const body = firstDescendant(document, 'body');
  if (body === null) {
    return {
      title: normalizedText(firstDescendant(document, 'title')) || 'Untitled section',
      partition: 'unknown',
      semanticTypes: [],
      text: '',
    };
  }

  const topSection = Array.from({ length: body.childNodes.length }, (_, index) => body.childNodes.item(index))
    .find((node): node is Element => node?.nodeType === 1 && (node as Element).localName === 'section');
  const bodyTypes = semanticTokens(body);
  const sectionTypes = topSection === undefined ? [] : semanticTokens(topSection);
  const semanticTypes = [...new Set([...bodyTypes, ...sectionTypes])];
  const output: string[] = [];
  walkText(body, output);

  return {
    title: headingText(body) ?? (normalizedText(firstDescendant(document, 'title')) || 'Untitled section'),
    partition: partitionFrom(bodyTypes) ?? partitionFrom(sectionTypes) ?? 'unknown',
    semanticTypes,
    text: cleanExtractedText(output.join('')),
  };
}
