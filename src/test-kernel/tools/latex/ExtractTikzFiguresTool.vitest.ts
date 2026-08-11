// Node imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it, afterEach, vi } from 'vitest';

// Local imports
import { TikzPictureManager } from '@latex/TikzPictureManager';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { ExtractTikzFiguresTool } from '@tools/latex/ExtractTikzFiguresTool';
import { pathToLocation } from '@utils/files/fileLocation';

function installPlatform(files: Record<string, string>) {
  return installFakePlatform({ workspacePath: '/workspace', files });
}

describe('ExtractTikzFiguresTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('compiles TikZ figures and returns attachments', async () => {
    await installPlatform({
      '/workspace/slides.tex': '\\documentclass{beamer}',
      '/workspace/build/slides/fig_a.pdf': '%PDF',
    });
    vi.spyOn(TikzPictureManager, 'extract').mockResolvedValue([
      ['fig:a', ['\\begin{tikzpicture}\\end{tikzpicture}']],
    ]);
    vi.spyOn(TikzPictureManager, 'compile').mockResolvedValue([
      pathToLocation('build/slides/fig_a.pdf'),
    ]);

    const tool = new ExtractTikzFiguresTool();
    const result = await tool.call({
      texPath: 'slides.tex',
    });

    assert.ok(result.summary?.includes('Found 1 TikZ figure'));
    assert.ok(result.summary?.includes('Compiled 1 standalone PDF.'));
    assert.ok(result.output?.includes('TikZ figures in slides.tex'));
    assert.ok(result.output?.includes('Compiled PDFs'));
    assert.strictEqual(result.files?.length, 1);
    assert.strictEqual(result.files?.[0].mimeType, 'application/pdf');
    assert.strictEqual(result.files?.[0].path, 'build/slides/fig_a.pdf');
    assert.ok(result.files?.[0].bytes);
    assert.strictEqual(result.files?.[0].base64Data, undefined);
  });

  it('omits attachments when compilation disabled', async () => {
    await installPlatform({
      '/workspace/draft.tex': '\\documentclass{article}',
    });
    vi.spyOn(TikzPictureManager, 'extract').mockResolvedValue([
      ['fig:b', ['\\begin{tikzpicture}\\end{tikzpicture}']],
    ]);

    const tool = new ExtractTikzFiguresTool();
    const result = await tool.call({ texPath: 'draft.tex', compile: false });

    assert.ok(result.summary?.includes('Found 1 TikZ figure'));
    assert.ok(!result.summary?.includes('Compiled'));
    assert.strictEqual(result.files, undefined);
  });

  it('returns error when LaTeX file is missing', async () => {
    await installPlatform({});

    const tool = new ExtractTikzFiguresTool();
    const result = await tool.call({ texPath: 'absent.tex' });

    assert.strictEqual(result.status, 'error');
    assert.ok(result.error?.includes('LaTeX file not found'));
  });
});
