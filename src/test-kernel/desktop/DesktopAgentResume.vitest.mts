// Test setup imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { ToolUseAgentConfigSchema } from '@agent/core/definition/AgentConfig';
import * as SessionResumeRetrieval from '@agent/runtime/SessionResumeRetrieval';
import * as AgentRunner from '@agent/runtime/runAgent';
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
    const session = createTestSession();
    session.transcripts.ensureStream(stream);
    const { installDesktopProcessResumeHandler, tryResumeDesktopStream } =
      await import('@desktop/main/desktopAgentResume');
    const dispose = installDesktopProcessResumeHandler({
      session,
      snapshots: createSnapshots(),
    });

    try {
      await expect(tryResumeDesktopStream(stream)).resolves.toBe(true);
      expect(runAgent).toHaveBeenCalledOnce();
    } finally {
      dispose();
      session.dispose();
    }
  });

  it('rejects a termination-triggered wake after shutdown disables resume', async () => {
    const session = createTestSession();
    session.transcripts.ensureStream(stream);
    const { installDesktopProcessResumeHandler, tryResumeDesktopStream } =
      await import('@desktop/main/desktopAgentResume');
    const dispose = installDesktopProcessResumeHandler({
      session,
      snapshots: createSnapshots(),
    });

    dispose();
    await expect(tryResumeDesktopStream(stream)).resolves.toBe(false);
    expect(retrieveSessionResumeData).not.toHaveBeenCalled();
    session.dispose();
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
    const session = createTestSession();
    session.transcripts.ensureStream(stream);
    const { installDesktopProcessResumeHandler, tryResumeDesktopStream } =
      await import('@desktop/main/desktopAgentResume');
    const dispose = installDesktopProcessResumeHandler({
      session,
      snapshots: createSnapshots(),
    });

    const resume = tryResumeDesktopStream(stream);
    await retrievalStarted;
    dispose();
    releaseRetrieval();

    await expect(resume).resolves.toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
    session.dispose();
  });
});
