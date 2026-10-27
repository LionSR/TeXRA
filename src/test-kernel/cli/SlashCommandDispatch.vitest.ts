// Test composition imports

import { it } from '@effect/vitest';
import { Effect } from 'effect';

// Slash command run dispatch.

import { afterEach, describe, expect, vi } from 'vitest';

import { handleTuiSlashCommand } from '@cli/chat/tui/commands/handleSlashCommand';
import { type SlashCommandContext } from '@cli/chat/tui/commands/handlers/slashContext';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import { installSlashCommands } from '@cli/chat/tui/commands/slashRegistry';
import { notices } from '@cli/chat/tui/state/transcript';
import { resetCliState } from '@cli/chat/tui/state/cliState';
import { activeForm } from '@cli/chat/tui/state/formSlot';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { withProcessServices } from '@platform/processRuntime';
import type { ApprovalPolicy } from '@shared/approvalPolicy';
import { type RunId } from '@shared/schemas';
import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

afterEach(() => {
  installSlashCommands([]);
  resetCliState();
});

/**
 * The process stores the built-in commands and the slash context read, the
 * pair the chat entry point threads in from its own platform services.
 */
const services = {
  secrets: new FakeSecrets(),
  stores: makeFakeSettingsStores('cli').stores,
  runtime: testRuntime(),
  runtimeSession: testSessionOf(testDefaultSession()),
  runSession: testSessionOf(testDefaultSession()),
};

function createContext(): SlashCommandContext {
  let approvalPolicy: ApprovalPolicy = 'ask';
  return {
    cliContext: createTestCliContext({
      cwd: '/tmp/workspace',
      mode: 'interactive',
      approvalPolicy: 'ask',
      stdoutIsTty: true,
      version: '0.0.0-test',
    }),
    session: new TuiSession(),
    ...services,
    processCwd: '/tmp/launcher',
    requestInputExit: vi.fn(),
    getApprovalPolicy: () => approvalPolicy,
    setApprovalPolicy: (policy) =>
      Effect.sync(() => {
        approvalPolicy = policy;
      }),
    resetSession: vi.fn(),
    resumeRun: (_id: RunId) => Effect.void,
  };
}

describe('handleTuiSlashCommand', () => {
  it.effect('discards inline key arguments without recording the secret', () =>
    Effect.gen(function* () {
      registerBuiltinSlashCommands({ ...services });
      const secret = 'sk-private-test-value';

      // The dispatcher as the composer runs it: one program on the process
      // services the composer threads in.
      const handled = yield* withProcessServices(
        services.runtime,
        handleTuiSlashCommand(`/keys ${secret}`, createContext()),
      );

      expect(handled).toBe(true);
      expect(activeForm.get()?.commandName).toBe('key');
      expect(JSON.stringify(activeForm.get())).not.toContain(secret);
      expect(JSON.stringify(notices.get())).not.toContain(secret);
    }),
  );
});
