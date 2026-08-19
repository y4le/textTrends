import { strToU8, zipSync } from 'fflate';

export const packageXml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">https://standardebooks.org/ebooks/test-author/test-book</dc:identifier>
    <dc:date>2025-01-02T00:00:00Z</dc:date>
    <meta property="dcterms:modified">2025-02-03T00:00:00Z</meta>
    <dc:title id="title">Test Book</dc:title>
    <meta property="title-type" refines="#title">main</meta>
    <dc:title id="subtitle">A Tale</dc:title>
    <meta property="title-type" refines="#subtitle">subtitle</meta>
    <dc:title id="fulltitle">Test Book: A Tale</dc:title>
    <meta property="title-type" refines="#fulltitle">expanded</meta>
    <dc:creator id="author">Test Author</dc:creator>
    <dc:contributor id="translator">Test Translator</dc:contributor>
    <meta property="role" refines="#translator">trl</meta>
    <dc:language>en-US</dc:language>
    <dc:subject>Fiction</dc:subject>
    <dc:description>A useful test book.</dc:description>
    <dc:rights>Public domain test fixture.</dc:rights>
    <meta property="schema:wordCount">42</meta>
    <meta id="collection-1" property="belongs-to-collection">Test Series</meta>
    <meta property="collection-type" refines="#collection-1">series</meta>
    <meta property="group-position" refines="#collection-1">3</meta>
    <meta id="collection-2" property="belongs-to-collection">Test Set</meta>
    <meta property="collection-type" refines="#collection-2">set</meta>
    <meta id="collection-3" property="belongs-to-collection">Bare Collection</meta>
    <link href="https://github.com/standardebooks/test-author_test-book_test-translator" rel="schema:codeRepository"/>
  </metadata>
  <manifest>
    <item href="text/titlepage.xhtml" id="titlepage.xhtml" media-type="application/xhtml+xml"/>
    <item href="text/chapter-1.xhtml" id="chapter-1.xhtml" media-type="application/xhtml+xml"/>
    <item href="text/endnotes.xhtml" id="endnotes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="titlepage.xhtml"/>
    <itemref idref="chapter-1.xhtml"/>
    <itemref idref="endnotes.xhtml"/>
  </spine>
</package>`;

export const titlepageXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Titlepage</title></head>
  <body epub:type="frontmatter">
    <section id="titlepage" epub:type="titlepage">
      <h1>Test Book</h1><p>By <b>Test Author</b>.</p>
    </section>
  </body>
</html>`;

export const chapterXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Chapter I</title></head>
  <body epub:type="bodymatter z3998:fiction">
    <section id="chapter-1" epub:type="chapter">
      <h2><span>Chapter</span> <span>I</span></h2>
      <p>First <i>emphasized</i> line.<a epub:type="noteref" href="endnotes.xhtml#note-1">1</a><br/>Second line.</p>
      <span epub:type="pagebreak" title="2">2</span>
    </section>
  </body>
</html>`;

export const endnotesXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Endnotes</title></head>
  <body epub:type="backmatter">
    <section id="endnotes" epub:type="endnotes"><h2>Endnotes</h2><p>A note.<a epub:type="backlink">↩</a></p></section>
  </body>
</html>`;

export function fixtureEpub(): Uint8Array {
  const container = `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="epub/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`;
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'epub/content.opf': strToU8(packageXml),
    'epub/text/titlepage.xhtml': strToU8(titlepageXhtml),
    'epub/text/chapter-1.xhtml': strToU8(chapterXhtml),
    'epub/text/endnotes.xhtml': strToU8(endnotesXhtml),
    'epub/images/large-unused.jpg': new Uint8Array(100_000),
  });
}

export function githubRepository(
  name: string,
  description: string,
): Record<string, unknown> {
  return {
    name,
    full_name: `standardebooks/${name}`,
    default_branch: 'master',
    html_url: `https://github.com/standardebooks/${name}`,
    description,
    fork: false,
    archived: false,
    pushed_at: '2025-02-01T00:00:00Z',
    updated_at: '2025-02-02T00:00:00Z',
  };
}
