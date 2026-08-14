// Test setup imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

// Local imports
import type { ResultEvent } from '@agent/trace';
import { ToolUseAgentConfigSchema } from '@agent/core/definition/AgentConfig';
import * as AgentExecution from '@agent/runtime/executeAgent';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import * as SessionResumeRetrieval from '@agent/runtime/SessionResumeRetrieval';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import * as AgentRunner from '@agent/runtime/runAgent';
import { ResumeAdmissionCancelledError } from '@agent/runtime/resumeAdmission';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { DesktopProcessResumeOwner } from '@desktop/main/desktopAgentResume';
import {
  AgentCategory,
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { snapshotFacts } from '@test/support/storeTestDrivers';
import { StreamSnapshotStore } from '@transcript';

const retrieveSessionResumeData = vi.spyOn(
  SessionResumeRetrieval,
  'retrieveSessionResumeData',
);
const runAgent = vi.spyOn(AgentRunner, 'runAgent');
const resumeToolUseFromResumeData = vi.spyOn(
  AgentExecution,
  'resumeToolUseFromResumeData',
);

const stream = 'headless-resume' as StreamTabId;
const executionId = 'abc123' as ExecutionId;
const config = ToolUseAgentConfigSchema.parse({
  agent: 'proofreader',
  model: 'deepseekproT',
  agentCategory: AgentCategory.ToolUse,
});

function failedResult(
  category: ResultEvent['category'],
  message: string,
): ResultEvent {
  return {
    type: 'result',
    outcome: RUN_OUTCOME.FAILED,
    executionId,
    streamId: stream,
    agentName: 'proofreader',
    category,
    isSubagent: false,
    error: { kind: 'unexpected', message },
  };
}

function completedResult(): ResultEvent {
  return {
    type: 'result',
    outcome: RUN_OUTCOME.COMPLETED,
    executionId,
    streamId: stream,
    agentName: 'proofreader',
    category: 'workflow',
    isSubagent: false,
  };
}

function completedRunResult(): AgentFlowResult {
  return {
    executionId,
    streamId: stream,
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
  runAgent.mockImplementation(async (_request, options) => {
    await options.onRun?.({} as never);
    session.publishRunEvent(stream, failedResult(category, message));
    throw new Error(message);
  });
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
    detach: session.useHostInteractions({ emit, cancel: vi.fn() }),
  };
}

/** Harness disposal is idempotent so tests can shut it down mid-test. */
function createResumeHarness(): {
  owner: DesktopProcessResumeOwner;
  session: SessionHandle;
  dispose(): void;
} {
  const snapshots = new StreamSnapshotStore();
  snapshotFacts(snapshots).setRunConfig(stream, config, executionId);
  const session = createTestSession({ snapshots });
  session.transcripts.ensureStream(stream);
  const owner = new DesktopProcessResumeOwner();
  const detach = owner.attach({ session });
  const detachTerminalResultToast = attachTerminalResultToast(
    session,
    session.interactions,
    { replayWhenAttached: true },
  );
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    detach();
    detachTerminalResultToast();
    session.dispose();
  };
  onTestFinished(dispose);
  return { owner, session, dispose };
}

function mockWorkflowResume(): void {
  retrieveSessionResumeData.mockResolvedValue({
    type: 'workflow',
    agentConfig: config,
    executionId,
  });
}

/** Hold workflow resume data retrieval open until the test releases it. */
function gateWorkflowResume(): {
  started: Promise<void>;
  release: () => void;
} {
  const started = createDeferred();
  const gate = createDeferred();
  retrieveSessionResumeData.mockImplementation(async () => {
    started.resolve();
    await gate.promise;
    return { type: 'workflow', agentConfig: config, executionId };
  });
  return { started: started.promise, release: () => gate.resolve() };
}

