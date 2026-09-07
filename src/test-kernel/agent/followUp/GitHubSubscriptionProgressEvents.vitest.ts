// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

const submitFollowUpMock = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'sent' as const })),
);

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  submitFollowUp: submitFollowUpMock,
}));

// Local imports
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { appSignals, type AppSignalPayloads } from '@eventBus/AppSignals';
import { effectRuntime } from '@platform/processRuntime';
import type { StreamTabId } from '@shared/schemas';

// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';
import { GitHubAuthError } from '@tools/github/githubClient';
import {
  PollingSourceBase,
  type BasePollSubscriptionState,
  type PollEventListener,
  type PollHookRejected,
} from '@tools/github/PollingSourceBase';
import {
  StreamSubscriptionRegistry,
  type StreamSubscriptionRegistryOptions,
} from '@tools/github/StreamSubscriptionRegistry';

// Local file imports
import { createRecordingHost } from '../progressTestUtils';

function createTestRegistry(
  source: RegistryTestSource,
  overrides: Partial<StreamSubscriptionRegistryOptions<string, string>> = {},
): StreamSubscriptionRegistry<string, string> {
  return new StreamSubscriptionRegistry<string, string>({
    name: 'test subscriptions',
    source,
    keyOf: (input) => input,
    ...overrides,
  });
}

function recordAppSignal<K extends keyof AppSignalPayloads>(
  event: K,
): {
  readonly events: { event: K; payload: AppSignalPayloads[K] }[];
  readonly dispose: () => void;
} {
  const events: { event: K; payload: AppSignalPayloads[K] }[] = [];
  const dispose = appSignals.on(event, (payload) => {
    events.push({ event, payload });
  });
  return { events, dispose };
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
      new GitHubAuthError('bad token'),
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
   * Awaiting the program keeps the assertions below deterministic.
   */
  async emit(input: string, text: string): Promise<void> {
    const listener = this.onEventByKey.get(input);
    if (listener) await effectRuntime().runPromise(listener(text));
  }

  private emitKeysChanged(): void {
    const keys = [...this.keys];
    for (const listener of this.keyListeners) listener(keys);
  }
}

