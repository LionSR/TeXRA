import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { setupPlatform } from '@test/support/setupPlatform';
import { GrepTool } from '@tools/grep';
import * as execUtils from '@utils/system/execUtils';

describe('GrepTool run', () => {
  setupPlatform({ workspacePath: process.cwd() });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect(
    'preserves total-count and offset/head_limit pagination semantics',
    () =>
      Effect.gen(function* () {
        vi.spyOn(execUtils, 'executeCommand').mockReturnValue(
          Effect.succeed({
            success: true,
            stdout: 'one\n\ntwo\nthree\nfour\n',
            stderr: '',
            timedOut: false,
            exitCode: 0,
          }),
        );

        const result = yield* GrepTool.call({
          pattern: 'item',
          output_mode: 'content',
          offset: 1,
          head_limit: 2,
        });

        expect(result.output).toBe(
          'two\nthree\n\n[Showing 2 of 4 results. Use offset=3 to see more.]',
        );
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );
});
