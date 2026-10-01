/** Shared byte-preserving block and whitespace policy; no parser dependencies. */
export const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'tfoot',
  'thead', 'tr', 'ul', 'td', 'th', 'summary', 'details',
]);

export function cleanExtractedText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}


export function normalizeMarkupText(value: string, inPre: boolean): string {
  return value.replace(/\r\n?/gu, '\n').replace(inPre ? /[\t\f\v ]+/gu : /[\t\n\f\v ]+/gu, ' ');
}
