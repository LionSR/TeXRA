import { afterEach, describe, expect, it, vi } from 'vitest';

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

    const result = await new ExtractBibliographyTool().call({
      texPath: 'main.tex',
    });

    expect(result.summary).toBe(
      'Resolved 2 bibliography entries for 2 citation keys in main.tex.',
    );
    expect(result.output).toContain('BibTeX entries cited in main.tex');
    expect(result.output).toContain('@article{alpha,...}');
    expect(result.output).toContain('@book{beta,...}');
    expect(result.userInstruction).toBeUndefined();
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

    const result = await new ExtractBibliographyTool().call({
      texPath: 'paper.tex',
    });

    expect(result.summary).toContain(
      'No matching bibliography entries found for 1 citation key in paper.tex.',
    );
    expect(result.output).toContain('No matching entries found.');
    expect(result.output).toContain('Missing bibliography files');
    expect(result.output).toContain('Missing citation keys');
  });

  it('returns error when tex file is missing', async () => {
    await installPlatform({});

    const result = await new ExtractBibliographyTool().call({
      texPath: 'missing.tex',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('LaTeX file not found');
  });

  it('includes explicit bibliography path when provided', async () => {
    await installPlatform({
      '/workspace/thesis.tex': '\\documentclass{article}',
      '/workspace/extra.bib': '@article{alpha,...}',
    });
    mockBibliography({
      context: { citationKeys: ['alpha'] },
      summary: ['@article{alpha,...}'],
    });
    const loadEntries = vi
      .mocked(bibliographyModule.loadBibliographyEntries)
      .mockResolvedValue({
        entries: new Map([['alpha', '@article{alpha,...}']]),
        missingKeys: [],
      });

    const result = await new ExtractBibliographyTool().call({
      texPath: 'thesis.tex',
      bibPath: 'extra.bib',
    });

    expect(loadEntries).toHaveBeenCalledOnce();
    expect(loadEntries.mock.calls[0]).toEqual([['extra.bib'], ['alpha']]);
    expect(result.summary).toContain('Resolved 1 bibliography entry');
  });

  it('falls back to wildcard when only a bibliography path is supplied', async () => {
    await installPlatform({
      '/workspace/standalone.tex': '\\documentclass{article}',
      '/workspace/refs.bib': '@article{alpha,...}',
    });
    mockBibliography({});
    const loadEntries = vi
      .mocked(bibliographyModule.loadBibliographyEntries)
      .mockResolvedValue({ entries: new Map(), missingKeys: [] });

    const result = await new ExtractBibliographyTool().call({
      texPath: 'standalone.tex',
      bibPath: 'refs.bib',
    });

    expect(loadEntries).toHaveBeenCalledOnce();
    expect(loadEntries.mock.calls[0]).toEqual([['refs.bib'], ['*']]);
    expect(result.summary).toContain(
      'No matching bibliography entries found for 1 citation key in standalone.tex.',
    );
  });
});
