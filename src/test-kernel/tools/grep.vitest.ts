// Third-party imports
import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Standard library imports

// Local imports
import { setupPlatform } from '@test/support/setupPlatform';
import { buildArguments, GrepTool, type GrepInput } from '@tools/grep';
import * as execUtils from '@utils/system/execUtils';

describe('buildArguments', () => {
  // output_mode is required after transform normalizes nullish to 'content'
  const baseInput: GrepInput = { pattern: 'example', output_mode: 'content' };

  it('omits --files-with-matches when using content mode', () => {
    const args = buildArguments(baseInput, 'content');
    assert.deepEqual(args, ['--color=never']);
  });

  it('includes --files-with-matches when explicitly requested', () => {
    const args = buildArguments(baseInput, 'files_with_matches');
    assert.ok(args.includes('--files-with-matches'));
  });

  it('includes --fixed-strings when literal is true', () => {
    const args = buildArguments({ ...baseInput, literal: true }, 'content');
    assert.ok(args.includes('--fixed-strings'));
  });

  it('omits --fixed-strings when literal is false or nullish', () => {
    const argsWithFalse = buildArguments(
      { ...baseInput, literal: false },
      'content',
    );
    const argsWithNull = buildArguments(
      { ...baseInput, literal: null },
      'content',
    );
    const argsWithUndefined = buildArguments(baseInput, 'content');

    assert.ok(!argsWithFalse.includes('--fixed-strings'));
    assert.ok(!argsWithNull.includes('--fixed-strings'));
    assert.ok(!argsWithUndefined.includes('--fixed-strings'));
  });
});

describe('GrepTool execution', () => {
  setupPlatform({ workspacePath: process.cwd() });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves total-count and offset/head_limit pagination semantics', async () => {
    const executeSpy = vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
      success: true,
      stdout: 'one\n\ntwo\nthree\nfour\n',
      stderr: null,
      timedOut: false,
      exitCode: 0,
    });

    const result = await new GrepTool().call({
      pattern: 'item',
      output_mode: 'content',
      offset: 1,
      head_limit: 2,
    });

    expect(result).toMatchObject({
      status: 'executed',
      summary: expect.stringContaining('Found 2 of 4 matches'),
    });
    expect(result.output).toBe(
      'two\nthree\n\n[Showing 2 of 4 results. Use offset=3 to see more.]',
    );
    expect(executeSpy.mock.calls[0]?.[1]?.maxBuffer).toBe(100_000_000);
  });

  it('reports output-limit overflow without paginating partial matches', async () => {
    vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
      success: false,
      stdout: 'partial-match-one\npartial-match-two',
      stderr: 'maxBuffer exceeded',
      timedOut: false,
      exitCode: 2,
      outputLimitExceeded: true,
    });

    const result = await new GrepTool().call({
      pattern: 'item',
      output_mode: 'content',
      offset: 1,
      head_limit: 1,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('retained-output ceiling');
    expect(result.error).toContain('Narrow the search path or pattern');
    expect(result.error).toContain('glob/type filters');
    expect(result.error).toContain('Pagination with offset/head_limit');
    expect(result.error).not.toContain('Regex error');
    expect(result.error).not.toContain('partial-match');
  });

  it('preserves ripgrep error classification', async () => {
    vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
      success: false,
      stdout: null,
      stderr: 'regex parse error: unclosed group',
      timedOut: false,
      exitCode: 2,
    });

    const result = await new GrepTool().call({
      pattern: '(',
      output_mode: 'content',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Regex error: regex parse error');
    expect(result.error).toContain('literal: true');
  });
});
