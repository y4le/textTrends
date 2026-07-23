/**
 * HTML container extraction — the worker-side adapter behind the `html` format.
 * Real-world HTML is rarely well-formed XML, so this uses a standards HTML5 tree
 * builder (parse5, dynamically imported) rather than an XML parser. Extraction
 * is INERT: parse5 builds a detached tree, and the walk never executes scripts,
 * fetches subresources, or resolves external entities. Source bytes are decoded
 * with the shared BOM/UTF-8/windows-1252 policy (a `<meta charset>` sniff is a
 * documented future refinement).
 *
 * To anchor heading candidates without fragile offset-mapping, the document is
 * split into heading-delimited SEGMENTS (the same shape the EPUB path joins):
 * each segment's cleaned text is concatenated with blank-line joins, and each
 * heading-led segment yields one `html-heading` candidate at its range — the
 * range addresses the FINAL text exactly, from one running cursor.
 */

import {
  decodeSource,
  finalizeExtraction,
  type ExtractedDocument,
  type ExtractionRecipeProvisional,
  type PreparedExtraction,
  type StructureCandidateV1,
} from '@texttrends/core';

type HtmlRecipe = Extract<ExtractionRecipeProvisional, { format: 'html' }>;

/** A malformed decode or oversize output, classified so the engine maps it to
 *  PARSE_FAILED vs CAP_EXCEEDED — never DECODE_FAILED. */
export class HtmlExtractionError extends Error {
  constructor(message: string, readonly cap: boolean) {
    super(message);
    this.name = 'HtmlExtractionError';
  }
}

const SKIPPED = new Set(['script', 'style', 'nav', 'head', 'template', 'noscript']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'tfoot',
  'thead', 'tr', 'ul',
]);
const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

interface P5Node {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly childNodes?: readonly P5Node[];
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
}

interface Segment {
  level: number | null; // heading level that opened it, or null (pre-heading)
  title: string;
  chunks: string[];
}

function attr(node: P5Node, name: string): string | undefined {
  return node.attrs?.find((a) => a.name === name)?.value;
}

function clean(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** Walk a parse5 tree, splitting into heading-delimited segments. */
function walk(node: P5Node, segments: Segment[], inHeading: { level: number } | null): void {
  const name = node.nodeName;
  if (node.nodeName === '#text') {
    segments[segments.length - 1]!.chunks.push((node.value ?? '').replace(/[\t\r\n\f\v ]+/gu, ' '));
    return;
  }
  if (node.tagName === undefined) {
    for (const c of node.childNodes ?? []) walk(c, segments, inHeading);
    return;
  }
  const tag = name.toLowerCase();
  if (SKIPPED.has(tag) || attr(node, 'aria-hidden') === 'true') return;
  if (tag === 'br') { segments[segments.length - 1]!.chunks.push('\n'); return; }
  if (tag === 'img') {
    const alt = attr(node, 'alt')?.trim();
    if (alt) segments[segments.length - 1]!.chunks.push(alt);
    return;
  }

  const level = HEADINGS[tag];
  if (level !== undefined && inHeading === null) {
    // Open a new segment; the heading text is its title AND its opening text.
    segments.push({ level, title: '', chunks: [] });
    const cur = segments[segments.length - 1]!;
    cur.chunks.push('\n\n');
    for (const c of node.childNodes ?? []) walk(c, segments, { level });
    cur.chunks.push('\n\n');
    cur.title = clean(cur.chunks.join('')).replace(/\n+/gu, ' ');
    return;
  }

  const isBlock = BLOCK.has(tag);
  if (isBlock) segments[segments.length - 1]!.chunks.push('\n\n');
  for (const c of node.childNodes ?? []) walk(c, segments, inHeading);
  if (isBlock) segments[segments.length - 1]!.chunks.push('\n\n');
}

function findBody(node: P5Node): P5Node | null {
  if (node.tagName?.toLowerCase() === 'body') return node;
  for (const c of node.childNodes ?? []) {
    const found = findBody(c);
    if (found) return found;
  }
  return null;
}

export async function extractHtmlDocument(
  bytes: Uint8Array,
  recipe: HtmlRecipe,
  maxTextUtf16: number,
): Promise<ExtractedDocument> {
  const { hashSourceBytes } = await import('@texttrends/core');
  let decoded;
  try {
    decoded = decodeSource(bytes); // BOM/UTF-8/1252 — throws DecodeError on ill-formed BOM Unicode
  } catch (e) {
    throw new HtmlExtractionError(e instanceof Error ? e.message : String(e), false);
  }
  const { parse } = await import('parse5');
  const doc = parse(decoded.text) as unknown as P5Node;
  const body = findBody(doc) ?? doc;

  const segments: Segment[] = [{ level: null, title: '', chunks: [] }];
  walk(body, segments, null);

  // Clean each segment, drop empties, join with blank lines, and record ranges
  // from ONE running cursor so candidate spans address the final text exactly.
  const parts: { level: number | null; title: string; text: string }[] = [];
  for (const s of segments) {
    const text = clean(s.chunks.join(''));
    if (text !== '') parts.push({ level: s.level, title: s.title, text });
  }
  const chunks: string[] = [];
  const candidates: StructureCandidateV1[] = [];
  let length = 0;
  for (const p of parts) {
    if (chunks.length > 0) { chunks.push('\n\n'); length += 2; }
    const start = length;
    chunks.push(p.text);
    length += p.text.length;
    if (p.level !== null && p.title.trim() !== '') {
      candidates.push({ kind: 'html-heading', level: p.level, title: p.title, chars: { start, end: length } });
    }
  }
  const text = chunks.join('');
  if (text.length > maxTextUtf16) {
    throw new HtmlExtractionError(`html extracted text of ${text.length} exceeds the per-document cap`, true);
  }

  const hash = await hashSourceBytes(bytes);
  const prepared: PreparedExtraction = {
    kind: 'transformed',
    source: {
      kind: 'markup',
      hash,
      byteLength: bytes.length,
      format: 'html',
      encoding: { detected: decoded.detected, hadReplacementChars: decoded.decoderReplacementCount > 0 },
    },
    text,
    candidates,
    evidence: { decoderReplacementCount: decoded.decoderReplacementCount, suspiciousControlCount: decoded.suspiciousControlCount },
  };
  return finalizeExtraction(prepared, recipe);
}
