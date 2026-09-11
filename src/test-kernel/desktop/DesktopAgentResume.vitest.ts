// Test setup imports
import '@test/support/sessionGraphTestSetup';

// Third-party imports
import { Effect } from 'effect';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

// Local imports
import type { ResultEvent } from '@agent/trace';
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
  RUN_OUTCOME,
  type RunId,
} from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import {
  createProcessSession,
  publishTestRunStart,
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

function failedResult(
  category: ResultEvent['category'],
  message: string,
): ResultEvent {
  return {
    type: 'result',
    outcome: RUN_OUTCOME.FAILED,
    runId,
    agentName: 'proofreader',
    category,
    error: { kind: 'unexpected', message },
  };
}

function completedResult(): ResultEvent {
  return {
    type: 'result',
    outcome: RUN_OUTCOME.COMPLETED,
    runId,
    agentName: 'proofreader',
    category: 'workflow',
  };
}

function completedRunResult(): AgentFlowResult {
  return {
    runId,
    category: 'workflow',
    outcome: RUN_OUTCOME.COMPLETED,
    outputs: [],
    compileFailures: [],
  };
}

/** runAgent fails after lifecycle startup, publishing one failed result. */
function failAfterLifecycle(
  session: SessionHandle,
  category: ResultEvent['category'],
  message: string,
): void {
  runAgent.mockImplementation((_request, options) =>
    Effect.tryPromise({
      try: async () => {
        await options.onRun?.({} as never);
        session.publishRunEvent(runId, failedResult(category, message));
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
    detach: session.interactions.use({ emit, cancel: vi.fn() }),
  };
}

/** Harness disposal is idempotent so tests can shut it down mid-test. */
async function createResumeHarness(): Promise<{
  owner: DesktopProcessResumeOwner;
  session: SessionHandle;
  dispose(): void;
}> {
  const session = testSession;
  session.publish([
    {
      type: 'run.config',
      aggregateId: aggregateId('run', runId),
      config,
    },
  ]);
  await session.settlePublications();
  const owner = new DesktopProcessResumeOwner({ sessions: () => [session] });
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    owner.disable();
    session.dispose();
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
        };
      },
      catch: ensureError,
    }),
  );
  return { started: started.promise, release: () => gate.resolve() };
}

