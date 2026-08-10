// Node imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it, afterEach, vi } from 'vitest';

// Local imports
import * as bibliographyModule from '@latex/extractBibliography';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { ExtractBibliographyTool } from '@tools/latex/ExtractBibliographyTool';

type BibliographyContext = Awaited<
  ReturnType<typeof bibliographyModule.extractBibliographyContext>
>;
type BibliographyEntries = Awaited<
  ReturnType<typeof bibliographyModule.loadBibliographyEntries>
>;

function installPlatform(files: Record<string, string>) {
  return installFakePlatform({ workspacePath: '/workspace', files });
}

/** Stub the three bibliography helpers the tool composes. */
function mockBibliography(options: {
  context?: Partial<BibliographyContext>;
  entries?: Partial<BibliographyEntries>;
  summary?: string[];
}): void {
  vi.spyOn(bibliographyModule, 'extractBibliographyContext').mockResolvedValue({
    citationKeys: [],
    bibliographyFiles: [],
    missingBibliographyFiles: [],
    ...options.context,
  });
  vi.spyOn(bibliographyModule, 'loadBibliographyEntries').mockResolvedValue({
    entries: new Map(),
    missingKeys: [],
    ...options.entries,
  });
  vi.spyOn(bibliographyModule, 'summarizeBibliographyEntries').mockReturnValue(
    options.summary ?? [],
  );
}

describe('ExtractBibliographyTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns bibliography entries and summary', async () => {
    await installPlatform({
      '/workspace/main.tex': '\\documentclass{article}',
    });
    mockBibliography({
      context: {
        citationKeys: ['alpha', 'beta'],
        bibliographyFiles: ['references.bib'],
      },
      entries: {
        entries: new Map([
          ['alpha', '@article{alpha,...}'],
          ['beta', '@book{beta,...}'],
        ]),
      },
      summary: ['@article{alpha,...}', '@book{beta,...}'],
    });

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

  it('reports missing bibliography files and keys', async () => {
    await installPlatform({
      '/workspace/paper.tex': '\\documentclass{article}',
    });
    mockBibliography({
      context: {
        citationKeys: ['alpha'],
        missingBibliographyFiles: ['references.bib'],
      },
      entries: { missingKeys: ['alpha'] },
    });

    const tool = new ExtractBibliographyTool();
    const result = await tool.call({ texPath: 'paper.tex' });

    assert.ok(
      result.summary?.includes(
        'No matching bibliography entries found for 1 citation key in paper.tex.',
      ),
    );
    assert.ok(result.output?.includes('No matching entries found.'));
    assert.ok(result.output?.includes('Missing bibliography files'));
    assert.ok(result.output?.includes('Missing citation keys'));
  });

  it('returns error when tex file is missing', async () => {
    await installPlatform({});

    const tool = new ExtractBibliographyTool();
    const result = await tool.call({ texPath: 'missing.tex' });

    assert.strictEqual(result.status, 'error');
    assert.ok(result.error?.includes('LaTeX file not found'));
  });

  it('includes explicit bibliography path when provided', async () => {
    const calls: { paths: string[]; keys: string[] }[] = [];

    await installPlatform({
      '/workspace/thesis.tex': '\\documentclass{article}',
      '/workspace/extra.bib': '@article{alpha,...}',
    });
    mockBibliography({
      context: { citationKeys: ['alpha'] },
      summary: ['@article{alpha,...}'],
    });
    vi.mocked(bibliographyModule.loadBibliographyEntries).mockImplementation(
      async (paths, keys) => {
        calls.push({ paths, keys });
        return {
          entries: new Map([['alpha', '@article{alpha,...}']]),
          missingKeys: [],
        };
      },
    );

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

  it('falls back to wildcard when only a bibliography path is supplied', async () => {
    const calls: { paths: string[]; keys: string[] }[] = [];

    await installPlatform({
      '/workspace/standalone.tex': '\\documentclass{article}',
      '/workspace/refs.bib': '@article{alpha,...}',
    });
    mockBibliography({});
    vi.mocked(bibliographyModule.loadBibliographyEntries).mockImplementation(
      async (paths, keys) => {
        calls.push({ paths, keys });
        return {
          entries: new Map(),
          missingKeys: [],
        };
      },
    );

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
