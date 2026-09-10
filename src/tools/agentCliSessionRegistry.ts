import { Deferred, Effect } from 'effect';

import type { RunHandle } from '@agent/runtime/RunHandle';
import type { RunRegistry } from '@agent/runtime/runRegistry';
import type { RunId } from '@shared/schemas';

/**
 * What the registry tracks about one live agent-CLI session: the child run's
 * identity and its follow-up address. Live handles are resolved on demand
 * through the session's own {@link RunRegistry}, injected once at
 * construction — entries carry no registry pointer of their own, so an entry
 * can never point across sessions. Provider specifics (codex thread, claude
 * model/permission mode/…) stay with the provider's own loop closure.
 */
export interface AgentCliSessionEntry {
  childRunId: RunId;
  runId: RunId;
}

type AgentCliSessionState =
  | {
      kind: 'reserved';
      ready: Deferred.Deferred<AgentCliSessionEntry | undefined>;
    }
  | { kind: 'active'; entry: AgentCliSessionEntry };

function settleReservation(
  state: AgentCliSessionState | undefined,
  entry: AgentCliSessionEntry | undefined,
): void {
  if (state?.kind === 'reserved') {
    Deferred.doneUnsafe(state.ready, Effect.succeed(entry));
  }
}

export class AgentCliSessionRegistry {
  private readonly sessions = new Map<string, AgentCliSessionState>();
  private readonly inFlight = new Map<RunId, AgentCliSessionEntry>();

  constructor(private readonly runs: RunRegistry) {}

  /**
   * Atomically reserve an unowned SDK session id. Returns a release handle
   * bound to this exact reservation, or undefined when another owner exists.
   * Registration promotes the reservation and makes that handle a no-op.
   */
  claim(sessionId: string): (() => void) | undefined {
    if (this.sessions.has(sessionId)) return undefined;

    const reservation: AgentCliSessionState = {
      kind: 'reserved',
      ready: Deferred.makeUnsafe<AgentCliSessionEntry | undefined>(),
    };
    this.sessions.set(sessionId, reservation);
    return () => {
      if (this.sessions.get(sessionId) !== reservation) return;
      this.sessions.delete(sessionId);
      settleReservation(reservation, undefined);
    };
  }

  /**
   * Register an active external-agent session. When the id was reserved,
   * registration also wakes callers waiting to enqueue a follow-up on the new
   * loop.
   */
  register(sessionId: string, entry: AgentCliSessionEntry): void {
    const previous = this.sessions.get(sessionId);
    this.sessions.set(sessionId, { kind: 'active', entry });
    settleReservation(previous, entry);
  }

  /** Track a launched loop before its SDK session id is safe to publish. */
  trackInFlight(entry: AgentCliSessionEntry): void {
    this.inFlight.set(entry.runId, entry);
  }

  lookup(sessionId: string): AgentCliSessionEntry | undefined {
    const state = this.sessions.get(sessionId);
    return state?.kind === 'active' ? state.entry : undefined;
  }

  /**
   * Live handle for an entry, resolved through the one run registry
   * this session's agent-CLI children run under. Ownership and follow-up
   * checks read the live handle rather than a stored pointer, so a detached
   * or re-parented child answers with its current state.
   */
  getHandle(
    entry: AgentCliSessionEntry | undefined,
  ): RunHandle | undefined {
    return entry && this.runs.getHandle(entry.runId);
  }

  /** Wait for a reserved id to become active, or for its owner to release it. */
  waitForActive(
    sessionId: string,
  ): Effect.Effect<AgentCliSessionEntry | undefined> {
    return Effect.suspend(() => {
      const state = this.sessions.get(sessionId);
      if (!state) return Effect.succeed(undefined);
      if (state.kind === 'active') return Effect.succeed(state.entry);
      return Deferred.await(state.ready);
    });
  }

  release(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    settleReservation(state, undefined);
  }

  /** Release every alias and in-flight handle owned by one child run. */
  releaseByRunId(runId: RunId): void {
    this.inFlight.delete(runId);
    for (const [sessionId, state] of this.sessions) {
      if (state.kind === 'active' && state.entry.runId === runId) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Interrupt every registered CLI-backed session. Registries are keyed by
   * runtime session (`agentCliSessionStores`), so "every" is already scoped
   * to one session's own agent-CLI children.
   */
  interruptAll(): void {
    const interrupted = new Set<RunId>();
    const interrupt = (entry: AgentCliSessionEntry): void => {
      if (interrupted.has(entry.runId)) return;
      const handle = this.runs.getAgentHandleByStream(
        entry.childStreamId,
      );
      if (!handle) return;
      interrupted.add(entry.runId);
      handle.interrupt();
    };

    for (const entry of this.inFlight.values()) interrupt(entry);
    for (const state of this.sessions.values()) {
      if (state.kind === 'active') interrupt(state.entry);
    }
  }
}