describe('desktop process resume owner', () => {
  beforeEach(async () => {
    testSession = createProcessSession();
    publishTestRunStart(testSession, runId);
    await testSession.settlePublications();
    retrieveSessionResumeData.mockReset();
    resumeToolUseFromResumeData.mockReset();
    runAgent.mockReset().mockReturnValue(Effect.succeed(completedRunResult()));
  });

  it('resumes while no BrowserWindow presentation exists', async () => {
    await mockWorkflowResume();
    const harness = await createResumeHarness();

    await expect(harness.owner.tryResumeRun(runId)).resolves.toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it('presents one error when workflow resume fails before lifecycle startup', async () => {
    await mockWorkflowResume();
    runAgent.mockReturnValue(Effect.fail(new Error('launch failed')));
    const harness = await createResumeHarness();
    const presenter = attachResultPresenter(harness.session);

    await expect(harness.owner.tryResumeRun(runId)).resolves.toBe(false);
    expectOneErrorPresentation(presenter, 'Resume failed: launch failed');
    expect(runAgent.mock.calls[0]?.[1].suppressErrorNotification).toBe(true);

    presenter.detach();
    const replacement = attachResultPresenter(harness.session);
    expect(replacement.emit).not.toHaveBeenCalled();
  });

  it('presents one workflow failure after lifecycle startup', async () => {
    await mockWorkflowResume();
    const harness = await createResumeHarness();
    failAfterLifecycle(
      harness.session,
      'workflow',
      'workflow lifecycle failed',
    );
    const presenter = attachResultPresenter(harness.session);

    await expect(harness.owner.tryResumeRun(runId)).resolves.toBe(false);
    expectOneErrorPresentation(
      presenter,
      'Resume failed: workflow lifecycle failed',
    );
  });

  it('replays one detached post-lifecycle workflow failure on replacement', async () => {
    await mockWorkflowResume();
    const harness = await createResumeHarness();
    failAfterLifecycle(
      harness.session,
      'workflow',
      'detached lifecycle failed',
    );
    attachResultPresenter(harness.session).detach();

    await expect(harness.owner.tryResumeRun(runId)).resolves.toBe(false);
    const replacement = attachResultPresenter(harness.session);
    await Promise.resolve();
    expectOneErrorPresentation(
      replacement,
      'Resume failed: detached lifecycle failed',
    );
    replacement.detach();

    const secondReplacement = attachResultPresenter(harness.session);
    await Promise.resolve();
    expect(secondReplacement.emit).not.toHaveBeenCalled();
  });

  it('presents one tool-use failure after lifecycle startup and restores follow-ups', async () => {
    await persistRunRecord('toolUse');
    retrieveSessionResumeData.mockReturnValue(
      Effect.succeed(createToolUseResumeData({ runId })),
    );
    const harness = await createResumeHarness();
    const flow = harness.session.followUps.claimLive(runId, 'flow')!;
    harness.session.followUps.queue(flow).enqueue({ text: 'keep this queued' });
    harness.session.followUps.release(flow, 'recoverable');
    resumeToolUseFromResumeData.mockImplementation((_resume, options) =>
      Effect.tryPromise({
        try: async () => {
          await options?.onRun?.({} as never);
          harness.session.publishRunEvent(
            runId,
            failedResult('toolUse', 'tool-use lifecycle failed'),
          );
          throw new Error('tool-use lifecycle failed');
        },
        catch: ensureError,
      }),
    );
    const presenter = attachResultPresenter(harness.session);

    await expect(harness.owner.tryResumeRun(runId)).resolves.toBe(false);
    expectOneErrorPresentation(
      presenter,
      'Resume failed: tool-use lifecycle failed',
    );
    expect(harness.session.followUps.getAll(runId)).toEqual([
      'keep this queued',
    ]);
  });

  it('does not duplicate a terminal resume failure presentation', async () => {
    await mockWorkflowResume();
    const harness = await createResumeHarness();
    failAfterLifecycle(harness.session, 'workflow', 'terminal resume failed');

    await expect(harness.owner.tryResumeRun(runId)).resolves.toBe(false);
    const presenter = attachResultPresenter(harness.session);
    await Promise.resolve();
    expectOneErrorPresentation(
      presenter,
      'Resume failed: terminal resume failed',
    );
  });

  it('reports a resume failure that follows a completed terminal result', async () => {
    await mockWorkflowResume();
    const harness = await createResumeHarness();
    runAgent.mockImplementation((_request, options) =>
      Effect.tryPromise({
        try: async () => {
          await options.onRun?.({} as never);
          options.session?.publishRunEvent(runId, completedResult());
          throw new Error('final artifact flush failed');
        },
        catch: ensureError,
      }),
    );

    await expect(harness.owner.tryResumeRun(runId)).resolves.toBe(false);
    const presenter = attachResultPresenter(harness.session);
    await Promise.resolve();
    expectOneErrorPresentation(
      presenter,
      'Resume failed: final artifact flush failed',
    );
  });

  it('rejects a termination-triggered wake after shutdown disables resume', async () => {
    const harness = await createResumeHarness();

    harness.dispose();
    await expect(harness.owner.tryResumeRun(runId)).resolves.toBe(false);
    expect(retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('cancels an in-flight resume before shutdown can launch it', async () => {
    const retrieval = await gateWorkflowResume();
    const harness = await createResumeHarness();

    const resume = harness.owner.tryResumeRun(runId);
    await retrieval.started;
    harness.dispose();
    retrieval.release();

    await expect(resume).resolves.toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('does not resume or recreate a run deleted during retrieval', async () => {
    const retrieval = await gateWorkflowResume();
    const harness = await createResumeHarness();

    const resume = harness.owner.tryResumeRun(runId);
    await retrieval.started;
    harness.session.publish([
      { type: 'run.removed', aggregateId: aggregateId('run', runId) },
    ]);
    await harness.session.settlePublications();
    retrieval.release();

    await expect(resume).resolves.toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
    expect(harness.session.transcripts.has(runId)).toBe(false);
  });

  it('rejects a stale process store after another process deletes the run', async () => {
    await mockWorkflowResume();
    const harness = await createResumeHarness();
    vi.spyOn(
      harness.session.transcripts,
      'hasAuthoritativeRun',
    ).mockReturnValue(Effect.succeed(false));

    await expect(harness.owner.tryResumeRun(runId)).resolves.toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
    expect(retrieveSessionResumeData).not.toHaveBeenCalled();
    expect(harness.session.transcripts.has(runId)).toBe(true);
  });
});
