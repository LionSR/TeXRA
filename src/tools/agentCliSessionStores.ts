import { Effect } from 'effect';

import type { RunRegistry } from '@agent/runtime/runRegistry';
import { settleLiveSessionRuns } from '@agent/runtime/SessionHandle';
import { heldSessions } from '@agent/runtime/sessionGraph';
import {
  SHUTDOWN_PHASE,
  type LifecycleHost,
  type ShutdownHandler,
} from '@platform/interfaces';

import { AgentCliSessionRegistry } from './agentCliSessionRegistry';

/**
 * Owns the two stores (`codexThreadsFor`, `claudeAgentSessionsFor`) that hold
 * each session's live agent-CLI registries, keyed by that session's `Runs`,
 * plus the host shutdown wiring that interrupts them at teardown — kept
 * together because the shutdown handlers close over the same `WeakMap`s the
 * accessors read.
 */

// Keyed by the session's runs (the childRunBudget WeakMap model): each
// session owns its own codex/claude registry, so per-session teardown
// interrupts exactly its own agent-CLI children and a registry dies with its
// session instead of living as a process singleton.
function sessionRegistries() {
  const registries = new WeakMap<RunRegistry, AgentCliSessionRegistry>();
  return {
    registries,
    for: (runs: RunRegistry): AgentCliSessionRegistry => {
      let registry = registries.get(runs);
      if (!registry) {
        registry = new AgentCliSessionRegistry(runs);
        registries.set(runs, registry);
      }
      return registry;
    },
  };
}

const codexThreads = sessionRegistries();
const claudeAgentSessions = sessionRegistries();

/** The session's registry of live codex threads. */
export const codexThreadsFor = codexThreads.for;

/** The session's registry of live claude-agent sessions. */
export const claudeAgentSessionsFor = claudeAgentSessions.for;

/**
 * Register the host shutdown handler that stops agent work at teardown: kill the
 * background OS processes owned by live runtime sessions and interrupt any
 * agent-CLI codex/claude sessions those sessions still track. Lives here —
 * next to the registries it interrupts — because the hosts import it once
 * during platform startup and the core never depends on tool-layer teardown
 * wiring.
 */
function registerAgentShutdownHandler(lifecycle: LifecycleHost): void {
  lifecycle.onShutdown(
    SHUTDOWN_PHASE.BEFORE,
    Effect.sync(() => {
      for (const session of heldSessions()) {
        session.runs.killBackgroundProcesses();
        codexThreads.registries.get(session.runs)?.interruptAll();
        claudeAgentSessions.registries.get(session.runs)?.interruptAll();
      }
    }),
  );
}

export interface RuntimeShutdownHooks {
  /** BEFORE handlers that must run before agent processes are interrupted. */
  readonly beforeAgentShutdown?: readonly ShutdownHandler[];
  /** BEFORE handlers between agent interruption and artifact persistence. */
  readonly afterAgentShutdown?: readonly ShutdownHandler[];
  /** Persist the host's process/session artifacts. */
  readonly flushArtifacts: ShutdownHandler;
  /** BEFORE handlers that require artifact persistence to have finished. */
  readonly afterFlushArtifacts?: readonly ShutdownHandler[];
  /** ON handlers that run after live runs have settled. */
  readonly afterRunSettlement?: readonly ShutdownHandler[];
}

/**
 * Register the cross-host runtime shutdown order with named host hooks.
 *
 * The ordering is load-bearing, not stylistic: of the handlers registered
 * *here*, `settleLiveSessionRuns` must come first in the `ON` phase. A
 * quit has to leave a durable `CANCELLED` outcome and a released follow-up
 * lease before host teardown (`teardownDefaultSession()` /
 * `processResources.dispose()`) tears the session out from under it. Anything
 * that runs before settlement can leave a live run's outcome
 * un-persisted, which surfaces later as a run stuck in RUNNING with no owner.
 *
 * `afterRunSettlement` is the safe place to add work, precisely because
 * it is registered after settlement by construction. Do not reorder these two
 * calls to get a hook in earlier.
 *
 * This constrains only this registrar's own ordering. A host may register its
 * own `ON` handler before calling here (the extension does, for Lean server
 * cleanup), which is fine as long as it does not touch run state.
 *
 * Each host used to carry this rationale in its own inline comment; the three
 * copies were consolidated here by #11355.
 */
export function registerRuntimeShutdownHandlers(
  lifecycle: LifecycleHost,
  hooks: RuntimeShutdownHooks,
): void {
  registerHandlers(lifecycle, SHUTDOWN_PHASE.BEFORE, hooks.beforeAgentShutdown);
  registerAgentShutdownHandler(lifecycle);
  registerHandlers(lifecycle, SHUTDOWN_PHASE.BEFORE, hooks.afterAgentShutdown);
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, hooks.flushArtifacts);
  registerHandlers(lifecycle, SHUTDOWN_PHASE.BEFORE, hooks.afterFlushArtifacts);
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, settleLiveSessionRuns);
  registerHandlers(lifecycle, SHUTDOWN_PHASE.ON, hooks.afterRunSettlement);
}

function registerHandlers(
  lifecycle: LifecycleHost,
  phase: (typeof SHUTDOWN_PHASE)[keyof typeof SHUTDOWN_PHASE],
  handlers: readonly ShutdownHandler[] | undefined,
): void {
  for (const handler of handlers ?? []) lifecycle.onShutdown(phase, handler);
}
