/**
 * Pure parsing/validation core of the Standard Ebooks catalog updater
 * (update-se-catalog.mjs holds the fetch orchestration and file writes).
 * Everything here fails closed by throwing DriftError; the offline fixture
 * suite (se-catalog-lib.test.mjs) exercises the drift gates without network.
 *
 * HTML scraping (site-specific, brittle by nature) stays here; the stable
 * Standard Ebooks contracts — the path→repository-name mapping and OPF
 * parsing (identifier, code repository, collections) — come from
 * @texttrends/standard-ebooks, so this module holds drift POLICY over the
 * library's parsed facts rather than its own OPF regexes.
 */

import { ebookPathToRepositoryName, parsePackage } from '@texttrends/standard-ebooks';

export const ORIGIN = 'https://standardebooks.org';
export const RAW_ORIGIN = 'https://raw.githubusercontent.com';
export const ORGANIZATION = 'standardebooks';

export class DriftError extends Error {}

export function assert(condition, message) {
  if (!condition) throw new DriftError(message);
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Decode character references, failing closed: an unknown named entity
 * throws, and any character-reference-shaped residue left after decoding
 * (a spelling the recognizer missed) also throws rather than being baked
 * into the artifact as literal source syntax.
 */
export function decodeEntities(text) {
  const decoded = text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (whole, body) => {
    if (/^#[xX]/u.test(body)) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    const named = NAMED_ENTITIES[body];
    assert(named !== undefined, `Unknown HTML entity: ${whole}`);
    return named;
  });
  const residue = /&#?[a-zA-Z0-9]+;/u.exec(decoded);
  assert(residue === null, `Undecoded character reference remains: ${residue?.[0]}`);
  return decoded;
}

function decodedNonEmpty(value, what) {
  const decoded = decodeEntities(value).trim();
  assert(decoded !== '', `${what} is empty after normalization`);
  return decoded;
}

/**
 * Parse every `<li typeof="schema:Book" …>` entry. The browse list keys the
 * ebook path off `about=`, a collection off `resource=`; both carry the title
 * as the first plain-paragraph schema:name span and the author(s) inside
 * `<p class="author">` blocks. Collections add a schema:position meta.
 */
export function parseBookEntries(html, label) {
  const chunks = html.split(/<li typeof="schema:Book"/u).slice(1);
  return chunks.map((chunk, index) => {
    const where = `${label} entry ${index + 1}`;
    const body = chunk.slice(0, chunk.indexOf('</li>'));
    const liTag = body.slice(0, body.indexOf('>'));
    const path = /(?:about|resource)="(\/ebooks\/[^"]+)"/u.exec(liTag)?.[1];
    assert(path !== undefined, `${where}: no ebook path`);
    // Any ribbon class marks an entry that is not a plain downloadable ebook
    // ("not-pd", "wanted" = not yet produced, …).
    const ribbon = /class="[^"]*ribbon[^"]*"/u.test(liTag);
    const position = /<meta property="schema:position" content="([^"]+)"\/>/u.exec(body)?.[1];
    const title = /<p><a [^>]*property="schema:url"><span property="schema:name">([^<]+)<\/span>/u.exec(body)?.[1];
    assert(title !== undefined, `${where}: no title`);
    const authors = [...body.matchAll(/<p class="author"[^>]*>.*?<span property="schema:name">([^<]+)<\/span>/gsu)].map((m) => m[1]);
    assert(authors.length > 0, `${where}: no author`);
    return {
      path,
      ribbon,
      position: position === undefined ? null : Number(position),
      title: decodedNonEmpty(title, `${where} title`),
      author: authors.map((a) => decodedNonEmpty(a, `${where} author`)).join(' and '),
    };
  });
}

/**
 * The library's slash-to-underscore mapping, reclassified as catalog drift:
 * the OPF cross-check proves the derived name is a real repository that
 * identifies as exactly this path.
 */
export function pathToRepositoryName(path) {
  try {
    return ebookPathToRepositoryName(path);
  } catch (error) {
    throw new DriftError(error instanceof Error ? error.message : String(error));
  }
}

/** One popularity page: selected-option drift gates + expected entry count. */
export function parsePopularityPage(html, { page, perPage, minimumCount }) {
  const label = `popularity page ${page}`;
  assert(html.includes('<option value="popularity" selected="selected">'), `${label}: popularity sort not selected (sort key drift?)`);
  assert(html.includes(`<option value="${perPage}" selected="selected">`), `${label}: per-page ${perPage} not selected`);
  const entries = parseBookEntries(html, label);
  assert(
    minimumCount === perPage ? entries.length === perPage : entries.length >= minimumCount,
    `${label}: expected ${minimumCount === perPage ? perPage : `at least ${minimumCount}`} books, got ${entries.length}`,
  );
  return entries;
}

