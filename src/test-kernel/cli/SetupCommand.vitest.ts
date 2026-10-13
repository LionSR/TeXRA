import { Effect } from 'effect';
import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

import { runSetup } from '@cli/commands/setup';
import { CliUsageError } from '@cli/runtime/cliContext';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

// `texra setup` is the chat with the setup agent pinned: the chat's own
// startup opens the "Connect a model" panel when no credential exists, so
// the command decides nothing about credentials itself.

const INTERACTIVE_CONTEXT = createTestCliContext({
  mode: 'interactive',
  stdoutIsTty: true,
});

describe('texra setup', () => {
  it('rejects non-interactive terminals before doing anything', () => {
    expect(() =>
      runSetup({
        ...INTERACTIVE_CONTEXT,
        mode: 'headless',
      }),
    ).toThrow(CliUsageError);
  });

  it.effect('names the setup-agent chat as the session to mount', () =>
    Effect.gen(function* () {
      const outcome = yield* runSetup(INTERACTIVE_CONTEXT);

      expect(outcome).toEqual({ chat: { agentOverride: SETUP_AGENT_NAME } });
    }),
  );
});
