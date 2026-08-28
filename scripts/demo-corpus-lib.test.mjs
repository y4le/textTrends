import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  commitCorpus,
  replaceManifest,
  validateDocuments,
} from './demo-corpus-lib.mjs';

const document = (doc = '001 - Example', title = 'Example') => ({ doc, title, text: 'Example text.\n' });

test('replaceManifest treats upstream dollar sequences as literal text', () => {
  const project = 'export const SAMPLE: readonly BuiltinDocFixture[] = [\n];\n';
  const replaced = replaceManifest(project, 'SAMPLE', [document('001 - $& cash', '$& cash')]);

  assert.match(replaced, /doc: '001 - \$& cash'/u);
  assert.match(replaced, /title: '\$& cash'/u);
  assert.equal(replaced.match(/export const SAMPLE/gu)?.length, 1);
});

test('validateDocuments permits literal commas but rejects URL-reserved ids', () => {
  assert.doesNotThrow(() => validateDocuments([document('001 - Hamilton, Madison, and Jay')]));
  assert.throws(
    () => validateDocuments([document('001 - Bad;Path')]),
    /URL-reserved character/u,
  );
});

test('commitCorpus rolls the corpus back when the paired manifest rename fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'texttrends-demo-corpus-'));
  const corpus = join(root, 'text/sample');
  const projectPath = join(root, 'project.ts');
  const originalProject = [
    'export const SAMPLE: readonly BuiltinDocFixture[] = [',
    "  { doc: 'old', title: 'Old', bytes: 4, textLengthUtf16: 4, sourceHash: 'old', textHash: 'old' },",
    '];',
    '',
  ].join('\n');
  await mkdir(corpus, { recursive: true });
  await writeFile(join(corpus, 'old.txt'), 'old\n', 'utf8');
  await writeFile(projectPath, originalProject, 'utf8');

  let refusedManifest = false;
  const renameFile = async (source, destination) => {
    if (!refusedManifest && source.endsWith('/project.ts') && destination === projectPath) {
      refusedManifest = true;
      throw new Error('synthetic manifest rename failure');
    }
    await rename(source, destination);
  };

  try {
    await assert.rejects(
      commitCorpus(
        { directory: 'sample', manifestName: 'SAMPLE', documents: [document()] },
        { root, projectPath, renameFile },
      ),
      /synthetic manifest rename failure/u,
    );
    assert.equal(await readFile(join(corpus, 'old.txt'), 'utf8'), 'old\n');
    await assert.rejects(access(join(corpus, '001 - Example.txt')));
    assert.equal(await readFile(projectPath, 'utf8'), originalProject);
    assert.deepEqual((await readdir(join(root, 'text'))).filter((name) => name.startsWith('.')), []);

    await commitCorpus(
      { directory: 'sample', manifestName: 'SAMPLE', documents: [document()] },
      { root, projectPath },
    );
    assert.equal(await readFile(join(corpus, '001 - Example.txt'), 'utf8'), 'Example text.\n');
    await assert.rejects(access(join(corpus, 'old.txt')));
    assert.match(await readFile(projectPath, 'utf8'), /doc: '001 - Example'/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
