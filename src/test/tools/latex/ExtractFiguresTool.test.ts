import * as assert from 'assert';

// Local imports - latex helpers
import * as figureModule from '@latex/extractFigure';

// Local imports - tools
import { ExtractLatexFiguresTool } from '@tools/latex';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

suite('ExtractLatexFiguresTool', () => {
  const originalExtract = figureModule.extractFigurePathsFromLatex;
  const originalExists = WorkspaceFS.exists;
  const originalReadBytes = WorkspaceFS.readFileBytes;

  teardown(() => {
    (
      figureModule as { extractFigurePathsFromLatex: typeof originalExtract }
    ).extractFigurePathsFromLatex = originalExtract;
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      originalExists;
    (
      WorkspaceFS as unknown as { readFileBytes: typeof originalReadBytes }
    ).readFileBytes = originalReadBytes;
  });

  test('attaches discovered figure files', async () => {
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async (path: string) => {
        return path === 'main.tex' || path === 'figures/plot.pdf';
      };
    (
      WorkspaceFS as unknown as { readFileBytes: typeof originalReadBytes }
    ).readFileBytes = async () => Buffer.from('pdf');
    (
      figureModule as {
        extractFigurePathsFromLatex: typeof originalExtract;
      }
    ).extractFigurePathsFromLatex = async () => ['figures/plot.pdf'];

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

  test('returns graceful message when figures are absent', async () => {
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async (path: string) => path === 'report.tex';
    (
      figureModule as {
        extractFigurePathsFromLatex: typeof originalExtract;
      }
    ).extractFigurePathsFromLatex = async () => [];

    const tool = new ExtractLatexFiguresTool();
    const result = await tool.call({ texPath: 'report.tex' });

    assert.strictEqual(result.summary, 'No figures found in report.tex.');
    assert.ok(result.output?.includes('(no entries)'));
    assert.strictEqual(result.files, undefined);
  });

  test('returns error when tex file is missing', async () => {
    (WorkspaceFS as unknown as { exists: typeof originalExists }).exists =
      async () => false;

    const tool = new ExtractLatexFiguresTool();
    const result = await tool.call({ texPath: 'missing.tex' });

    assert.strictEqual(result.isError, true);
    assert.ok(result.error?.includes('LaTeX file not found'));
  });
});
