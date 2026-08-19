// Third-party imports
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

// Local imports
import { ModelRetryGate } from '@agent/runtime/ModelRetryGate';
import { createDeferred } from '@test/support/asyncTestUtils';

const ROUTE = 'openai:subscription:gpt-5.6';
const OTHER_ROUTE = 'anthropic:api-key:claude-opus';
const MODEL_ROUTE = `${ROUTE}:model`;
const OTHER_MODEL_ROUTE = 'openai:subscription:gpt-5.7:model';
const TRANSIENT = new Error('temporary connection failure');
const RATE_LIMIT = Object.assign(new Error('model rate limited'), {
  status: 429,
});
const UNAUTHORIZED = Object.assign(new Error('credential expired'), {
  status: 401,
});

function options(
  signal: AbortSignal = new AbortController().signal,
  baseBackoffMs = 1000,
) {
  return {
    signal,
    baseBackoffMs,
    classifyFailure: () => ({}),
  };
}

async function throwTransient(): Promise<never> {
  throw TRANSIENT;
}

/** Holds the gate's probe open until `complete()` is called. */
function pendingOperation() {
  const deferred = createDeferred();
  return {
    operation: vi.fn(() => deferred.promise),
    complete(): void {
      deferred.resolve();
    },
  };
}

async function openGate(gate: ModelRetryGate): Promise<void> {
  await expect(gate.run(ROUTE, options(), throwTransient)).rejects.toBe(
    TRANSIENT,
  );
}

/** Asserts the pending call stays queued until exactly `delayMs` elapses. */
async function expectAdmittedAfter(
  pending: Promise<unknown>,
  operation: Mock,
  delayMs: number,
): Promise<void> {
  await vi.advanceTimersByTimeAsync(delayMs - 1);
  expect(operation).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(operation).toHaveBeenCalledOnce();
}

/** Recovers ROUTE with a successful probe after its base-backoff cooldown. */
async function recoverRoute(
  gate: ModelRetryGate,
  runOptions: Parameters<ModelRetryGate['run']>[1] = options(),
): Promise<void> {
  const probe = gate.run(ROUTE, runOptions, async () => undefined);
  await vi.advanceTimersByTimeAsync(1000);
  await probe;
}

/** Fails ROUTE's recovery probe after the base-backoff cooldown. */
async function failRecoveryProbe(gate: ModelRetryGate): Promise<void> {
  const failedProbe = gate.run(ROUTE, options(), throwTransient);
  const failedProbeResult = expect(failedProbe).rejects.toBe(TRANSIENT);
  await vi.advanceTimersByTimeAsync(1000);
  await failedProbeResult;
}

