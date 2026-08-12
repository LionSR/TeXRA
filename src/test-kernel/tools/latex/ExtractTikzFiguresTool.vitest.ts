import { afterEach, describe, expect, it, vi } from 'vitest';

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

    const result = await new ExtractTikzFiguresTool().call({
      texPath: 'slides.tex',
    });

    expect(result.summary).toContain('Found 1 TikZ figure');
    expect(result.summary).toContain('Compiled 1 standalone PDF.');
    expect(result.output).toContain('TikZ figures in slides.tex');
    expect(result.output).toContain('Compiled PDFs');
    expect(result.files).toHaveLength(1);
    expect(result.files?.[0].mimeType).toBe('application/pdf');
    expect(result.files?.[0].path).toBe('build/slides/fig_a.pdf');
    expect(result.files?.[0].bytes).toBeTruthy();
    expect(result.files?.[0].base64Data).toBeUndefined();
  });

  it('omits attachments when compilation disabled', async () => {
    await installPlatform({
      '/workspace/draft.tex': '\\documentclass{article}',
    });
    vi.spyOn(TikzPictureManager, 'extract').mockResolvedValue([
      ['fig:b', ['\\begin{tikzpicture}\\end{tikzpicture}']],
    ]);

    const result = await new ExtractTikzFiguresTool().call({
      texPath: 'draft.tex',
      compile: false,
    });

    expect(result.summary).toContain('Found 1 TikZ figure');
    expect(result.summary).not.toContain('Compiled');
    expect(result.files).toBeUndefined();
  });

  it('returns error when LaTeX file is missing', async () => {
    await installPlatform({});

    const result = await new ExtractTikzFiguresTool().call({
      texPath: 'absent.tex',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('LaTeX file not found');
  });
});
