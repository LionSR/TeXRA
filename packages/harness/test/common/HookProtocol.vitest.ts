// Security edge of the Claude Code hooks protocol: exit 2 on PreToolUse
// denies even with invalid JSON (a policy hook must not fail open), and a
// `permissionDecision` is read as the hook's answer, whatever the exit code.
// A JSON answer longer than the context cap is read whole, never as raw text.
import { join } from 'node:path';

import { it as effectIt } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { describe, expect, it } from 'vitest';

import { interpretHookRun } from '@common/plugins/hookProtocol';
import { runHook } from '@common/plugins/pluginHooks';
import { nodePlatformServices } from '@platform/defaults/nodePlatform';

const ran = (
  exitCode: number,
  stdout = '',
  stderr = '',
): Parameters<typeof interpretHookRun>[1] => ({
  kind: 'exited',
  exitCode,
  stdout,
  stderr,
  cut: false,
});

const json = (value: unknown) => JSON.stringify(value);

describe('the Claude Code hooks protocol at our edge', () => {
  it('denies on exit 2 even when the JSON is invalid', () => {
    const verdict = interpretHookRun(
      { hook_event_name: 'PreToolUse' },
      ran(2, '{"hookSpecificOutput": 3}', 'no rm here\nmore'),
    );
    expect(verdict).toMatchObject({
      status: 'blocked',
      decision: 'deny',
      reason: 'no rm here\nmore',
    });
  });

  it('reads allow and deny as the hook answered them, whatever the exit code', () => {
    const allow = interpretHookRun(
      { hook_event_name: 'PreToolUse' },
      ran(
        0,
        json({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'fine',
          },
        }),
      ),
    );
    expect(allow).toMatchObject({
      status: 'ok',
      decision: 'allow',
      reason: 'fine',
      context: null,
    });
    const deny = interpretHookRun(
      { hook_event_name: 'PreToolUse' },
      ran(
        1,
        json({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Database writes are not allowed',
          },
        }),
      ),
    );
    expect(deny).toMatchObject({
      status: 'ok',
      decision: 'deny',
      reason: 'Database writes are not allowed',
    });
  });

  effectIt.live('reads a JSON answer longer than the context cap as JSON', () =>
    Effect.gen(function* () {
      const answer = json({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'x'.repeat(12_000),
        },
      });
      const dir =
        yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const { run } = yield* runHook(
        {
          id: 'test/SessionStart/0/0',
          event: 'SessionStart',
          matcher: undefined,
          command: process.execPath,
          args: ['-e', `process.stdout.write(${JSON.stringify(answer)})`],
          timeoutSeconds: 30,
        },
        '{}',
        { projectDir: dir, pluginRoot: dir, pluginData: join(dir, 'data') },
      );
      const verdict = interpretHookRun(
        { hook_event_name: 'SessionStart' },
        run,
      );
      expect(verdict.status).toBe('ok');
      expect(verdict.context === 'x'.repeat(10_000)).toBe(true);
    }).pipe(Effect.provide(nodePlatformServices)),
  );
});
