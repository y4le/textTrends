import { DOMParser } from '@xmldom/xmldom';
import { EpubError } from './errors.js';

export function parseXml(source: string, label: string, xhtml = false): Document {
  let detail: string | undefined;
  try {
    const document = new DOMParser({
      onError: (level, message) => {
        if (level === 'warning') return;
        detail ??= message;
        throw new EpubError('INVALID_EPUB', `${label} is not valid XML: ${message}`);
      },
    }).parseFromString(source, xhtml ? 'application/xhtml+xml' : 'application/xml') as unknown as Document;
    if (document.documentElement === null) throw new EpubError('INVALID_EPUB', `${label} has no root element`);
    return document;
  } catch (error) {
    if (error instanceof EpubError) throw error;
    throw new EpubError('INVALID_EPUB', `${label} is not valid XML${detail ? `: ${detail}` : ''}`, { cause: error });
  }
}

export function descendants(parent: Document | Element, localName: string): Element[] {
  const result: Element[] = [];
  const nodes = parent.getElementsByTagName('*');
  for (let index = 0; index < nodes.length; index++) {
    const element = nodes.item(index);
    if (element !== null && element.localName === localName) result.push(element);
  }
  return result;
}

/** XML element identity is namespace URI + local name, not local name alone. */
export function namespacedDescendants(
  parent: Document | Element,
  namespaceUri: string,
  localName: string,
): Element[] {
  return descendants(parent, localName).filter((element) => element.namespaceURI === namespaceUri);
}

export function firstDescendant(parent: Document | Element, localName: string): Element | null {
  return descendants(parent, localName)[0] ?? null;
}

export function normalizedText(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

export function semanticTokens(element: Element): string[] {
  const value =
    element.getAttributeNS('http://www.idpf.org/2007/ops', 'type')
    ?? element.getAttribute('epub:type')
    ?? '';
  return value.split(/\s+/u).filter((token) => token !== '');
}
