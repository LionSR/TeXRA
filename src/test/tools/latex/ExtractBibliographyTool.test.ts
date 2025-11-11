import * as assert from 'assert';

// Local imports - latex helpers
import * as bibliographyModule from '@latex/extractBibliography';

// Local imports - tools
import { ExtractBibliographyTool } from '@tools/latex';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

suite('ExtractBibliographyTool', () => {
  const originalExists = WorkspaceFS.exists;
  const originalContext = bibliographyModule.extractBibliographyContext;
  const originalLoad = bibliographyModule.loadBibliographyEntries;
  const originalSummarize = bibliographyModule.summarizeBibliographyEntries;

  teardown(() => {
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      originalExists;
    (
      bibliographyModule as {
        extractBibliographyContext: typeof originalContext;
      }
    ).extractBibliographyContext = originalContext;
    (
      bibliographyModule as { loadBibliographyEntries: typeof originalLoad }
    ).loadBibliographyEntries = originalLoad;
    (
      bibliographyModule as {
        summarizeBibliographyEntries: typeof originalSummarize;
      }
    ).summarizeBibliographyEntries = originalSummarize;
  });

  test('returns bibliography entries and summary', async () => {
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async (path: string) => path === 'main.tex';
    (
      bibliographyModule as {
        extractBibliographyContext: typeof originalContext;
      }
    ).extractBibliographyContext = async () => ({
      citationKeys: ['alpha', 'beta'],
      bibliographyFiles: ['references.bib'],
      missingBibliographyFiles: [],
    });
    (
      bibliographyModule as { loadBibliographyEntries: typeof originalLoad }
    ).loadBibliographyEntries = async () => ({
      entries: new Map([
        ['alpha', '@article{alpha,...}'],
        ['beta', '@book{beta,...}'],
      ]),
      missingKeys: [],
    });
    (
      bibliographyModule as {
        summarizeBibliographyEntries: typeof originalSummarize;
      }
    ).summarizeBibliographyEntries = () => [
      '@article{alpha,...}',
      '@book{beta,...}',
    ];

    const tool = new ExtractBibliographyTool();
    const result = await tool.call({ texPath: 'main.tex' });

    assert.strictEqual(
      result.summary,
      'Resolved 2 bibliography entries for 2 citation keys in main.tex.',
    );
    assert.ok(result.output?.includes('BibTeX entries cited in main.tex'));
    assert.ok(result.output?.includes('@article{alpha,...}'));
    assert.ok(result.output?.includes('@book{beta,...}'));
    assert.strictEqual(result.userInstruction, undefined);
  });

  test('reports missing bibliography files and keys', async () => {
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async (path: string) => path === 'paper.tex';
    (
      bibliographyModule as {
        extractBibliographyContext: typeof originalContext;
      }
    ).extractBibliographyContext = async () => ({
      citationKeys: ['alpha'],
      bibliographyFiles: [],
      missingBibliographyFiles: ['references.bib'],
    });
    (
      bibliographyModule as { loadBibliographyEntries: typeof originalLoad }
    ).loadBibliographyEntries = async () => ({
      entries: new Map(),
      missingKeys: ['alpha'],
    });
    (
      bibliographyModule as {
        summarizeBibliographyEntries: typeof originalSummarize;
      }
    ).summarizeBibliographyEntries = () => [];

    const tool = new ExtractBibliographyTool();
    const result = await tool.call({ texPath: 'paper.tex' });

    assert.ok(
      result.summary?.includes(
        'No matching bibliography entries found for 1 citation key in paper.tex.',
      ),
    );
    assert.ok(result.output?.includes('No matching entries found.'));
    assert.ok(result.userInstruction?.includes('Missing bibliography files'));
    assert.ok(result.userInstruction?.includes('Missing citation keys'));
  });

  test('returns error when tex file is missing', async () => {
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async () => false;

    const tool = new ExtractBibliographyTool();
    const result = await tool.call({ texPath: 'missing.tex' });

    assert.strictEqual(result.isError, true);
    assert.ok(result.error?.includes('LaTeX file not found'));
  });

  test('includes explicit bibliography path when provided', async () => {
    const calls: { paths: string[]; keys: string[] }[] = [];

    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async (path: string) => path === 'thesis.tex' || path === 'extra.bib';
    (
      bibliographyModule as {
        extractBibliographyContext: typeof originalContext;
      }
    ).extractBibliographyContext = async () => ({
      citationKeys: ['alpha'],
      bibliographyFiles: [],
      missingBibliographyFiles: [],
    });
    (
      bibliographyModule as { loadBibliographyEntries: typeof originalLoad }
    ).loadBibliographyEntries = async (paths, keys) => {
      calls.push({ paths, keys });
      return {
        entries: new Map([['alpha', '@article{alpha,...}']]),
        missingKeys: [],
      };
    };
    (
      bibliographyModule as {
        summarizeBibliographyEntries: typeof originalSummarize;
      }
    ).summarizeBibliographyEntries = () => ['@article{alpha,...}'];

    const tool = new ExtractBibliographyTool();
    const result = await tool.call({
      texPath: 'thesis.tex',
      bibPath: 'extra.bib',
    });

    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].paths, ['extra.bib']);
    assert.deepStrictEqual(calls[0].keys, ['alpha']);
    assert.ok(result.summary?.includes('Resolved 1 bibliography entry'));
  });

  test('falls back to wildcard when only a bibliography path is supplied', async () => {
    const calls: { paths: string[]; keys: string[] }[] = [];

    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async (path: string) => path === 'standalone.tex' || path === 'refs.bib';
    (
      bibliographyModule as {
        extractBibliographyContext: typeof originalContext;
      }
    ).extractBibliographyContext = async () => ({
      citationKeys: [],
      bibliographyFiles: [],
      missingBibliographyFiles: [],
    });
    (
      bibliographyModule as { loadBibliographyEntries: typeof originalLoad }
    ).loadBibliographyEntries = async (paths, keys) => {
      calls.push({ paths, keys });
      return {
        entries: new Map(),
        missingKeys: [],
      };
    };
    (
      bibliographyModule as {
        summarizeBibliographyEntries: typeof originalSummarize;
      }
    ).summarizeBibliographyEntries = () => [];

    const tool = new ExtractBibliographyTool();
    const result = await tool.call({
      texPath: 'standalone.tex',
      bibPath: 'refs.bib',
    });

    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].paths, ['refs.bib']);
    assert.deepStrictEqual(calls[0].keys, ['*']);
    assert.ok(
      result.summary?.includes(
        'No matching bibliography entries found for 1 citation key in standalone.tex.',
      ),
    );
  });
});