describe('desktop process resume owner', () => {
  beforeEach(() => {
    retrieveSessionResumeData.mockReset();
    resumeToolUseFromResumeData.mockReset();
    runAgent.mockReset().mockResolvedValue(completedRunResult());
  });

  it('resumes while no BrowserWindow presentation exists', async () => {
    mockWorkflowResume();
    const harness = createResumeHarness();

    await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it('presents one fallback when workflow resume fails before lifecycle startup', async () => {
    mockWorkflowResume();
    runAgent.mockRejectedValue(new Error('launch failed'));
    const harness = createResumeHarness();
    const presenter = attachResultPresenter(harness.session);

    await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
    expectOneErrorPresentation(presenter, 'Resume failed: launch failed');
    expect(runAgent.mock.calls[0]?.[1].suppressErrorNotification).toBe(true);

    presenter.detach();
    const replacement = attachResultPresenter(harness.session);
    expect(replacement.emit).not.toHaveBeenCalled();
  });

  it('leaves post-lifecycle workflow failure presentation to the terminal result', async () => {
    mockWorkflowResume();
    const harness = createResumeHarness();
    failAfterLifecycle(
      harness.session,
      'workflow',
      'workflow lifecycle failed',
    );
    const presenter = attachResultPresenter(harness.session);

    await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
    expectOneErrorPresentation(presenter, 'workflow lifecycle failed');
  });

  it('replays one detached post-lifecycle workflow failure on replacement', async () => {
    mockWorkflowResume();
    const harness = createResumeHarness();
    failAfterLifecycle(
      harness.session,
      'workflow',
      'detached lifecycle failed',
    );
    attachResultPresenter(harness.session).detach();

    await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
    const replacement = attachResultPresenter(harness.session);
    await Promise.resolve();
    expectOneErrorPresentation(replacement, 'detached lifecycle failed');
    replacement.detach();

    const secondReplacement = attachResultPresenter(harness.session);
    await Promise.resolve();
    expect(secondReplacement.emit).not.toHaveBeenCalled();
  });

  it('leaves post-lifecycle tool-use failure presentation to the terminal result and restores follow-ups', async () => {
    retrieveSessionResumeData.mockResolvedValue(
      createToolUseResumeData({ streamId: stream, executionId }),
    );
    const harness = createResumeHarness();
    const flow = harness.session.followUps.claimLive(stream, 'flow')!;
    harness.session.followUps.queue(flow).enqueue({ text: 'keep this queued' });
    harness.session.followUps.release(flow, 'recoverable');
    resumeToolUseFromResumeData.mockImplementation(async (_resume, options) => {
      await options?.onRun?.({} as never);
      harness.session.publishRunEvent(
        stream,
        failedResult('toolUse', 'tool-use lifecycle failed'),
      );
      throw new Error('tool-use lifecycle failed');
    });
    const presenter = attachResultPresenter(harness.session);

    await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
    expectOneErrorPresentation(presenter, 'tool-use lifecycle failed');
    expect(harness.session.followUps.getAll(stream)).toEqual([
      'keep this queued',
    ]);
  });

  it('does not duplicate a terminal resume failure presentation', async () => {
    mockWorkflowResume();
    const harness = createResumeHarness();
    failAfterLifecycle(harness.session, 'workflow', 'terminal resume failed');

    await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
    const presenter = attachResultPresenter(harness.session);
    await Promise.resolve();
    expectOneErrorPresentation(presenter, 'terminal resume failed');
  });

  it('reports a resume failure that follows a completed terminal result', async () => {
    mockWorkflowResume();
    const harness = createResumeHarness();
    runAgent.mockImplementation(async (_request, options) => {
      await options.onRun?.({} as never);
      options.session?.publishRunEvent(stream, completedResult());
      throw new Error('final artifact flush failed');
    });

    await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
    const presenter = attachResultPresenter(harness.session);
    await Promise.resolve();
    expectOneErrorPresentation(
      presenter,
      'Resume failed: final artifact flush failed',
    );
  });

  it('rejects a termination-triggered wake after shutdown disables resume', async () => {
    const harness = createResumeHarness();

    harness.dispose();
    await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
    expect(retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('cancels an in-flight resume before shutdown can launch it', async () => {
    const retrieval = gateWorkflowResume();
    const harness = createResumeHarness();

    const resume = harness.owner.tryResumeStream(stream);
    await retrieval.started;
    harness.dispose();
    retrieval.release();

    await expect(resume).resolves.toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('does not resume or recreate a stream deleted during retrieval', async () => {
    const retrieval = gateWorkflowResume();
    const harness = createResumeHarness();

    const resume = harness.owner.tryResumeStream(stream);
    await retrieval.started;
    await harness.session.transcripts.delete(stream);
    retrieval.release();

    await expect(resume).resolves.toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
    expect(harness.session.transcripts.has(stream)).toBe(false);
  });

  it('rejects a stale process store after another process deletes the stream', async () => {
    mockWorkflowResume();
    const harness = createResumeHarness();
    vi.spyOn(
      harness.session.transcripts,
      'hasAuthoritativeStream',
    ).mockResolvedValue(false);
    runAgent.mockImplementation(async (_request, options) => {
      if ((await options.canAcquireResumeLease?.()) === false) {
        throw new ResumeAdmissionCancelledError(executionId);
      }
      return completedRunResult();
    });

    await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
    expect(harness.session.transcripts.has(stream)).toBe(true);

    const presenter = attachResultPresenter(harness.session);
    expect(presenter.emit).not.toHaveBeenCalled();
  });
});
