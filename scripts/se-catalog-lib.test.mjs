/**
 * Offline fixture suite for the catalog updater's fail-closed gates: media
 * types, entity decoding (including residue rejection), label normalization,
 * the rel="schema:codeRepository" OPF cross-check, and canonical content
 * assembly. No network: fetchText takes a stubbed fetch. Runs via
 * `node --test scripts/` (part of `pnpm test`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DriftError,
  ORIGIN,
  canonicalContent,
  decodeEntities,
  fetchText,
  parseBookEntries,
  parsePopularityPage,
  pathToRepositoryName,
  validateOpfDocument,
} from './se-catalog-lib.mjs';

const bookLi = ({ path, title, author }) => `
  <li typeof="schema:Book" about="${path}">
    <div class="thumbnail-container"><a href="${path}" property="schema:url"><picture></picture></a></div>
    <p><a href="${path}" property="schema:url"><span property="schema:name">${title}</span></a></p>
    <p class="author" typeof="schema:Person" property="schema:author"><a href="x" property="schema:url"><span property="schema:name">${author}</span></a></p>
  </li>`;

const browsePage = (entries, { sortSelected = true, perPageSelected = true } = {}) => `
  <select name="sort"><option value="popularity"${sortSelected ? ' selected="selected"' : ''}>Popularity</option></select>
  <select name="per-page"><option value="2"${perPageSelected ? ' selected="selected"' : ''}>2</option></select>
  <ol class="ebooks-list grid">${entries.join('')}</ol>`;

/** A minimal but REAL package: the validator parses it with the library's
 *  parsePackage (title, manifest, and an XHTML spine are required). */
