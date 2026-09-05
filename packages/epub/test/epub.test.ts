import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseEpub } from '../src/epub.js';
import { fixtureEpub } from './fixtures.js';

function archive() { return unzipSync(fixtureEpub()); }
const cap = 10_000;

describe('manifest-directed EPUB admission', () => {
  it.each(['chapter.html', 'chapter.htm', 'chapter.XHTML', 'chapter'])('reads XHTML declared at %s', (name) => {
    const files = archive();
    files['epub/content.opf'] = strToU8(strFromU8(files['epub/content.opf']!).replace('chapter.xhtml', name));
    files[`epub/text/${name}`] = files['epub/text/chapter.xhtml']!;
    delete files['epub/text/chapter.xhtml'];
    expect(parseEpub(zipSync(files), cap).documents[1]!.source).toContain('First');
  });

  it('resolves escaped package/spine paths and ignores unreferenced text and packages', () => {
    const files = archive();
    files['META-INF/container.xml'] = strToU8(strFromU8(files['META-INF/container.xml']!).replace('epub/content.opf', 'epub/my%20package'));
    files['epub/my package'] = strToU8(strFromU8(files['epub/content.opf']!).replace('chapter.xhtml', 'my%20chapter.html'));
    delete files['epub/content.opf'];
    files['epub/text/my chapter.html'] = files['epub/text/chapter.xhtml']!;
    delete files['epub/text/chapter.xhtml'];
    files['unused.xhtml'] = new Uint8Array(cap * 10);
    files['unused.opf'] = new Uint8Array(cap * 10);
    const result = parseEpub(zipSync(files), cap);
    expect(result.documents[1]!.href).toBe('epub/text/my chapter.html');
    expect(result.documents).toHaveLength(3);
  });

  it.each(['../evil.opf', '/epub/content.opf', 'https://example.test/book.opf'])('refuses a non-contained rootfile %s', (path) => {
    const files = archive();
    files['META-INF/container.xml'] = strToU8(strFromU8(files['META-INF/container.xml']!).replace('epub/content.opf', path));
    expect(() => parseEpub(zipSync(files), cap)).toThrow(/root/);
  });

  it.each(['../../evil.xhtml', '/epub/text/chapter.xhtml'])('refuses a non-contained spine path %s', (path) => {
    const files = archive();
    files['epub/content.opf'] = strToU8(strFromU8(files['epub/content.opf']!).replace('text/chapter.xhtml', path));
    expect(() => parseEpub(zipSync(files), cap)).toThrow(/root/);
  });

  it('charges a repeated spine reference once and each duplicate ZIP entry separately', () => {
    const files = archive();
    delete files['mimetype'];
    delete files['epub/images/unused.jpg'];
    files['epub/content.opf'] = strToU8(strFromU8(files['epub/content.opf']!).replace('<itemref idref="chapter"/>', '<itemref idref="chapter"/><itemref idref="chapter"/>'));
    const exactSize = Object.values(files).reduce((total, file) => total + file.length, 0);
    expect(parseEpub(zipSync(files), exactSize).documents).toHaveLength(4);
    files['epub/text/chaptez.xhtml'] = files['epub/text/chapter.xhtml']!;
    const bytes = zipSync(files, { level: 0 });
    const from = strToU8('epub/text/chaptez.xhtml');
    const to = strToU8('epub/text/chapter.xhtml');
    for (let index = 0; index <= bytes.length - from.length; index++) {
      if (from.every((value, offset) => bytes[index + offset] === value)) bytes.set(to, index);
    }
    expect(() => parseEpub(bytes, exactSize)).toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));
  });
});
