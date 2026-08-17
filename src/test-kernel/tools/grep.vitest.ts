import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { platform } from '@platform/platform';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { setupPlatform } from '@test/support/setupPlatform';
import * as gitignoreUtils from '@tools/gitignore';
import { buildArguments, GrepTool, type GrepInput } from '@tools/grep';
import * as execUtils from '@utils/system/execUtils';

describe('buildArguments', () => {
  // output_mode is required after transform normalizes nullish to 'content'
  const baseInput: GrepInput = { pattern: 'example', output_mode: 'content' };

  it('omits --files-with-matches when using content mode', () => {
    const args = buildArguments(baseInput, 'content');
    expect(args).toEqual(['--color=never']);
  });

  it('includes --files-with-matches when explicitly requested', () => {
    const args = buildArguments(baseInput, 'files_with_matches');
    expect(args).toContain('--files-with-matches');
  });

  it('includes --fixed-strings when literal is true', () => {
    const args = buildArguments({ ...baseInput, literal: true }, 'content');
    expect(args).toContain('--fixed-strings');
  });

  it.each([false, null, undefined])(
    'omits --fixed-strings when literal is %s',
    (literal) => {
      const args = buildArguments({ ...baseInput, literal }, 'content');
      expect(args).not.toContain('--fixed-strings');
    },
  );
});

describe('GrepTool execution', () => {
  setupPlatform({ workspacePath: process.cwd() });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockWorkspaceGitignore(): void {
    vi.spyOn(gitignoreUtils, 'getGitignoreMatcher').mockResolvedValue({
      hasRules: true,
      ignores: () => false,
      ignoreFiles: ['/workspace/.gitignore'],
    });
  }

  it('preserves total-count and offset/head_limit pagination semantics', async () => {
    const executeSpy = vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
      success: true,
      stdout: 'one\n\ntwo\nthree\nfour\n',
      stderr: '',
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
      stdout: '',
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

  it('does not apply workspace ignore files to unrestricted external searches', async () => {
    mockWorkspaceGitignore();
    const executeSpy = vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
      success: true,
      stdout: '/outside/dist/external.tex:external\n',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    });
    await platform().workspaceState.update(
      WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
      false,
    );

    try {
      const result = await new GrepTool().call({
        pattern: 'external',
        path: '/outside/dist',
        output_mode: 'content',
      });

      expect(result.status).toBe('executed');
      expect(executeSpy).toHaveBeenCalledOnce();
      expect(executeSpy.mock.calls[0]?.[0]).not.toContain('--ignore-file');
    } finally {
      await platform().workspaceState.update(
        WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
        true,
      );
    }
  });

  it('retains workspace ignore files for an explicit working directory', async () => {
    mockWorkspaceGitignore();
    const executeSpy = vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      timedOut: false,
      exitCode: 1,
    });

    const result = await withRunContext(
      createRunContext({
        workingDirectory: '/outside/worktree',
      }),
      () =>
        new GrepTool().call({
          pattern: 'external',
          output_mode: 'content',
        }),
    );

    expect(result.status).toBe('executed');
    expect(executeSpy.mock.calls[0]?.[0]).toContain('--ignore-file');
  });
});
