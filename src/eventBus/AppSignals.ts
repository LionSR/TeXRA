import { EventEmitter } from 'node:events';

/**
 * Cross-cutting, process-scoped app-lifecycle signals (auth, subscriptions,
 * tool availability, workspace-file writes). Not for run/session progress
 * events — those extend `AgentEvent` (`agent/trace/`) or `SessionFact`
 * (`SessionEventHub` in `agent/runtime/`), per the VS Code-free-zone rule in
 * CLAUDE.md.
 */
export interface AppSignalPayloads {
  /**
   * GitHub rejected the configured token. Frontends can surface the failure
   * and direct the user to token settings.
   */
  githubTokenInvalid: { message: string };

  /**
   * The active GitHub subscriptions (PR, repo, or issue) or their stream owners
   * changed. Keyless on purpose: every listener re-reads the full subscription
   * list, so which kind changed carries no information.
   */
  githubSubscriptionsChanged: undefined;

  /**
   * External tool availability was re-probed. Frontends refresh their
   * dashboards from the updated cache.
   */
  toolAvailabilityChanged: undefined;

  /** The editor's language-model catalogue or access permissions changed. */
  languageModelsChanged: undefined;

  /**
   * The session's approval policy changed (workspace transition or a settings
   * update). Surfaces that re-paint the status-bar policy line.
   */
  approvalPolicyChanged: undefined;

  /** The included-model-access preference changed. */
  includedModelAccessChanged: boolean;

  /**
   * One or more files were written directly to the workspace. Frontends can
   * badge or refresh those files without routing through a run-scoped channel.
   */
  workspaceFilesWritten: { absolutePaths: string[] };
}

type AppSignal = keyof AppSignalPayloads;

class AppSignals {
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
    let listenerFailed = false;
    let firstError: unknown;
    for (const listener of this.emitter.rawListeners(event)) {
      try {
        listener(payload);
      } catch (error) {
        if (!listenerFailed) firstError = error;
        listenerFailed = true;
      }
    }
    if (listenerFailed) throw firstError;
  }
}

export const appSignals = new AppSignals();
