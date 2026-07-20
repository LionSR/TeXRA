// Test setup imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { ToolUseAgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { StreamSnapshotStore } from '@transcript';

const resumeMocks = vi.hoisted(() => ({
  retrieveSessionResumeData: vi.fn(),
  runAgent: vi.fn(async () => undefined),
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: resumeMocks.retrieveSessionResumeData,
}));
vi.mock('@agent/runtime/runAgent', () => ({ runAgent: resumeMocks.runAgent }));

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
  afterEach(() => {
    resumeMocks.retrieveSessionResumeData.mockReset();
    resumeMocks.runAgent.mockClear();
  });

  it('resumes while no BrowserWindow presentation exists', async () => {
    resumeMocks.retrieveSessionResumeData.mockResolvedValue({
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
      expect(resumeMocks.runAgent).toHaveBeenCalledOnce();
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
    expect(resumeMocks.retrieveSessionResumeData).not.toHaveBeenCalled();
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
    resumeMocks.retrieveSessionResumeData.mockImplementation(async () => {
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
    expect(resumeMocks.runAgent).not.toHaveBeenCalled();
    session.dispose();
  });
});
