// Third-party imports
import * as assert from 'node:assert';
import { describe, it, afterEach, vi } from 'vitest';

// Local imports - tests

// Local imports - tools
import * as bibliographyModule from '@latex/extractBibliography';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { ExtractBibliographyTool } from '@tools/latex';

function installPlatform(files: Record<string, string>) {
  return installFakePlatform({ workspacePath: '/workspace', files });
}

describe('ExtractBibliographyTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns bibliography entries and summary', async () => {
    await installPlatform({
      '/workspace/main.tex': '\\documentclass{article}',
    });
    vi.spyOn(
      bibliographyModule,
      'extractBibliographyContext',
    ).mockResolvedValue({
      citationKeys: ['alpha', 'beta'],
      bibliographyFiles: ['references.bib'],
      missingBibliographyFiles: [],
    });
    vi.spyOn(bibliographyModule, 'loadBibliographyEntries').mockResolvedValue({
      entries: new Map([
        ['alpha', '@article{alpha,...}'],
        ['beta', '@book{beta,...}'],
      ]),
      missingKeys: [],
    });
    vi.spyOn(
      bibliographyModule,
      'summarizeBibliographyEntries',
    ).mockReturnValue(['@article{alpha,...}', '@book{beta,...}']);

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
    vi.spyOn(
      bibliographyModule,
      'extractBibliographyContext',
    ).mockResolvedValue({
      citationKeys: ['alpha'],
      bibliographyFiles: [],
      missingBibliographyFiles: ['references.bib'],
    });
    vi.spyOn(bibliographyModule, 'loadBibliographyEntries').mockResolvedValue({
      entries: new Map(),
      missingKeys: ['alpha'],
    });
    vi.spyOn(
      bibliographyModule,
      'summarizeBibliographyEntries',
    ).mockReturnValue([]);

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
    vi.spyOn(
      bibliographyModule,
      'extractBibliographyContext',
    ).mockResolvedValue({
      citationKeys: ['alpha'],
      bibliographyFiles: [],
      missingBibliographyFiles: [],
    });
    vi.spyOn(bibliographyModule, 'loadBibliographyEntries').mockImplementation(
      async (paths, keys) => {
        calls.push({ paths, keys });
        return {
          entries: new Map([['alpha', '@article{alpha,...}']]),
          missingKeys: [],
        };
      },
    );
    vi.spyOn(
      bibliographyModule,
      'summarizeBibliographyEntries',
    ).mockReturnValue(['@article{alpha,...}']);

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
    vi.spyOn(
      bibliographyModule,
      'extractBibliographyContext',
    ).mockResolvedValue({
      citationKeys: [],
      bibliographyFiles: [],
      missingBibliographyFiles: [],
    });
    vi.spyOn(bibliographyModule, 'loadBibliographyEntries').mockImplementation(
      async (paths, keys) => {
        calls.push({ paths, keys });
        return {
          entries: new Map(),
          missingKeys: [],
        };
      },
    );
    vi.spyOn(
      bibliographyModule,
      'summarizeBibliographyEntries',
    ).mockReturnValue([]);

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
