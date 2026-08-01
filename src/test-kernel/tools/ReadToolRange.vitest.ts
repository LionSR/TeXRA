// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { describe, expect, it, beforeEach } from 'vitest';

// Local imports
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { StreamTabId } from '@shared/schemas';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { ReadFileTool } from '@tools/ReadTool';

const EXECUTION_ID = 'read-range-exec';

/** 10 lines: "line 1" … "line 10". */
const SMALL = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

async function callRead(input: unknown) {
  const tool = new ReadFileTool();
  return withRunContext(
    createRunContext({
      streamId: `stream:${EXECUTION_ID}` as StreamTabId,
      executionId: EXECUTION_ID,
    }),
    () => tool.call(input),
  );
}

describe('read_file line ranges', () => {
  beforeEach(async () => {
    await installFakePlatform({
      workspacePath: '/workspace',
      files: { '/workspace/small.txt': SMALL },
    });
  });

  it('reads the whole file when no range is given', async () => {
    const result = await callRead({ path: 'small.txt' });

    expect(result.summary).toBe('Read small.txt');
    expect(result.output).toContain('line 1');
    expect(result.output).toContain('line 10');
  });

  it('reads an explicit in-bounds range inclusively', async () => {
    const result = await callRead({
      path: 'small.txt',
      range: { start: 3, end: 5 },
    });

    expect(result.summary).toBe('Read lines 3-5 of small.txt');
    expect(result.output).toContain('line 3');
    expect(result.output).toContain('line 5');
    expect(result.output).not.toContain('line 6');
    expect(result.output).not.toContain('line 2');
  });

  it('renders a single-line range with the singular label', async () => {
    const result = await callRead({
      path: 'small.txt',
      range: { start: 4, end: 4 },
    });

    expect(result.summary).toBe('Read line 4 of small.txt');
    expect(result.output).toContain('line 4');
    expect(result.output).not.toContain('line 5');
  });

  it('clamps an end past EOF and says so in the summary', async () => {
    const result = await callRead({
      path: 'small.txt',
      range: { start: 8, end: 999 },
    });

    expect(result.summary).toBe(
      'Read lines 8-10 of small.txt (requested end 999 exceeds file length 10)',
    );
    expect(result.output).toContain('line 10');
  });

  it('reports an empty view when the start is past EOF', async () => {
    const result = await callRead({
      path: 'small.txt',
      range: { start: 50, end: 60 },
    });

    expect(result.summary).toBe(
      'Read small.txt (no lines in requested range) (requested end 60 exceeds file length 10)',
    );
    expect(result.output).toBe('');
  });

  it('reads to EOF when only a start is given', async () => {
    const result = await callRead({ path: 'small.txt', range: { start: 7 } });

    expect(result.summary).toBe('Read lines 7-10 of small.txt');
    expect(result.output).toContain('line 7');
    expect(result.output).toContain('line 10');
    expect(result.output).not.toContain('line 6');
  });

  it('accepts the array range form some models emit', async () => {
    const result = await callRead({ path: 'small.txt', range: [2, 4] });

    expect(result.summary).toBe('Read lines 2-4 of small.txt');
    expect(result.output).toContain('line 2');
    expect(result.output).toContain('line 4');
    expect(result.output).not.toContain('line 5');
  });

  it('rejects an end below the start', async () => {
    const result = await callRead({
      path: 'small.txt',
      range: { start: 5, end: 2 },
    });

    expect(result.status).toBe('error');
  });
});
