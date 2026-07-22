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
    classifyTransient: () => ({}),
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
