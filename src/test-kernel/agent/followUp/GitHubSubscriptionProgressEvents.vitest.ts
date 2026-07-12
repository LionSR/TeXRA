// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendFollowUpMock = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'sent' as const })),
);

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  sendFollowUp: sendFollowUpMock,
}));

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { SessionHandle } from '@agent/runtime/SessionHandle';

// Local imports - event bus
import { appSignals, type AppSignalPayloads } from '@eventBus/AppSignals';

// Local imports - shared schemas
import type { StreamTabId } from '@shared/schemas';

// Local imports - tools
import { emitGitHubSubscriptionChanged } from '@tools/github/subscriptionEventEmitter';
import { GitHubAuthError } from '@tools/github/githubClient';
import {
  PollingSourceBase,
  type BasePollSubscriptionState,
} from '@tools/github/PollingSourceBase';
import { StreamSubscriptionRegistry } from '@tools/github/StreamSubscriptionRegistry';

// Local imports - test
import { createRecordingHost } from '../progressTestUtils';

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

  protected pollOne(): Promise<void> {
    return Promise.resolve();
  }

  protected formatErrorEvent(): string {
    return 'subscription error';
  }

  protected emitKeysChangedEvent(): void {
    // No-op: this test double doesn't need to observe key-change events.
  }

  failWithAuthError(state: BasePollSubscriptionState): void {
    this.handleFailure('owner/repo', state, new GitHubAuthError('bad token'));
  }

  failWithTransient(key: string, state: BasePollSubscriptionState): void {
    this.handleFailure(key, state, new Error('network down'));
  }
}

class RegistryTestSource {
  private readonly keys = new Set<string>();
  private readonly keyListeners = new Set<(keys: readonly string[]) => void>();
  private readonly onEventByKey = new Map<string, (text: string) => void>();

  has(key: string): boolean {
    return this.keys.has(key);
  }

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
    onEvent: (text: string) => void,
  ): { dispose(): void } {
    this.keys.add(input);
    this.onEventByKey.set(input, onEvent);
    this.emitKeysChanged();
    return {
      dispose: () => {
        this.keys.delete(input);
        this.onEventByKey.delete(input);
        this.emitKeysChanged();
      },
    };
  }

  emit(input: string, text: string): void {
    this.onEventByKey.get(input)?.(text);
  }

  private emitKeysChanged(): void {
    const keys = [...this.keys];
    for (const listener of this.keyListeners) listener(keys);
  }
}

describe('GitHub subscription app signals and follow-ups', () => {
  beforeEach(() => {
    sendFollowUpMock.mockReset();
    sendFollowUpMock.mockResolvedValue({ status: 'sent' as const });
  });

  it('publishes binding changes through app signals', () => {
    const signal = recordAppSignal('repoSubscriptionBindingsChanged');

    try {
      emitGitHubSubscriptionChanged(
        'repoSubscriptionBindingsChanged',
        undefined,
      );

      expect(signal.events).toEqual([
        { event: 'repoSubscriptionBindingsChanged', payload: undefined },
      ]);
    } finally {
      signal.dispose();
    }
  });

  it('publishes issue binding changes without a runtime host', () => {
    const signal = recordAppSignal('issueSubscriptionBindingsChanged');

    try {
      emitGitHubSubscriptionChanged(
        'issueSubscriptionBindingsChanged',
        undefined,
      );

      expect(signal.events).toEqual([
        { event: 'issueSubscriptionBindingsChanged', payload: undefined },
      ]);
    } finally {
      signal.dispose();
    }
  });

  it('reports token invalid events through app signals', () => {
    const host = createRecordingHost();
    const signal = recordAppSignal('githubTokenInvalid');
    const listener = () => {};
    const state: BasePollSubscriptionState = {
      listeners: new Set([listener]),
      lastSuccessAt: Date.now(),
      consecutiveFailures: 0,
      skipPollUntilMs: 0,
    };

    try {
      new TestPollingSource().failWithAuthError(state);

      expect(signal.events).toContainEqual({
        event: 'githubTokenInvalid',
        payload: { message: 'bad token' },
      });
      expect(host.events).toEqual([]);
    } finally {
      signal.dispose();
    }
  });

  it('tracks transient backoff independently per subscription', () => {
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
      source.failWithTransient('owner/repo#1', first);
      source.failWithTransient('owner/repo#1', first);
      source.failWithTransient('owner/repo#2', second);

      expect(first.skipPollUntilMs).toBe(now + 2_000);
      expect(second.skipPollUntilMs).toBe(now + 1_000);
    } finally {
      nowSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });

  it('emits one binding change when unsubscribe disposes synchronously', () => {
    const host = createRecordingHost();
    const signal = recordAppSignal('repoSubscriptionBindingsChanged');
    const source = new RegistryTestSource();
    const registry = new StreamSubscriptionRegistry<string, string>({
      name: 'test subscriptions',
      source,
      keyOf: (input) => input,
      bindingsChangedEvent: 'repoSubscriptionBindingsChanged',
    });

    try {
      registry.bind('stream-a' as StreamTabId, 'owner/repo');
      host.events.length = 0;

      expect(registry.unbind('stream-a' as StreamTabId, 'owner/repo')).toBe(
        true,
      );

      expect(signal.events).toEqual([
        { event: 'repoSubscriptionBindingsChanged', payload: undefined },
      ]);
      expect(host.events).toEqual([]);
    } finally {
      signal.dispose();
    }
  });

  it('passes the bind-time session to detached subscription follow-ups', () => {
    const streamId = 'stream-a' as StreamTabId;
    const host = createRecordingHost();
    const source = new RegistryTestSource();
    const session = createTestSession();
    const registry = new StreamSubscriptionRegistry<string, string>({
      name: 'test subscriptions',
      source,
      keyOf: (input) => input,
      bindingsChangedEvent: 'repoSubscriptionBindingsChanged',
    });
    sendFollowUpMock.mockClear();

    try {
      withRunContext(
        createRunContext({
          runtimeHost: host.host,
          streamId,
          session,
        }),
        () => registry.bind(streamId, 'owner/repo'),
      );

      source.emit('owner/repo', 'new github event');

      expect(sendFollowUpMock).toHaveBeenCalledWith(
        streamId,
        'new github event',
        undefined,
        undefined,
        session,
      );
    } finally {
      session.dispose();
    }
  });

  it('warns instead of leaking an unhandled rejection when delivery fails', async () => {
    const streamId = 'stream-a' as StreamTabId;
    const host = createRecordingHost();
    const source = new RegistryTestSource();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const registry = new StreamSubscriptionRegistry<string, string>({
      name: 'test subscriptions',
      logger,
      source,
      keyOf: (input) => input,
      bindingsChangedEvent: 'repoSubscriptionBindingsChanged',
    });
    const unhandledRejection = vi.fn();
    sendFollowUpMock.mockRejectedValueOnce(new Error('delivery failed'));

    try {
      process.once('unhandledRejection', unhandledRejection);
      registry.bind(streamId, 'owner/repo');

      source.emit('owner/repo', 'new github event');
      await new Promise((resolve) => setImmediate(resolve));

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
