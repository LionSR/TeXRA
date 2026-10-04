// Regression coverage for `launchDetachedSubagent`'s child run launch: it
// reports a detached run-loop rejection through the `childRunLoop` channel log.

import { it } from '@effect/vitest';
import { Effect, Scope } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import { Runs } from '@agent/runtime/runRegistry';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import type { RunId } from '@shared/schemas';
import { noStep, testModelCell } from '@test/support/nativeToolTestLayer';
import { noopTrace } from '@test/support/noopTrace';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { testRunRegistry } from '@test/support/runHandleFixtures';
import { fakeProcessServices } from '@test/support/setupPlatform';
import type { RunToolCall } from '@tools/core/toolRun';

const mocks = vi.hoisted(() => ({
  startChildRunLoop: vi.fn(),
  registerRun: vi.fn(),
}));

vi.mock('@agent/runtime/AgentLaunchContext', () => ({
  prepareAgentDefinition: ({ config }: { config: unknown }) =>
    Effect.succeed({ config, persona: { tools: [] }, task: null }),
}));

vi.mock('@agent/runtime/runLaunchGuard', () => ({
  runWithLaunchGuard: (
    ...args: Parameters<
      typeof import('@agent/runtime/runLaunchGuard').runWithLaunchGuard
    >
  ) => args[2],
}));

vi.mock('@agent/runtime/childRunLoop', () => ({
  startChildRunLoop: mocks.startChildRunLoop,
}));

vi.mock('@agent/storage', () => ({
  registerRun: mocks.registerRun,
}));

// `launchDetachedSubagent` registers through `registerRun`; route the spy through it.
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

import { launchDetachedSubagent } from '@tools/delegation/subagentRun';
import { RunFileService } from '@utils/files/runStorage';

describe('launchDetachedSubagent child run launch', () => {
  const defaultPayload = {
    agent: 'proof-checker',
    model: 'openai/gpt-5-2025-08-07',
  } as never;

  const roots = createFakeWorkspaceRoots();
  const parent: RunToolCall = {
    roots,
    tracker: new FileInteractionState(),
    requests: {
      nextId: (prefix: string) => prefix,
      open: () => Effect.die(new Error('This fixture opens no request.')),
    },
    run: {
      runId: 'parent-exec' as RunId,
      session: { tag: 'parent-session' } as never,
      task: null,
      opening: null,
      fileService: new RunFileService('parent-exec' as RunId, roots),
      steps: noStep(),
      scope: Scope.makeUnsafe(),
      config: AgentConfigSchema.parse({
        agent: 'chat',
        model: 'openai/gpt-5-2025-08-07',
      }),
      model: testModelCell('openai/gpt-5-2025-08-07'),
      logger: noopTrace,
      toolPolicy: {
        approvalPromptsUnavailable: false,
      },
    },
  };

  function runDefaultSubagent() {
    return Effect.provide(
      launchDetachedSubagent(parent, defaultPayload, {
        runId: 'child-run' as RunId,
        parentOffered: [],
        inheritChildRunApprovals: () => undefined,
      }).pipe(Effect.provideService(Runs, testRunRegistry())),
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
