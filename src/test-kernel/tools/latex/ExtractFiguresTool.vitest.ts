// Node imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it, afterEach, vi } from 'vitest';

// Local imports
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

    const tool = new ExtractLatexFiguresTool();
    const result = await tool.call({
      texPath: 'main.tex',
    });

    assert.strictEqual(result.summary, 'Found 1 figure file in main.tex.');
    assert.ok(result.output?.includes('Figures referenced in main.tex'));
    assert.ok(result.output?.includes('- figures/plot.pdf'));
    assert.ok(result.files);
    assert.strictEqual(result.files?.length, 1);
    assert.strictEqual(result.files?.[0].mimeType, 'application/pdf');
    assert.strictEqual(result.files?.[0].path, 'figures/plot.pdf');
    assert.ok(result.files?.[0].bytes);
    assert.strictEqual(result.files?.[0].base64Data, undefined);
  });

  it('returns graceful message when figures are absent', async () => {
    await installPlatform({
      '/workspace/report.tex': '\\documentclass{article}',
    });
    vi.spyOn(figureModule, 'extractFigurePathsFromLatex').mockResolvedValue([]);

    const tool = new ExtractLatexFiguresTool();
    const result = await tool.call({ texPath: 'report.tex' });

    assert.strictEqual(result.summary, 'No figures found in report.tex.');
    assert.ok(result.output?.includes('(no entries)'));
    assert.strictEqual(result.files, undefined);
  });

  it('returns error when tex file is missing', async () => {
    await installPlatform({});

    const tool = new ExtractLatexFiguresTool();
    const result = await tool.call({ texPath: 'missing.tex' });

    assert.strictEqual(result.status, 'error');
    assert.ok(result.error?.includes('LaTeX file not found'));
  });
});
