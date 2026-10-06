// Failure modes, written before the protocol module:
// 1. exit 2 on PreToolUse with output that is not valid JSON still denies,
//    with stderr as the reason (a policy hook must not fail open);
// 2. `permissionDecision: "allow"` never approves: it is no objection;
// 3. malformed JSON is `malformed` with a warning and no effect, never a
//    silent default;
// 4. plain stdout is context on UserPromptSubmit and SessionStart only;
// 5. a non-zero exit other than 2 with valid JSON lets the JSON decide;
// 6. a timeout renders no decision, so PreToolUse does not deny;
// 7. what v1 parses but does not act on (a prompt block, a stop block, an
//    input rewrite) is named as ignored, not dropped;
// 8. matchers: `*`/empty match all, an exact list, else an unanchored regex.
import { describe, expect, it } from 'vitest';

import { matchesHook } from '@common/plugins/hookConfig';
import { interpretHookRun } from '@common/plugins/hookProtocol';

const ran = (
  exitCode: number,
  stdout = '',
  stderr = '',
): Parameters<typeof interpretHookRun>[1] => ({
  kind: 'exited',
  exitCode,
  stdout,
  stderr,
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
      deny: 'no rm here\nmore',
    });
  });

  it('reads allow as no objection and deny as a denial, whatever the exit code', () => {
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
    expect(allow).toMatchObject({ status: 'ok', deny: null, context: null });
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
      deny: 'Database writes are not allowed',
    });
  });

  it('turns malformed output into a warning with no effect', () => {
    for (const stdout of [
      '{not json}',
      json({ hookSpecificOutput: { hookEventName: 'PostToolUse' } }),
      json({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'maybe',
        },
      }),
    ]) {
      const verdict = interpretHookRun(
        { hook_event_name: 'PreToolUse' },
        ran(0, stdout),
      );
      expect(verdict.status).toBe('malformed');
      expect(verdict.deny).toBeNull();
      expect(verdict.context).toBeNull();
      expect(verdict.warning).toMatch(/PreToolUse/);
    }
  });

  it('adds plain stdout as context only where the reference does', () => {
    expect(
      interpretHookRun(
        { hook_event_name: 'UserPromptSubmit' },
        ran(0, 'branch: main\n'),
      ).context,
    ).toBe('branch: main');
    expect(
      interpretHookRun({ hook_event_name: 'SessionStart' }, ran(0, 'hello'))
        .context,
    ).toBe('hello');
    expect(
      interpretHookRun({ hook_event_name: 'PreToolUse' }, ran(0, 'hello')),
    ).toMatchObject({
      status: 'ok',
      context: null,
      deny: null,
    });
  });

  it('gives PostToolUse feedback from a block reason, context, or exit 2', () => {
    expect(
      interpretHookRun(
        { hook_event_name: 'PostToolUse' },
        ran(
          0,
          json({
            decision: 'block',
            reason: 'lint failed',
            hookSpecificOutput: {
              hookEventName: 'PostToolUse',
              additionalContext: 'file is generated',
            },
          }),
        ),
      ).context,
    ).toBe('lint failed\nfile is generated');
    expect(
      interpretHookRun(
        { hook_event_name: 'PostToolUse' },
        ran(2, '', 'tests broke'),
      ),
    ).toMatchObject({ status: 'blocked', context: 'tests broke' });
  });

  it('renders no decision on a timeout', () => {
    const verdict = interpretHookRun(
      { hook_event_name: 'PreToolUse' },
      {
        kind: 'timeout',
        stdout: '',
        stderr: '',
      },
    );
    expect(verdict).toMatchObject({ status: 'timeout', deny: null });
    expect(verdict.warning).toMatch(/timed out/);
  });

  it('names what v1 parses but does not act on', () => {
    const prompt = interpretHookRun(
      { hook_event_name: 'UserPromptSubmit' },
      ran(
        0,
        json({
          decision: 'block',
          reason: 'no',
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: 'ctx',
          },
        }),
      ),
    );
    expect(prompt.context).toBe('ctx');
    expect(prompt.ignored.join(' ')).toMatch(/block/);
    // A stop's block is the instruction the run continues with, once.
    const stop = { hook_event_name: 'Stop', stop_hook_active: false } as const;
    expect(interpretHookRun(stop, ran(2, '', 'keep going'))).toMatchObject({
      status: 'blocked',
      context: 'keep going',
      ignored: [],
    });
    const block = json({ decision: 'block', reason: 'run the tests' });
    expect(interpretHookRun(stop, ran(0, block)).context).toBe('run the tests');
    const again = interpretHookRun(
      { ...stop, stop_hook_active: true },
      ran(2, block, 'keep going'),
    );
    expect(again).toMatchObject({ status: 'blocked', context: null });
    expect(again.ignored).toHaveLength(1);
    expect(again.warning).toMatch(/second block/);
    const rewrite = interpretHookRun(
      { hook_event_name: 'PreToolUse' },
      ran(
        0,
        json({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: { command: 'ls' },
          },
        }),
      ),
    );
    expect(rewrite.ignored.join(' ')).toMatch(/updatedInput/);
  });

  it('fails a non-zero exit with plain output loudly and without effect', () => {
    const verdict = interpretHookRun(
      { hook_event_name: 'PreToolUse' },
      ran(1, 'oops', 'first line\nsecond'),
    );
    expect(verdict).toMatchObject({ status: 'failed', deny: null });
    expect(verdict.warning).toMatch(/first line/);
  });

  it('matches tool names the way the reference does', () => {
    expect(matchesHook(undefined, ['Bash'])).toBe(true);
    expect(matchesHook('*', ['Bash'])).toBe(true);
    expect(matchesHook('', ['Bash'])).toBe(true);
    expect(matchesHook('Bash', ['Bash', 'bash'])).toBe(true);
    expect(matchesHook('Edit|Write', ['Write', 'write_file'])).toBe(true);
    expect(matchesHook('Edit, Write', ['Read', 'read_file'])).toBe(false);
    expect(matchesHook('Bash', ['BashOutput'])).toBe(false);
    expect(matchesHook('^Notebook', ['NotebookEdit'])).toBe(true);
    expect(matchesHook('mcp__.*', ['mcp__memory__read'])).toBe(true);
  });
});
