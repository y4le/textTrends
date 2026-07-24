/**
 * The protocol import boundary: the versioned wire module is an implementation
 * detail of the worker + its one transport seam (WorkerClient). Everything
 * else consumes the neutral domain contracts (shared/) or core. This test
 * makes the boundary grep-auditable and regression-proof — a new import of
 * `worker/protocol-*` outside the allowed set fails here, not in review.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('protocol import boundary', () => {
  it('only worker/ and the transport seam (lib/client.ts) may import worker/protocol-*', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      const allowed = rel.startsWith('worker/') || rel === 'lib/client.ts';
      if (allowed) continue;
      const source = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*worker\/protocol-/.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('components never import worker/ modules at all', () => {
    const offenders: string[] = [];
    for (const file of walk(join(SRC, 'components'))) {
      const source = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*\/worker\//.test(source)) {
        offenders.push(relative(SRC, file).split(sep).join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