describe('GitHub subscription app signals and follow-ups', () => {
  beforeEach(() => {
    submitFollowUpMock.mockReset();
    submitFollowUpMock.mockResolvedValue({ status: 'sent' as const });
  });

  it('publishes githubSubscriptionsChanged through app signals', async () => {
    const signal = recordAppSignal('githubSubscriptionsChanged');
    const source = new RegistryTestSource();
    const registry = createTestRegistry(source);

    try {
      await effectRuntime().runPromise(
        registry.bind('stream-a' as StreamTabId, 'owner/repo'),
      );
      expect(signal.events).toEqual([
        { event: 'githubSubscriptionsChanged', payload: undefined },
      ]);

      registry.unbind('stream-a' as StreamTabId, 'owner/repo');

      expect(signal.events).toEqual([
        { event: 'githubSubscriptionsChanged', payload: undefined },
        { event: 'githubSubscriptionsChanged', payload: undefined },
      ]);
    } finally {
      signal.dispose();
    }
  });

  it.effect('reports token invalid events through app signals', () =>
    Effect.gen(function* () {
      const host = createRecordingHost();
      const signal = recordAppSignal('githubTokenInvalid');
      const listener = (): Effect.Effect<void> => Effect.void;
      const state: BasePollSubscriptionState = {
        listeners: new Set([listener]),
        lastSuccessAt: Date.now(),
        consecutiveFailures: 0,
        skipPollUntilMs: 0,
      };

      try {
        yield* new TestPollingSource().failWithAuthError(state);

        expect(signal.events).toContainEqual({
          event: 'githubTokenInvalid',
          payload: { message: 'bad token' },
        });
        expect(host.events).toEqual([]);
      } finally {
        signal.dispose();
      }
    }),
  );

  it.effect('tracks transient backoff independently per subscription', () =>
    Effect.gen(function* () {
      const now = 1_800_000_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const createState = (): BasePollSubscriptionState => ({
        listeners: new Set(),
        lastSuccessAt: now,
        consecutiveFailures: 0,
        skipPollUntilMs: 0,
      });
      const source = new TestPollingSource();
      const first = createState();
      const second = createState();

      try {
        yield* source.failWithTransient('owner/repo#1', first);
        yield* source.failWithTransient('owner/repo#1', first);
        yield* source.failWithTransient('owner/repo#2', second);

        expect(first.skipPollUntilMs).toBe(now + 2_000);
        expect(second.skipPollUntilMs).toBe(now + 1_000);
      } finally {
        nowSpy.mockRestore();
        randomSpy.mockRestore();
      }
    }),
  );

  it('emits one binding change when unsubscribe disposes synchronously', async () => {
    const host = createRecordingHost();
    const signal = recordAppSignal('githubSubscriptionsChanged');
    const source = new RegistryTestSource();
    const registry = createTestRegistry(source);

    try {
      await effectRuntime().runPromise(
        registry.bind('stream-a' as StreamTabId, 'owner/repo'),
      );
      host.events.length = 0;
      signal.events.length = 0;

      expect(registry.unbind('stream-a' as StreamTabId, 'owner/repo')).toBe(
        true,
      );

      expect(signal.events).toEqual([
        { event: 'githubSubscriptionsChanged', payload: undefined },
      ]);
      expect(host.events).toEqual([]);
    } finally {
      signal.dispose();
    }
  });

  it('passes the bind-time session to detached subscription follow-ups', async () => {
    const streamId = 'stream-a' as StreamTabId;
    const source = new RegistryTestSource();
    const session = createTestSession();
    session.followUps.claimLive(streamId, 'flow');
    const registry = createTestRegistry(source);

    try {
      await withRunContext(createRunContext({ streamId, session }), () =>
        effectRuntime().runPromise(registry.bind(streamId, 'owner/repo')),
      );

      await source.emit('owner/repo', 'new github event');

      expect(submitFollowUpMock).toHaveBeenCalledWith(
        streamId,
        'new github event',
        { session, mode: 'live_notification' },
      );
    } finally {
      session.dispose();
    }
  });

  it('rebinds an existing subscription to the session that rebound it', async () => {
    const streamId = 'stream-a' as StreamTabId;
    const source = new RegistryTestSource();
    const firstSession = createTestSession();
    firstSession.followUps.claimLive(streamId, 'flow');
    const secondSession = createTestSession();
    secondSession.followUps.claimLive(streamId, 'flow');
    const registry = createTestRegistry(source);

    try {
      await withRunContext(
        createRunContext({ streamId, session: firstSession }),
        () => effectRuntime().runPromise(registry.bind(streamId, 'owner/repo')),
      );
      await withRunContext(
        createRunContext({ streamId, session: secondSession }),
        () => effectRuntime().runPromise(registry.bind(streamId, 'owner/repo')),
      );

      await source.emit('owner/repo', 'new github event');

      expect(submitFollowUpMock).toHaveBeenCalledWith(
        streamId,
        'new github event',
        { session: secondSession, mode: 'live_notification' },
      );
    } finally {
      firstSession.dispose();
      secondSession.dispose();
    }
  });

  it('warns instead of leaking an unhandled rejection when delivery fails', async () => {
    const streamId = 'stream-a' as StreamTabId;
    const source = new RegistryTestSource();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const registry = createTestRegistry(source, { logger });
    const unhandledRejection = vi.fn();
    submitFollowUpMock.mockRejectedValueOnce(new Error('delivery failed'));

    try {
      process.once('unhandledRejection', unhandledRejection);
      await effectRuntime().runPromise(registry.bind(streamId, 'owner/repo'));

      // emit() awaits the delivery program, so the recovery has run by the
      // time it resolves — no settle-and-hope.
      await source.emit('owner/repo', 'new github event');

      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to deliver subscription follow-up',
        expect.objectContaining({
          data: expect.objectContaining({
            key: 'owner/repo',
            streamId,
          }),
        }),
      );
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });
});
