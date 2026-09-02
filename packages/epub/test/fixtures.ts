import { strToU8, zipSync } from 'fflate';

export const packageXml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:test:book</dc:identifier>
    <dc:title id="title">Test Book</dc:title>
    <meta property="title-type" refines="#title">main</meta>
    <dc:title id="subtitle">A Tale</dc:title>
    <meta property="title-type" refines="#subtitle">subtitle</meta>
    <dc:creator>Test Author</dc:creator>
    <dc:contributor id="translator">Test Translator</dc:contributor>
    <meta property="role" refines="#translator">trl</meta>
    <dc:language>en-US</dc:language>
    <dc:subject>Fiction</dc:subject>
    <meta property="schema:wordCount">42</meta>
    <meta id="collection" property="belongs-to-collection">Test Series</meta>
    <meta property="collection-type" refines="#collection">series</meta>
    <meta property="group-position" refines="#collection">3</meta>
  </metadata>
  <manifest>
    <item href="text/titlepage.xhtml" id="titlepage" media-type="application/xhtml+xml"/>
    <item href="text/chapter.xhtml" id="chapter" media-type="application/xhtml+xml"/>
    <item href="text/endnotes.xhtml" id="endnotes" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="titlepage"/>
    <itemref idref="chapter"/>
    <itemref idref="endnotes"/>
  </spine>
</package>`;

export const titlepageXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Titlepage</title></head>
  <body epub:type="frontmatter"><section epub:type="titlepage"><h1>Test Book</h1></section></body>
</html>`;

export const chapterXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Chapter I</title></head>
  <body epub:type="bodymatter z3998:fiction">
    <section epub:type="chapter">
      <h2><span>Chapter</span> <span>I</span></h2>
      <p>First <i>emphasized</i> line.<a epub:type="noteref">1</a><br/>Second line.</p>
      <span epub:type="pagebreak">2</span>
    </section>
  </body>
</html>`;

export const endnotesXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Endnotes</title></head>
  <body epub:type="backmatter"><section epub:type="endnotes"><h2>Endnotes</h2><p>A note.</p></section></body>
</html>`;

export function fixtureEpub(reverseContentOrder = false): Uint8Array {
  const container = `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="epub/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`;
  const content: [string, Uint8Array][] = [
    ['META-INF/container.xml', strToU8(container)],
    ['epub/content.opf', strToU8(packageXml)],
    ['epub/text/titlepage.xhtml', strToU8(titlepageXhtml)],
    ['epub/text/chapter.xhtml', strToU8(chapterXhtml)],
    ['epub/text/endnotes.xhtml', strToU8(endnotesXhtml)],
    ['epub/images/unused.jpg', new Uint8Array(100_000)],
  ];
  return zipSync(Object.fromEntries([
    ['mimetype', strToU8('application/epub+zip')],
    ...(reverseContentOrder ? content.reverse() : content),
  ]));
}
