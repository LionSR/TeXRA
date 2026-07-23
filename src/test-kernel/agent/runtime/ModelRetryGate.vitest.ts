// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { ModelRetryGate } from '@agent/runtime/ModelRetryGate';

const ROUTE = 'openai:subscription:gpt-5.6';
const TRANSIENT = new Error('temporary connection failure');
const UNAUTHORIZED = Object.assign(new Error('relay token expired'), {
  status: 401,
});

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
    const first = gate.run(
      ROUTE,
      options(new AbortController().signal),
      probeOperation,
    );
    const sibling = gate.run(
      ROUTE,
      options(new AbortController().signal),
      siblingOperation,
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(probeOperation).toHaveBeenCalledOnce();
    expect(siblingOperation).not.toHaveBeenCalled();

    resolveProbe();
    await Promise.all([first, sibling]);
    expect(siblingOperation).toHaveBeenCalledOnce();
    gate.dispose();
  });

  it('grows the shared backoff when the released herd re-fails after a probe', async () => {
    // Regression: resetting the failure streak on probe success capped the
    // backoff at its base forever on capacity-limited (429) routes — the rate
    // window fits one probe, the released herd re-fails, and the counter
    // restarts from zero every round.
    const gate = new ModelRetryGate();
    await openGate(gate);

    const probeOperation = vi.fn(async () => undefined);
    const probe = gate.run(
      ROUTE,
      options(new AbortController().signal),
      probeOperation,
    );
    const herdOperation = vi.fn(async () => {
      throw TRANSIENT;
    });
    const herd = gate.run(
      ROUTE,
      options(new AbortController().signal),
      herdOperation,
    );

    const herdResult = expect(herd).rejects.toBe(TRANSIENT);
    await vi.advanceTimersByTimeAsync(1000);
    await probe;
    await herdResult;
    expect(probeOperation).toHaveBeenCalledOnce();
    expect(herdOperation).toHaveBeenCalledOnce();

    // Second failure on the route: backoff must now be 2x the base, not base.
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

    // Third failure keeps growing: 4x the base.
    const thirdFailure = gate.run(
      ROUTE,
      options(new AbortController().signal),
      async () => {
        throw TRANSIENT;
      },
    );
    await expect(thirdFailure).rejects.toBe(TRANSIENT);
    const finalOperation = vi.fn(async () => undefined);
    const final = gate.run(
      ROUTE,
      options(new AbortController().signal),
      finalOperation,
    );
    await vi.advanceTimersByTimeAsync(3999);
    expect(finalOperation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await final;
    gate.dispose();
  });

  it('ends the failure streak after a clean round-trip on the healthy route', async () => {
    const gate = new ModelRetryGate();
    await openGate(gate);

    // Recover the route via a successful probe (streak carries over)...
    const probe = gate.run(
      ROUTE,
      options(new AbortController().signal),
      async () => undefined,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await probe;

    // ...then a success admitted while the route is already healthy resets it.
    await gate.run(
      ROUTE,
      options(new AbortController().signal),
      async () => undefined,
    );

    await expect(
      gate.run(ROUTE, options(new AbortController().signal), async () => {
        throw TRANSIENT;
      }),
    ).rejects.toBe(TRANSIENT);

    // Cooling restarts at the base backoff, not the previous streak's tier.
    const nextOperation = vi.fn(async () => undefined);
    const next = gate.run(
      ROUTE,
      options(new AbortController().signal),
      nextOperation,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await next;
    expect(nextOperation).toHaveBeenCalledOnce();
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

  it('keeps peers queued after an unclassified probe failure', async () => {
    const gate = new ModelRetryGate();
    await openGate(gate);

    let rejectProbe = (_error: Error): void => undefined;
    const probeResult = new Promise<void>((_resolve, reject) => {
      rejectProbe = reject;
    });
    const failedProbe = gate.run(
      ROUTE,
      {
        ...options(new AbortController().signal),
        classifyFailure: (error: Error) =>
          error === TRANSIENT ? {} : undefined,
      },
      () => probeResult,
    );
    const failedProbeResult = expect(failedProbe).rejects.toBe(UNAUTHORIZED);
    const firstPeerOperation = vi.fn(async () => undefined);
    const firstPeer = gate.run(
      ROUTE,
      options(new AbortController().signal),
      firstPeerOperation,
    );
    const secondPeerOperation = vi.fn(async () => undefined);
    const secondPeer = gate.run(
      ROUTE,
      options(new AbortController().signal),
      secondPeerOperation,
    );

    await vi.advanceTimersByTimeAsync(1000);
    rejectProbe(UNAUTHORIZED);
    await failedProbeResult;
    expect(firstPeerOperation).not.toHaveBeenCalled();
    expect(secondPeerOperation).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([firstPeer, secondPeer]);
    expect(firstPeerOperation).toHaveBeenCalledOnce();
    expect(secondPeerOperation).toHaveBeenCalledOnce();
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

  it('cancels the cooldown timer when its final waiter aborts', async () => {
    const gate = new ModelRetryGate();
    await openGate(gate);
    const controller = new AbortController();
    const waiting = gate.run(
      ROUTE,
      options(controller.signal),
      async () => undefined,
    );

    expect(vi.getTimerCount()).toBe(1);
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
    gate.dispose();
  });
});