describe('ModelRetryGate', () => {
  let gate: ModelRetryGate;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    gate = new ModelRetryGate();
  });

  afterEach(() => {
    gate.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('admits one recovery probe and releases siblings after success', async () => {
    await openGate(gate);

    const probe = pendingOperation();
    const siblingOperation = vi.fn(async () => undefined);
    const first = gate.run(ROUTE, options(), probe.operation);
    const sibling = gate.run(ROUTE, options(), siblingOperation);

    await vi.advanceTimersByTimeAsync(1000);
    expect(probe.operation).toHaveBeenCalledOnce();
    expect(siblingOperation).not.toHaveBeenCalled();

    probe.complete();
    await Promise.all([first, sibling]);
    expect(siblingOperation).toHaveBeenCalledOnce();
  });

  it('grows the shared backoff when the released herd re-fails after a probe', async () => {
    // Regression: resetting the failure streak on probe success capped the
    // backoff at its base forever on capacity-limited (429) routes — the rate
    // window fits one probe, the released herd re-fails, and the counter
    // restarts from zero every round.
    await openGate(gate);

    const probeOperation = vi.fn(async () => undefined);
    const probe = gate.run(ROUTE, options(), probeOperation);
    const herdOperation = vi.fn(throwTransient);
    const herd = gate.run(ROUTE, options(), herdOperation);

    const herdResult = expect(herd).rejects.toBe(TRANSIENT);
    await vi.advanceTimersByTimeAsync(1000);
    await probe;
    await herdResult;
    expect(probeOperation).toHaveBeenCalledOnce();
    expect(herdOperation).toHaveBeenCalledOnce();

    // Second failure on the route: backoff must now be 2x the base, not base.
    const nextOperation = vi.fn(async () => undefined);
    const next = gate.run(ROUTE, options(), nextOperation);
    await expectAdmittedAfter(next, nextOperation, 2000);

    // Third failure keeps growing: 4x the base.
    await expect(gate.run(ROUTE, options(), throwTransient)).rejects.toBe(
      TRANSIENT,
    );
    const finalOperation = vi.fn(async () => undefined);
    const final = gate.run(ROUTE, options(), finalOperation);
    await expectAdmittedAfter(final, finalOperation, 4000);
  });

  it('keeps model rate limits off the shared wire route', async () => {
    const modelOptions = (modelRoute: string) => ({
      ...options(),
      classifyFailure: () => undefined,
      isReachableFailure: (error: Error) => error === RATE_LIMIT,
      additionalRoutes: [
        {
          key: modelRoute,
          classifyFailure: (error: Error) =>
            error === RATE_LIMIT ? {} : undefined,
        },
      ],
    });

    await expect(
      gate.run(ROUTE, modelOptions(MODEL_ROUTE), async () => {
        throw RATE_LIMIT;
      }),
    ).rejects.toBe(RATE_LIMIT);

    const limitedOperation = vi.fn(async () => undefined);
    const limited = gate.run(
      ROUTE,
      modelOptions(MODEL_ROUTE),
      limitedOperation,
    );
    const otherModelOperation = vi.fn(async () => undefined);
    await gate.run(ROUTE, modelOptions(OTHER_MODEL_ROUTE), otherModelOperation);

    expect(otherModelOperation).toHaveBeenCalledOnce();
    expect(limitedOperation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await limited;
    expect(limitedOperation).toHaveBeenCalledOnce();
  });

  it('does not reserve the wire probe while waiting for a model cooldown', async () => {
    const modelOptions = (modelRoute: string, modelRetryAfterMs?: number) => ({
      ...options(),
      classifyFailure: (error: Error) => (error === TRANSIENT ? {} : undefined),
      isReachableFailure: (error: Error) => error === RATE_LIMIT,
      additionalRoutes: [
        {
          key: modelRoute,
          classifyFailure: (error: Error) =>
            error === RATE_LIMIT
              ? { retryAfterMs: modelRetryAfterMs }
              : undefined,
        },
      ],
    });

    await expect(
      gate.run(ROUTE, modelOptions(MODEL_ROUTE, 10_000), async () => {
        throw RATE_LIMIT;
      }),
    ).rejects.toBe(RATE_LIMIT);
    await expect(
      gate.run(ROUTE, modelOptions(OTHER_MODEL_ROUTE), throwTransient),
    ).rejects.toBe(TRANSIENT);

    const limitedOperation = vi.fn(async () => undefined);
    const limited = gate.run(
      ROUTE,
      modelOptions(MODEL_ROUTE, 10_000),
      limitedOperation,
    );
    const siblingOperation = vi.fn(async () => undefined);
    const sibling = gate.run(
      ROUTE,
      modelOptions(OTHER_MODEL_ROUTE),
      siblingOperation,
    );

    await vi.advanceTimersByTimeAsync(1000);
    await sibling;
    expect(siblingOperation).toHaveBeenCalledOnce();
    expect(limitedOperation).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(9000);
    await limited;
    expect(limitedOperation).toHaveBeenCalledOnce();
  });

  it('ends the failure streak after a clean round-trip on the healthy route', async () => {
    await openGate(gate);

    // Recover the route via a successful probe (streak carries over)...
    await recoverRoute(gate);

    // ...then a success admitted while the route is already healthy resets it.
    await gate.run(ROUTE, options(), async () => undefined);

    await expect(gate.run(ROUTE, options(), throwTransient)).rejects.toBe(
      TRANSIENT,
    );

    // Cooling restarts at the base backoff, not the previous streak's tier.
    const nextOperation = vi.fn(async () => undefined);
    const next = gate.run(ROUTE, options(), nextOperation);
    await vi.advanceTimersByTimeAsync(1000);
    await next;
    expect(nextOperation).toHaveBeenCalledOnce();
  });

  it('honors an explicitly disabled shared backoff', async () => {
    const controller = new AbortController();
    await expect(
      gate.run(ROUTE, options(controller.signal, 0), throwTransient),
    ).rejects.toBe(TRANSIENT);

    const operation = vi.fn(async () => undefined);
    const retry = gate.run(ROUTE, options(undefined, 0), operation);
    expect(operation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    await retry;
    expect(operation).toHaveBeenCalledOnce();
  });

  it('increases the shared backoff after a failed probe', async () => {
    await openGate(gate);
    await failRecoveryProbe(gate);

    const nextOperation = vi.fn(async () => undefined);
    const next = gate.run(ROUTE, options(), nextOperation);
    await expectAdmittedAfter(next, nextOperation, 2000);
  });

  it('keeps peers queued after an unclassified probe failure', async () => {
    await openGate(gate);

    let rejectProbe = (_error: Error): void => undefined;
    const probeResult = new Promise<void>((_resolve, reject) => {
      rejectProbe = reject;
    });
    const failedProbe = gate.run(
      ROUTE,
      {
        ...options(),
        classifyFailure: (error: Error) =>
          error === TRANSIENT ? {} : undefined,
      },
      () => probeResult,
    );
    const failedProbeResult = expect(failedProbe).rejects.toBe(UNAUTHORIZED);
    const firstPeerOperation = vi.fn(async () => undefined);
    const firstPeer = gate.run(ROUTE, options(), firstPeerOperation);
    const secondPeerOperation = vi.fn(async () => undefined);
    const secondPeer = gate.run(ROUTE, options(), secondPeerOperation);

    await vi.advanceTimersByTimeAsync(1000);
    rejectProbe(UNAUTHORIZED);
    await failedProbeResult;
    expect(firstPeerOperation).not.toHaveBeenCalled();
    expect(secondPeerOperation).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([firstPeer, secondPeer]);
    expect(firstPeerOperation).toHaveBeenCalledOnce();
    expect(secondPeerOperation).toHaveBeenCalledOnce();
  });

  it('resets an old failure streak after a healthy unclassified failure', async () => {
    await openGate(gate);
    const scopedOptions = {
      ...options(),
      classifyFailure: (error: Error) => (error === TRANSIENT ? {} : undefined),
    };

    const probe = gate.run(ROUTE, scopedOptions, async () => undefined);
    const healthyFailure = gate.run(ROUTE, scopedOptions, async () => {
      throw UNAUTHORIZED;
    });
    const healthyFailureResult =
      expect(healthyFailure).rejects.toBe(UNAUTHORIZED);
    await vi.advanceTimersByTimeAsync(1000);
    await probe;
    await healthyFailureResult;

    await expect(gate.run(ROUTE, scopedOptions, throwTransient)).rejects.toBe(
      TRANSIENT,
    );
    const recoveredOperation = vi.fn(async () => undefined);
    const recovered = gate.run(ROUTE, scopedOptions, recoveredOperation);
    await expectAdmittedAfter(recovered, recoveredOperation, 1000);
  });

  it('does not let a stale success erase a newer failed probe', async () => {
    const stale = pendingOperation();
    const stalePending = gate.run(ROUTE, options(), stale.operation);
    await openGate(gate);
    await failRecoveryProbe(gate);

    const currentProbe = vi.fn(async () => undefined);
    const current = gate.run(ROUTE, options(), currentProbe);
    stale.complete();
    await stalePending;
    await expectAdmittedAfter(current, currentProbe, 2000);
  });

  it('does not let a stale healthy success reset recovered backoff', async () => {
    const stale = pendingOperation();
    const stalePending = gate.run(ROUTE, options(), stale.operation);
    await openGate(gate);
    await recoverRoute(gate);

    stale.complete();
    await stalePending;
    await expect(gate.run(ROUTE, options(), throwTransient)).rejects.toBe(
      TRANSIENT,
    );

    const nextOperation = vi.fn(async () => undefined);
    const next = gate.run(ROUTE, options(), nextOperation);
    await expectAdmittedAfter(next, nextOperation, 2000);
  });

  it('hands an abandoned probe to the next waiting call', async () => {
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
    const next = gate.run(ROUTE, options(), nextOperation);

    await vi.advanceTimersByTimeAsync(1000);
    firstController.abort(new DOMException('cancelled', 'AbortError'));
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    await next;
    expect(nextOperation).toHaveBeenCalledOnce();
  });

  it('rejects calls waiting when the session is disposed', async () => {
    await openGate(gate);

    const waiting = gate.run(ROUTE, options(), async () => undefined);
    gate.dispose();

    await expect(waiting).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Model retry gate disposed',
    });
  });

  it('cancels the cooldown timer when its final waiter aborts', async () => {
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
  });
});
