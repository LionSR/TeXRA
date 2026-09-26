// Test setup imports
import '@test/support/sessionGraphTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { beforeEach, describe, expect, onTestFinished, vi } from 'vitest';

// Local imports
import { getRunRecords } from '@agent/storage';
import {
  AgentConfigSchema,
  ToolUseAgentConfigSchema,
} from '@agent/core/definition/AgentConfig';
import * as AgentRun from '@agent/runtime/executeAgent';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import * as SessionResumeRetrieval from '@agent/runtime/SessionResumeRetrieval';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import * as AgentRunner from '@agent/runtime/runAgent';
import { DesktopProcessResumeOwner } from '@desktop/main/desktopAgentResume';
import {
  AgentCategory,
  aggregateId,
  emptyRunEndOutput,
  RUN_OUTCOME,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createDeferred } from '@test/support/asyncTestUtils';
import {
  createProcessSession,
  publishTestRunStart,
  queuedFollowUps,
} from '@test/support/sessionTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { ensureError } from '@utils/errors/errorMessage';

const retrieveSessionResumeData = vi.spyOn(
  SessionResumeRetrieval,
  'retrieveSessionResumeData',
);
const runAgent = vi.spyOn(AgentRunner, 'runAgent');
const resumeToolUseFromResumeData = vi.spyOn(
  AgentRun,
  'resumeToolUseFromResumeData',
);

let testSession: SessionHandle;
const runId = 'abc123' as RunId;
const config = ToolUseAgentConfigSchema.parse({
  agent: 'proofreader',
  model: 'deepseekproT',
  agentCategory: AgentCategory.ToolUse,
});
const workflowConfig = AgentConfigSchema.parse({
  agent: 'proofreader',
  model: 'deepseekproT',
  agentCategory: AgentCategory.Workflow,
});

/** Persist the durable run record `resumeRun` resolves before launching. */
async function persistRunRecord(
  category: 'toolUse' | 'workflow',
): Promise<void> {
  await Effect.runPromise(
    getRunRecords(testSession, runId).writeRunRecord(
      category === 'toolUse' ? config : workflowConfig,
    ),
  );
}

function failedRunEnd(
  category: AgentCategory,
  message: string,
): SessionEventDraft {
  return {
    type: 'run.end',
    aggregateId: aggregateId('run', runId),
    outcome: RUN_OUTCOME.FAILED,
    output: emptyRunEndOutput(category),
    error: { kind: 'unexpected', message },
  };
}

function completedRunEnd(): SessionEventDraft {
  return {
    type: 'run.end',
    aggregateId: aggregateId('run', runId),
    outcome: RUN_OUTCOME.COMPLETED,
    output: emptyRunEndOutput(AgentCategory.Workflow),
  };
}

function completedRunResult(): AgentFlowResult {
  return {
    runId,
    outcome: RUN_OUTCOME.COMPLETED,
    output: emptyRunEndOutput(AgentCategory.Workflow),
  };
}

/** runAgent fails after lifecycle startup, publishing one failed result. */
function failAfterLifecycle(
  session: SessionHandle,
  category: AgentCategory,
  message: string,
): void {
  runAgent.mockImplementation((_request, options) =>
    Effect.tryPromise({
      try: async () => {
        await Effect.runPromise(options.onRun?.(runId) ?? Effect.void);
        session.publish([failedRunEnd(category, message)]);
        throw new Error(message);
      },
      catch: ensureError,
    }),
  );
}

function expectOneErrorPresentation(
  presenter: { emit: ReturnType<typeof vi.fn> },
  message: string,
): void {
  expect(presenter.emit).toHaveBeenCalledOnce();
  expect(presenter.emit).toHaveBeenCalledWith('requestShowError', { message });
}

function attachResultPresenter(session: SessionHandle): {
  emit: ReturnType<typeof vi.fn>;
  detach(): void;
} {
  const emit = vi.fn();
  return {
    emit,
    detach: Effect.runSync(session.interactions.use({ emit })),
  };
}

