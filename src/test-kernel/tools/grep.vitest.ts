import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import { workspaceRoots } from '@platform/workspaceRoots';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { setupPlatform } from '@test/support/setupPlatform';
import * as gitignoreUtils from '@tools/gitignore';
import { GrepTool } from '@tools/grep';
import * as execUtils from '@utils/system/execUtils';

describe('GrepTool run', () => {
  setupPlatform({ workspacePath: process.cwd() });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockWorkspaceGitignore(): void {
    vi.spyOn(gitignoreUtils, 'getGitignoreMatcher').mockReturnValue(
      Effect.succeed({
        ignores: () => false,
        ignoreFiles: ['/workspace/.gitignore'],
      }),
    );
  }

  it.effect(
    'preserves total-count and offset/head_limit pagination semantics',
    () =>
      Effect.gen(function* () {
        const executeSpy = vi
          .spyOn(execUtils, 'executeCommand')
          .mockResolvedValue({
            success: true,
            stdout: 'one\n\ntwo\nthree\nfour\n',
            stderr: '',
            timedOut: false,
            exitCode: 0,
          });

        const result = yield* new GrepTool().call({
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
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.effect('omits the continuation hint on an exact final page', () =>
    Effect.gen(function* () {
      vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
        success: true,
        stdout: 'one\ntwo\nthree\nfour\n',
        stderr: '',
        timedOut: false,
        exitCode: 0,
      });

      const result = yield* new GrepTool().call({
        pattern: 'item',
        output_mode: 'content',
        offset: 2,
        head_limit: 2,
      });

      expect(result).toMatchObject({
        status: 'executed',
        summary: expect.stringContaining('Found 2 of 4 matches'),
        output: 'three\nfour',
      });
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.effect(
    'reports output-limit overflow without paginating partial matches',
    () =>
      Effect.gen(function* () {
        vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
          success: false,
          stdout: 'partial-match-one\npartial-match-two',
          stderr: 'maxBuffer exceeded',
          timedOut: false,
          exitCode: 2,
          outputLimitExceeded: true,
        });

        const result = yield* new GrepTool().call({
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
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.effect('preserves ripgrep error classification', () =>
    Effect.gen(function* () {
      vi.spyOn(execUtils, 'executeCommand').mockResolvedValue({
        success: false,
        stdout: '',
        stderr: 'regex parse error: unclosed group',
        timedOut: false,
        exitCode: 2,
      });

      const result = yield* new GrepTool().call({
        pattern: '(',
        output_mode: 'content',
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain('Regex error: regex parse error');
      expect(result.error).toContain('literal: true');
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.effect(
    'does not apply workspace ignore files to unrestricted external searches',
    () =>
      Effect.gen(function* () {
        mockWorkspaceGitignore();
        const executeSpy = vi
          .spyOn(execUtils, 'executeCommand')
          .mockResolvedValue({
            success: true,
            stdout: '/outside/dist/external.tex:external\n',
            stderr: '',
            timedOut: false,
            exitCode: 0,
          });
        yield* Effect.promise(() =>
          workspaceRoots().workspaceState.update(
            WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
            false,
          ),
        );

        try {
          const result = yield* new GrepTool().call({
            pattern: 'external',
            path: '/outside/dist',
            output_mode: 'content',
          });

          expect(result.status).toBe('executed');
          expect(executeSpy).toHaveBeenCalledOnce();
          expect(executeSpy.mock.calls[0]?.[0]).not.toContain('--ignore-file');
        } finally {
          yield* Effect.promise(() =>
            workspaceRoots().workspaceState.update(
              WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
              true,
            ),
          );
        }
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.effect(
    'retains workspace ignore files for an explicit working directory',
    () =>
      Effect.gen(function* () {
        mockWorkspaceGitignore();
        const executeSpy = vi
          .spyOn(execUtils, 'executeCommand')
          .mockResolvedValue({
            success: true,
            stdout: '',
            stderr: '',
            timedOut: false,
            exitCode: 1,
          });

        const result = yield* new GrepTool()
          .call({
            pattern: 'external',
            output_mode: 'content',
          })
          .pipe(
            Effect.provide(
              nativeToolTestLayer({ workingDirectory: '/outside/worktree' }),
            ),
          );

        expect(result.status).toBe('executed');
        expect(executeSpy.mock.calls[0]?.[0]).toContain('--ignore-file');
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );
});