const opfFor = ({ path, name }) => `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${ORIGIN}${path}</dc:identifier>
    <dc:title>A Fixture</dc:title>
    <meta property="se:url.vcs.github" id="vcs-repository">https://github.com/standardebooks/${name}</meta>
    <link href="https://github.com/standardebooks/${name}" refines="#vcs-repository" rel="schema:codeRepository"/>
  </metadata>
  <manifest><item href="text/ch1.xhtml" id="c1" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;

const throws = (fn, pattern) => assert.throws(fn, (e) => e instanceof DriftError && pattern.test(e.message));

describe('decodeEntities', () => {
  it('decodes named, decimal, and hex (either case) references', () => {
    assert.equal(decodeEntities('A &amp; B &#38; C &#x26; D &#X26; E'), 'A & B & C & D & E');
    assert.equal(decodeEntities('caf&#233;'), 'café');
  });
  it('rejects unknown named entities and any undecoded residue', () => {
    throws(() => decodeEntities('one &frac12; cup'), /Unknown HTML entity: &frac12;/u);
    throws(() => decodeEntities('bad &#xZZ1; ref'), /Undecoded character reference/u);
  });
});

describe('pathToRepositoryName', () => {
  it('joins segments with underscores, tolerating underscores inside a segment', () => {
    assert.equal(pathToRepositoryName('/ebooks/homer/the-odyssey/william-cullen-bryant'), 'homer_the-odyssey_william-cullen-bryant');
    assert.equal(pathToRepositoryName('/ebooks/leo-tolstoy/war-and-peace/louise-maude_aylmer-maude'), 'leo-tolstoy_war-and-peace_louise-maude_aylmer-maude');
  });
  it('applies Standard Ebooks\' GitHub-limit truncation to long repository names', () => {
    assert.equal(
      pathToRepositoryName('/ebooks/hans-jakob-christoffel-von-grimmelshausen/the-adventurous-simplicissimus/alfred-thomas-scrope-goodrick'),
      'hans-jakob-christoffel-von-grimmelshausen_the-adventurous-simplicissimus_alfred-thomas-scrope-goodri',
    );
  });
  it('rejects single-segment and empty-segment paths as DriftError', () => {
    throws(() => pathToRepositoryName('/ebooks/only-author'), /Not a Standard Ebooks ebook URL path/u);
    throws(() => pathToRepositoryName('/ebooks/a//b'), /Not a Standard Ebooks ebook URL path/u);
  });
});

describe('parseBookEntries', () => {
  const good = { path: '/ebooks/a/b', title: 'Book &amp; Title', author: 'An Author' };
  it('decodes labels', () => {
    const [entry] = parseBookEntries(bookLi(good), 't');
    assert.equal(entry.title, 'Book & Title');
  });
  it('labels the site\'s empty canonical anonymous author', () => {
    const anonymous = bookLi(good).replace(
      /<p class="author"[^>]*>.*?<\/p>/su,
      '<p class="author" typeof="schema:Person" property="schema:author" resource="/ebooks/anonymous"></p>',
    );
    const [entry] = parseBookEntries(anonymous, 't');
    assert.equal(entry.author, 'Anonymous');
  });
  it('rejects whitespace-only labels before anything can be written', () => {
    throws(() => parseBookEntries(bookLi({ ...good, title: '  ' }), 't'), /title is empty after normalization/u);
    throws(() => parseBookEntries(bookLi({ ...good, author: '&#32;' }), 't'), /author is empty after normalization/u);
  });
  it('rejects entries missing a path, title, or author', () => {
    throws(() => parseBookEntries('<li typeof="schema:Book" about="/other/x"><p>x</p></li>', 't'), /no ebook path/u);
    throws(() => parseBookEntries('<li typeof="schema:Book" about="/ebooks/a/b"><p>x</p></li>', 't'), /no title/u);
    const unnamed = bookLi(good).replace(/<span property="schema:name">An Author<\/span>/u, '');
    throws(() => parseBookEntries(unnamed, 't'), /author has no name/u);
  });
});

describe('parsePopularityPage', () => {
  const entries = [bookLi({ path: '/ebooks/a/b', title: 'T1', author: 'A1' }), bookLi({ path: '/ebooks/a/c', title: 'T2', author: 'A2' })];
  it('accepts a page with the expected selections and count', () => {
    assert.equal(parsePopularityPage(browsePage(entries), { page: 1, perPage: 2, minimumCount: 2 }).length, 2);
  });
  it('rejects sort/per-page drift (the server ignores unknown sort values)', () => {
    throws(() => parsePopularityPage(browsePage(entries, { sortSelected: false }), { page: 1, perPage: 2, minimumCount: 2 }), /popularity sort not selected/u);
    throws(() => parsePopularityPage(browsePage(entries, { perPageSelected: false }), { page: 1, perPage: 2, minimumCount: 2 }), /per-page 2 not selected/u);
  });
  it('rejects a short full page', () => {
    throws(() => parsePopularityPage(browsePage(entries.slice(0, 1)), { page: 1, perPage: 2, minimumCount: 2 }), /expected 2 books/u);
  });
  it('accepts a partial final page that reaches its requested tail count', () => {
    assert.equal(parsePopularityPage(browsePage(entries), { page: 2, perPage: 2, minimumCount: 1 }).length, 2);
    throws(() => parsePopularityPage(browsePage([]), { page: 2, perPage: 2, minimumCount: 1 }), /expected at least 1 book/u);
  });
});

describe('validateOpfDocument', () => {
  const book = { path: '/ebooks/a/b', name: 'a_b' };
  it('accepts a matching OPF', () => {
    validateOpfDocument(opfFor(book), book);
  });
  it('rejects identifier or code-repository drift', () => {
    throws(() => validateOpfDocument(opfFor({ path: '/ebooks/a/OTHER', name: 'a_b' }), book), /dc:identifier .* does not match/u);
    // An unqualified link to the right URL must NOT satisfy the check: the
    // rel="schema:codeRepository" declaration itself is what is validated.
    const noRel = opfFor(book).replace(' rel="schema:codeRepository"', '');
    throws(() => validateOpfDocument(noRel, book), /schema:codeRepository .* does not match/u);
    throws(() => validateOpfDocument('<not-a-package/>', book), /root is not an OPF package element/u);
  });
  it('requires element and attribute IDENTITY via the real XML parse', () => {
    const realLink = /<link [^>]*rel="schema:codeRepository"[^>]*>/u;
    const withLink = (replacement) => opfFor(book).replace(realLink, replacement);
    // data-rel/data-href carry the right VALUES under near-name attributes.
    throws(
      () => validateOpfDocument(withLink('<link data-rel="schema:codeRepository" data-href="https://github.com/standardebooks/a_b"/>'), book),
      /schema:codeRepository .* does not match/u,
    );
    // The correct relation pointing at the wrong repository.
    throws(
      () => validateOpfDocument(withLink('<link href="https://github.com/standardebooks/other_repo" rel="schema:codeRepository"/>'), book),
      /schema:codeRepository .* does not match/u,
    );
    // A commented-out declaration must not satisfy the check.
    throws(
      () => validateOpfDocument(opfFor(book).replace(realLink, (m) => `<!-- ${m} -->`), book),
      /schema:codeRepository .* does not match/u,
    );
    // A near-name ELEMENT with the right attributes must not satisfy it either.
    throws(
      () => validateOpfDocument(withLink('<link-other href="https://github.com/standardebooks/a_b" rel="schema:codeRepository"/>'), book),
      /schema:codeRepository .* does not match/u,
    );
    // Attribute order stays free: href-before-rel with the right values passes.
    validateOpfDocument(withLink('<link href="https://github.com/standardebooks/a_b" rel="schema:codeRepository"/>'), book);
    // A foreign-NAMESPACE link with the right local name, attributes, and
    // values must not satisfy the check (XML identity = namespace + name).
    throws(
      () => validateOpfDocument(withLink('<evil:link xmlns:evil="urn:not-opf" href="https://github.com/standardebooks/a_b" rel="schema:codeRepository"/>'), book),
      /schema:codeRepository .* does not match/u,
    );
  });
  it('resolves the identifier via unique-identifier, so a decoy cannot satisfy policy', () => {
    // First identifier carries the EXPECTED value but is not the declared
    // unique identifier; the canonical one identifies as something else.
    const decoyed = opfFor(book).replace(
      `<dc:identifier id="uid">${ORIGIN}${book.path}</dc:identifier>`,
      `<dc:identifier id="decoy">${ORIGIN}${book.path}</dc:identifier><dc:identifier id="uid">urn:wrong-unique-id</dc:identifier>`,
    );
    throws(() => validateOpfDocument(decoyed, book), /dc:identifier .* does not match/u);
  });
});

describe('fetchText', () => {
  const respond = (overrides = {}) =>
    fetchText('https://example.org/x', {
      origin: 'https://example.org',
      types: ['text/plain'],
      label: 'fixture',
      userAgent: 'test',
      fetchImpl: async () => ({
        ok: (overrides.status ?? 200) < 300,
        status: overrides.status ?? 200,
        url: overrides.url ?? 'https://example.org/x',
        headers: new Headers({ 'content-type': overrides.type ?? 'text/plain; charset=utf-8' }),
        text: async () => 'body',
      }),
    });
  it('returns the body when status, origin, and media type all match', async () => {
    assert.equal(await respond(), 'body');
  });
  it('rejects non-OK, cross-origin, and wrong-media-type 200 responses', async () => {
    await assert.rejects(() => respond({ status: 404 }), /HTTP 404/u);
    await assert.rejects(() => respond({ url: 'https://evil.example/x' }), /unexpected final origin/u);
    await assert.rejects(() => respond({ type: 'application/octet-stream' }), /unexpected content type "application\/octet-stream"/u);
  });
});

describe('canonicalContent', () => {
  it('emits only ranked books in order under schema version 2', () => {
    const popular = [
      { name: 'p1', title: 'P1', author: 'A', popularityRank: 1, path: '/ebooks/p/1' },
      { name: 's2', title: 'S2', author: 'A', popularityRank: 2, path: '/ebooks/s/2' },
    ];
    const content = canonicalContent(popular, 'pop-url');
    assert.equal(content.schemaVersion, 2);
    assert.deepEqual(content.books.map((b) => b.name), ['p1', 's2']);
    assert.deepEqual(content.books.map((b) => b.popularityRank), [1, 2]);
    assert.equal('series' in content, false);
    assert.equal(content.source.popularityUrl, 'pop-url');
  });
});
