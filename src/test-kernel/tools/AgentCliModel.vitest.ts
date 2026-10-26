// The model and effort the Claude Code tool sends the SDK.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { readClaudeCodeRun } from '@texra/tools/claudeAgentShared';

import { makeFakeSettingsStores } from '../support/settingsStoresFake';

describe('readClaudeCodeRun', () => {
  it.effect(
    'sends the API id, the default medium effort and adaptive thinking',
    () =>
      Effect.gen(function* () {
        expect(
          yield* readClaudeCodeRun(makeFakeSettingsStores().stores, {
            model: 'anthropic/claude-sonnet-5-5',
            effort: undefined,
          }),
        ).toEqual({
          ref: 'anthropic/claude-sonnet-5-5',
          model: 'claude-sonnet-5-5',
          effort: 'medium',
          thinking: { type: 'adaptive' },
          note: undefined,
        });
      }),
  );
});
