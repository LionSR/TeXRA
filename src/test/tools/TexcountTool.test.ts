import * as assert from 'assert';

// Local imports - tools
import { TexcountTool } from '@tools/texcount';

// Local imports - latex utilities
import * as texcountModule from '@latex/texcount';

suite('TexcountTool', () => {
  const originalGetTeXCount = texcountModule.getTeXCount;

  teardown(() => {
    (
      texcountModule as { getTeXCount: typeof originalGetTeXCount }
    ).getTeXCount = originalGetTeXCount;
  });

  test('returns raw texcount output for single file input', async () => {
    const calls: Array<{
      files: string[];
      options?: texcountModule.TexcountOptions;
    }> = [];
    (
      texcountModule as { getTeXCount: typeof originalGetTeXCount }
    ).getTeXCount = async (files, options) => {
      calls.push({
        files: Array.isArray(files) ? files : [files],
        options,
      });
      return { output: 'Words in text: 42', errors: [] };
    };

    const tool = new TexcountTool();
    const result = await tool.call({ files: 'main.tex' });

    assert.strictEqual(result.summary, 'texcount analysis for 1 file');
    assert.strictEqual(result.output, 'Words in text: 42');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].files, ['main.tex']);
    assert.strictEqual(calls[0].options?.mode, 'separate');
  });

  test('formats output when stats format requested', async () => {
    (
      texcountModule as { getTeXCount: typeof originalGetTeXCount }
    ).getTeXCount = async () => ({
      output: 'Words in text: 100',
      errors: [],
    });

    const tool = new TexcountTool();
    const result = await tool.call({
      files: ['chapter1.tex', 'chapter2.tex'],
      format: 'stats',
    });

    assert.strictEqual(result.summary, 'texcount analysis for 2 files');
    assert.ok(result.output?.includes('<texcount>'));
    assert.ok(result.output?.includes('Words in text: 100'));
  });

  test('returns error result when texcount output is missing', async () => {
    (
      texcountModule as { getTeXCount: typeof originalGetTeXCount }
    ).getTeXCount = async () => ({
      output: null,
      errors: ['File missing.tex does not exist.'],
    });

    const tool = new TexcountTool();
    const result = await tool.call({ files: ['missing.tex'], mode: 'sum' });

    assert.strictEqual(result.isError, true);
    assert.ok(result.error?.includes('missing.tex'));
  });

  test('passes selected mode to texcount implementation', async () => {
    const calls: Array<{
      files: string[];
      options?: texcountModule.TexcountOptions;
    }> = [];
    (
      texcountModule as { getTeXCount: typeof originalGetTeXCount }
    ).getTeXCount = async (files, options) => {
      calls.push({
        files: Array.isArray(files) ? files : [files],
        options,
      });
      return { output: 'Words in text: 21', errors: [] };
    };

    const tool = new TexcountTool();
    const result = await tool.call({
      files: ['file1.tex', 'file2.tex'],
      mode: 'sum',
    });

    assert.strictEqual(result.summary, 'texcount analysis for 2 files');
    assert.strictEqual(result.output, 'Words in text: 21');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].files, ['file1.tex', 'file2.tex']);
    assert.strictEqual(calls[0].options?.mode, 'sum');
  });
});
