/**
 * Markdown heading scan — 'markdown-heading-scan-v1' (contract §12.4; plan
 * §(b)). A HEADING SCAN, deliberately not CommonMark: it recognizes ATX
 * (`# …` through `###### …`) and setext (`===`/`---` underlines) headings
 * over the LITERAL extracted text, and tracks fenced and indented code so a
 * `# comment` inside a fence never becomes a false chapter. Anything subtler
 * (lazy continuation, HTML blocks, nested lists) is out of scope by design
 * and by name.
 *
 * Candidates are char-anchored to the heading LINE span (setext: title line
 * start through underline end) in the extracted text; titles are the
 * trimmed heading text with ATX markers and trailing closing hashes
 * removed. Offsets are UTF-16 and address the text exactly as decoded.
 */

import { canonicalJson, sha256Hex } from '../contract/hash.ts';

export interface StructureCandidateV1 {
  readonly kind: 'md-heading-atx' | 'md-heading-setext';
  readonly level: number; // 1–6 as authored
  readonly title: string;
  readonly chars: { readonly start: number; readonly end: number };
}

const ATX_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/;
const ATX_EMPTY_RE = /^ {0,3}(#{1,6})[ \t]*$/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
/** A CLOSING fence is marker-only (optional whitespace after) — an info
 *  string means a new opening, never a close. */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;

interface Line {
  readonly start: number; // char offset of line start
  readonly end: number;   // char offset of line end (exclusive of terminator)
  readonly text: string;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text.charCodeAt(i) : -1;
    if (c === 0x0a /* LF */ || c === -1) {
      // CRLF: the CR belongs to the terminator, not the line text.
      const end = i > start && text.charCodeAt(i - 1) === 0x0d ? i - 1 : i;
      if (i > start || c === 0x0a) lines.push({ start, end, text: text.slice(start, end) });
      start = i + 1;
    }
  }
  return lines;
}

export function scanMarkdownHeadings(text: string): StructureCandidateV1[] {
  const candidates: StructureCandidateV1[] = [];
  let lines = splitLines(text);
  // A LEADING front-matter block (---…---) is metadata, not prose: without
  // this skip, its closing --- would read as a setext underline for the
  // final metadata line.
  if (lines.length > 0 && lines[0]!.text === '---') {
    const close = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l.text));
    if (close > 0) lines = lines.slice(close + 1);
  }
  // An open fence closes ONLY on the same marker character repeated at
  // least the OPENING length, with nothing but whitespace after (review:
  // a ```` fence must not be closed by ```, and ```js opens, never closes).
  let openFence: { readonly char: string; readonly length: number } | null = null;
  let previous: Line | null = null; // candidate setext title line

  for (const line of lines) {
    if (openFence !== null) {
      const close = FENCE_CLOSE_RE.exec(line.text);
      if (close && close[1]![0] === openFence.char && close[1]!.length >= openFence.length) {
        openFence = null;
      }
      previous = null;
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line.text);
    if (open) {
      openFence = { char: open[1]![0]!, length: open[1]!.length };
      previous = null;
      continue;
    }
    if (INDENTED_CODE_RE.test(line.text) && line.text.trim() !== '') {
      previous = null;
      continue;
    }

    const atx = ATX_RE.exec(line.text);
    if (atx || ATX_EMPTY_RE.test(line.text)) {
      if (atx && atx[2]!.trim() !== '') {
        candidates.push({
          kind: 'md-heading-atx',
          level: atx[1]!.length,
          title: atx[2]!.trim(),
          chars: { start: line.start, end: line.end },
        });
      }
      previous = null;
      continue;
    }

    const underline = SETEXT_UNDERLINE_RE.exec(line.text);
    if (underline && previous !== null && previous.text.trim() !== '') {
      candidates.push({
        kind: 'md-heading-setext',
        level: underline[1]![0] === '=' ? 1 : 2,
        title: previous.text.trim(),
        chars: { start: previous.start, end: line.end },
      });
      previous = null;
      continue;
    }

    previous = line.text.trim() === '' ? null : line;
  }
  return candidates;
}

/** Canonical identity of a candidate set (order is text order, so the array
 *  itself is canonical). */
export async function hashStructureCandidates(
  candidates: readonly StructureCandidateV1[],
): Promise<string> {
  return sha256Hex(
    canonicalJson(
      candidates.map((c) => ({
        kind: c.kind,
        level: c.level,
        title: c.title,
        start: c.chars.start,
        end: c.chars.end,
      })),
    ),
  );
}
