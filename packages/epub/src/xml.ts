import { DOMParser } from '@xmldom/xmldom';
import { EPUB_PARSE_LIMITS, EPUB_XML_LIMITS } from './limits.js';
import { EpubError } from './errors.js';

/** Lexical resource admission precedes DOM allocation. This deliberately is
 * not an XML validator: quoted values, comments and CDATA do not contribute
 * attribute names. Unquoted values and quotes outside values are rejected
 * because xmldom repairs them with states that can conceal attributes. */
function admitXmlTags(source: string, label: string): void {
  let documentAttributes = 0;
  for (let start = source.indexOf('<'); start !== -1; start = source.indexOf('<', start + 1)) {
    const terminator = source.startsWith('<!--', start) ? '-->'
      : source.startsWith('<![CDATA[', start) ? ']]>' : null;
    if (terminator !== null) {
      const end = source.indexOf(terminator, start + 4);
      if (end === -1) return; // The parser diagnoses the malformed section.
      start = end + terminator.length - 1;
      continue;
    }
    const declaration = source.charCodeAt(start + 1) === 0x21;
    let quote = 0;
    let attributes = 0;
    let inToken = false;
    let nameSeen = false;
    let valueExpected = false;
    const token = () => {
      if (!nameSeen) { nameSeen = true; return; }
      attributes++;
      documentAttributes++;
      if (attributes > EPUB_XML_LIMITS.maxAttributesPerTag || documentAttributes > EPUB_XML_LIMITS.maxAttributesPerDocument) {
        throw new EpubError('CAP_EXCEEDED', `${label} exceeds the XML attribute limit`);
      }
    };
    let end = start + 1;
    for (; end < source.length; end++) {
      if (end - start > EPUB_XML_LIMITS.maxTagUtf16) throw new EpubError('CAP_EXCEEDED', `${label} exceeds the XML tag length limit`);
      const code = source.charCodeAt(end);
      if (quote !== 0) { if (code === quote) { quote = 0; inToken = false; } continue; }
      const xmlSpace = code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
      if ((code <= 0x20 && !xmlSpace) || code === 0x80 || code === 0x85 || code === 0x2028 || code === 0x2029) {
        throw new EpubError('INVALID_EPUB', `${label} has an invalid XML tag separator`);
      }
      if (code === 0x3e) { start = end; break; }
      if (xmlSpace) { inToken = false; continue; }
      if (code === 0x3d) { valueExpected = true; inToken = false; continue; }
      if (code === 0x2f || code === 0x3f) continue;
      if (code === 0x22 || code === 0x27) {
        if (!valueExpected && !declaration) throw new EpubError('INVALID_EPUB', `${label} has a quote outside an XML attribute value`);
        valueExpected = false;
        quote = code;
        continue;
      }
      if (valueExpected) throw new EpubError('INVALID_EPUB', `${label} has an unquoted XML attribute value`);
      if (!inToken) { token(); inToken = true; }
    }
    if (end === source.length) return;
  }
}

export function parseXml(source: string, label: string, xhtml = false): Document {
  if (source.length > EPUB_PARSE_LIMITS.maxDocumentBytes) throw new EpubError('CAP_EXCEEDED', `${label} exceeds the XML document limit`);
  let markup = 0;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 0x3c && ++markup > EPUB_PARSE_LIMITS.maxMarkupPerDocument) throw new EpubError('CAP_EXCEEDED', `${label} exceeds the XML markup limit`);
  admitXmlTags(source, label);
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
