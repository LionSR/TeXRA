import { Data, Deferred, Effect, Queue } from 'effect';

import { getExecutionStore } from '@agent/storage';
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import type { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import { createLog } from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

const logger = createLog('AgentCliSessionRegistry');

interface AgentCliSessionRegistryDependencies {
  persistSessionId(
    executionId: ExecutionId,
    key: string,
    sessionId: string,
  ): Promise<void>;
  reportPersistenceFailure(executionId: ExecutionId, error: unknown): void;
}

const DEFAULT_DEPENDENCIES: AgentCliSessionRegistryDependencies = {
  persistSessionId: (executionId, key, sessionId) =>
    getExecutionStore(executionId).write(key, sessionId),
  reportPersistenceFailure: (executionId, error) => {
    logger.debug(`Failed to persist CLI session mapping for ${executionId}`, {
      data: error,
    });
  },
};

/** The session-mapping write rejected or threw; `cause` is what it raised. */
class SessionMappingWriteFailed extends Data.TaggedError(
  'SessionMappingWriteFailed',
)<{ readonly cause: unknown }> {}

/**
 * Persist one SDK session id for a child execution. A write failure is
 * reported through the injected diagnostics sink and otherwise contained:
 * registration never waits on it and never fails because of it. The sink
 * itself throwing is a defect of the drain fiber, not a rejection anyone
 * observes.
 */
const persistSessionMapping = Effect.fn(
  'AgentCliSessionRegistry.persistSessionMapping',
)(function* (
  dependencies: AgentCliSessionRegistryDependencies,
  executionId: ExecutionId,
  key: string,
  sessionId: string,
) {
  yield* Effect.tryPromise({
    try: () => dependencies.persistSessionId(executionId, key, sessionId),
    catch: (cause) => new SessionMappingWriteFailed({ cause }),
  }).pipe(
    Effect.catchTag('SessionMappingWriteFailed', (failure) =>
      Effect.sync(() =>
        dependencies.reportPersistenceFailure(executionId, failure.cause),
      ),
    ),
  );
});

/** One queued session-mapping persistence write. */
interface SessionMappingWrite {
  readonly executionId: ExecutionId;
  readonly sessionId: string;
}

/**
 * What the registry tracks about one live agent-CLI session: the child run's
 * identity and its follow-up address. Live handles are resolved on demand
 * through the session's own {@link ExecutionRegistry}, injected once at
 * construction — entries carry no registry pointer of their own, so an entry
 * can never point across sessions. Provider specifics (codex thread, claude
 * model/permission mode/…) stay with the provider's own loop closure.
 */
export interface AgentCliSessionEntry {
  childStreamId: StreamTabId;
  executionId: ExecutionId;
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
  private readonly inFlight = new Map<ExecutionId, AgentCliSessionEntry>();
  /**
   * The write queue a live drain takes from. Created by the first
   * {@link persistenceDrain}; absent before any drain starts, in which case
   * {@link register} buffers instead.
   */
  private writes: Queue.Queue<SessionMappingWrite> | undefined;
  private readonly bufferedWrites: SessionMappingWrite[] = [];

  constructor(
    private readonly persistedSessionKey: string,
    private readonly executions: ExecutionRegistry,
    private readonly dependencies: AgentCliSessionRegistryDependencies = DEFAULT_DEPENDENCIES,
  ) {}

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
   * Register an active external-agent session and queue its SDK id for
   * persistence (for later display or cross-reference after an extension
   * reload clears memory). When the id was reserved, registration also wakes
   * callers waiting to enqueue a follow-up on the new loop. The write itself
   * is taken by a {@link persistenceDrain} fiber — the boundary that launches
   * a loop forks one — so registration never waits on it and never fails
   * because of it. A write registered before the first drain starts is
   * buffered and flushed when one does.
   */
  register(sessionId: string, entry: AgentCliSessionEntry): void {
    const previous = this.sessions.get(sessionId);
    this.sessions.set(sessionId, { kind: 'active', entry });
    settleReservation(previous, entry);
    const write: SessionMappingWrite = {
      executionId: entry.executionId,
      sessionId,
    };
    if (this.writes) Queue.offerUnsafe(this.writes, write);
    else this.bufferedWrites.push(write);
  }

  /**
   * The session-mapping write drain: takes queued writes one at a time and
   * runs each to completion. One write is uninterruptible once taken, so a
   * write racing its loop's teardown still lands; interruption between
   * writes ends the drain at once. The boundary launching a loop forks this
   * and races it against that loop's settlement; concurrent drains are safe
   * because each queued write is taken exactly once. The first drain creates
   * the queue and flushes anything buffered before it started.
   */
  persistenceDrain(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.writes) return this.drainWrites(this.writes);
      return Effect.flatMap(Queue.unbounded<SessionMappingWrite>(), (queue) => {
        this.writes = queue;
        for (const write of this.bufferedWrites.splice(0)) {
          Queue.offerUnsafe(queue, write);
        }
        return this.drainWrites(queue);
      });
    });
  }

  private drainWrites(
    queue: Queue.Queue<SessionMappingWrite>,
  ): Effect.Effect<void> {
    return Effect.forever(
      Effect.flatMap(Queue.take(queue), (write) =>
        Effect.uninterruptible(
          persistSessionMapping(
            this.dependencies,
            write.executionId,
            this.persistedSessionKey,
            write.sessionId,
          ),
        ),
      ),
    );
  }

  /** Track a launched loop before its SDK session id is safe to publish. */
  trackInFlight(entry: AgentCliSessionEntry): void {
    this.inFlight.set(entry.executionId, entry);
  }

  lookup(sessionId: string): AgentCliSessionEntry | undefined {
    const state = this.sessions.get(sessionId);
    return state?.kind === 'active' ? state.entry : undefined;
  }

  /**
   * Live handle for an entry, resolved through the one execution registry
   * this session's agent-CLI children run under. Ownership and follow-up
   * checks read the live handle rather than a stored pointer, so a detached
   * or re-parented child answers with its current state.
   */
  getHandle(
    entry: AgentCliSessionEntry | undefined,
  ): AgentExecutionHandle | undefined {
    return entry && this.executions.getHandle(entry.executionId);
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

  /** Release every alias and in-flight handle owned by one child execution. */
  releaseByExecutionId(executionId: ExecutionId): void {
    this.inFlight.delete(executionId);
    for (const [sessionId, state] of this.sessions) {
      if (state.kind === 'active' && state.entry.executionId === executionId) {
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
    const interrupted = new Set<ExecutionId>();
    const interrupt = (entry: AgentCliSessionEntry): void => {
      if (interrupted.has(entry.executionId)) return;
      const handle = this.executions.getAgentHandleByStream(
        entry.childStreamId,
      );
      if (!handle) return;
      interrupted.add(entry.executionId);
      handle.interrupt();
    };

    for (const entry of this.inFlight.values()) interrupt(entry);
    for (const state of this.sessions.values()) {
      if (state.kind === 'active') interrupt(state.entry);
    }
  }
}
