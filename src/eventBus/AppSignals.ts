import { EventEmitter } from 'node:events';

/**
 * Cross-cutting, process-scoped app-lifecycle signals (auth, subscriptions,
 * tool availability, workspace-file writes). Not for run/session progress
 * events — those extend `AgentEvent` (`agent/trace/`) or `SessionFact`
 * (`SessionEventHub` in `agent/runtime/`), per the VS Code-free-zone rule in
 * CLAUDE.md.
 *
 * Every signal below records which hosts consume it and — where a host does
 * not — why not. A signal with no such note is the ambiguous middle this file
 * exists to prevent: a host that silently never reacts is indistinguishable
 * from a host that deliberately doesn't. Keep the note truthful when you add a
 * subscriber; "no equivalent surface" is a valid, and common, answer.
 */
export interface AppSignalPayloads {
  /**
   * GitHub rejected the configured token. Frontends can surface the failure
   * and direct the user to token settings.
   *
   * Consumed by: extension (modal error + jump to Git settings), desktop
   * (error dialog + re-post of the Git tab's token status). Not the CLI: a
   * poller rejection arrives with no chat turn to attach it to, and the TUI
   * has no out-of-band notice surface — the rejection is logged instead.
   */
  githubTokenInvalid: { message: string };

  /**
   * The active GitHub subscriptions (PR, repo, or issue) or their stream owners
   * changed. Keyless on purpose: every listener re-reads the full subscription
   * list, so which kind changed carries no information.
   *
   * Consumed by: extension and desktop settings views, both re-reading the
   * full subscription list for their Git tab. Not the CLI: it lists
   * subscriptions on demand from a slash command and has no persistent panel
   * that could go stale.
   */
  githubSubscriptionsChanged: undefined;

  /**
   * External tool availability was re-probed. Frontends refresh their
   * dashboards from the updated cache.
   *
   * Consumed by: extension and desktop settings views — this is the sole
   * repaint path for both Tools dashboards, so every re-probe reaches the UI
   * regardless of which input changed. Not the CLI: it has no tools
   * dashboard; availability is read per-run when a tool is invoked.
   */
  toolAvailabilityChanged: undefined;

  /**
   * The editor's language-model catalogue or access permissions changed.
   *
   * Extension-only by construction: the sole emitter is VS Code's
   * `lm.onDidChangeModels` / `onDidChangeAccess`. Desktop and CLI have no
   * editor-provided model catalogue to change, so there is nothing to react
   * to — not a missing subscription.
   */
  languageModelsChanged: undefined;

  /**
   * The session's approval policy changed (workspace transition or a settings
   * update). Surfaces that re-paint the status-bar policy line.
   *
   * Extension-only: it exists because VS Code's status-bar tooltip is painted
   * outside the settings webview's own round-trip and has no other refresh
   * trigger. The desktop's write path re-posts the approval snapshot inline
   * (`applyStateSettingUpdate` -> `postStateSettingSnapshot`), and the CLI
   * holds the policy in TUI state that its `/approval` command updates
   * directly, so a subscription on either host would be a duplicate repaint.
   */
  approvalPolicyChanged: undefined;

  /**
   * One or more files were written directly to the workspace. Frontends can
   * badge or refresh those files without routing through a run-scoped channel.
   *
   * Consumed by: extension (VS Code's `FileDecorationProvider` badges the
   * written Explorer entries) and desktop (its file tree caches a directory
   * listing and has no filesystem watcher, so this is the only notice it gets
   * that a write landed behind its back). Not the CLI: it has no file tree or
   * decoration surface — accepted paths are printed into the transcript by the
   * tool row, which is built from the tool result and cannot go stale.
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
