import { Deferred, Effect } from 'effect';

import type { RunId } from '@texra-ai/harness/schemas';

/**
 * What the registry tracks about one live agent-CLI session: its follow-up
 * address. The run's live state is the session's (`session.runs`), read by
 * the call that asks; an entry carries no pointer to it. Provider specifics
 * (codex thread, claude model/permission mode/…) stay with the provider's
 * own loop closure.
 */
export interface AgentCliSessionEntry {
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
  /** Each live child's hold on this registry, ended by `releaseByRunId`. */
  private readonly holds = new Map<RunId, Deferred.Deferred<void>>();

  private readonly hold: (until: Effect.Effect<void>) => Effect.Effect<void>;
  constructor(
    /** The plugin layer's hold (`PluginHold`) on this registry. */
    hold: (until: Effect.Effect<void>) => Effect.Effect<void>,
  ) {
    this.hold = hold;
  }

  /**
   * Keep this registry up while the child `runId` lives, released with its
   * aliases: a plugin switched off and on while the child runs keeps the
   * registry that routes the child's follow-ups, instead of building an
   * empty one that would launch a second loop for the same thread.
   */
  holdWhileLive(runId: RunId): Effect.Effect<void> {
    return Effect.suspend(() => {
      const done = Deferred.makeUnsafe<void>();
      this.holds.set(runId, done);
      return this.hold(Deferred.await(done));
    });
  }

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

  lookup(sessionId: string): AgentCliSessionEntry | undefined {
    const state = this.sessions.get(sessionId);
    return state?.kind === 'active' ? state.entry : undefined;
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

  /** Release every alias owned by one child run, and its hold. */
  releaseByRunId(runId: RunId): void {
    for (const [sessionId, state] of this.sessions) {
      if (state.kind === 'active' && state.entry.runId === runId) {
        this.sessions.delete(sessionId);
      }
    }
    const hold = this.holds.get(runId);
    this.holds.delete(runId);
    if (hold) Deferred.doneUnsafe(hold, Effect.void);
  }
}
