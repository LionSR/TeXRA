// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

const submitFollowUpMock = vi.hoisted(() => vi.fn());

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  submitFollowUp: submitFollowUpMock,
}));

// Local imports
import {
  onAppSignal,
  type AppSignal,
  type AppSignalPayloads,
} from '@eventBus/AppSignals';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { AgentResume, Lifecycle } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import type { RunId } from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import {
  fakeHostAgentResume,
  fakeHostLifecycle,
  fakeHostSecrets,
} from '@test/support/setupPlatform';
import { testRuntime } from '@test/support/testProcessRuntime';

// Test support imports
import { captureLogEntries } from '@test/support/logSinkCapture';
import { createTestSession } from '@test/support/sessionTestUtils';
import { GitHubAuthError } from '@tools/github/githubClient';
import {
  PollingSourceBase,
  type BasePollSubscriptionState,
  type PollEventListener,
  type PollHookRejected,
} from '@tools/github/PollingSourceBase';
import {
  RunSubscriptionRegistry,
  type RunSubscriptionRegistryOptions,
} from '@tools/github/RunSubscriptionRegistry';

// Local file imports
import { createRecordingHost } from '../progressTestUtils';

function createTestRegistry(
  source: RegistryTestSource,
  overrides: Partial<RunSubscriptionRegistryOptions<string, string>> = {},
): RunSubscriptionRegistry<string, string> {
  return new RunSubscriptionRegistry<string, string>({
    name: 'test subscriptions',
    source,
    keyOf: (input) => input,
    ...overrides,
  });
}

/**
 * Collect one signal on a fiber of the harness runtime, as a host's own run
 * edge does. The await lets that fiber register before the caller publishes:
 * a subscription only receives what is published after it exists.
 */
async function recordAppSignal<K extends AppSignal>(
  event: K,
): Promise<{
  readonly events: { event: K; payload: AppSignalPayloads[K] }[];
  readonly dispose: () => void;
  /** An Effect that completes once `count` events have been delivered. */
  readonly delivered: (count: number) => Effect.Effect<void>;
}> {
  const events: { event: K; payload: AppSignalPayloads[K] }[] = [];
  const waiters: Array<{ count: number; deferred: Deferred.Deferred<void> }> =
    [];
  const notify = () => {
    for (const waiter of [...waiters]) {
      if (events.length >= waiter.count) {
        Deferred.doneUnsafe(waiter.deferred, Effect.void);
      }
    }
  };
  const fiber = testRuntime().runFork(
    onAppSignal(event, (payload) => {
      events.push({ event, payload });
      notify();
    }),
  );
  await testRuntime().runPromise(Effect.void);
  return {
    events,
    dispose: () => {
      testRuntime().runFork(Fiber.interrupt(fiber));
    },
    delivered: (count) =>
      Effect.gen(function* () {
        if (events.length >= count) return;
        const deferred = yield* Deferred.make<void>();
        waiters.push({ count, deferred });
        yield* Deferred.await(deferred);
      }),
  };
}

class TestPollingSource extends PollingSourceBase<
  string,
  BasePollSubscriptionState
> {
  constructor() {
    super({
      name: 'TestPollingSource',
      pollIntervalMs: 10_000,
      maxConcurrent: 1,
      backoffBaseMs: 1_000,
      backoffMaxMs: 10_000,
      maxFailureDurationMs: 60_000,
    });
  }

  protected pollOne(): Effect.Effect<void, PollHookRejected> {
    return Effect.void;
  }

  protected formatErrorEvent(): string {
    return 'subscription error';
  }

  failWithAuthError(state: BasePollSubscriptionState): Effect.Effect<void> {
    return this.handleFailure(
      'owner/repo',
      state,
      new GitHubAuthError({ message: 'bad token' }),
      Date.now(),
    );
  }

  failWithTransient(
    key: string,
    state: BasePollSubscriptionState,
  ): Effect.Effect<void> {
    return this.handleFailure(
      key,
      state,
      new Error('network down'),
      Date.now(),
    );
  }
}

