// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const retrieveSessionResumeDataMock = vi.hoisted(() => vi.fn());

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: retrieveSessionResumeDataMock,
}));

import {
  resolveAndResumeStream,
  resumeStreamWithRecovery,
  type ResumeStreamPorts,
} from '@agent/runtime/resolveAndResumeStream';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { STREAM_PHASE, type StreamTabId } from '@shared/schemas';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/support/streamStatusTestUtils';
import { createDeferred } from '@test/support/asyncTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';

const STREAM = 'stream:resume' as StreamTabId;

const RESOLVED_STATE = {
  status: 'resolved' as const,
  state: {
    runState: { agent: 'a', model: 'm' } as never,
    executionId: 'exec-1' as never,
  },
};

function basePorts(
  overrides: Partial<ResumeStreamPorts> = {},
): ResumeStreamPorts {
  return {
    streamStatus: defaultSession().status,
    resolveResumeState: vi.fn(async () => RESOLVED_STATE),
    resumeToolUse: vi.fn(async () => true),
    executeWorkflow: vi.fn(async () => {}),
    reportResumeStateResolution: vi.fn(),
    reportNoResumableSession: vi.fn(),
    reportFailure: vi.fn(),
    ...overrides,
  };
}

/**
 * Drives one resume whose `port` reporting blocks on a gate, proving the
 * in-flight guard is held until the report completes rather than dropped the
 * moment retrieval settles.
 */
async function expectGuardHeldThroughAsyncReport(
  port: 'reportNoResumableSession' | 'reportFailure',
): Promise<void> {
  const gate = createDeferred();
  const reportStarted = createDeferred();
  const ports = basePorts({
    [port]: vi.fn(async () => {
      reportStarted.resolve();
      await gate.promise;
    }),
  });

  const pending = resolveAndResumeStream(STREAM, ports);
  await reportStarted.promise;

  gate.resolve();
  await expect(pending).resolves.toBe(false);
}

describe('resumeStreamWithRecovery', () => {
  it('releases recovery ownership when the resume callback throws synchronously', async () => {
    const recovery = { streamId: STREAM } as never;
    const followUps = {
      useRecovery: vi.fn(() => recovery),
      claimRecovery: vi.fn(),
      release: vi.fn(),
    };
    const error = new Error('synchronous resume failure');

    await expect(
      resumeStreamWithRecovery(
        { followUps } as never,
        STREAM,
        () => {
          throw error;
        },
        recovery,
      ),
    ).rejects.toBe(error);
    expect(followUps.release).toHaveBeenCalledWith(recovery, 'recoverable');
  });
});

