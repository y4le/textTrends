/**
 * Recipe canonicalization + deep-freeze + identity memo (Phase D / D3 ruling):
 * `validatedExtractionRecipe` synchronously snapshots the untrusted input into
 * an OWNED canonical object, deeply freezes it BEFORE the first await, proves
 * the windows-1252 table hash against the frozen snapshot, and caches ONLY
 * successfully-validated canonical objects in a module-private WeakSet.
 * These tests target the ruling's enumerated weakening risks.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultExtractionRecipes,
  epubExtractionRecipe,
  hashExtractionRecipe,
  validateExtractionRecipe,
  type ExtractionRecipeProvisional,
} from '../src/index.ts';
import { validatedExtractionRecipe, type EbookPartition } from '../src/extract/extraction.ts';
import { windows1252TableHash } from '../src/extract/decode.ts';

/** A freshly-allocated, MUTABLE, valid raw recipe (never a canonical object). */
async function rawRecipe(format: 'txt' | 'md' | 'epub' | 'html'): Promise<Record<string, unknown>> {
  const decoder = () => ({
    id: 'bom-utf8-windows1252-v1',
    bom: 'utf8-utf16le-utf16be-v1',
    unicodeErrors: 'fatal',
    fallback: 'windows-1252-whatwg-v1',
    windows1252TableHash: tableHash,
    newlineNormalization: 'none',
  });
  const tableHash = await windows1252TableHash();
  switch (format) {
    case 'txt':
      return {
        schema: 'texttrends/extraction-recipe/0-provisional',
        format: 'txt',
        decoder: decoder(),
        parser: { id: 'txt-literal-v1' },
      };
    case 'md':
      return {
        schema: 'texttrends/extraction-recipe/0-provisional',
        format: 'md',
        decoder: decoder(),
        parser: {
          id: 'markdown-literal-v1',
          textPolicy: 'preserve-source-markdown',
        },
      };
    case 'epub':
      return {
        schema: 'texttrends/extraction-recipe/0-provisional',
        format: 'epub',
        extractor: {
          id: 'standard-ebooks-epub-v1',
          partitions: ['frontmatter', 'bodymatter'],
          serializer: 'xhtml-block-collapse-v1',
        },
      };
    case 'html':
      return {
        schema: 'texttrends/extraction-recipe/0-provisional',
        format: 'html',
        extractor: {
          id: 'html5-inert-v1',
          decoder: decoder(),
          parser: 'parse5-v7',
          serializer: 'html-block-collapse-v1',
        },
      };
  }
}

/** Every reachable object/array in a graph (the canonical graphs are acyclic). */
function reachableObjects(root: unknown, out: object[] = []): object[] {
  if (root === null || typeof root !== 'object') return out;
  out.push(root);
  for (const key of Object.getOwnPropertyNames(root)) {
    reachableObjects((root as Record<string, unknown>)[key], out);
  }
  return out;
}

describe('recipe-hash stability (hard requirement: stored manifests must not move)', () => {
  it('the canonical snapshot hashes IDENTICALLY to the raw valid input via the old path, for every format', async () => {
    for (const format of ['txt', 'md', 'epub', 'html'] as const) {
      const raw = await rawRecipe(format);
      const canonical = await validatedExtractionRecipe(raw);
      expect(canonical).not.toBe(raw); // owned snapshot, not the input
      expect(await hashExtractionRecipe(canonical)).toBe(
        await hashExtractionRecipe(raw as unknown as ExtractionRecipeProvisional),
      );
    }
  });

  it('input property order cannot move the hash (canonical serialization is key-sorted)', async () => {
    const raw = await rawRecipe('txt');
    const scrambled = {
      parser: raw.parser,
      format: raw.format,
      decoder: raw.decoder,
      schema: raw.schema,
    };
    const canonical = await validatedExtractionRecipe(scrambled);
    expect(await hashExtractionRecipe(canonical)).toBe(
      await hashExtractionRecipe(raw as unknown as ExtractionRecipeProvisional),
    );
  });
});

