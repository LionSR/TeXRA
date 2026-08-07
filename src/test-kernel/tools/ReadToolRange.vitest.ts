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
const LARGE = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join(
  '\n',
);

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
      files: {
        '/workspace/large.txt': LARGE,
        '/workspace/small.txt': SMALL,
      },
    });
  });

  it('reads the whole file when no range is given', async () => {
    const result = await callRead({ path: 'small.txt' });

    expect(result.summary).toBe('Read small.txt');
    expect(result.output).toContain('line 1');
    expect(result.output).toContain('line 10');
  });

  it.each([
    {
      name: 'an explicit in-bounds range inclusively',
      range: { start: 3, end: 5 },
      summary: 'Read lines 3-5 of small.txt',
      contains: ['line 3', 'line 5'],
      excludes: ['line 2', 'line 6'],
    },
    {
      name: 'a single-line range with the singular label',
      range: { start: 4, end: 4 },
      summary: 'Read line 4 of small.txt',
      contains: ['line 4'],
      excludes: ['line 5'],
    },
    {
      name: 'an end clamped past EOF, saying so in the summary',
      range: { start: 8, end: 999 },
      summary:
        'Read lines 8-10 of small.txt (requested end 999 exceeds file length 10)',
      contains: ['line 10'],
      excludes: [],
    },
    {
      name: 'an empty view when the start is past EOF',
      range: { start: 50, end: 60 },
      summary:
        'Read small.txt (no lines in requested range) (requested end 60 exceeds file length 10)',
      contains: [],
      excludes: [],
      empty: true,
    },
    {
      name: 'to EOF when only a start is given',
      range: { start: 7 },
      summary: 'Read lines 7-10 of small.txt',
      contains: ['line 7', 'line 10'],
      excludes: ['line 6'],
    },
    {
      name: 'the array range form some models emit',
      range: [2, 4],
      summary: 'Read lines 2-4 of small.txt',
      contains: ['line 2', 'line 4'],
      excludes: ['line 5'],
    },
  ])('reads $name', async ({ range, summary, contains, excludes, empty }) => {
    const result = await callRead({ path: 'small.txt', range });

    expect(result.summary).toBe(summary);
    if (empty) {
      expect(result.output).toBe('');
    }
    for (const line of contains) {
      expect(result.output).toContain(line);
    }
    for (const line of excludes) {
      expect(result.output).not.toContain(line);
    }
  });

  it('reports remaining lines when a start-only range is truncated', async () => {
    const result = await callRead({
      path: 'large.txt',
      range: { start: 2 },
    });

    expect(result.summary).toBe('Read lines 2-2001 of large.txt');
    expect(result.output).toContain('...(truncated, 499 more lines)');
  });

  it('rejects an end below the start', async () => {
    const result = await callRead({
      path: 'small.txt',
      range: { start: 5, end: 2 },
    });

    expect(result.status).toBe('error');
  });
});