describe('resolveAndResumeStream', () => {
  beforeEach(() => {
    retrieveSessionResumeDataMock.mockReset();
  });

  afterEach(() => {
    clearStreamStatusForTest(defaultSession().status, STREAM);
  });

  it('routes a tool-use snapshot to the resume port', async () => {
    const snapshot = createToolUseResumeData({ streamId: STREAM });
    retrieveSessionResumeDataMock.mockResolvedValue(snapshot);
    const ports = basePorts();

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(true);
    expect(ports.resumeToolUse).toHaveBeenCalledWith(snapshot, undefined);
    expect(ports.executeWorkflow).not.toHaveBeenCalled();
  });

  it('passes recovered parent stream identity to resume retrieval', async () => {
    const parentStreamId = 'stream:parent' as StreamTabId;
    const snapshot = createToolUseResumeData({
      streamId: STREAM,
      parentStreamId,
    });
    retrieveSessionResumeDataMock.mockResolvedValue(snapshot);
    const ports = basePorts({
      resolveResumeState: vi.fn(async () => ({
        ...RESOLVED_STATE,
        state: { ...RESOLVED_STATE.state, parentStreamId },
      })),
    });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(true);

    expect(retrieveSessionResumeDataMock).toHaveBeenCalledWith(
      STREAM,
      'exec-1',
      expect.anything(),
      { parentStreamId },
    );
    expect(ports.resumeToolUse).toHaveBeenCalledWith(snapshot, undefined);
  });

  it('launches workflow resumes without pre-acquiring the stream', async () => {
    const agentConfig = { agent: 'a', model: 'm' } as never;
    retrieveSessionResumeDataMock.mockResolvedValue({
      type: 'workflow',
      agentConfig,
      executionId: 'exec-1',
      modelHandlerCompatibilityKey: 'key-1',
    });
    let statusDuringLaunch: string | undefined;
    const ports = basePorts({
      executeWorkflow: vi.fn(async () => {
        statusDuringLaunch = defaultSession().status.get(STREAM);
      }),
    });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(true);
    expect(statusDuringLaunch).toBeUndefined();
    expect(ports.executeWorkflow).toHaveBeenCalledWith(
      agentConfig,
      'exec-1',
      'key-1',
    );
  });

  it('abandons resume when the stream becomes active during retrieval', async () => {
    // A concurrent non-resume run flips the stream active while we await KV.
    // `resumeInFlight` (held here) cannot catch that, so the post-retrieval
    // re-check must bail before touching the resume ports.
    retrieveSessionResumeDataMock.mockImplementation(async () => {
      seedStreamStatusForTest(defaultSession().status, STREAM, {
        phase: STREAM_PHASE.RUNNING,
      });
      return createToolUseResumeData({ streamId: STREAM });
    });
    const ports = basePorts();

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(ports.resumeToolUse).not.toHaveBeenCalled();
    expect(ports.executeWorkflow).not.toHaveBeenCalled();
  });

  it('skips resume without resolving when the stream is already active', async () => {
    seedStreamStatusForTest(defaultSession().status, STREAM, {
      phase: STREAM_PHASE.RUNNING,
    });
    const ports = basePorts();

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(ports.resolveResumeState).not.toHaveBeenCalled();
    expect(retrieveSessionResumeDataMock).not.toHaveBeenCalled();
  });

  it('skips resume when cancellation was already requested', async () => {
    const ports = basePorts({ isCancellationRequested: () => true });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(ports.resolveResumeState).not.toHaveBeenCalled();
    expect(retrieveSessionResumeDataMock).not.toHaveBeenCalled();
  });

  it('stops after persisted state resolution when cancellation arrives', async () => {
    let cancelled = false;
    const ports = basePorts({
      isCancellationRequested: () => cancelled,
      resolveResumeState: vi.fn(async () => {
        cancelled = true;
        return RESOLVED_STATE;
      }),
    });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(retrieveSessionResumeDataMock).not.toHaveBeenCalled();
    expect(ports.resumeToolUse).not.toHaveBeenCalled();
    expect(ports.executeWorkflow).not.toHaveBeenCalled();
  });

  it('stops after resume-data retrieval when cancellation arrives', async () => {
    let cancelled = false;
    retrieveSessionResumeDataMock.mockImplementation(async () => {
      cancelled = true;
      return createToolUseResumeData({ streamId: STREAM });
    });
    const ports = basePorts({
      isCancellationRequested: () => cancelled,
    });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(ports.resumeToolUse).not.toHaveBeenCalled();
    expect(ports.executeWorkflow).not.toHaveBeenCalled();
  });

  it('guards against the injected session machine, not the process default (#7640)', async () => {
    // Desktop scenario: the window's own session machine has the stream
    // active while the process-global default is empty. The guard must read
    // the injected machine — before #7640 it read the global and never fired.
    const windowStatus = new StreamStatusMachine(new SessionEventHub());
    seedStreamStatusForTest(windowStatus, STREAM, {
      phase: STREAM_PHASE.RUNNING,
    });
    const ports = basePorts({ streamStatus: windowStatus });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(ports.resolveResumeState).not.toHaveBeenCalled();

    clearStreamStatusForTest(windowStatus, STREAM);
  });

  it('ignores activity recorded only on a different session machine', async () => {
    // The inverse: activity on the process default must not block a resume in
    // a session whose own machine says the stream is idle.
    seedStreamStatusForTest(defaultSession().status, STREAM, {
      phase: STREAM_PHASE.RUNNING,
    });
    retrieveSessionResumeDataMock.mockResolvedValue(
      createToolUseResumeData({ streamId: STREAM }),
    );
    const ports = basePorts({
      streamStatus: new StreamStatusMachine(new SessionEventHub()),
    });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(true);
    expect(ports.resumeToolUse).toHaveBeenCalled();
  });

  it('reports a persisted-state read failure separately from missing resume data', async () => {
    const error = new Error('snapshot disk offline');
    const resolution = { status: 'read-failed' as const, error };
    const ports = basePorts({
      resolveResumeState: vi.fn(async () => resolution),
    });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(ports.reportResumeStateResolution).toHaveBeenCalledWith(
      STREAM,
      resolution,
      'Persisted run state could not be read (snapshot disk offline). The resume was not started; retry once the storage issue is resolved.',
    );
    expect(retrieveSessionResumeDataMock).not.toHaveBeenCalled();
    expect(ports.reportNoResumableSession).not.toHaveBeenCalled();
  });

  it('reports no resumable session when retrieval finds nothing', async () => {
    retrieveSessionResumeDataMock.mockResolvedValue(null);
    const ports = basePorts();

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(ports.reportNoResumableSession).toHaveBeenCalledWith(STREAM);
    expect(ports.resumeToolUse).not.toHaveBeenCalled();
    expect(ports.executeWorkflow).not.toHaveBeenCalled();
  });

  it('keeps the in-flight guard until async no-session reporting completes', async () => {
    retrieveSessionResumeDataMock.mockResolvedValue(null);

    await expectGuardHeldThroughAsyncReport('reportNoResumableSession');
  });

  it('surfaces a retrieval failure without leaking the in-flight slot', async () => {
    const error = new Error('kv boom');
    retrieveSessionResumeDataMock.mockRejectedValue(error);
    const ports = basePorts();

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(ports.reportFailure).toHaveBeenCalledWith(STREAM, error);
  });

  it('keeps the in-flight guard until async failure reporting completes', async () => {
    retrieveSessionResumeDataMock.mockRejectedValue(new Error('kv boom'));

    await expectGuardHeldThroughAsyncReport('reportFailure');
  });
});
