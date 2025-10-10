import * as assert from 'assert';

// Local imports - latex helpers
import { tikzPictureManager } from '@latex/TikzPictureManager';

// Local imports - tools
import { ExtractTikzFiguresTool } from '@tools/latex';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

suite('ExtractTikzFiguresTool', () => {
  const originalExtract = tikzPictureManager.extract;
  const originalCompile = tikzPictureManager.compile;
  const originalExists = WorkspaceFS.exists;
  const originalReadBytes = WorkspaceFS.readFileBytes;

  teardown(() => {
    (
      tikzPictureManager as unknown as { extract: typeof originalExtract }
    ).extract = originalExtract;
    (
      tikzPictureManager as unknown as { compile: typeof originalCompile }
    ).compile = originalCompile;
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      originalExists;
    (
      WorkspaceFS as unknown as { readFileBytes: typeof originalReadBytes }
    ).readFileBytes = originalReadBytes;
  });

  test('compiles TikZ figures and returns attachments', async () => {
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async (path: string) =>
        path === 'slides.tex' || path === 'build/slides/fig_a.pdf';
    (
      WorkspaceFS as unknown as { readFileBytes: typeof originalReadBytes }
    ).readFileBytes = async () => Buffer.from('%PDF');
    (
      tikzPictureManager as unknown as { extract: typeof originalExtract }
    ).extract = async () => [
      ['fig:a', ['\\begin{tikzpicture}\\end{tikzpicture}']],
    ];
    (
      tikzPictureManager as unknown as { compile: typeof originalCompile }
    ).compile = async () => ['build/slides/fig_a.pdf'];

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

  test('omits attachments when compilation disabled', async () => {
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async (path: string) => path === 'draft.tex';
    (
      tikzPictureManager as unknown as { extract: typeof originalExtract }
    ).extract = async () => [
      ['fig:b', ['\\begin{tikzpicture}\\end{tikzpicture}']],
    ];

    const tool = new ExtractTikzFiguresTool();
    const result = await tool.call({ texPath: 'draft.tex', compile: false });

    assert.ok(result.summary?.includes('Found 1 TikZ figure'));
    assert.ok(!result.summary?.includes('Compiled'));
    assert.strictEqual(result.files, undefined);
  });

  test('returns error when LaTeX file is missing', async () => {
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async () => false;

    const tool = new ExtractTikzFiguresTool();
    const result = await tool.call({ texPath: 'absent.tex' });

    assert.strictEqual(result.isError, true);
    assert.ok(result.error?.includes('LaTeX file not found'));
  });
});
