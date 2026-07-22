// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { ModelRetryGate } from '@agent/runtime/ModelRetryGate';

const ROUTE = 'openai:subscription:gpt-5.6';
const TRANSIENT = new Error('temporary connection failure');

function options(signal: AbortSignal, baseBackoffMs = 1000) {
  return {
    signal,
    baseBackoffMs,
    classifyFailure: () => ({}),
  };
}

async function openGate(gate: ModelRetryGate): Promise<void> {
  const controller = new AbortController();
  await expect(
    gate.run(ROUTE, options(controller.signal), async () => {
      throw TRANSIENT;
    }),
  ).rejects.toBe(TRANSIENT);
}

describe('ModelRetryGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('admits one recovery probe and releases siblings after success', async () => {
    const gate = new ModelRetryGate();
    await openGate(gate);

    let resolveProbe = (): void => undefined;
    const probeResult = new Promise<void>((resolve) => {
      resolveProbe = resolve;
    });
    const probeOperation = vi.fn(() => probeResult);
    const siblingOperation = vi.fn(async () => undefined);
    const onAdmitted = vi.fn(async () => undefined);
    const first = gate.run(
      ROUTE,
      options(new AbortController().signal),
      probeOperation,
    );
    const sibling = gate.run(
      ROUTE,
      { ...options(new AbortController().signal), onAdmitted },
      siblingOperation,
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(probeOperation).toHaveBeenCalledOnce();
    expect(siblingOperation).not.toHaveBeenCalled();

    resolveProbe();
    await Promise.all([first, sibling]);
    expect(siblingOperation).toHaveBeenCalledOnce();
    expect(onAdmitted).not.toHaveBeenCalled();
    gate.dispose();
  });

  it('keeps stale peers behind one immediate credential recovery', async () => {
    const gate = new ModelRetryGate();
    let rejectPrimary = (_error: Error): void => undefined;
    let rejectPeer = (_error: Error): void => undefined;
    let releaseRecovery = (): void => undefined;
    let announceRecovery = (): void => undefined;
    const primaryFailure = new Promise<string>((_resolve, reject) => {
      rejectPrimary = reject;
    });
    const peerFailure = new Promise<string>((_resolve, reject) => {
      rejectPeer = reject;
    });
    const recoveryMayFinish = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const recoveryStarted = new Promise<void>((resolve) => {
      announceRecovery = resolve;
    });
    let releaseAdmission = (): void => undefined;
    const admissionMayFinish = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const onAdmitted = vi.fn(() => admissionMayFinish);
    const recoveryRuns = vi.fn(async (retry: () => Promise<string>) => {
      announceRecovery();
      await recoveryMayFinish;
      return retry();
    });
    const recoveries = vi.fn(
      (retry: () => Promise<string>) => (): Promise<string> =>
        recoveryRuns(retry),
    );
    const primaryOperation = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => primaryFailure)
      .mockResolvedValue('primary recovered');
    const peerOperation = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => peerFailure)
      .mockResolvedValue('peer recovered');
    const recoverableOptions = {
      ...options(new AbortController().signal),
      recoverFailure: (_error: Error, retry: () => Promise<string>) =>
        recoveries(retry),
      onAdmitted,
    };

    const primary = gate.run(ROUTE, recoverableOptions, primaryOperation);
    const peer = gate.run(ROUTE, recoverableOptions, peerOperation);
    await Promise.resolve();
    expect(primaryOperation).toHaveBeenCalledOnce();
    expect(peerOperation).toHaveBeenCalledOnce();

    rejectPrimary(TRANSIENT);
    await recoveryStarted;
    rejectPeer(TRANSIENT);
    await Promise.resolve();
    await Promise.resolve();

    expect(recoveries).toHaveBeenCalledTimes(2);
    expect(recoveryRuns).toHaveBeenCalledOnce();
    expect(peerOperation).toHaveBeenCalledOnce();

    // Recovery owns the probe rather than a cooling timer. Even when token
    // refresh takes much longer than the ordinary backoff, a stale peer must
    // remain queued until that recovery completes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(peerOperation).toHaveBeenCalledOnce();

    releaseRecovery();
    await expect(primary).resolves.toBe('primary recovered');
    await Promise.resolve();
    expect(onAdmitted).toHaveBeenCalledOnce();
    expect(peerOperation).toHaveBeenCalledOnce();
    releaseAdmission();
    await expect(peer).resolves.toBe('peer recovered');
    expect(primaryOperation).toHaveBeenCalledTimes(2);
    expect(peerOperation).toHaveBeenCalledTimes(2);
    gate.dispose();
  });

  it('refreshes an admitted client after the recovery probe fails', async () => {
    const gate = new ModelRetryGate();
    const recoveryError = new Error('provider still unavailable');
    const failedRecovery = gate.run(
      ROUTE,
      {
        ...options(new AbortController().signal),
        recoverFailure: () => () => Promise.reject(recoveryError),
      },
      async () => {
        throw TRANSIENT;
      },
    );

    await expect(failedRecovery).rejects.toBe(recoveryError);

    const order: string[] = [];
    const next = gate.run(
      ROUTE,
      {
        ...options(new AbortController().signal),
        onAdmitted: () => {
          order.push('refresh');
        },
      },
      async () => {
        order.push('operation');
      },
    );

    await vi.advanceTimersByTimeAsync(1000);
    await next;
    expect(order).toEqual(['refresh', 'operation']);
    gate.dispose();
  });

  it('preserves client refresh after a cooled probe recovery fails', async () => {
    const gate = new ModelRetryGate();
    await openGate(gate);

    const recoveryError = new Error('provider still unavailable');
    const failedRecoveryProbe = gate.run(
      ROUTE,
      {
        ...options(new AbortController().signal),
        recoverFailure: () => () => Promise.reject(recoveryError),
      },
      async () => {
        throw TRANSIENT;
      },
    );
    const failedRecoveryResult =
      expect(failedRecoveryProbe).rejects.toBe(recoveryError);
    await vi.advanceTimersByTimeAsync(1000);
    await failedRecoveryResult;

    const order: string[] = [];
    const next = gate.run(
      ROUTE,
      {
        ...options(new AbortController().signal),
        onAdmitted: () => {
          order.push('refresh');
        },
      },
      async () => {
        order.push('operation');
      },
    );

    await vi.advanceTimersByTimeAsync(2000);
    await next;
    expect(order).toEqual(['refresh', 'operation']);
    gate.dispose();
  });

  it('honors an explicitly disabled shared backoff', async () => {
    const gate = new ModelRetryGate();
    const controller = new AbortController();
    await expect(
      gate.run(ROUTE, options(controller.signal, 0), async () => {
        throw TRANSIENT;
      }),
    ).rejects.toBe(TRANSIENT);

    const operation = vi.fn(async () => undefined);
    const retry = gate.run(
      ROUTE,
      options(new AbortController().signal, 0),
      operation,
    );
    expect(operation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    await retry;
    expect(operation).toHaveBeenCalledOnce();
    gate.dispose();
  });

  it('increases the shared backoff after a failed probe', async () => {
    const gate = new ModelRetryGate();
    await openGate(gate);

    const failedProbe = gate.run(
      ROUTE,
      options(new AbortController().signal),
      async () => {
        throw TRANSIENT;
      },
    );
    const failedProbeResult = expect(failedProbe).rejects.toBe(TRANSIENT);
    await vi.advanceTimersByTimeAsync(1000);
    await failedProbeResult;

    const nextOperation = vi.fn(async () => undefined);
    const next = gate.run(
      ROUTE,
      options(new AbortController().signal),
      nextOperation,
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(nextOperation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(nextOperation).toHaveBeenCalledOnce();
    gate.dispose();
  });

  it('does not let a stale success erase a newer failed probe', async () => {
    const gate = new ModelRetryGate();
    let resolveStale = (): void => undefined;
    const staleResult = new Promise<void>((resolve) => {
      resolveStale = resolve;
    });
    const stale = gate.run(
      ROUTE,
      options(new AbortController().signal),
      () => staleResult,
    );
    await openGate(gate);

    const failedProbe = gate.run(
      ROUTE,
      options(new AbortController().signal),
      async () => {
        throw TRANSIENT;
      },
    );
    const failedProbeResult = expect(failedProbe).rejects.toBe(TRANSIENT);
    await vi.advanceTimersByTimeAsync(1000);
    await failedProbeResult;

    const currentProbe = vi.fn(async () => undefined);
    const current = gate.run(
      ROUTE,
      options(new AbortController().signal),
      currentProbe,
    );
    resolveStale();
    await stale;
    await vi.advanceTimersByTimeAsync(1999);
    expect(currentProbe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await current;
    expect(currentProbe).toHaveBeenCalledOnce();
    gate.dispose();
  });

  it('hands an abandoned probe to the next waiting call', async () => {
    const gate = new ModelRetryGate();
    await openGate(gate);

    const firstController = new AbortController();
    const first = gate.run(
      ROUTE,
      options(firstController.signal),
      () =>
        new Promise<void>((_resolve, reject) => {
          firstController.signal.addEventListener(
            'abort',
            () => reject(firstController.signal.reason),
            { once: true },
          );
        }),
    );
    const nextOperation = vi.fn(async () => undefined);
    const next = gate.run(
      ROUTE,
      options(new AbortController().signal),
      nextOperation,
    );

    await vi.advanceTimersByTimeAsync(1000);
    firstController.abort(new DOMException('cancelled', 'AbortError'));
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    await next;
    expect(nextOperation).toHaveBeenCalledOnce();
    gate.dispose();
  });

  it('rejects calls waiting when the session is disposed', async () => {
    const gate = new ModelRetryGate();
    await openGate(gate);

    const waiting = gate.run(
      ROUTE,
      options(new AbortController().signal),
      async () => undefined,
    );
    gate.dispose();

    await expect(waiting).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Model retry gate disposed',
    });
  });
});
