// Standard library imports
import { strict as assert } from 'assert';

// Local imports - tools
import { ExtractFiguresTool } from '@tools/latex/ExtractFiguresTool';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

describe('ExtractFiguresTool', () => {
  const tool = new ExtractFiguresTool();

  const originalRead = WorkspaceFS.read;
  const originalExists = WorkspaceFS.exists;
  const originalFilter = WorkspaceFS.filterExistingFiles;

  afterEach(() => {
    (WorkspaceFS as any).read = originalRead;
    (WorkspaceFS as any).exists = originalExists;
    (WorkspaceFS as any).filterExistingFiles = originalFilter;
  });

  it('collects figure references and returns attachments', async () => {
    (WorkspaceFS as any).read = async () =>
      '\\documentclass{article}\n\\begin{document}\n\\includegraphics{figures/plot}\n\\end{document}';
    (WorkspaceFS as any).exists = async (path: string) =>
      path === 'figures/plot.pdf';
    (WorkspaceFS as any).filterExistingFiles = async (items: Array<{ path: string }>) =>
      items.filter((item) => item.path === 'figures/plot.pdf');

    const result = await tool.call({ files: ['paper.tex'] });
    assert.ok(result.summary?.includes('Found 1 figure'));
    const parsed = JSON.parse(result.output ?? '[]');
    assert.deepEqual(parsed, [{ file: 'paper.tex', figures: ['figures/plot.pdf'] }]);
    assert.deepEqual(result.files, [{ path: 'figures/plot.pdf' }]);
  });

  it('returns empty result when no figures are found', async () => {
    (WorkspaceFS as any).read = async () => '\\documentclass{article}';
    (WorkspaceFS as any).exists = async () => false;
    (WorkspaceFS as any).filterExistingFiles = async () => [];

    const result = await tool.call({ files: ['paper.tex'] });
    assert.ok(result.summary?.includes('No figures discovered'));
    const parsed = JSON.parse(result.output ?? '[]');
    assert.deepEqual(parsed, [{ file: 'paper.tex', figures: [] }]);
    assert.strictEqual(result.files?.length, 0);
  });
});
