import { Effect } from 'effect';

import type { RunRegistry } from '@agent/runtime/runRegistry';
import { closeAllSessions } from '@agent/runtime/sessionGraph';
import {
  SHUTDOWN_PHASE,
  type LifecycleHost,
  type ShutdownHandler,
} from '@platform/interfaces';

import { AgentCliSessionRegistry } from './agentCliSessionRegistry';

/**
 * Owns the two stores (`codexThreadsFor`, `claudeAgentSessionsFor`) that hold
 * each session's live agent-CLI registries, keyed by that session's `Runs`,
 * plus the host shutdown order every composition root registers.
 */

// Keyed by the session's runs (the childRunBudget WeakMap model): each
// session owns its own codex/claude registry, and a registry dies with its
// session instead of living as a process singleton.
function sessionRegistries(): (runs: RunRegistry) => AgentCliSessionRegistry {
  const registries = new WeakMap<RunRegistry, AgentCliSessionRegistry>();
  return (runs) => {
    let registry = registries.get(runs);
    if (!registry) {
      registry = new AgentCliSessionRegistry(runs);
      registries.set(runs, registry);
    }
    return registry;
  };
}

/** The session's registry of live codex threads. */
export const codexThreadsFor = sessionRegistries();

/** The session's registry of live claude-agent sessions. */
export const claudeAgentSessionsFor = sessionRegistries();

export interface RuntimeShutdownHooks {
  /** BEFORE handlers that must run before artifact persistence. */
  readonly beforeAgentShutdown?: readonly ShutdownHandler[];
  /** BEFORE handlers that run after {@link beforeAgentShutdown}. */
  readonly afterAgentShutdown?: readonly ShutdownHandler[];
  /** Persist the host's process/session artifacts. */
  readonly flushArtifacts: ShutdownHandler;
  /** BEFORE handlers that require artifact persistence to have finished. */
  readonly afterFlushArtifacts?: readonly ShutdownHandler[];
  /** ON handlers that run after every session has closed. */
  readonly afterRunSettlement?: readonly ShutdownHandler[];
  /**
   * Release the host's sessions and the project scopes that hold their
   * state. A RELEASE handler: it follows every ON handler, including those
   * registered after this call, under the phase's own deadline.
   */
  readonly releaseSessions: ShutdownHandler;
  /**
   * Dispose the process runtime: the last step on every host. Its layer
   * finalizers drain the usage log while the HTTP client and account plane
   * it sends through are still up, so it runs to completion rather than
   * being cut at the deadline a slow session release has spent.
   */
  readonly disposeRuntime: Effect.Effect<void>;
}

/**
 * Register the cross-host runtime shutdown order with named host hooks.
 *
 * The ordering is load-bearing, not stylistic: of the handlers registered
 * *here*, closing every session (`closeAllSessions`) must come first in the
 * `ON` phase. A session's close stops its runs, settles the ones still live
 * past the deadline to a durable `CANCELLED` outcome, releases their leases
 * and flushes its artifacts, and host teardown must not tear the session out
 * from under that. Anything that runs before it can leave a live run's
 * outcome un-persisted, which surfaces later as a run stuck in RUNNING with no
 * owner. `afterRunSettlement` is the safe place to add work, precisely
 * because it is registered after the close by construction.
 *
 * The process's release closes the order on all three hosts: the sessions,
 * then the runtime, in the `RELEASE` phase after every `ON` handler. It used
 * to be the tail of the desktop's and the CLI's `ON` phase, where a slow
 * settlement could spend the phase budget and interrupt the runtime disposal
 * mid-drain, losing queued usage records, while the extension ran it after
 * the drain.
 *
 * Each host used to carry this rationale in its own inline comment; the three
 * copies were consolidated here by #11355.
 */
export function registerRuntimeShutdownHandlers(
  lifecycle: LifecycleHost,
  hooks: RuntimeShutdownHooks,
): void {
  registerHandlers(lifecycle, SHUTDOWN_PHASE.BEFORE, hooks.beforeAgentShutdown);
  registerHandlers(lifecycle, SHUTDOWN_PHASE.BEFORE, hooks.afterAgentShutdown);
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, hooks.flushArtifacts);
  registerHandlers(lifecycle, SHUTDOWN_PHASE.BEFORE, hooks.afterFlushArtifacts);
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, Effect.asVoid(closeAllSessions()));
  registerHandlers(lifecycle, SHUTDOWN_PHASE.ON, hooks.afterRunSettlement);
  lifecycle.onShutdown(SHUTDOWN_PHASE.RELEASE, hooks.releaseSessions);
  lifecycle.onShutdown(
    SHUTDOWN_PHASE.RELEASE,
    Effect.uninterruptible(hooks.disposeRuntime),
  );
}

function registerHandlers(
  lifecycle: LifecycleHost,
  phase: (typeof SHUTDOWN_PHASE)[keyof typeof SHUTDOWN_PHASE],
  handlers: readonly ShutdownHandler[] | undefined,
): void {
  for (const handler of handlers ?? []) lifecycle.onShutdown(phase, handler);
}
