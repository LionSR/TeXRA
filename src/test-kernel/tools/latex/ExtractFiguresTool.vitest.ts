import { afterEach, describe, expect, it, vi } from 'vitest';

import * as figureModule from '@latex/extractFigure';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { ExtractLatexFiguresTool } from '@tools/latex/ExtractFiguresTool';

function installPlatform(files: Record<string, string>) {
  return installFakePlatform({ workspacePath: '/workspace', files });
}

describe('ExtractLatexFiguresTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches discovered figure files', async () => {
    await installPlatform({
      '/workspace/main.tex': '\\documentclass{article}',
      '/workspace/figures/plot.pdf': 'pdf',
    });
    vi.spyOn(figureModule, 'extractFigurePathsFromLatex').mockResolvedValue([
      'figures/plot.pdf',
    ]);

    const result = await new ExtractLatexFiguresTool().call({
      texPath: 'main.tex',
    });

    expect(result.summary).toBe('Found 1 figure file in main.tex.');
    expect(result.output).toContain('Figures referenced in main.tex');
    expect(result.output).toContain('- figures/plot.pdf');
    expect(result.files).toHaveLength(1);
    expect(result.files?.[0].mimeType).toBe('application/pdf');
    expect(result.files?.[0].path).toBe('figures/plot.pdf');
    expect(result.files?.[0].bytes).toBeTruthy();
    expect(result.files?.[0].base64Data).toBeUndefined();
  });

  it('returns graceful message when figures are absent', async () => {
    await installPlatform({
      '/workspace/report.tex': '\\documentclass{article}',
    });
    vi.spyOn(figureModule, 'extractFigurePathsFromLatex').mockResolvedValue([]);

    const result = await new ExtractLatexFiguresTool().call({
      texPath: 'report.tex',
    });

    expect(result.summary).toBe('No figures found in report.tex.');
    expect(result.output).toContain('(no entries)');
    expect(result.files).toBeUndefined();
  });

  it('returns error when tex file is missing', async () => {
    await installPlatform({});

    const result = await new ExtractLatexFiguresTool().call({
      texPath: 'missing.tex',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('LaTeX file not found');
  });
});
