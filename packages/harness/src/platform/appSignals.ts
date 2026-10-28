import {
  Context,
  Deferred,
  Effect,
  Layer,
  PubSub,
  type Scope,
  Stream,
} from 'effect';

/**
 * Cross-cutting, process-scoped app-lifecycle signals (subscriptions,
 * credentials, workspace-file writes). Not for run/session progress
 * events — those extend `AgentEvent` (`agent/trace/`) or the `SessionEvent`
 * schema (`shared/schemas/sessionEvent.ts`), per the event-channel rule in
 * the harness AGENTS.md.
 *
 * Delivery and error order, which this module owns and no caller may vary:
 *
 * - Publishing (`emit`, `emitAppSignal`) enqueues and returns. It never runs
 *   a subscriber, so a subscriber can neither block nor fail the code that
 *   emitted.
 * - Each subscriber drains its own `PubSub` subscription on its own fiber,
 *   forked at the host's run edge (the fork lives at the host entry, not
 *   in the bus, since only a host runs Effects). One subscriber sees the
 *   signals it subscribed to in publication order; there is no order *between* subscribers, and a slow
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
   * them remembering to. The one file store emits from its own commit
   * finalizer, and a window's watch of the file (`FileSecrets.watch`)
   * emits for writes from other processes. The finalizer runs on every exit of the write, failure and
   * interruption included, because an interrupted commit may still have
   * landed; the signal means "re-read this key", never "the value changed".
   * The same stores hold OAuth tokens and other credentials, so a subscriber filters on `key` and ignores the rest: an
   * OAuth refresh must not repaint the profile tab.
   *
   * Consumed by: extension and desktop (an `apiKey.*` change repaints the
   * credential-dependent settings, launcher and model surfaces), the CLI chat
   * TUI (an `apiKey.*` change bumps the subscription-preference version its
   * status bar reads), and the `ToolAvailability` process service on every
   * host and the agent package (a key a plugin lists in `reprobeOnSecrets`,
   * such as the GitHub token, re-probes each workspace it holds, which the
   * next step's tool list reads).
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
   * The workspace agents changed outside a settings round-trip. Keyless
   * on purpose: every listener re-reads the agent list, so which team or agent
   * moved carries no information.
   *
   * Emitted, in every process sharing the global store, when the default
   * team changes (`apply_team`, which the setup agent runs mid-conversation,
   * even in a background service task; `agentCatalogFollower`); and by the tool
   * registry (`pluginCatalogLayer`) once it has reloaded the agent catalog
   * after a tool switch or the plugin install record changed, in this
   * process or another.
   * Settings-originated changes repaint through their own handler and do not
   * emit.
   *
   * Consumed by: extension and desktop settings views, both re-reading the
   * agent list and team presets. Not the CLI: it reads the agent list per command
   * and has no persistent panel that could go stale.
   */
  workspaceAgentsChanged: undefined;

  /**
   * The session's approval policy changed through a settings update.
   * Surfaces that re-paint the status-bar policy line.
   *
   * Extension-only: it exists because VS Code's status-bar tooltip is painted
   * outside the settings webview's own round-trip and has no other refresh
   * trigger. The desktop's write path re-posts the approval snapshot inline
   * (the shared settings commands' `updateStateSetting`), and the CLI
   * holds the policy in TUI state that its `/approval` command updates
   * directly, so a subscription on either host would be a duplicate repaint.
   */
  approvalPolicyChanged: undefined;

  /**
   * One or more files were written directly to the workspace. Frontends can
   * badge or refresh those files without routing through a run-scoped channel.
   * A run's accepted files arrive as its `documents/accepted` fact, announced
   * in every process that folds the run (the arm's `writes`); a host's own
   * write (an accepted diff, the progress view's Accept) emits here directly.
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

/** The name of one app signal. */
export type AppSignal = keyof AppSignalPayloads;

/**
 * One published signal. The key and its payload are correlated by `emit`
 * and the subscriptions below, which is where a caller proves the pair; on the
 * hub they travel as what every subscription reads, a key and one of the
 * declared payloads.
 */