/** One collection page: a COMPLETE series — every member positioned, none flagged. */
export function parseSeriesPage(html, slug) {
  const label = `collection ${slug}`;
  assert(html.includes(`typeof="schema:BookSeries" about="/collections/${slug}"`), `${label}: no BookSeries markup`);
  const title = /typeof="schema:BookSeries"[^>]*>\s*<meta property="schema:name" content="([^"]+)"\/>/u.exec(html)?.[1];
  assert(title !== undefined, `${label}: no series title`);
  const entries = parseBookEntries(html, label);
  assert(entries.length > 1, `${label}: a series needs at least two members`);
  for (const entry of entries) {
    assert(!entry.ribbon, `${label}: ${entry.path} is flagged (not-pd/wanted/…) — series is not a complete downloadable showcase`);
    assert(entry.position !== null && Number.isFinite(entry.position) && entry.position > 0, `${label}: ${entry.path} has no valid position`);
  }
  assert(new Set(entries.map((e) => e.position)).size === entries.length, `${label}: duplicate positions`);
  const members = [...entries]
    .sort((a, b) => a.position - b.position)
    .map((entry) => ({ ...entry, name: pathToRepositoryName(entry.path) }));
  return { slug, title: decodedNonEmpty(title, `${label} title`), sourceUrl: `${ORIGIN}/collections/${slug}`, members };
}

/**
 * The OPF is the per-book source of truth: require the identifier and the
 * `rel="schema:codeRepository"` link to agree with the derived name, and each
 * claimed series membership to be declared with the same position, so markup
 * or mapping drift fails at generation instead of producing bad downloads at
 * add-time. The facts come from the library's real XML parse (parsePackage:
 * comments ignored, attribute/element identity exact); only the drift policy
 * lives here.
 */
export function validateOpfDocument(opf, book, seriesMemberships) {
  const label = `OPF ${book.name}`;
  let metadata;
  try {
    metadata = parsePackage(opf, label).metadata;
  } catch (error) {
    throw new DriftError(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert(
    metadata.identifier === `${ORIGIN}${book.path}`,
    `${label}: dc:identifier "${metadata.identifier}" does not match ${book.path}`,
  );
  assert(
    metadata.repositoryUrl === `https://github.com/${ORGANIZATION}/${book.name}`,
    `${label}: schema:codeRepository "${metadata.repositoryUrl ?? '(none)'}" does not match the derived repository name`,
  );
  for (const { seriesTitle, position } of seriesMemberships) {
    const collection = metadata.collections.find((c) => c.title === seriesTitle);
    assert(collection !== undefined, `${label}: no belongs-to-collection for "${seriesTitle}"`);
    assert(collection.type === 'series', `${label}: "${seriesTitle}" is not declared collection-type=series`);
    assert(
      collection.position === position,
      `${label}: group-position ${collection.position ?? '(none)'} disagrees with collection position ${position}`,
    );
  }
}

/**
 * The canonical artifact content (everything except generatedAt): ranked
 * books 1..N first, then series-only books in configured-series order and
 * position order, each book exactly once.
 */
export function canonicalContent(popular, series, popularityUrl) {
  const books = [...popular.map(({ name, title, author, popularityRank }) => ({ name, title, author, popularityRank }))];
  const seen = new Set(books.map((b) => b.name));
  for (const s of series) {
    for (const { name, title, author } of s.members) {
      if (seen.has(name)) continue;
      seen.add(name);
      books.push({ name, title, author });
    }
  }
  return {
    schemaVersion: 1,
    source: { popularityUrl },
    books,
    series: series.map(({ slug, title, sourceUrl, members }) => ({
      slug,
      title,
      sourceUrl,
      members: members.map(({ name, position }) => ({ name, position })),
    })),
  };
}

/**
 * Fetch one of the KNOWN catalog/collection/raw URLs (never crawled links).
 * Status, final origin, AND media type are all part of the fail-closed gate:
 * a same-origin 200 with an unexpected representation must never reach the
 * parsers.
 */
export async function fetchText(url, { origin, types, label, userAgent, fetchImpl = fetch }) {
  const response = await fetchImpl(url, { headers: { 'user-agent': userAgent } });
  assert(response.ok, `${label}: HTTP ${response.status} for ${url}`);
  assert(new URL(response.url).origin === origin, `${label}: unexpected final origin ${response.url}`);
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  assert(types.includes(mediaType), `${label}: unexpected content type "${mediaType}" for ${url}`);
  return response.text();
}
