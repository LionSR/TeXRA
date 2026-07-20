// Test setup imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { ToolUseAgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import * as SessionResumeRetrieval from '@agent/runtime/SessionResumeRetrieval';
import * as AgentRunner from '@agent/runtime/runAgent';
import { DesktopProcessResumeOwner } from '@desktop/main/desktopAgentResume';
import {
  AgentCategory,
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { StreamSnapshotStore } from '@transcript';

const retrieveSessionResumeData = vi.spyOn(
  SessionResumeRetrieval,
  'retrieveSessionResumeData',
);
const runAgent = vi.spyOn(AgentRunner, 'runAgent');

const stream = 'headless-resume' as StreamTabId;
const executionId = 'abc123' as ExecutionId;
const config = ToolUseAgentConfigSchema.parse({
  agent: 'proofreader',
  model: 'deepseekproT',
  agentCategory: AgentCategory.ToolUse,
});

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

  it('replays a headless resume failure to the next presentation once', async () => {
    retrieveSessionResumeData.mockResolvedValue({
      type: 'workflow',
      agentConfig: config,
      executionId,
    });
    runAgent.mockRejectedValue(new Error('launch failed'));
    const harness = createResumeHarness();

    try {
      await expect(harness.owner.tryResumeStream(stream)).resolves.toBe(false);
      const firstEmit = vi.fn();
      const detach = harness.session.useHostInteractions({
        emit: firstEmit,
        cancel: vi.fn(),
      });
      expect(firstEmit).toHaveBeenCalledOnce();
      expect(firstEmit).toHaveBeenCalledWith('requestShowError', {
        message: 'Resume failed: launch failed',
      });

      detach();
      const secondEmit = vi.fn();
      harness.session.useHostInteractions({
        emit: secondEmit,
        cancel: vi.fn(),
      });
      expect(secondEmit).not.toHaveBeenCalled();
    } finally {
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
});