export interface AppSignalEvent {
  readonly signal: AppSignal;
  readonly payload: AppSignalPayloads[AppSignal];
}

/**
 * The process's signal hub: one unbounded `PubSub`, built once by the
 * process layer and served to every program of the process from context.
 * Unbounded and never shut down, so publishing never blocks or drops; a
 * subscription only receives what is published after it exists.
 */
export class AppSignals extends Context.Service<
  AppSignals,
  {
    /**
     * Publish `signal` to every current subscriber and return. Synchronous
     * by construction: the publish is the enqueue, and the hub is unbounded,
     * so it always accepts without suspending. The delivery itself runs on
     * each subscriber's own fiber — see the delivery and error order above.
     * For an owner whose callbacks run outside any fiber (a secret store's
     * commit, a registry's close listener), which captures the service
     * where its layer is built; a program publishes with
     * {@link emitAppSignal}.
     */
    readonly emit: <K extends AppSignal>(
      signal: K,
      payload: AppSignalPayloads[K],
    ) => void;
    /** A subscription to every signal, held for the caller's scope. */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<AppSignalEvent>,
      never,
      Scope.Scope
    >;
  }
>()('@texra-ai/harness/AppSignals') {
  static readonly layer: Layer.Layer<AppSignals> = Layer.effect(
    AppSignals,
    Effect.map(PubSub.unbounded<AppSignalEvent>(), (hub) => ({
      emit: (signal, payload) => {
        PubSub.publishUnsafe(hub, { signal, payload });
      },
      subscribe: PubSub.subscribe(hub),
    })),
  );
}

/** Publish `signal` from a program: {@link AppSignals}' `emit`. */
export const emitAppSignal = <K extends AppSignal>(
  signal: K,
  payload: AppSignalPayloads[K],
): Effect.Effect<void, never, AppSignals> =>
  AppSignals.useSync((signals) => signals.emit(signal, payload));

/** The payloads of `signal` among every signal a subscription reads. */
const payloadsOf =
  <K extends AppSignal>(signal: K) =>
  <R>(
    events: Stream.Stream<AppSignalEvent, never, R>,
  ): Stream.Stream<AppSignalPayloads[K], never, R> =>
    events.pipe(
      Stream.filter((event) => event.signal === signal),
      // A generic key cannot carry the key-payload pairing through the hub's
      // type.
      // cast: the key matched, so the payload is the one this key declares.
      Stream.map((event) => event.payload as AppSignalPayloads[K]),
    );

/**
 * `signal`'s payloads, as a stream for a host to run where it holds the
 * lifetime: each run subscribes when it starts and unsubscribes when it
 * ends, so it reads what is published after it starts. A caller that must
 * know the subscription is live before it reads the state the signal
 * announces uses {@link onAppSignal} and its `subscribed`.
 */
export function appSignalStream<K extends AppSignal>(
  signal: K,
): Stream.Stream<AppSignalPayloads[K], never, AppSignals> {
  return Stream.unwrap(
    Effect.map(
      AppSignals.use((signals) => signals.subscribe),
      Stream.fromSubscription,
    ),
  ).pipe(payloadsOf(signal));
}

/**
 * Deliver `signal` to `listener` until the caller interrupts. The program a
 * host's run edge forks: its scope holds the subscription, so interrupting
 * the fiber unsubscribes, and the `warn` on a failing listener is this
 * module's, not the host's. `subscribed` completes once the subscription is
 * live, for a caller that must not miss a signal published after it reads
 * the state the signal announces.
 */
export function onAppSignal<K extends AppSignal>(
  signal: K,
  listener: (payload: AppSignalPayloads[K]) => void,
  subscribed?: Deferred.Deferred<void>,
): Effect.Effect<void, never, AppSignals> {
  return Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* (yield* AppSignals).subscribe;
      if (subscribed) yield* Deferred.succeed(subscribed, undefined);
      yield* Stream.fromSubscription(subscription).pipe(
        payloadsOf(signal),
        Stream.runForEach((payload) =>
          Effect.sync(() => listener(payload)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `An "${signal}" app-signal subscriber failed`,
                cause,
              ),
            ),
          ),
        ),
      );
    }),
  );
}
