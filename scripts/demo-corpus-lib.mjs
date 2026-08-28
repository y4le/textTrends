import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT_PATH = join(ROOT, 'apps/web/src/lib/project.ts');

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function tsString(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function manifestEntry(document) {
  const bytes = new TextEncoder().encode(document.text);
  const hash = sha256(bytes);
  return `  { doc: ${tsString(document.doc)}, title: ${tsString(document.title)}, bytes: ${bytes.byteLength}, textLengthUtf16: ${document.text.length}, sourceHash: '${hash}', textHash: '${hash}' },`;
}

export function replaceManifest(project, manifestName, documents) {
  const declaration = `export const ${manifestName}: readonly BuiltinDocFixture[] = [`;
  const pattern = new RegExp(
    `export const ${manifestName}: readonly [^\\n]+\\[\\] = \\[\\n[\\s\\S]*?\\];`,
    'gu',
  );
  const matches = project.match(pattern) ?? [];
  assert(matches.length === 1, `Expected exactly one ${manifestName} manifest block, found ${matches.length}`);
  const replacement = `${declaration}\n${documents.map(manifestEntry).join('\n')}\n];`;
  return project.replace(pattern, () => replacement);
}

export function validateDocuments(documents) {
  assert(documents.length > 0, 'corpus must contain at least one document');
  const ids = new Set();
  for (const document of documents) {
    assert(document.doc.trim() === document.doc && document.doc !== '', 'document id must be non-empty and trimmed');
    assert(!document.doc.includes('/') && !document.doc.includes('\\'), `${document.doc}: document id contains a path separator`);
    assert(!/[;:@&=+$#?]/u.test(document.doc), `${document.doc}: document id contains a URL-reserved character`);
    assert(!ids.has(document.doc), `${document.doc}: duplicate document id`);
    ids.add(document.doc);
    assert(document.title.trim() !== '', `${document.doc}: title is empty`);
    assert(document.text.trim() !== '', `${document.doc}: text is empty`);
    assert(document.text.endsWith('\n'), `${document.doc}: text must end in one LF`);
    assert(!document.text.includes('\r'), `${document.doc}: text contains non-LF line endings`);
    assert(!document.text.includes('\uFFFD'), `${document.doc}: text contains replacement characters`);
    assert(!/[ \t]+$/mu.test(document.text), `${document.doc}: text contains trailing horizontal whitespace`);
  }
}

/** Replace a corpus directory and its static integrity manifest as one staged pair. */
export async function commitCorpus(
  { directory, manifestName, documents },
  { root = ROOT, projectPath = join(root, 'apps/web/src/lib/project.ts'), renameFile = rename } = {},
) {
  validateDocuments(documents);
  const corpusDir = join(root, 'text', directory);
  const stagingRoot = await mkdtemp(join(root, 'text', `.${directory}-update-`));
  const stagedCorpus = join(stagingRoot, 'corpus');
  const previousCorpus = join(stagingRoot, 'previous');
  const stagedProject = join(stagingRoot, 'project.ts');
  let movedPrevious = false;
  let movedCorpus = false;

  try {
    await mkdir(stagedCorpus);
    for (const document of documents) {
      await writeFile(join(stagedCorpus, `${document.doc}.txt`), document.text, 'utf8');
    }
    const project = await readFile(projectPath, 'utf8');
    await writeFile(stagedProject, replaceManifest(project, manifestName, documents), 'utf8');

    try {
      await renameFile(corpusDir, previousCorpus);
      movedPrevious = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await renameFile(stagedCorpus, corpusDir);
      movedCorpus = true;
      await renameFile(stagedProject, projectPath);
    } catch (error) {
      if (movedCorpus) await renameFile(corpusDir, stagedCorpus);
      if (movedPrevious) await renameFile(previousCorpus, corpusDir);
      movedCorpus = false;
      movedPrevious = false;
      throw error;
    }
    console.log(`refreshed ${directory}: ${documents.length} documents`);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

/** Pin an already checked-in corpus into the generated fixture manifest. */
export async function refreshExistingCorpusManifest({ directory, manifestName, documents }) {
  const hydrated = await Promise.all(documents.map(async (document) => ({
    ...document,
    text: await readFile(join(ROOT, 'text', directory, `${document.doc}.txt`), 'utf8'),
  })));
  validateDocuments(hydrated);
  const project = await readFile(PROJECT_PATH, 'utf8');
  await writeFile(PROJECT_PATH, replaceManifest(project, manifestName, hydrated), 'utf8');
  console.log(`refreshed ${directory} manifest: ${hydrated.length} documents`);
}

export async function fetchBytes(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'textTrends corpus updater (https://github.com/yalethom/textTrends)' },
    redirect: 'follow',
  });
  assert(response.ok, `${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.byteLength > 0, `${url}: empty response`);
  return bytes;
}

export async function fetchText(url) {
  return new TextDecoder('utf-8', { fatal: true }).decode(await fetchBytes(url));
}

export function normalizeLf(text) {
  return text.replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export function stripGutenbergEnvelope(text) {
  const normalized = normalizeLf(text);
  const start = /^\*{3} START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*{3}\s*$/imu.exec(normalized);
  const end = /^\*{3} END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*{3}\s*$/imu.exec(normalized);
  assert(start !== null, 'Project Gutenberg start marker is missing');
  assert(end !== null && end.index > start.index, 'Project Gutenberg end marker is missing');
  return normalized.slice(start.index + start[0].length, end.index).trim();
}