describe('weakening risk: mutation after validation', () => {
  it('top-level assignment on the returned canonical object throws (strict-mode frozen write)', async () => {
    const canonical = await validatedExtractionRecipe(await rawRecipe('md'));
    expect(() => {
      (canonical as { format: string }).format = 'txt';
    }).toThrow(TypeError);
    expect(() => {
      (canonical as Record<string, unknown>).extra = 1;
    }).toThrow(TypeError);
    expect(() => {
      delete (canonical as Record<string, unknown>).parser;
    }).toThrow(TypeError);
  });

  it('nested decoder-policy mutation throws', async () => {
    const canonical = await validatedExtractionRecipe(await rawRecipe('md'));
    if (canonical.format !== 'md') throw new Error('expected md');
    expect(() => {
      (canonical.decoder as { windows1252TableHash: string }).windows1252TableHash = 'f'.repeat(64);
    }).toThrow(TypeError);
    const html = await validatedExtractionRecipe(await rawRecipe('html'));
    if (html.format !== 'html') throw new Error('expected html');
    expect(() => {
      (html.extractor.decoder as { unicodeErrors: string }).unicodeErrors = 'replace';
    }).toThrow(TypeError);
  });

  it('partition-array mutation throws (element write, push, length)', async () => {
    const canonical = await validatedExtractionRecipe(await rawRecipe('epub'));
    if (canonical.format !== 'epub') throw new Error('expected epub');
    const partitions = canonical.extractor.partitions as EbookPartition[];
    expect(() => {
      partitions[0] = 'unknown';
    }).toThrow(TypeError);
    expect(() => {
      partitions.push('backmatter');
    }).toThrow(TypeError);
    expect(() => {
      partitions.length = 0;
    }).toThrow(TypeError);
  });
});

describe('weakening risk: async TOCTOU (snapshot before the first await)', () => {
  it('mutating the INPUT while validation is suspended cannot reach the canonical output', async () => {
    const input = await rawRecipe('md');
    const pending = validatedExtractionRecipe(input);
    // The snapshot + freeze happen synchronously inside the call above; these
    // mutations land while the async table-hash proof is still suspended.
    input.format = 'epub';
    input.extra = 'smuggled';
    (input.decoder as Record<string, unknown>).windows1252TableHash = 'f'.repeat(64);
    delete input.parser;
    const canonical = await pending;
    expect(canonical.format).toBe('md');
    if (canonical.format !== 'md') throw new Error('expected md');
    expect(canonical.parser.id).toBe('markdown-literal-v1');
    expect(canonical.decoder.windows1252TableHash).toBe(await windows1252TableHash());
    expect('extra' in canonical).toBe(false);
    // And the canonical still hashes as the ORIGINAL valid recipe.
    expect(await hashExtractionRecipe(canonical)).toBe(
      await hashExtractionRecipe((await rawRecipe('md')) as unknown as ExtractionRecipeProvisional),
    );
  });
});

describe('weakening risk: invalid-cache poisoning', () => {
  it('an invalid recipe never enters the memo — it rejects on EVERY attempt', async () => {
    const bad = await rawRecipe('md');
    (bad.decoder as Record<string, unknown>).windows1252TableHash = 'f'.repeat(64);
    await expect(validatedExtractionRecipe(bad)).rejects.toThrow(/table hash/);
    // A second pass over the SAME object must re-reject, not hit a cache.
    await expect(validatedExtractionRecipe(bad)).rejects.toThrow(/table hash/);
  });

  it('correcting the input in place validates from scratch and returns a fresh canonical object', async () => {
    const recipe = await rawRecipe('txt');
    (recipe.decoder as Record<string, unknown>).windows1252TableHash = 'f'.repeat(64);
    await expect(validatedExtractionRecipe(recipe)).rejects.toThrow(/table hash/);
    (recipe.decoder as Record<string, unknown>).windows1252TableHash = await windows1252TableHash();
    const canonical = await validatedExtractionRecipe(recipe);
    expect(canonical).not.toBe(recipe);
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(await hashExtractionRecipe(canonical)).toBe(
      await hashExtractionRecipe((await rawRecipe('txt')) as unknown as ExtractionRecipeProvisional),
    );
  });

  it('a structurally invalid recipe (unknown field) also rejects repeatably', async () => {
    const bad = { ...(await rawRecipe('txt')), extra: true };
    await expect(validatedExtractionRecipe(bad)).rejects.toThrow(RangeError);
    await expect(validatedExtractionRecipe(bad)).rejects.toThrow(RangeError);
  });
});

describe('weakening risk: identity confusion', () => {
  it('separately-allocated deep-equal inputs validate to DIFFERENT canonical objects', async () => {
    const a = await rawRecipe('md');
    const b = await rawRecipe('md');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    const ca = await validatedExtractionRecipe(a);
    const cb = await validatedExtractionRecipe(b);
    expect(ca).not.toBe(cb); // never keyed by value/hash — object identity only
    expect(ca).toEqual(cb);
    expect(await hashExtractionRecipe(ca)).toBe(await hashExtractionRecipe(cb));
  });

  it('revalidating a RETURNED canonical object is an identity hit returning the same object', async () => {
    const canonical = await validatedExtractionRecipe(await rawRecipe('html'));
    expect(await validatedExtractionRecipe(canonical)).toBe(canonical);
    // The assertion wrapper routes through the same memo.
    expect(await validateExtractionRecipe(canonical)).toBe(canonical);
  });

  it('a deep-equal COPY of a canonical object is NOT an identity hit — it mints its own canonical', async () => {
    const canonical = await validatedExtractionRecipe(await rawRecipe('epub'));
    if (canonical.format !== 'epub') throw new Error('expected epub');
    const copy = {
      ...canonical,
      extractor: { ...canonical.extractor, partitions: [...canonical.extractor.partitions] },
    };
    const revalidated = await validatedExtractionRecipe(copy);
    expect(revalidated).not.toBe(copy);
    expect(revalidated).not.toBe(canonical);
    expect(revalidated).toEqual(canonical);
  });
});

