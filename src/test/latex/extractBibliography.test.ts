// Node.js built-in imports
import * as assert from 'assert';
import * as path from 'path';

// Local imports - latex helpers
import { WorkspaceFS } from '@utils/files';
import {
  extractBibliographyContext,
  loadBibliographyEntries,
  summarizeBibliographyEntries,
} from '@latex/extractBibliography';

// Local imports - utils

describe('extractBibliography helpers', () => {
  const originalRead = WorkspaceFS.read;
  const originalExists = WorkspaceFS.exists;

  afterEach(() => {
    (WorkspaceFS as unknown as { read: typeof originalRead }).read =
      originalRead;
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      originalExists;
  });

  it('collects bibliography paths and citation keys', async () => {
    const texPath = path.join('chapters', 'main.tex');
    const expectedBibPath = path.join('chapters', 'references.bib');

    (WorkspaceFS as unknown as { read: typeof originalRead }).read =
      async () => `
      % comment
      \documentclass{article}
      \addbibresource[location=local]{references}
      Some text \cite{alpha , beta}
      More citations \nocite{gamma}
      % \cite{ignored}
    `;
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async (file: string) => file === expectedBibPath;

    const result = await extractBibliographyContext(texPath);

    assert.deepStrictEqual(result.bibliographyFiles, [expectedBibPath]);
    assert.deepStrictEqual(result.missingBibliographyFiles, []);
    assert.deepStrictEqual(
      new Set(result.citationKeys),
      new Set(['alpha', 'beta', 'gamma']),
    );
  });

  it('handles wildcard nocite directives consistently across runs', async () => {
    const texPath = 'paper.tex';
    const expectedBibPath = 'refs.bib';
    const texContent = `
      % bibliographies
      \\bibliography{refs}
      Intro text
      \\nocite{*}
    `;

    (WorkspaceFS as unknown as { read: typeof originalRead }).read = async () =>
      texContent;
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async () => true;

    const first = await extractBibliographyContext(texPath);
    const second = await extractBibliographyContext(texPath);

    const expectedKeys = new Set(['*']);

    assert.deepStrictEqual(first.bibliographyFiles, [expectedBibPath]);
    assert.deepStrictEqual(second.bibliographyFiles, [expectedBibPath]);
    assert.deepStrictEqual(new Set(first.citationKeys), expectedKeys);
    assert.deepStrictEqual(new Set(second.citationKeys), expectedKeys);
    assert.deepStrictEqual(second, first);
  });

  it('marks missing bibliography files and ignores empty citations', async () => {
    const texPath = 'paper.tex';

    (WorkspaceFS as unknown as { read: typeof originalRead }).read =
      async () => `
      \bibliography{bib/one, bib/two.bib, } % trailing comma
      \cite{first} \cite{second, third}
    `;
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async (file: string) => file === path.join('bib', 'two.bib');

    const result = await extractBibliographyContext(texPath);

    assert.deepStrictEqual(result.bibliographyFiles, [
      path.join('bib', 'two.bib'),
    ]);
    assert.deepStrictEqual(result.missingBibliographyFiles, [
      path.join('bib', 'one.bib'),
    ]);
    assert.deepStrictEqual(
      new Set(result.citationKeys),
      new Set(['first', 'second', 'third']),
    );
  });

  it('loads requested bibliography entries and reports missing keys', async () => {
    const expectedContent = `@article{alpha,
  title = {Alpha Paper},
}

@book{beta,
  title = {Beta Book},
}`;

    (WorkspaceFS as unknown as { read: typeof originalRead }).read = async () =>
      expectedContent;

    const { entries, missingKeys } = await loadBibliographyEntries(
      ['references.bib'],
      ['alpha', 'gamma'],
    );

    assert.strictEqual(entries.size, 1);
    assert.strictEqual(
      entries.get('alpha'),
      '@article{alpha,\n  title = {Alpha Paper},\n}',
    );
    assert.deepStrictEqual(missingKeys, ['gamma']);

    const formatted = summarizeBibliographyEntries(entries, 5);
    assert.deepStrictEqual(formatted, [
      '@article{alpha,\n  title = {Alpha Paper},\n}',
    ]);
  });

  it('loads all entries when nocite wildcard is present', async () => {
    const expectedContent = `@article{alpha,
  title = {Alpha Paper},
}

@book{beta,
  title = {Beta Book},
}`;

    (WorkspaceFS as unknown as { read: typeof originalRead }).read = async () =>
      expectedContent;

    const { entries, missingKeys } = await loadBibliographyEntries(
      ['references.bib'],
      ['*'],
    );

    assert.strictEqual(entries.size, 2);
    assert.deepStrictEqual(missingKeys, []);
    assert.ok(entries.has('alpha'));
    assert.ok(entries.has('beta'));
  });
});
