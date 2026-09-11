// Regression coverage for `executeSubagent`'s child run launch: it refuses to
// start a child when the parent run context carries no session, and it reports
// a detached run-loop rejection through the `childRunLoop` channel log.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import type { RunId } from '@shared/schemas';
import { fakeProcessServices } from '@test/support/setupPlatform';

const mocks = vi.hoisted(() => ({
  startChildRunLoop: vi.fn(),
  registerRun: vi.fn(),
  tryUseRunContext: vi.fn(),
  getCurrentToolCallContext: vi.fn(),
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

vi.mock('@agent/runtime/RunContext', () => {
  const readRunContextField = (context: any, field: string) =>
    context?.kind === 'launch' ? context.runScope[field] : context?.[field];
  return {
    tryUseRunContext: mocks.tryUseRunContext,
    runInSession: (_session: unknown, operation: () => unknown) => operation(),
    getRunContextRunId: (context: any) => readRunContextField(context, 'runId'),
    getRunContextSession: (context: any) =>
      readRunContextField(context, 'session'),
  };
});

vi.mock('@agent/followUp/ToolFileInteractionContext', () => ({
  getCurrentToolCallContext: mocks.getCurrentToolCallContext,
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

  function runDefaultSubagent() {
    return Effect.runPromise(
      Effect.provide(
        executeSubagent(
          mocks.tryUseRunContext(),
          mocks.getCurrentToolCallContext(),
          defaultPayload,
          'proof-checker',
          orchestratorRunId,
        ),
        fakeProcessServices(),
      ),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startChildRunLoop.mockReturnValue(Effect.forkDetach(Effect.void));
    mocks.registerRun.mockReturnValue(Effect.void);
    mocks.tryUseRunContext.mockReturnValue({
      runId: 'parent-exec',
      session: { tag: 'parent-session' },
      approvalPromptsUnavailable: false,
      runtimeUnavailableTools: [],
      stopAfterCycle: false,
    });
    mocks.getCurrentToolCallContext.mockReturnValue(undefined);
  });

  it('requires the run context to carry its owning session', async () => {
    mocks.tryUseRunContext.mockReturnValue({
      runId: 'parent-exec',
      approvalPromptsUnavailable: false,
      runtimeUnavailableTools: [],
      stopAfterCycle: false,
    });

    await expect(runDefaultSubagent()).resolves.toMatchObject({
      status: 'error',
      summary: 'Delegation session unavailable',
      diagnostics: { type: 'missing_session' },
    });
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('logs a detached run-loop rejection through the childRunLoop channel log', async () => {
    const lateFailure = new Error('late subagent finalization failed');
    mocks.startChildRunLoop.mockReturnValue(
      Effect.forkDetach(Effect.fail(lateFailure)),
    );

    await expect(runDefaultSubagent()).resolves.toMatchObject({
      status: 'executed',
    });
    await vi.waitFor(() => {
      expect(mocks.childLoopError).toHaveBeenCalledWith(
        "Subagent 'proof-checker' run loop failed after launch",
        { data: lateFailure },
      );
    });
  });
});
