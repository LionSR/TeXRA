// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - agent runtime
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';

// Local imports - shared schemas
import type { StreamTabId } from '@shared/schemas';

// Local imports - tools
import {
  emitGitHubSubscriptionChanged,
  emitGitHubSubscriptionChangedToHosts,
} from '@tools/github/subscriptionEventEmitter';
import { GitHubAuthError } from '@tools/github/githubClient';
import {
  PollingSourceBase,
  type BasePollSubscriptionState,
} from '@tools/github/PollingSourceBase';
import { StreamSubscriptionRegistry } from '@tools/github/StreamSubscriptionRegistry';

// Local imports - test
import { createRecordingHost } from '../progressTestUtils';

class TestPollingSource extends PollingSourceBase<
  string,
  BasePollSubscriptionState
> {
  private keysChangedEventCount = 0;

  constructor() {
    super({
      name: 'TestPollingSource',
      pollIntervalMs: 10_000,
      maxConcurrent: 1,
      backoffBaseMs: 1_000,
      backoffMaxMs: 1_000,
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
    this.keysChangedEventCount += 1;
  }

  failWithAuthError(state: BasePollSubscriptionState): void {
    this.handleFailure('owner/repo', state, new GitHubAuthError('bad token'));
  }
}

class RegistryTestSource {
  private readonly keys = new Set<string>();
  private readonly keyListeners = new Set<(keys: readonly string[]) => void>();

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
    runtimeHost: AgentRuntimeHost,
  ): { dispose(): void } {
    void onEvent;
    void runtimeHost;
    this.keys.add(input);
    this.emitKeysChanged();
    return {
      dispose: () => {
        this.keys.delete(input);
        this.emitKeysChanged();
      },
    };
  }

  private emitKeysChanged(): void {
    const keys = [...this.keys];
    for (const listener of this.keyListeners) listener(keys);
  }
}

describe('GitHub subscription progress events', () => {
  it('publishes binding changes through the explicit runtime host', () => {
    const host = createRecordingHost();

    emitGitHubSubscriptionChanged(
      host.host,
      'repoSubscriptionBindingsChanged',
      undefined,
    );

    expect(host.events).toEqual([
      { event: 'repoSubscriptionBindingsChanged', payload: undefined },
    ]);
  });

  it('deduplicates multiple bindings that share a runtime host', () => {
    const host = createRecordingHost();

    emitGitHubSubscriptionChangedToHosts(
      [host.host, host.host],
      'issueSubscriptionBindingsChanged',
      undefined,
    );

    expect(host.events).toEqual([
      { event: 'issueSubscriptionBindingsChanged', payload: undefined },
    ]);
  });

  it('reports token invalid events through the subscription runtime host', () => {
    const host = createRecordingHost();
    const listener = () => {};
    const state: BasePollSubscriptionState = {
      listeners: new Set([listener]),
      runtimeHostByListener: new Map([[listener, host.host]]),
      lastSuccessAt: Date.now(),
      consecutiveFailures: 0,
      skipPollUntilMs: 0,
    };

    new TestPollingSource().failWithAuthError(state);

    expect(host.events).toContainEqual({
      event: 'githubTokenInvalid',
      payload: { message: 'bad token' },
    });
  });

  it('emits one binding change when unsubscribe disposes synchronously', () => {
    const host = createRecordingHost();
    const source = new RegistryTestSource();
    const registry = new StreamSubscriptionRegistry<string, string>({
      name: 'test subscriptions',
      source,
      keyOf: (input) => input,
      bindingsChangedEvent: 'repoSubscriptionBindingsChanged',
    });

    registry.bind('stream-a' as StreamTabId, 'owner/repo', host.host);
    host.events.length = 0;

    expect(
      registry.unbind('stream-a' as StreamTabId, 'owner/repo', host.host),
    ).toBe(true);

    expect(host.events).toEqual([
      { event: 'repoSubscriptionBindingsChanged', payload: undefined },
    ]);
  });
});