/** Harness disposal is idempotent so tests can shut it down mid-test. */
async function createResumeHarness(): Promise<{
  owner: DesktopProcessResumeOwner;
  session: SessionHandle;
  dispose(): Promise<void>;
}> {
  const session = testSession;
  session.publish([
    {
      type: 'run.config',
      aggregateId: aggregateId('run', runId),
      config,
    },
  ]);
  await Effect.runPromise(session.settlePublications());
  const owner = new DesktopProcessResumeOwner({
    sessions: () => [session],
    runtime: testRuntime,
  });
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    owner.disable();
    await Effect.runPromise(closeSessionOf(session));
  };
  onTestFinished(dispose);
  return { owner, session, dispose };
}

async function mockWorkflowResume(): Promise<void> {
  await persistRunRecord('workflow');
  retrieveSessionResumeData.mockReturnValue(
    Effect.succeed({
      type: 'workflow',
      agentConfig: workflowConfig,
      runId,
      modelCompatibilityKey: null,
    }),
  );
}

/** Hold workflow resume data retrieval open until the test releases it. */
async function gateWorkflowResume(): Promise<{
  started: Promise<void>;
  release: () => void;
}> {
  await persistRunRecord('workflow');
  const started = createDeferred();
  const gate = createDeferred();
  retrieveSessionResumeData.mockImplementation(() =>
    Effect.tryPromise({
      try: async () => {
        started.resolve();
        await gate.promise;
        return {
          type: 'workflow' as const,
          agentConfig: workflowConfig,
          runId,
          modelCompatibilityKey: null,
        };
      },
      catch: ensureError,
    }),
  );
  return { started: started.promise, release: () => gate.resolve() };
}

