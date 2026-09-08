import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// These slices retain the original cascade, including later cross-feature overrides.
// A component must not change their order by importing its own stylesheet.
const STYLE_ORDER = [
  'tokens.css',
  'reader.css',
  'query-scope.css',
  'inputs.css',
  'analysis-views.css',
  'dock-settings.css',
  'terms.css',
  'trends.css',
  'footer.css',
  'footer-passage.css',
  'compact-navigation.css',
  'recovery.css',
];
const SRC = join(__dirname, '..', 'src');

it('loads every stylesheet eagerly from main in the declared cascade order', () => {
  const owners: { file: string; styles: string[] }[] = [];
  for (const file of readdirSync(SRC, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(file)) continue;
    const parsed = ts.createSourceFile(file, readFileSync(join(SRC, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const styles = parsed.statements.flatMap((node) =>
      ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && node.moduleSpecifier.text.endsWith('.css') ? [node.moduleSpecifier.text] : []);
    if (styles.length > 0) owners.push({ file, styles });
  }
  expect(owners).toEqual([{ file: 'main.tsx', styles: STYLE_ORDER.map((file) => `./style/${file}`) }]);
  expect(readdirSync(join(SRC, 'style')).filter((file) => file.endsWith('.css')).sort())
    .toEqual([...STYLE_ORDER].sort());
});
