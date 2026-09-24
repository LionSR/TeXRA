// Regression coverage for `executeSubagent`'s child run launch: it refuses to
// start a child when the parent run context carries no session, and it reports
// a detached run-loop rejection through the `childRunLoop` channel log.

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import { Runs } from '@agent/runtime/runRegistry';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import type { RunId } from '@shared/schemas';
import { emptyPinnedComposition } from '@test/support/nativeToolTestLayer';
import { noopTrace } from '@test/support/noopTrace';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { testRunRegistry } from '@test/support/runHandleFixtures';
import { fakeProcessServices } from '@test/support/setupPlatform';
import type { DelegationParent } from '@tools/delegation/proposalFlow';

const mocks = vi.hoisted(() => ({
  startChildRunLoop: vi.fn(),
  registerRun: vi.fn(),
}));

vi.mock('@agent/runtime/AgentLaunchContext', () => ({
  prepareAgentDefinition: ({ config }: { config: unknown }) =>
    Effect.succeed({ config }),
}));

vi.mock('@agent/runtime/childRunLoop', () => ({
  startChildRunLoop: mocks.startChildRunLoop,
  runWithOwnedRunLeaseLaunchGuard: (
    ...args: Parameters<
      typeof import('@agent/runtime/childRunLoop').runWithOwnedRunLeaseLaunchGuard
    >
  ) => args[2],
}));

vi.mock('@agent/storage', () => ({
  registerRun: mocks.registerRun,
}));

// `executeSubagent` registers through `registerRun`; route the spy through it.
vi.mock('@agent/storage/runLifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/storage/runLifecycle')>();
  return {
    ...actual,
    registerRun: mocks.registerRun,
  };
});

vi.mock('@tools/approval', () => ({
  configureDelegatedChildApprovals: vi.fn(),
}));

import { executeSubagent } from '@tools/delegation/subagentRun';

describe('executeSubagent child run launch', () => {
  const orchestratorRunId = 'orchestrator-stream' as RunId;

  const defaultPayload = {
    agent: 'proof-checker',
    model: 'gpt5',
    agentCategory: 'toolUse',
  } as never;

  const parent: DelegationParent = {
    roots: createFakeWorkspaceRoots(),
    tracker: new FileInteractionState(),
    run: {
      runId: 'parent-exec' as RunId,
      session: { tag: 'parent-session' } as never,
      config: AgentConfigSchema.parse({ agent: 'chat', model: 'gpt5' }),
      logger: noopTrace,
      toolPolicy: {
        approvalPromptsUnavailable: false,
      },
      composition: emptyPinnedComposition,
    },
  };

  function runDefaultSubagent() {
    return Effect.provide(
      executeSubagent(
        parent,
        defaultPayload,
        'proof-checker',
        orchestratorRunId,
      ).pipe(Effect.provideService(Runs, testRunRegistry())),
      fakeProcessServices(),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startChildRunLoop.mockReturnValue(Effect.forkDetach(Effect.void));
    mocks.registerRun.mockReturnValue(Effect.void);
  });

  afterEach(() => {
    setLogSink(null);
  });

  it.effect(
    'logs a detached run-loop rejection through the childRunLoop channel log',
    () =>
      Effect.gen(function* () {
        const lateFailure = new Error('late subagent finalization failed');
        mocks.startChildRunLoop.mockReturnValue(
          Effect.forkDetach(Effect.fail(lateFailure)),
        );

        const logs = captureLogEntries();

        expect(yield* runDefaultSubagent()).toMatchObject({
          status: 'executed',
        });

        // The report comes from the detached watcher fiber; let it run.
        while (logs.at('ERROR', 'childRunLoop').length === 0) {
          yield* Effect.yieldNow;
        }
        const [entry] = logs.at('ERROR', 'childRunLoop');
        expect(entry?.message).toBe(
          "Subagent 'proof-checker' run loop failed after launch",
        );
        expect(String(entry?.annotations['data'])).toContain(
          'late subagent finalization failed',
        );
      }).pipe(Effect.provide(effectDiagnosticsLayer('Trace'))),
  );
});
