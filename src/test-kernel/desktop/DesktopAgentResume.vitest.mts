// Test setup imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { ResultEvent } from '@agent/trace';
import { ToolUseAgentConfigSchema } from '@agent/core/definition/AgentConfig';
import * as AgentExecution from '@agent/runtime/executeAgent';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import * as SessionResumeRetrieval from '@agent/runtime/SessionResumeRetrieval';
import * as AgentRunner from '@agent/runtime/runAgent';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { DesktopProcessResumeOwner } from '@desktop/main/desktopAgentResume';
import {
  AgentCategory,
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
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

function attachResultPresenter(
  session: SessionHandle,
  emit = vi.fn(),
): { emit: ReturnType<typeof vi.fn>; detach(): void } {
  const detachHost = session.useHostInteractions({ emit, cancel: vi.fn() });
  const detachToast = attachTerminalResultToast(session, session.interactions, {
    replayWhenAttached: true,
  });
  return {
    emit,
    detach() {
      detachToast();
      detachHost();
    },
  };
}

function createSnapshots(): StreamSnapshotStore {
  const snapshots = new StreamSnapshotStore();
  snapshots.setTaskState(stream, { agentConfig: config }, executionId);
  return snapshots;
}

function createResumeHarness(): {
  owner: DesktopProcessResumeOwner;
  session: SessionHandle;
  dispose(): void;
} {
  const session = createTestSession();
  session.transcripts.ensureStream(stream);
  const owner = new DesktopProcessResumeOwner();
  const detach = owner.attach({ session, snapshots: createSnapshots() });
  return {
    owner,
    session,
    dispose() {
      detach();
      session.dispose();
    },
  };
}

describe('desktop process resume owner', () => {
  beforeEach(() => {
    retrieveSessionResumeData.mockReset();
    resumeToolUseFromResumeData.mockReset();
    runAgent.mockReset().mockResolvedValue({
      executionId,
      streamId: stream,
      category: 'workflow',
      outcome: RUN_OUTCOME.COMPLETED,
      outputs: [],
      compileFailures: [],
    });
  });

  it('resumes while no BrowserWindow presentation exists', async () => {
    retrieveSessionResumeData.mockResolvedValue({
      type: 'workflow',
      agentConfig: config,
      executionId,
    });
    const harness = createResumeHarness();

    try {
      await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(true);
      expect(runAgent).toHaveBeenCalledOnce();
    } finally {
      harness.dispose();
    }
  });

  it('presents one fallback when workflow resume fails before lifecycle startup', async () => {
    retrieveSessionResumeData.mockResolvedValue({
      type: 'workflow',
      agentConfig: config,
      executionId,
    });
    runAgent.mockRejectedValue(new Error('launch failed'));
    const harness = createResumeHarness();
    const presenter = attachResultPresenter(harness.session);

    try {
      await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
      expect(presenter.emit).toHaveBeenCalledOnce();
      expect(presenter.emit).toHaveBeenCalledWith('requestShowError', {
        message: 'Resume failed: launch failed',
      });
    } finally {
      presenter.detach();
      harness.dispose();
    }
  });

  it('leaves post-lifecycle workflow failure presentation to the terminal result', async () => {
    retrieveSessionResumeData.mockResolvedValue({
      type: 'workflow',
      agentConfig: config,
      executionId,
    });
    const harness = createResumeHarness();
    runAgent.mockImplementation(async (_request, options) => {
      await options.onRun?.({} as never);
      harness.session.publishRunEvent(
        stream,
        failedResult('workflow', 'workflow lifecycle failed'),
      );
      throw new Error('workflow lifecycle failed');
    });
    const presenter = attachResultPresenter(harness.session);

    try {
      await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
      expect(presenter.emit).toHaveBeenCalledOnce();
      expect(presenter.emit).toHaveBeenCalledWith('requestShowError', {
        message: 'workflow lifecycle failed',
      });
    } finally {
      presenter.detach();
      harness.dispose();
    }
  });

  it('replays one detached post-lifecycle workflow failure on replacement', async () => {
    retrieveSessionResumeData.mockResolvedValue({
      type: 'workflow',
      agentConfig: config,
      executionId,
    });
    const harness = createResumeHarness();
    runAgent.mockImplementation(async (_request, options) => {
      await options.onRun?.({} as never);
      harness.session.publishRunEvent(
        stream,
        failedResult('workflow', 'detached lifecycle failed'),
      );
      throw new Error('detached lifecycle failed');
    });
    attachResultPresenter(harness.session).detach();

    try {
      await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
      const replacement = attachResultPresenter(harness.session);
      await Promise.resolve();
      expect(replacement.emit).toHaveBeenCalledOnce();
      expect(replacement.emit).toHaveBeenCalledWith('requestShowError', {
        message: 'detached lifecycle failed',
      });
      replacement.detach();

      const secondReplacement = attachResultPresenter(harness.session);
      await Promise.resolve();
      expect(secondReplacement.emit).not.toHaveBeenCalled();
      secondReplacement.detach();
    } finally {
      harness.dispose();
    }
  });

  it('leaves post-lifecycle tool-use failure presentation to the terminal result and restores follow-ups', async () => {
    retrieveSessionResumeData.mockResolvedValue(
      createToolUseResumeData({ streamId: stream, executionId }),
    );
    const harness = createResumeHarness();
    harness.session.followUps.acquire(stream);
    harness.session.followUps.enqueue(stream, { text: 'keep this queued' });
    resumeToolUseFromResumeData.mockImplementation(
      async (_resume, _runtimeHost, options) => {
        await options?.onRun?.({} as never);
        harness.session.publishRunEvent(
          stream,
          failedResult('toolUse', 'tool-use lifecycle failed'),
        );
        throw new Error('tool-use lifecycle failed');
      },
    );
    const presenter = attachResultPresenter(harness.session);

    try {
      await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
      expect(presenter.emit).toHaveBeenCalledOnce();
      expect(presenter.emit).toHaveBeenCalledWith('requestShowError', {
        message: 'tool-use lifecycle failed',
      });
      expect(harness.session.followUps.getAll(stream)).toEqual([
        'keep this queued',
      ]);
    } finally {
      presenter.detach();
      harness.dispose();
    }
  });

  it('rejects a termination-triggered wake after shutdown disables resume', async () => {
    const harness = createResumeHarness();

    harness.dispose();
    await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
    expect(retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('cancels an in-flight resume before shutdown can launch it', async () => {
    let releaseRetrieval!: () => void;
    let markRetrievalStarted!: () => void;
    const retrievalStarted = new Promise<void>((resolve) => {
      markRetrievalStarted = resolve;
    });
    const retrievalGate = new Promise<void>((resolve) => {
      releaseRetrieval = resolve;
    });
    retrieveSessionResumeData.mockImplementation(async () => {
      markRetrievalStarted();
      await retrievalGate;
      return { type: 'workflow', agentConfig: config, executionId };
    });
    const harness = createResumeHarness();

    const resume = harness.owner.tryResumeStream(stream);
    await retrievalStarted;
    harness.dispose();
    releaseRetrieval();

    await expect(resume).resolves.toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('does not resume or recreate a stream deleted during retrieval', async () => {
    let releaseRetrieval!: () => void;
    let markRetrievalStarted!: () => void;
    const retrievalStarted = new Promise<void>((resolve) => {
      markRetrievalStarted = resolve;
    });
    const retrievalGate = new Promise<void>((resolve) => {
      releaseRetrieval = resolve;
    });
    retrieveSessionResumeData.mockImplementation(async () => {
      markRetrievalStarted();
      await retrievalGate;
      return { type: 'workflow', agentConfig: config, executionId };
    });
    const harness = createResumeHarness();

    try {
      const resume = harness.owner.tryResumeStream(stream);
      await retrievalStarted;
      await harness.session.transcripts.delete(stream);
      releaseRetrieval();

      await expect(resume).resolves.toBe(false);
      expect(runAgent).not.toHaveBeenCalled();
      expect(harness.session.transcripts.has(stream)).toBe(false);
    } finally {
      harness.dispose();
    }
  });
});