class RegistryTestSource {
  private readonly keys = new Set<string>();
  private readonly keyListeners = new Set<(keys: readonly string[]) => void>();
  private readonly onEventByKey = new Map<string, PollEventListener>();

  activeKeys(): readonly string[] {
    return [...this.keys];
  }

  keyListenerCount(): number {
    return this.keyListeners.size;
  }

  onKeysChanged(listener: (keys: readonly string[]) => void): {
    dispose(): void;
  } {
    this.keyListeners.add(listener);
    return { dispose: () => this.keyListeners.delete(listener) };
  }

  subscribe(
    input: string,
    onEvent: PollEventListener,
  ): Effect.Effect<{ dispose(): void }> {
    return Effect.suspend(() => {
      this.keys.add(input);
      this.onEventByKey.set(input, onEvent);
      this.emitKeysChanged();
      return Effect.succeed({
        dispose: () => {
          this.keys.delete(input);
          this.onEventByKey.delete(input);
          this.emitKeysChanged();
        },
      });
    });
  }

  /**
   * Deliver one event the way `PollingSourceBase.emitToListener` does: the
   * listener builds its delivery program on this turn, then the program runs.
   * Awaiting the program keeps the assertions below deterministic, and the
   * diagnostics logger routes its warnings to the log sink as a host's does.
   */
  async emit(input: string, text: string): Promise<void> {
    const listener = this.onEventByKey.get(input);
    if (listener) {
      await testRuntime().runPromise(
        listener(text).pipe(Effect.provide(effectDiagnosticsLayer('Trace'))),
      );
    }
  }

  private emitKeysChanged(): void {
    const keys = [...this.keys];
    for (const listener of this.keyListeners) listener(keys);
  }
}

