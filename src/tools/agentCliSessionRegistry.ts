import { Context, Data, Deferred, Effect, Layer } from 'effect';

import { getExecutionStore } from '@agent/storage';
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import type { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import { createLog } from '@logger/logUtils';
import { effectRuntime } from '@platform/processRuntime';
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
 * itself throwing is a defect of the detached fiber, not a rejection anyone
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

/**
 * What the registry tracks about one live agent-CLI session: the child run's
 * identity and its follow-up address. Live handles are resolved on demand
 * through the session's own {@link ExecutionRegistry}, injected once when the
 * registry is made — entries carry no registry pointer of their own, so an
 * entry can never point across sessions. Provider specifics (codex thread,
 * claude model/permission mode/…) stay with the provider's own loop closure.
 */
export interface AgentCliSessionEntry {
  childStreamId: StreamTabId;
  executionId: ExecutionId;
}

/**
 * One session's live agent-CLI sessions.
 *
 * `waitForActive` is the only operation with anything to await, and it is an
 * Effect: a waiter is interrupted with the program that is waiting instead of
 * holding a promise nobody can cancel. Everything else is a map read or write
 * plus a `Deferred` settle — synchronous by construction, and reached from
 * `ChildRunStrategy`'s synchronous loop callbacks, which is why wrapping them
 * in Effect would only push a run boundary into that callback.
 */
export interface AgentCliSessions {
  /**
   * Atomically reserve an unowned SDK session id. Returns a release handle
   * bound to this exact reservation, or undefined when another owner exists.
   * Registration promotes the reservation and makes that handle a no-op. The
   * handle stays a plain callback: it is handed to
   * `ChildRunStrategy.releaseSessionOwnership`, a synchronous contract.
   */
  readonly claim: (sessionId: string) => (() => void) | undefined;
  /**
   * Register an active external-agent session and persist its SDK id for
   * later display or cross-reference after an extension reload clears
   * memory. When the id was reserved, registration also wakes callers
   * waiting to enqueue a follow-up on the new loop.
   */
  readonly register: (sessionId: string, entry: AgentCliSessionEntry) => void;
  /** Track a launched loop before its SDK session id is safe to publish. */
  readonly trackInFlight: (entry: AgentCliSessionEntry) => void;
  readonly lookup: (sessionId: string) => AgentCliSessionEntry | undefined;
  /**
   * Live handle for an entry, resolved through the one execution registry
   * this session's agent-CLI children run under. Ownership and follow-up
   * checks read the live handle rather than a stored pointer, so a detached
   * or re-parented child answers with its current state.
   */
  readonly getHandle: (
    entry: AgentCliSessionEntry | undefined,
  ) => AgentExecutionHandle | undefined;
  /** Wait for a reserved id to become active, or for its owner to release it. */
  readonly waitForActive: (
    sessionId: string,
  ) => Effect.Effect<AgentCliSessionEntry | undefined>;
  readonly release: (sessionId: string) => void;
  /** Release every alias and in-flight handle owned by one child execution. */
  readonly releaseByExecutionId: (executionId: ExecutionId) => void;
  /**
   * Interrupt every registered CLI-backed session. Registries are keyed by
   * runtime session (`agentCliSessionStores`), so "every" is already scoped
   * to one session's own agent-CLI children.
   */
  readonly interruptAll: () => void;
}

/**
 * The ambient session's agent-CLI registry. The tool dispatch boundary
 * resolves it once from the session-keyed store and provides it with
 * {@link AgentCliSessionRegistry.layer}; every program below reads it from
 * context instead of threading a parameter.
 */
export class AgentCliSessionRegistry extends Context.Service<
  AgentCliSessionRegistry,
  AgentCliSessions
>()('@texra/tools/AgentCliSessionRegistry') {
  static layer(
    sessions: AgentCliSessions,
  ): Layer.Layer<AgentCliSessionRegistry> {
    return Layer.succeed(AgentCliSessionRegistry)(sessions);
  }
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

/**
 * Make one session's registry. The session-keyed store
 * (`agentCliSessionStores`) owns the instance for the life of its session and
 * hands it to {@link AgentCliSessionRegistry.layer}.
 */
export function makeAgentCliSessionRegistry(
  persistedSessionKey: string,
  executions: ExecutionRegistry,
  dependencies: AgentCliSessionRegistryDependencies = DEFAULT_DEPENDENCIES,
): AgentCliSessions {
  const sessions = new Map<string, AgentCliSessionState>();
  const inFlight = new Map<ExecutionId, AgentCliSessionEntry>();

  const lookup = (sessionId: string): AgentCliSessionEntry | undefined => {
    const state = sessions.get(sessionId);
    return state?.kind === 'active' ? state.entry : undefined;
  };

  const getHandle = (
    entry: AgentCliSessionEntry | undefined,
  ): AgentExecutionHandle | undefined =>
    entry && executions.getHandle(entry.executionId);

  return {
    claim: (sessionId) => {
      if (sessions.has(sessionId)) return undefined;

      const reservation: AgentCliSessionState = {
        kind: 'reserved',
        ready: Deferred.makeUnsafe<AgentCliSessionEntry | undefined>(),
      };
      sessions.set(sessionId, reservation);
      return () => {
        if (sessions.get(sessionId) !== reservation) return;
        sessions.delete(sessionId);
        settleReservation(reservation, undefined);
      };
    },

    register: (sessionId, entry) => {
      const previous = sessions.get(sessionId);
      sessions.set(sessionId, { kind: 'active', entry });
      settleReservation(previous, entry);
      // A detached best-effort write, not a run boundary for any caller: the
      // only caller is `ChildRunStrategy.onTurnSuccess`, a synchronous
      // callback, and nothing observes the write's outcome except the
      // diagnostics sink inside {@link persistSessionMapping}.
      effectRuntime().runFork(
        persistSessionMapping(
          dependencies,
          entry.executionId,
          persistedSessionKey,
          sessionId,
        ),
      );
    },

    trackInFlight: (entry) => {
      inFlight.set(entry.executionId, entry);
    },

    lookup,
    getHandle,

    waitForActive: Effect.fn('AgentCliSessionRegistry.waitForActive')(
      function* (sessionId: string) {
        const state = sessions.get(sessionId);
        if (!state) return undefined;
        if (state.kind === 'active') return state.entry;
        return yield* Deferred.await(state.ready);
      },
    ),

    release: (sessionId) => {
      const state = sessions.get(sessionId);
      sessions.delete(sessionId);
      settleReservation(state, undefined);
    },

    releaseByExecutionId: (executionId) => {
      inFlight.delete(executionId);
      for (const [sessionId, state] of sessions) {
        if (
          state.kind === 'active' &&
          state.entry.executionId === executionId
        ) {
          sessions.delete(sessionId);
        }
      }
    },

    interruptAll: () => {
      const interrupted = new Set<ExecutionId>();
      const interrupt = (entry: AgentCliSessionEntry): void => {
        if (interrupted.has(entry.executionId)) return;
        const handle = executions.getAgentHandleByStream(entry.childStreamId);
        if (!handle) return;
        interrupted.add(entry.executionId);
        handle.interrupt();
      };

      for (const entry of inFlight.values()) interrupt(entry);
      for (const state of sessions.values()) {
        if (state.kind === 'active') interrupt(state.entry);
      }
    },
  };
}
