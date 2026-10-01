import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BoundedZip } from '../src/zip.js';

function fixture(text = 'visible prose', level: 0 | 6 = 6) {
  const bytes = zipSync({ x: strToU8(text) }, { level });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const central = view.getUint32(bytes.length - 6, true);
  return { bytes, view, central };
}
const invalid = expect.objectContaining({ code: 'INVALID_EPUB' });

describe('bounded ZIP member inflation', () => {
  it.each([0, 6] as const)('reads stored/deflated content with verified length and CRC (%s)', (level) => {
    const { bytes } = fixture('visible prose', level);
    expect(new BoundedZip(bytes, 13).read('x')).toEqual(strToU8('visible prose'));
    expect(() => new BoundedZip(bytes, 12).read('x')).toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));
  });
  it.each([1, 2_000_000])('rejects under/over-declared sizes without truncation (%s)', (size) => {
    const { bytes, view, central } = fixture('a'.repeat(1_000_000));
    view.setUint32(22, size, true);
    view.setUint32(central + 24, size, true);
    expect(() => new BoundedZip(bytes, 3_000_000).read('x')).toThrowError(invalid);
  });
  it('rejects a checksum mismatch', () => {
    const { bytes, view, central } = fixture();
    view.setUint32(14, 1, true);
    view.setUint32(central + 16, 1, true);
    expect(() => new BoundedZip(bytes, 100).read('x')).toThrowError(invalid);
  });
  it.each(['encrypted', 'zip64', 'unsupported-method', 'truncated-data'])('rejects unsupported or incomplete member: %s', (kind) => {
    const { bytes, view, central } = fixture();
    if (kind === 'encrypted') { view.setUint16(6, 1, true); view.setUint16(central + 8, 1, true); }
    if (kind === 'zip64') view.setUint32(central + 24, 0xffffffff, true);
    if (kind === 'unsupported-method') { view.setUint16(8, 9, true); view.setUint16(central + 10, 9, true); }
    if (kind === 'truncated-data') { view.setUint32(18, 100_000, true); view.setUint32(central + 20, 100_000, true); }
    expect(() => new BoundedZip(bytes, 100).read('x')).toThrowError(invalid);
  });
  it('rejects duplicate requested names', () => {
    const bytes = zipSync({ x: strToU8('first'), y: strToU8('second') });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let central = view.getUint32(bytes.length - 6, true);
    central += 46 + view.getUint16(central + 28, true) + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
    const local = view.getUint32(central + 42, true);
    bytes[central + 46] = 120; bytes[local + 30] = 120;
    expect(() => new BoundedZip(bytes, 100).read('x')).toThrowError(invalid);
  });
});
