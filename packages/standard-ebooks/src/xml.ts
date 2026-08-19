import { DOMParser } from '@xmldom/xmldom';
import { StandardEbooksError } from './errors.js';

export function parseXml(source: string, label: string): Document {
  const document = new DOMParser().parseFromString(source, 'application/xml') as unknown as Document;
  const root = document.documentElement;
  const parserErrors = document.getElementsByTagName('parsererror');
  if (root === null || parserErrors.length > 0) {
    const detail = parserErrors.item(0)?.textContent?.replace(/\s+/g, ' ').trim();
    throw new StandardEbooksError(
      'INVALID_RESPONSE',
      `${label} is not valid XML${detail ? `: ${detail}` : ''}`,
    );
  }
  return document;
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

/**
 * XML element identity is namespace URI + local name, not local name alone:
 * a foreign-namespace `evil:link` must never satisfy a lookup for an OPF
 * `<link>`. Any prefix bound to the right namespace matches.
 */
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
    element.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ??
    element.getAttribute('epub:type') ??
    '';
  return value.split(/\s+/u).filter((token) => token !== '');
}
