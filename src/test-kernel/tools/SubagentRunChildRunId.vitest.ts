// Regression coverage for `executeSubagent`'s child run launch: it refuses to
// start a child when the parent run context carries no session, and it reports
// a detached run-loop rejection through the `childRunLoop` channel log.

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import type { RunId } from '@shared/schemas';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { fakeProcessServices } from '@test/support/setupPlatform';
import type { DelegationParent } from '@tools/delegation/proposalFlow';

const mocks = vi.hoisted(() => ({
  startChildRunLoop: vi.fn(),
  registerRun: vi.fn(),
  childLoopError: vi.fn(),
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

// `executeSubagent` reports a late detached-loop failure through an inline
// `createLog('childRunLoop')` call; spread the real module so the graph's
// other `createLog` consumers (e.g. `runLifecycle`,
// `inBandSubagentRun`) keep working loggers.
vi.mock('@logger/logUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@logger/logUtils')>();
  return {
    ...actual,
    createLog: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: mocks.childLoopError,
    }),
  };
});

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

vi.mock('@agent/storage/runLease', () => ({
  assertOwnedRunLease: vi.fn(),
}));

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
    model: 'gpt5',
    tracker: new FileInteractionState(),
    run: {
      runId: 'parent-exec' as RunId,
      session: { tag: 'parent-session' } as never,
      toolPolicy: {
        approvalPromptsUnavailable: false,
        runtimeUnavailableTools: [],
      },
    },
    inScope: (operation) => operation(),
  };

  function runDefaultSubagent() {
    return Effect.provide(
      executeSubagent(
        parent,
        defaultPayload,
        'proof-checker',
        orchestratorRunId,
      ),
      fakeProcessServices(),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startChildRunLoop.mockReturnValue(Effect.forkDetach(Effect.void));
    mocks.registerRun.mockReturnValue(Effect.void);
  });

  it.effect(
    'logs a detached run-loop rejection through the childRunLoop channel log',
    () =>
      Effect.gen(function* () {
        const lateFailure = new Error('late subagent finalization failed');
        mocks.startChildRunLoop.mockReturnValue(
          Effect.forkDetach(Effect.fail(lateFailure)),
        );

        expect(yield* runDefaultSubagent()).toMatchObject({
          status: 'executed',
        });
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(mocks.childLoopError).toHaveBeenCalledWith(
              "Subagent 'proof-checker' run loop failed after launch",
              { data: lateFailure },
            );
          }),
        );
      }),
  );
});