describe('weakening risk: partial freezing', () => {
  it('EVERY reachable object/array of a validated canonical graph is frozen (all formats)', async () => {
    for (const format of ['txt', 'md', 'epub', 'html'] as const) {
      const canonical = await validatedExtractionRecipe(await rawRecipe(format));
      const objects = reachableObjects(canonical);
      expect(objects.length).toBeGreaterThan(1); // the walk really descends
      for (const o of objects) {
        expect(Object.isFrozen(o), `unfrozen node in the ${format} canonical graph`).toBe(true);
      }
    }
  });
});

describe('weakening risk: constructor drift', () => {
  it('defaultExtractionRecipes returns deeply-frozen canonical recipes that revalidate by identity', async () => {
    const recipes = await defaultExtractionRecipes();
    expect(Object.isFrozen(recipes)).toBe(true);
    for (const format of ['txt', 'md', 'epub', 'html'] as const) {
      const recipe = recipes[format];
      for (const o of reachableObjects(recipe)) expect(Object.isFrozen(o)).toBe(true);
      // Minted via the canonicalizer → already in the validated set.
      expect(await validatedExtractionRecipe(recipe)).toBe(recipe);
    }
  });

  it('epubExtractionRecipe returns a deeply-frozen canonical recipe that revalidates by identity', async () => {
    const recipe = epubExtractionRecipe(['bodymatter', 'frontmatter']);
    for (const o of reachableObjects(recipe)) expect(Object.isFrozen(o)).toBe(true);
    expect(await validatedExtractionRecipe(recipe)).toBe(recipe);
    if (recipe.format !== 'epub') throw new Error('expected epub');
    // Canonical partition order survives the minting path.
    expect(recipe.extractor.partitions).toEqual(['frontmatter', 'bodymatter']);
  });

  it('the default epub recipe and an equivalent constructor call share one hash', async () => {
    const recipes = await defaultExtractionRecipes();
    expect(await hashExtractionRecipe(recipes.epub)).toBe(
      await hashExtractionRecipe(epubExtractionRecipe(['bodymatter'])),
    );
  });
});

describe('assertion API compatibility (validateExtractionRecipe wrapper)', () => {
  it('returns the canonical frozen snapshot for a raw valid input', async () => {
    const raw = await rawRecipe('txt');
    const returned = await validateExtractionRecipe(raw);
    expect(returned).not.toBe(raw);
    expect(Object.isFrozen(returned)).toBe(true);
    expect(await hashExtractionRecipe(returned)).toBe(
      await hashExtractionRecipe(raw as unknown as ExtractionRecipeProvisional),
    );
  });

  it('still rejects with RangeError, never TypeError, at the wire (spot checks)', async () => {
    await expect(validateExtractionRecipe(null)).rejects.toThrow(RangeError);
    await expect(validateExtractionRecipe('recipe')).rejects.toThrow(RangeError);
    await expect(validateExtractionRecipe({ ...(await rawRecipe('txt')), schema: 'x' })).rejects.toThrow(/schema/);
    const withSmuggledArrayProp = await rawRecipe('epub');
    const partitions = (withSmuggledArrayProp.extractor as { partitions: EbookPartition[] }).partitions;
    (partitions as unknown as Record<string, unknown>).named = 'x';
    await expect(validateExtractionRecipe(withSmuggledArrayProp)).rejects.toThrow(RangeError);
  });
});

describe('weakening risk: symbol-keyed array slots (review-d3-recipes finding)', () => {
  it('a symbol-keyed property on the epub partitions array REJECTS, never normalizes away', async () => {
    const raw = await rawRecipe('epub');
    const extractor = raw['extractor'] as Record<string, unknown>;
    const partitions = [...(extractor['partitions'] as unknown[])];
    (partitions as unknown as Record<symbol, unknown>)[Symbol('hidden')] = 'x';
    extractor['partitions'] = partitions;
    await expect(validatedExtractionRecipe(raw)).rejects.toThrow(/symbol-keyed properties/);
  });
});
