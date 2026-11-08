// Slash command run dispatch.

import { layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { afterEach, expect, vi } from 'vitest';

import { handleTuiSlashCommand } from '@cli/chat/tui/commands/handleSlashCommand';
import { type SlashCommandContext } from '@cli/chat/tui/commands/handlers/slashContext';
import { builtinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import { notices } from '@cli/chat/tui/state/transcript';
import { resetCliState } from '@cli/chat/tui/state/cliState';
import { activeForm } from '@cli/chat/tui/state/formSlot';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { SessionGraph, TestSession } from '@test/support/testKernel';
import type { ApprovalPolicy, RunId } from '@texra-ai/harness/schemas';

/**
 * The process stores the built-in commands and the slash context read, the
 * pair the chat entry point threads in from its own platform services.
 */
const processServices = Effect.gen(function* () {
  const session = yield* TestSession;
  return {
    stores: makeFakeSettingsStores().stores,
    runtime: yield* SessionGraph.runtime,
    runSession: session,
  };
});

function createContext(
  services: Effect.Success<typeof processServices>,
): SlashCommandContext {
  let approvalPolicy: ApprovalPolicy = 'ask';
  const select = () => Effect.void;
  return {
    commands: builtinSlashCommands({
      ...services,
      onAgentSelect: select,
      onTeamSelect: select,
      onAccountChanged: () => Effect.void,
      canSelectAgent: () => true,
      getApprovalPolicy: () => approvalPolicy,
      onApprovalPolicySelect: select,
      onProjectApprovalPolicyChanged: vi.fn(),
      onModelSelect: select,
      canSelectModel: () => true,
      getModelSwitchDisabledReason: () => Effect.succeed(undefined),
      onModelAccessSelect: select,
      onLoginSelect: select,
      onMemorySelect: select,
      onResumeSelect: select,
      onSkillSelect: select,
      configRoots: services.runSession.roots,
      onError: vi.fn(),
    }),
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
    resumeTask: (_id: RunId) => Effect.void,
  };
}

layer(Layer.provideMerge(TestSession.layer(), SessionGraph.hosted))(
  'handleTuiSlashCommand',
  (it) => {
    afterEach(() => {
      resetCliState();
    });

    it.effect(
      'discards inline key arguments without recording the secret',
      () =>
        Effect.gen(function* () {
          const services = yield* processServices;
          const secret = 'sk-private-test-value';

          // The dispatcher as the composer runs it: one program on the process
          // services the composer threads in.
          const handled = yield* handleTuiSlashCommand(
            `/keys ${secret}`,
            createContext(services),
          );

          expect(handled).toBe(true);
          expect(activeForm.get()?.commandName).toBe('key');
          expect(JSON.stringify(activeForm.get())).not.toContain(secret);
          expect(JSON.stringify(notices.get())).not.toContain(secret);
        }),
    );
  },
);