describe('GitHub subscription app signals and follow-ups', () => {
  beforeEach(() => {
    submitFollowUpMock.mockReset();
    submitFollowUpMock.mockReturnValue(
      Effect.succeed({ status: 'sent' as const }),
    );
  });

  afterEach(() => {
    setLogSink(null);
  });

  it.effect('reports token invalid events through app signals', () =>
    Effect.gen(function* () {
      const host = createRecordingHost();
      const signal = yield* Effect.promise(() =>
        recordAppSignal('githubTokenInvalid'),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => signal.dispose()));
      const listener = (): Effect.Effect<void> => Effect.void;
      const state: BasePollSubscriptionState = {
        listeners: new Set([listener]),
        lastSuccessAt: Date.now(),
        consecutiveFailures: 0,
        skipPollUntilMs: 0,
      };

      yield* new TestPollingSource().failWithAuthError(state);

      yield* signal.delivered(1);
      expect(signal.events).toContainEqual({
        event: 'githubTokenInvalid',
        payload: { message: 'bad token' },
      });
      expect(host.events).toEqual([]);
    }),
  );

  it.effect('dispose releases every binding and the source-key listener', () =>
    Effect.gen(function* () {
      const source = new RegistryTestSource();
      const session = createTestSession();
      const registry = createTestRegistry(source);
      yield* Effect.addFinalizer(() => closeSessionOf(session));

      yield* registry
        .bind('stream-a' as RunId, 'owner/repo', session)
        .pipe(
          Effect.provideService(Secrets, fakeHostSecrets),
          Effect.provideService(AgentResume, fakeHostAgentResume),
          Effect.provideService(Lifecycle, fakeHostLifecycle),
        );
      expect(source.keyListenerCount()).toBe(1);

      registry.dispose();

      expect(source.activeKeys()).toEqual([]);
      expect(source.keyListenerCount()).toBe(0);
      expect(registry.list(['owner/repo'])).toEqual([
        { key: 'owner/repo', runIds: [] },
      ]);
    }),
  );

  it.effect(
    'passes the bind-time session to detached subscription follow-ups',
    () =>
      Effect.gen(function* () {
        const runId = 'stream-a' as RunId;
        const source = new RegistryTestSource();
        const session = createTestSession();
        session.followUps.claimLive(runId, 'flow');
        const registry = createTestRegistry(source);
        yield* Effect.addFinalizer(() => closeSessionOf(session));

        yield* registry
          .bind(runId, 'owner/repo', session)
          .pipe(
            Effect.provideService(Secrets, fakeHostSecrets),
            Effect.provideService(AgentResume, fakeHostAgentResume),
            Effect.provideService(Lifecycle, fakeHostLifecycle),
          );

        yield* Effect.promise(() =>
          source.emit('owner/repo', 'new github event'),
        );

        expect(submitFollowUpMock).toHaveBeenCalledWith(
          runId,
          'new github event',
          { session, mode: 'live_notification' },
        );
      }),
  );

  it.effect(
    'rebinds an existing subscription to the session that rebound it',
    () =>
      Effect.gen(function* () {
        const runId = 'stream-a' as RunId;
        const source = new RegistryTestSource();
        const firstSession = createTestSession();
        firstSession.followUps.claimLive(runId, 'flow');
        const secondSession = createTestSession();
        secondSession.followUps.claimLive(runId, 'flow');
        const registry = createTestRegistry(source);
        yield* Effect.addFinalizer(() => closeSessionOf(secondSession));
        yield* Effect.addFinalizer(() => closeSessionOf(firstSession));

        yield* registry
          .bind(runId, 'owner/repo', firstSession)
          .pipe(
            Effect.provideService(Secrets, fakeHostSecrets),
            Effect.provideService(AgentResume, fakeHostAgentResume),
            Effect.provideService(Lifecycle, fakeHostLifecycle),
          );
        yield* registry
          .bind(runId, 'owner/repo', secondSession)
          .pipe(
            Effect.provideService(Secrets, fakeHostSecrets),
            Effect.provideService(AgentResume, fakeHostAgentResume),
            Effect.provideService(Lifecycle, fakeHostLifecycle),
          );

        yield* Effect.promise(() =>
          source.emit('owner/repo', 'new github event'),
        );

        expect(submitFollowUpMock).toHaveBeenCalledWith(
          runId,
          'new github event',
          { session: secondSession, mode: 'live_notification' },
        );
      }),
  );

  it.effect(
    'warns instead of leaking an unhandled rejection when delivery fails',
    () =>
      Effect.gen(function* () {
        const runId = 'stream-a' as RunId;
        const source = new RegistryTestSource();
        const session = createTestSession();
        const logs = captureLogEntries();
        const registry = createTestRegistry(source);
        const unhandledRejection = vi.fn();
        submitFollowUpMock.mockReturnValueOnce(
          Effect.fail(new Error('delivery failed')),
        );
        yield* Effect.addFinalizer(() => closeSessionOf(session));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            process.off('unhandledRejection', unhandledRejection),
          ),
        );

        process.once('unhandledRejection', unhandledRejection);
        yield* registry
          .bind(runId, 'owner/repo', session)
          .pipe(
            Effect.provideService(Secrets, fakeHostSecrets),
            Effect.provideService(AgentResume, fakeHostAgentResume),
            Effect.provideService(Lifecycle, fakeHostLifecycle),
          );

        // emit() awaits the delivery program, so the recovery has run by the
        // time it resolves — no settle-and-hope.
        yield* Effect.promise(() =>
          source.emit('owner/repo', 'new github event'),
        );

        expect(unhandledRejection).not.toHaveBeenCalled();
        const [warning] = logs.at('WARN', 'test subscriptions');
        expect(warning?.message).toBe(
          `Failed to deliver subscription follow-up for owner/repo (run ${runId})`,
        );
        expect(warning?.annotations.data).toContain('delivery failed');
      }),
  );
});
