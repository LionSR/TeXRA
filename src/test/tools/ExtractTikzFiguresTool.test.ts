// Standard library imports
import { strict as assert } from 'assert';

// Local imports - tools
import { ExtractTikzFiguresTool } from '@tools/latex/ExtractTikzFiguresTool';

// Local imports - latex
import { tikzPictureManager } from '@latex';

describe('ExtractTikzFiguresTool', () => {
  const tool = new ExtractTikzFiguresTool();

  const originalExtract = tikzPictureManager.extract;
  const originalCompile = tikzPictureManager.compile;

  afterEach(() => {
    (tikzPictureManager as any).extract = originalExtract;
    (tikzPictureManager as any).compile = originalCompile;
  });

  it('returns labeled tikz blocks without compilation', async () => {
    (tikzPictureManager as any).extract = async () => [
      ['fig:one', ['\\begin{tikzpicture}\\end{tikzpicture}']],
    ];
    let compileCalled = false;
    (tikzPictureManager as any).compile = async () => {
      compileCalled = true;
      return [];
    };

    const result = await tool.call({ files: ['paper.tex'], compile: false });
    assert.ok(result.summary?.includes('Found 1 labeled TikZ figure'));
    const parsed = JSON.parse(result.output ?? '[]');
    assert.deepEqual(parsed, [
      {
        file: 'paper.tex',
        labels: [
          {
            label: 'fig:one',
            tikz: ['\\begin{tikzpicture}\\end{tikzpicture}'],
          },
        ],
        compiled: [],
      },
    ]);
    assert.strictEqual(result.files?.length, 0);
    assert.strictEqual(compileCalled, false);
  });

  it('adds compiled artifacts when requested', async () => {
    (tikzPictureManager as any).extract = async () => [
      ['fig:two', ['\\begin{tikzpicture}\\end{tikzpicture}']],
    ];
    (tikzPictureManager as any).compile = async () => ['build/fig-two.pdf'];

    const result = await tool.call({ files: ['paper.tex'], compile: true });
    assert.ok(result.summary?.includes('Found 1 labeled TikZ figure'));
    const parsed = JSON.parse(result.output ?? '[]');
    assert.deepEqual(parsed[0].compiled, ['build/fig-two.pdf']);
    assert.deepEqual(result.files, [{ path: 'build/fig-two.pdf' }]);
  });
});
