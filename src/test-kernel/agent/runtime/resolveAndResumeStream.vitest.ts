// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';

const retrieveSessionResumeDataMock = vi.hoisted(() => vi.fn());

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: retrieveSessionResumeDataMock,
}));

import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import {
  isResumeInFlight,
  resolveAndResumeStream,
  type ResumeStreamPorts,
} from '@agent/runtime/resolveAndResumeStream';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

const STREAM = 'stream:resume' as StreamTabId;
const runtimeHost = { emit: vi.fn() };

function basePorts(
  overrides: Partial<ResumeStreamPorts> = {},
): ResumeStreamPorts {
  return {
    runtimeHost,
    streamStatus: defaultSession().status,
    resolveResumeState: vi.fn(async () => ({
      runState: { agent: 'a', model: 'm' } as never,
      executionId: 'exec-1' as never,
    })),
    resumeToolUse: vi.fn(async () => true),
    executeWorkflow: vi.fn(async () => {}),
    reportNoResumableSession: vi.fn(),
    reportFailure: vi.fn(),
    ...overrides,
  };
}

describe('resolveAndResumeStream', () => {
  beforeEach(() => {
    retrieveSessionResumeDataMock.mockReset();
    runtimeHost.emit.mockReset();
  });

  afterEach(() => {
    clearStreamStatusForTest(defaultSession().status, STREAM);
  });

  it('routes a tool-use snapshot to the resume port', async () => {
    const snapshot = createToolUseResumeData({ streamId: STREAM });
    retrieveSessionResumeDataMock.mockResolvedValue(snapshot);
    const ports = basePorts();

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(true);
    expect(ports.resumeToolUse).toHaveBeenCalledWith(snapshot);
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
        runState: { agent: 'a', model: 'm' } as never,
        executionId: 'exec-1' as never,
        parentStreamId,
      })),
    });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(true);

    expect(retrieveSessionResumeDataMock).toHaveBeenCalledWith(
      STREAM,
      'exec-1',
      expect.anything(),
      { parentStreamId },
    );
    expect(ports.resumeToolUse).toHaveBeenCalledWith(snapshot);
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
      seedStreamStatusForTest(
        defaultSession().status,
        STREAM,
        STREAM_STATUS.RUNNING,
      );
      return createToolUseResumeData({ streamId: STREAM });
    });
    const ports = basePorts();

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(ports.resumeToolUse).not.toHaveBeenCalled();
    expect(ports.executeWorkflow).not.toHaveBeenCalled();
  });

  it('skips resume without resolving when the stream is already active', async () => {
    seedStreamStatusForTest(
      defaultSession().status,
      STREAM,
      STREAM_STATUS.RUNNING,
    );
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
    expect(isResumeInFlight(STREAM)).toBe(false);
  });

  it('stops after persisted state resolution when cancellation arrives', async () => {
    let cancelled = false;
    const ports = basePorts({
      isCancellationRequested: () => cancelled,
      resolveResumeState: vi.fn(async () => {
        cancelled = true;
        return {
          runState: { agent: 'a', model: 'm' } as never,
          executionId: 'exec-1' as never,
        };
      }),
    });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(retrieveSessionResumeDataMock).not.toHaveBeenCalled();
    expect(ports.resumeToolUse).not.toHaveBeenCalled();
    expect(ports.executeWorkflow).not.toHaveBeenCalled();
    expect(isResumeInFlight(STREAM)).toBe(false);
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
    expect(isResumeInFlight(STREAM)).toBe(false);
  });

  it('guards against the injected session machine, not the process default (#7640)', async () => {
    // Desktop scenario: the window's own session machine has the stream
    // active while the process-global default is empty. The guard must read
    // the injected machine — before #7640 it read the global and never fired.
    const windowStatus = new StreamStatusMachine();
    seedStreamStatusForTest(windowStatus, STREAM, STREAM_STATUS.RUNNING);
    const ports = basePorts({ streamStatus: windowStatus });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(ports.resolveResumeState).not.toHaveBeenCalled();

    clearStreamStatusForTest(windowStatus, STREAM);
  });

  it('ignores activity recorded only on a different session machine', async () => {
    // The inverse: activity on the process default must not block a resume in
    // a session whose own machine says the stream is idle.
    seedStreamStatusForTest(
      defaultSession().status,
      STREAM,
      STREAM_STATUS.RUNNING,
    );
    retrieveSessionResumeDataMock.mockResolvedValue(
      createToolUseResumeData({ streamId: STREAM }),
    );
    const ports = basePorts({ streamStatus: new StreamStatusMachine() });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(true);
    expect(ports.resumeToolUse).toHaveBeenCalled();
  });

  it('returns false (host owns its messaging) when no state resolves', async () => {
    const ports = basePorts({
      resolveResumeState: vi.fn(async () => undefined),
    });

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
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
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markReportStarted!: () => void;
    const reportStarted = new Promise<void>((resolve) => {
      markReportStarted = resolve;
    });
    const ports = basePorts({
      reportNoResumableSession: vi.fn(async () => {
        markReportStarted();
        await gate;
      }),
    });

    const pending = resolveAndResumeStream(STREAM, ports);
    await reportStarted;
    expect(isResumeInFlight(STREAM)).toBe(true);

    release();
    await expect(pending).resolves.toBe(false);
    expect(isResumeInFlight(STREAM)).toBe(false);
  });

  it('surfaces a retrieval failure without leaking the in-flight slot', async () => {
    const error = new Error('kv boom');
    retrieveSessionResumeDataMock.mockRejectedValue(error);
    const ports = basePorts();

    await expect(resolveAndResumeStream(STREAM, ports)).resolves.toBe(false);
    expect(ports.reportFailure).toHaveBeenCalledWith(STREAM, error);
    expect(isResumeInFlight(STREAM)).toBe(false);
  });

  it('keeps the in-flight guard until async failure reporting completes', async () => {
    const error = new Error('kv boom');
    retrieveSessionResumeDataMock.mockRejectedValue(error);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markReportStarted!: () => void;
    const reportStarted = new Promise<void>((resolve) => {
      markReportStarted = resolve;
    });
    const ports = basePorts({
      reportFailure: vi.fn(async () => {
        markReportStarted();
        await gate;
      }),
    });

    const pending = resolveAndResumeStream(STREAM, ports);
    await reportStarted;
    expect(isResumeInFlight(STREAM)).toBe(true);

    release();
    await expect(pending).resolves.toBe(false);
    expect(isResumeInFlight(STREAM)).toBe(false);
  });

  it('reports in-flight while preparing and clears it once settled', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedPort!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedPort = resolve;
    });
    retrieveSessionResumeDataMock.mockResolvedValue(
      createToolUseResumeData({ streamId: STREAM }),
    );
    const ports = basePorts({
      resumeToolUse: vi.fn(async () => {
        reachedPort();
        await gate;
        return true;
      }),
    });

    const pending = resolveAndResumeStream(STREAM, ports);
    await reached;
    expect(isResumeInFlight(STREAM)).toBe(true);

    release();
    await expect(pending).resolves.toBe(true);
    expect(isResumeInFlight(STREAM)).toBe(false);
  });
});
