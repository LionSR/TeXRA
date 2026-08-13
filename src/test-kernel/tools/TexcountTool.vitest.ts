// Node.js built-in imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it, afterEach, vi } from 'vitest';

// Local imports - tools
import * as texcountModule from '@latex/texcount';
import { TexcountTool } from '@tools/texcount/TexcountTool';

const tool = new TexcountTool();

type TexcountCall = {
  files: string[];
  options?: texcountModule.TexcountOptions;
};

function stubTexcount(output: string | null, errors: string[] = []): void {
  vi.spyOn(texcountModule, 'getTeXCount').mockImplementation(async () => ({
    output,
    errors,
  }));
}

// Spies getTeXCount and records each call's files/options.
function captureTexcountCalls(output: string): TexcountCall[] {
  const calls: TexcountCall[] = [];
  vi.spyOn(texcountModule, 'getTeXCount').mockImplementation(
    async (files, options) => {
      calls.push({ files: Array.isArray(files) ? files : [files], options });
      return { output, errors: [] };
    },
  );
  return calls;
}

describe('TexcountTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns raw texcount output for single file input', async () => {
    const calls = captureTexcountCalls('Words in text: 42');

    const result = await tool.call({ files: 'main.tex' });

    assert.strictEqual(result.summary, 'Analyzed: 1 file');
    assert.strictEqual(result.output, 'Words in text: 42');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].files, ['main.tex']);
    assert.strictEqual(calls[0].options?.mode, 'separate');
  });

  it('formats output when stats format requested', async () => {
    stubTexcount('Words in text: 100');

    const result = await tool.call({
      files: ['chapter1.tex', 'chapter2.tex'],
      format: 'stats',
    });

    assert.strictEqual(result.summary, 'Analyzed: 2 files');
    assert.ok(result.output?.includes('<texcount>'));
    assert.ok(result.output?.includes('Words in text: 100'));
  });

  it('returns error result when texcount output is missing', async () => {
    stubTexcount(null, ['File missing.tex does not exist.']);

    const result = await tool.call({ files: ['missing.tex'], mode: 'sum' });

    assert.strictEqual(result.status, 'error');
    assert.ok(result.error?.includes('missing.tex'));
  });

  it('passes selected mode to texcount implementation', async () => {
    const calls = captureTexcountCalls('Words in text: 21');

    const result = await tool.call({
      files: ['file1.tex', 'file2.tex'],
      mode: 'sum',
    });

    assert.strictEqual(result.summary, 'Analyzed: 2 files');
    assert.strictEqual(result.output, 'Words in text: 21');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].files, ['file1.tex', 'file2.tex']);
    assert.strictEqual(calls[0].options?.mode, 'sum');
  });
});
