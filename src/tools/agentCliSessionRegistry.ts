import pDefer from 'p-defer';

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
      ready: Promise<AgentCliSessionEntry | undefined>;
      resolve: (entry: AgentCliSessionEntry | undefined) => void;
    }
  | { kind: 'active'; entry: AgentCliSessionEntry };

export class AgentCliSessionRegistry {
  private readonly sessions = new Map<string, AgentCliSessionState>();
  private readonly inFlight = new Map<ExecutionId, AgentCliSessionEntry>();

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

    const ready = pDefer<AgentCliSessionEntry | undefined>();
    const reservation: AgentCliSessionState = {
      kind: 'reserved',
      ready: ready.promise,
      resolve: ready.resolve,
    };
    this.sessions.set(sessionId, reservation);
    return () => {
      if (this.sessions.get(sessionId) !== reservation) return;
      this.sessions.delete(sessionId);
      reservation.resolve(undefined);
    };
  }

  /**
   * Register an active external-agent session and persist its SDK id for later
   * display or cross-reference after an extension reload clears memory. When
   * the id was reserved, registration also wakes callers waiting to enqueue a
   * follow-up on the new loop.
   */
  register(sessionId: string, entry: AgentCliSessionEntry): void {
    const previous = this.sessions.get(sessionId);
    this.sessions.set(sessionId, { kind: 'active', entry });
    if (previous?.kind === 'reserved') previous.resolve(entry);
    void Promise.resolve()
      .then(() =>
        this.dependencies.persistSessionId(
          entry.executionId,
          this.persistedSessionKey,
          sessionId,
        ),
      )
      .catch((error) => {
        try {
          this.dependencies.reportPersistenceFailure(entry.executionId, error);
        } catch {
          // Best-effort diagnostics must not create an unhandled rejection.
        }
      });
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
  async waitForActive(
    sessionId: string,
  ): Promise<AgentCliSessionEntry | undefined> {
    const state = this.sessions.get(sessionId);
    return state?.kind === 'active' ? state.entry : state?.ready;
  }

  release(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (state?.kind === 'reserved') state.resolve(undefined);
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
