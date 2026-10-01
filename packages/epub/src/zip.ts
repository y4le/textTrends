import { Inflate } from 'fflate';
import { EpubError } from './errors.js';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function updateCrc(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return crc;
}

interface Entry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressed: number;
  readonly size: number;
  readonly local: number;
  readonly zip64: boolean;
}

function hasZip64(view: DataView, start: number, length: number): boolean {
  const end = start + length;
  let found = false;
  for (let pos = start; pos < end;) {
    if (pos + 4 > end) invalid('Truncated ZIP extra field');
    found ||= view.getUint16(pos, true) === 1;
    pos += 4 + view.getUint16(pos + 2, true);
    if (pos > end) invalid('Truncated ZIP extra field payload');
  }
  return found;
}

function invalid(message: string): never { throw new EpubError('INVALID_EPUB', message); }

/** ZIP32 central-directory reader. Only requested members are decompressed;
 * actual output is checked after every bounded compressed-input chunk. */
export class BoundedZip {
  private readonly view: DataView;
  private readonly entries = new Map<string, Entry | null>();
  private readonly directoryStart: number;
  private total = 0;

  constructor(private readonly bytes: Uint8Array, private readonly budget: number) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let footer = -1;
    for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65_557); pos--) {
      if (this.view.getUint32(pos, true) === 0x06054b50
        && pos + 22 + this.view.getUint16(pos + 20, true) === bytes.length) { footer = pos; break; }
    }
    if (footer < 0) invalid('EPUB ZIP directory is missing');
    const count = this.view.getUint16(footer + 10, true);
    this.directoryStart = this.view.getUint32(footer + 16, true);
    const size = this.view.getUint32(footer + 12, true);
    if (this.view.getUint32(footer + 4, true) !== 0 || this.view.getUint16(footer + 8, true) !== count
      || count === 0xffff || size === 0xffffffff || this.directoryStart === 0xffffffff
      || this.directoryStart + size !== footer) invalid('EPUB requires a complete single-disk ZIP32 directory');
    const decode = (from: number, length: number): string | null => {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(from, from + length)); }
      catch { return null; } // Non-UTF-8 auxiliary members cannot match OPF paths.
    };
    let pos = this.directoryStart;
    for (let i = 0; i < count; i++) {
      if (pos + 46 > footer || this.view.getUint32(pos, true) !== 0x02014b50) invalid('EPUB ZIP directory is truncated');
      const nameLength = this.view.getUint16(pos + 28, true);
      const extraLength = this.view.getUint16(pos + 30, true);
      const commentLength = this.view.getUint16(pos + 32, true);
      const end = pos + 46 + nameLength + extraLength + commentLength;
      if (end > footer || this.view.getUint16(pos + 34, true) !== 0) invalid('EPUB ZIP directory entry is invalid');
      const name = decode(pos + 46, nameLength);
      if (name === null) { pos = end; continue; }
      const entry = { name, flags: this.view.getUint16(pos + 8, true), method: this.view.getUint16(pos + 10, true),
        crc: this.view.getUint32(pos + 16, true), compressed: this.view.getUint32(pos + 20, true),
        size: this.view.getUint32(pos + 24, true), zip64: hasZip64(this.view, pos + 46 + nameLength, extraLength), local: this.view.getUint32(pos + 42, true) };
      this.entries.set(name, this.entries.has(name) ? null : entry);
      pos = end;
    }
    if (pos !== footer) invalid('EPUB ZIP directory has unexpected data');
  }

  read(name: string, maxMemberBytes = this.budget): Uint8Array {
    const entry = this.entries.get(name);
    if (entry === undefined) invalid(`EPUB is missing archive member: ${name}`);
    if (entry === null) invalid(`EPUB has duplicate archive members: ${name}`);
    const { local, flags, method, size, compressed, crc } = entry;
    if ((flags & ~0x080e) !== 0 || (method !== 0 && method !== 8)
      || entry.zip64 || [size, compressed, local].includes(0xffffffff)) invalid(`Unsupported EPUB ZIP member: ${name}`);
    if (local + 30 > this.directoryStart || this.view.getUint32(local, true) !== 0x04034b50) invalid(`Invalid ZIP header: ${name}`);
    const nameLength = this.view.getUint16(local + 26, true);
    const extraLength = this.view.getUint16(local + 28, true);
    const start = local + 30 + nameLength + extraLength;
    const end = start + compressed;
    if (end > this.directoryStart || this.view.getUint16(local + 6, true) !== flags
      || this.view.getUint16(local + 8, true) !== method) invalid(`ZIP header disagrees with directory: ${name}`);
    const localName = new TextDecoder().decode(this.bytes.subarray(local + 30, local + 30 + nameLength));
    if (hasZip64(this.view, local + 30 + nameLength, extraLength)) invalid(`ZIP64 member is unsupported: ${name}`);
    if (localName !== name) invalid(`ZIP name disagrees with directory: ${name}`);
    if ((flags & 8) === 0 && (this.view.getUint32(local + 14, true) !== crc
      || this.view.getUint32(local + 18, true) !== compressed || this.view.getUint32(local + 22, true) !== size)) invalid(`ZIP sizes disagree: ${name}`);
    if (method === 0 && size !== compressed) invalid(`Stored ZIP member has inconsistent sizes: ${name}`);
    if (size > Math.min(maxMemberBytes, this.budget - this.total)) throw new EpubError('CAP_EXCEEDED', `EPUB exceeds the ${this.budget}-byte extraction limit`);
    const out = new Uint8Array(size);
    let checksum = 0xffffffff;
    let length = 0;
    const accept = (chunk: Uint8Array): void => {
      if (length + chunk.length > size) invalid(`ZIP member exceeds its declared size: ${name}`);
      if (this.total + length + chunk.length > this.budget) throw new EpubError('CAP_EXCEEDED', 'EPUB decompressed output exceeds its limit');
      out.set(chunk, length);
      length += chunk.length;
      checksum = updateCrc(checksum, chunk);
    };
    try {
      if (method === 0) accept(this.bytes.subarray(start, end));
      else {
        const inflate = new Inflate(accept);
        // One push expands by at most DEFLATE's ratio (~1032x): a 4 KiB
        // input bounds transient overshoot near 4 MiB before the callback.
        for (let pos = start; pos < end; pos += 4096) inflate.push(this.bytes.subarray(pos, Math.min(pos + 4096, end)), pos + 4096 >= end);
        if (compressed === 0) inflate.push(new Uint8Array(), true);
      }
    } catch (cause) {
      if (cause instanceof EpubError) throw cause;
      throw new EpubError('INVALID_EPUB', `Could not decompress ZIP member: ${name}`, { cause });
    }
    if (length !== size || ((checksum ^ 0xffffffff) >>> 0) !== crc) invalid(`ZIP member size or checksum is damaged: ${name}`);
    this.total += length;
    return out;
  }
}
