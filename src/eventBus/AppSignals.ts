import { Effect, PubSub } from 'effect';

/**
 * Cross-cutting, process-scoped app-lifecycle signals (auth, subscriptions,
 * tool availability, workspace-file writes). Not for run/session progress
 * events — those extend `AgentEvent` (`agent/trace/`) or `SessionFact`
 * (`SessionEvents` in `agent/runtime/`), per the VS Code-free-zone rule in
 * CLAUDE.md.
 *
 * Delivery and error order, which this module owns and no caller may vary:
 *
 * - `emitAppSignal` publishes and returns. It never runs a subscriber, so a
 *   subscriber can neither block nor fail the code that emitted.
 * - Each subscriber drains its own `PubSub` subscription on its own fiber,
 *   forked at the host's run edge (R1: the fork lives at the host entry, not
 *   in the bus). One subscriber sees the signals it subscribed to in
 *   publication order; there is no order *between* subscribers, and a slow
 *   one holds up neither the publisher nor another subscriber.
 * - A subscriber that throws is logged at `warn` by its own delivery fiber
 *   and keeps its subscription: one broken listener never truncates a
 *   delivery. This is the one contract the `PubSub` conversion changed — the
 *   `EventEmitter` this replaces ran every listener on the emitter's stack
 *   and then rethrew the first listener's error into `emit`, so a settings
 *   view that failed to repaint could fail the tool call that wrote the
 *   file. Nothing depended on that throw; every caller emitted as a
 *   statement.
 * - A subscriber is live once its forked fiber has reached the `subscribe`
 *   below, which is a later scheduler turn than the `runFork` at the host's
 *   run edge: `runFork` schedules the fiber and returns, it does not run it.
 *   So a signal published in the same synchronous turn that subscribed
 *   reaches nobody — the ordinary `PubSub` rule that a subscription only
 *   receives what is published after it exists, and the reason the suites
 *   here yield once before they publish.
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
   * A write or removal of one secret-store entry settled. Emitted by the
   * store itself, so every writer is covered — the settings controllers, the
   * setup agent's `unset_api_key`, the GitHub token forms — without any of
   * them remembering to. The file-backed stores (desktop, CLI) emit from
   * their own commit finalizer; the VS Code store emits from
   * `SecretStorage.onDidChange`, which also sees writes from other windows.
   * The same stores hold OAuth tokens, sign-in nonces and Overleaf
   * credentials, so a subscriber filters on `key` and ignores the rest: an
   * OAuth refresh must not repaint the profile tab.
   *
   * Consumed by: extension and desktop (an `apiKey.*` change repaints the
   * credential-dependent settings, launcher and model surfaces; the GitHub
   * token re-probes tool availability), and the CLI chat TUI (an `apiKey.*`
   * change bumps the subscription-preference version its status bar reads;
   * the GitHub token re-probes tool availability, which the next run's tool
   * list reads from cache).
   */
  credentialChanged: { key: string };

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
   * The workspace agent roster changed outside a settings round-trip. Keyless
   * on purpose: every listener re-reads the roster, so which team or agent
   * moved carries no information.
   *
   * Emitted by the in-process roster writers that bypass the settings
   * round-trip: `apply_team`, which the setup agent runs mid-conversation,
   * and the agent-creator prompt that adds a new agent to the dropdown.
   * Settings-originated changes repaint through their own handler and do not
   * emit.
   *
   * Consumed by: extension and desktop settings views, both re-reading the
   * agent list and team presets. Not the CLI: it reads the roster per command
   * and has no persistent panel that could go stale.
   */
  agentRosterChanged: undefined;

  /**
   * The editor's language-model catalogue or access permissions changed.
   *
   * Extension-only by construction: the sole emitter is the language-model
   * port's `onDidChange`. Desktop and CLI have no editor-provided model
   * catalogue to change, so there is nothing to react to — not a missing
   * subscription.
   */
  languageModelsChanged: undefined;

  /**
   * The session's approval policy changed through a settings update.
   * Surfaces that re-paint the status-bar policy line.
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

export type AppSignal = keyof AppSignalPayloads;

/**
 * One published signal. The key and its payload are correlated by the two
 * public functions below, which is where a caller proves the pair; on the
 * hub they travel as what every subscription reads, a key and one of the
 * declared payloads.
 */
interface AppSignalEvent {
  readonly signal: AppSignal;
  readonly payload: AppSignalPayloads[AppSignal];
}

/**
 * The hub every signal is published to, opened by the first subscriber. A
 * `PubSub` is built inside an Effect and this module holds no execution
 * boundary of its own (R1), so there is nothing to open it before then — and
 * nothing is lost: a subscription only receives what is published after it
 * exists, so a signal emitted before the first subscriber had no reader
 * either way. Unbounded and never shut down: it lives as long as the
 * process, and publishing never blocks or drops.
 */
let hub: PubSub.PubSub<AppSignalEvent> | undefined;

const openHub: Effect.Effect<PubSub.PubSub<AppSignalEvent>> = Effect.suspend(
  () => {
    if (hub !== undefined) return Effect.succeed(hub);
    // `??=` settles a race between two first subscribers on the winner: the
    // loser publishes into, and reads from, the hub the winner opened.
    return Effect.map(
      PubSub.unbounded<AppSignalEvent>(),
      (opened) => (hub ??= opened),
    );
  },
);

/**
 * Publish `signal` to every current subscriber and return. Synchronous by
 * construction: the publish is the enqueue, and the hub is unbounded, so it
 * always accepts without suspending. The delivery itself runs on each
 * subscriber's own fiber — see the delivery and error order above.
 */
export function emitAppSignal<K extends AppSignal>(
  signal: K,
  payload: AppSignalPayloads[K],
): void {
  if (hub === undefined) return;
  PubSub.publishUnsafe(hub, { signal, payload });
}

/**
 * Deliver `signal` to `listener` until the caller interrupts. The program a
 * host's run edge forks: its scope holds the subscription, so interrupting
 * the fiber unsubscribes, and the `warn` on a failing listener is this
 * module's, not the host's.
 */
export function onAppSignal<K extends AppSignal>(
  signal: K,
  listener: (payload: AppSignalPayloads[K]) => void,
): Effect.Effect<void> {
  return Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(yield* openHub);
      while (true) {
        const event = yield* PubSub.take(subscription);
        if (event.signal !== signal) continue;
        // The key matched, so the payload is the one this key declares; a
        // generic key cannot carry that pairing through the hub's type.
        const payload = event.payload as AppSignalPayloads[K];
        yield* Effect.sync(() => listener(payload)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `An "${signal}" app-signal subscriber failed`,
              cause,
            ),
          ),
        );
      }
    }),
  );
}