describe('desktop process resume owner', () => {
  beforeEach(async () => {
    testSession = await Effect.runPromise(createProcessSession());
    publishTestRunStart(testSession, runId);
    await Effect.runPromise(testSession.settlePublications());
    retrieveSessionResumeData.mockReset();
    resumeToolUseFromResumeData.mockReset();
    runAgent.mockReset().mockReturnValue(Effect.succeed(completedRunResult()));
  });

  it.effect('resumes while no BrowserWindow presentation exists', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => mockWorkflowResume());
      const harness = yield* Effect.promise(() => createResumeHarness());

      expect(yield* harness.owner.tryResumeRun(runId)).toBe(true);
      expect(runAgent).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    'presents one error when workflow resume fails before lifecycle startup',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mockWorkflowResume());
        runAgent.mockReturnValue(Effect.fail(new Error('launch failed')));
        const harness = yield* Effect.promise(() => createResumeHarness());
        const presenter = attachResultPresenter(harness.session);

        expect(yield* harness.owner.tryResumeRun(runId)).toBe(false);
        expectOneErrorPresentation(presenter, 'Resume failed: launch failed');
        expect(runAgent.mock.calls[0]?.[1].suppressErrorNotification).toBe(
          true,
        );

        presenter.detach();
        const replacement = attachResultPresenter(harness.session);
        expect(replacement.emit).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'replays one detached post-lifecycle workflow failure on replacement',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mockWorkflowResume());
        const harness = yield* Effect.promise(() => createResumeHarness());
        failAfterLifecycle(
          harness.session,
          'workflow',
          'detached lifecycle failed',
        );
        attachResultPresenter(harness.session).detach();

        expect(yield* harness.owner.tryResumeRun(runId)).toBe(false);
        const replacement = attachResultPresenter(harness.session);
        yield* Effect.promise(() => Promise.resolve());
        expectOneErrorPresentation(
          replacement,
          'Resume failed: detached lifecycle failed',
        );
        replacement.detach();

        const secondReplacement = attachResultPresenter(harness.session);
        yield* Effect.promise(() => Promise.resolve());
        expect(secondReplacement.emit).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'presents one tool-use failure after lifecycle startup and restores follow-ups',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => persistRunRecord('toolUse'));
        retrieveSessionResumeData.mockReturnValue(
          Effect.succeed(createToolUseResumeData({ runId })),
        );
        const harness = yield* Effect.promise(() => createResumeHarness());
        const flow = harness.session.followUps.claimLive(runId, 'flow')!;
        yield* harness.session.followUps.submit(
          runId,
          { text: 'keep this queued' },
          'live_owner',
        );
        harness.session.followUps.release(flow, 'recoverable');
        resumeToolUseFromResumeData.mockImplementation((_resume, options) =>
          Effect.tryPromise({
            try: async () => {
              await Effect.runPromise(options?.onRun?.(runId) ?? Effect.void);
              harness.session.publish([
                failedRunEnd(
                  AgentCategory.ToolUse,
                  'tool-use lifecycle failed',
                ),
              ]);
              throw new Error('tool-use lifecycle failed');
            },
            catch: ensureError,
          }),
        );
        const presenter = attachResultPresenter(harness.session);

        expect(yield* harness.owner.tryResumeRun(runId)).toBe(false);
        expectOneErrorPresentation(
          presenter,
          'Resume failed: tool-use lifecycle failed',
        );
        expect(yield* queuedFollowUps(harness.session, runId)).toMatchObject([
          { text: 'keep this queued' },
        ]);
      }),
  );

  it.effect('does not duplicate a terminal resume failure presentation', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => mockWorkflowResume());
      const harness = yield* Effect.promise(() => createResumeHarness());
      failAfterLifecycle(
        harness.session,
        AgentCategory.Workflow,
        'terminal resume failed',
      );

      expect(yield* harness.owner.tryResumeRun(runId)).toBe(false);
      const presenter = attachResultPresenter(harness.session);
      yield* Effect.promise(() => Promise.resolve());
      expectOneErrorPresentation(
        presenter,
        'Resume failed: terminal resume failed',
      );
    }),
  );

  it.effect(
    'reports a resume failure that follows a completed terminal result',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mockWorkflowResume());
        const harness = yield* Effect.promise(() => createResumeHarness());
        runAgent.mockImplementation((_request, options) =>
          Effect.tryPromise({
            try: async () => {
              await Effect.runPromise(options.onRun?.(runId) ?? Effect.void);
              options.session?.publish([completedRunEnd()]);
              throw new Error('final artifact flush failed');
            },
            catch: ensureError,
          }),
        );

        expect(yield* harness.owner.tryResumeRun(runId)).toBe(false);
        const presenter = attachResultPresenter(harness.session);
        yield* Effect.promise(() => Promise.resolve());
        expectOneErrorPresentation(
          presenter,
          'Resume failed: final artifact flush failed',
        );
      }),
  );

  it.effect(
    'rejects a termination-triggered wake after shutdown disables resume',
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createResumeHarness());

        yield* Effect.promise(() => harness.dispose());
        expect(yield* harness.owner.tryResumeRun(runId)).toBe(false);
        expect(retrieveSessionResumeData).not.toHaveBeenCalled();
      }),
  );

  it.effect('cancels an in-flight resume before shutdown can launch it', () =>
    Effect.gen(function* () {
      const retrieval = yield* Effect.promise(() => gateWorkflowResume());
      const harness = yield* Effect.promise(() => createResumeHarness());

      const resume = yield* Effect.forkChild(
        harness.owner.tryResumeRun(runId),
        { startImmediately: true },
      );
      yield* Effect.promise(() => retrieval.started);
      yield* Effect.promise(() => harness.dispose());
      retrieval.release();

      expect(yield* Fiber.join(resume)).toBe(false);
      expect(runAgent).not.toHaveBeenCalled();
    }),
  );

  it.effect('does not resume or recreate a run deleted during retrieval', () =>
    Effect.gen(function* () {
      const retrieval = yield* Effect.promise(() => gateWorkflowResume());
      const harness = yield* Effect.promise(() => createResumeHarness());

      const resume = yield* Effect.forkChild(
        harness.owner.tryResumeRun(runId),
        { startImmediately: true },
      );
      yield* Effect.promise(() => retrieval.started);
      harness.session.publish([
        { type: 'run.removed', aggregateId: aggregateId('run', runId) },
      ]);
      yield* harness.session.settlePublications();
      retrieval.release();

      expect(yield* Fiber.join(resume)).toBe(false);
      expect(runAgent).not.toHaveBeenCalled();
      expect(harness.session.runView(runId)).toBeUndefined();
    }),
  );

  it.effect(
    'rejects a stale process store after another process deletes the run',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mockWorkflowResume());
        const harness = yield* Effect.promise(() => createResumeHarness());
        vi.spyOn(harness.session, 'readRunEvents').mockReturnValue(
          Effect.succeed([]),
        );

        expect(yield* harness.owner.tryResumeRun(runId)).toBe(false);
        expect(runAgent).not.toHaveBeenCalled();
        expect(retrieveSessionResumeData).not.toHaveBeenCalled();
        expect(harness.session.runView(runId)).toBeDefined();
      }),
  );
});
