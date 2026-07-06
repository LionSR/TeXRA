import { EventEmitter } from 'node:events';

export interface AppSignalPayloads {
  /**
   * GitHub rejected the configured token. Frontends can surface the failure
   * and direct the user to token settings.
   */
  githubTokenInvalid: { message: string };

  /** Active PR-activity subscription keys changed. */
  prSubscriptionsChanged: { keys: readonly string[] };
  /** Active PR-activity owners changed. */
  prSubscriptionBindingsChanged: undefined;
  /** Active repo-activity subscription keys changed. */
  repoSubscriptionsChanged: { keys: readonly string[] };
  /** Active repo-activity owners changed. */
  repoSubscriptionBindingsChanged: undefined;
  /** Active issue-activity subscription keys changed. */
  issueSubscriptionsChanged: { keys: readonly string[] };
  /** Active issue-activity owners changed. */
  issueSubscriptionBindingsChanged: undefined;

  /**
   * External tool availability was re-probed. Frontends refresh their
   * dashboards from the updated cache.
   */
  toolAvailabilityChanged: undefined;
}

export type AppSignal = keyof AppSignalPayloads;

export interface AppSignalsLike {
  on<K extends AppSignal>(
    event: K,
    listener: (payload: AppSignalPayloads[K]) => void,
    options?: { signal?: AbortSignal },
  ): () => void;

  emit<K extends AppSignal>(event: K, payload: AppSignalPayloads[K]): void;
}

class AppSignals implements AppSignalsLike {
  private readonly emitter = new EventEmitter();

  on<K extends AppSignal>(
    event: K,
    listener: (payload: AppSignalPayloads[K]) => void,
    options?: { signal?: AbortSignal },
  ): () => void {
    if (options?.signal?.aborted) return () => {};

    this.emitter.on(event, listener);
    const cleanup = (): void => {
      this.emitter.off(event, listener);
    };
    options?.signal?.addEventListener('abort', cleanup, { once: true });
    return cleanup;
  }

  emit<K extends AppSignal>(event: K, payload: AppSignalPayloads[K]): void {
    this.emitter.emit(event, payload);
  }
}

export const appSignals = new AppSignals();
