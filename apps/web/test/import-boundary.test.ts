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

/**
 * ONE module-specifier scanner used by EVERY assertion below (a per-rule
 * regex drifts: the round-2 review proved a dynamic import from shared/
 * slipped the leaf rule). Covers the four syntax forms:
 *   import x from '…'; export … from '…'; import '…'; import('…').
 */
function moduleSpecifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /import\s[^'"()]*?from\s*['"]([^'"]+)['"]/g, // import x from '…' (incl. type/multiline)
    /export\s[^'"()]*?from\s*['"]([^'"]+)['"]/g, // export … from '…'
    /import\s*['"]([^'"]+)['"]/g,                // side-effect import '…'
    /import\(\s*['"]([^'"]+)['"]/g,              // dynamic import('…')
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

const references = (source: string, fragment: string): boolean =>
  moduleSpecifiers(source).some((spec) => spec.includes(fragment));

describe('the specifier scanner itself', () => {
  // Table-driven self-test: the guard is only as good as its scanner — every
  // syntax form the boundary rules claim to cover must actually be extracted.
  const CASES: readonly [string, string][] = [
    ["import { a } from '../worker/x.ts';", '../worker/x.ts'],
    ["import type {\n  A,\n  B,\n} from '../worker/y.ts';", '../worker/y.ts'],
    ["export { z } from '../worker/z.ts';", '../worker/z.ts'],
    ["export type { T } from '../worker/t.ts';", '../worker/t.ts'],
    ["import '../worker/side-effect.ts';", '../worker/side-effect.ts'],
    ["const f = () => import('../worker/dynamic.ts');", '../worker/dynamic.ts'],
    ["await import(\n  '../worker/dyn2.ts'\n);", '../worker/dyn2.ts'],
  ];
  it('extracts every import/export syntax form', () => {
    for (const [source, expected] of CASES) {
      expect(moduleSpecifiers(source), source).toContain(expected);
    }
  });
});

describe('protocol import boundary', () => {
  it('only worker/ and the transport seam (lib/client.ts) may import worker/protocol-*', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      const allowed = rel.startsWith('worker/') || rel === 'lib/client.ts';
      if (allowed) continue;
      if (references(readFileSync(file, 'utf8'), 'worker/protocol-')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('lib/ (beyond the transport seam) imports no worker/ module at all', () => {
    // Today this edge is clean; lock it so a convenience import of the engine
    // or a store adapter cannot creep into the main-thread model layer.
    // (The e2e helpers OUTSIDE src/ deliberately import the DB-name constants
    // — sanctioned anti-drift, and outside this walk by construction.)
    const offenders: string[] = [];
    for (const file of walk(join(SRC, 'lib'))) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (rel === 'lib/client.ts') continue; // the one sanctioned seam
      if (references(readFileSync(file, 'utf8'), '/worker/')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('components never import worker/ modules at all', () => {
    const offenders: string[] = [];
    for (const file of walk(join(SRC, 'components'))) {
      if (references(readFileSync(file, 'utf8'), '/worker/')) {
        offenders.push(relative(SRC, file).split(sep).join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('shared/ is a leaf: it imports only from @texttrends/core', () => {
    const offenders: string[] = [];
    for (const file of walk(join(SRC, 'shared'))) {
      for (const spec of moduleSpecifiers(readFileSync(file, 'utf8'))) {
        if (spec !== '@texttrends/core') offenders.push(`${relative(SRC, file).split(sep).join('/')} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('worker/ never imports lib/ or components/ (the reverse edge)', () => {
    const offenders: string[] = [];
    for (const file of walk(join(SRC, 'worker'))) {
      const source = readFileSync(file, 'utf8');
      if (references(source, '/lib/') || references(source, '/components/')) {
        offenders.push(relative(SRC, file).split(sep).join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
