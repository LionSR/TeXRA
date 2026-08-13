import { getExecutionStore } from '@agent/storage';
import { createChannelTrace } from '@agent/trace';
import type { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

const logger = createChannelTrace('AgentCliSessionRegistry');

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

export interface AgentCliSessionEntry {
  childStreamId: StreamTabId;
  executionId: ExecutionId;
  executions: ExecutionRegistry;
}

type AgentCliSessionState<T> =
  | {
      kind: 'reserved';
      ready: Promise<T | undefined>;
      resolve: (entry: T | undefined) => void;
    }
  | { kind: 'active'; entry: T };

export class AgentCliSessionRegistry<T extends AgentCliSessionEntry> {
  private readonly sessions = new Map<string, AgentCliSessionState<T>>();
  private readonly inFlight = new Map<ExecutionId, T>();

  constructor(
    private readonly persistedSessionKey: string,
    private readonly dependencies: AgentCliSessionRegistryDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  /**
   * Atomically reserve an unowned SDK session id. Returns a release handle
   * bound to this exact reservation, or undefined when another owner exists.
   * Registration promotes the reservation and makes that handle a no-op.
   */
  claim(sessionId: string): (() => void) | undefined {
    if (this.sessions.has(sessionId)) return undefined;

    let settleReservation: ((entry: T | undefined) => void) | undefined;
    const ready = new Promise<T | undefined>((settle) => {
      settleReservation = settle;
    });
    const reservation: AgentCliSessionState<T> = {
      kind: 'reserved',
      ready,
      resolve: (entry) => settleReservation?.(entry),
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
  register(sessionId: string, entry: T): void {
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
  trackInFlight(entry: T): void {
    this.inFlight.set(entry.executionId, entry);
  }

  lookup(sessionId: string): T | undefined {
    const state = this.sessions.get(sessionId);
    return state?.kind === 'active' ? state.entry : undefined;
  }

  /** Wait for a reserved id to become active, or for its owner to release it. */
  async waitForActive(sessionId: string): Promise<T | undefined> {
    const state = this.sessions.get(sessionId);
    if (state?.kind === 'active') return state.entry;
    return state?.ready;
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
   * Interrupt every registered CLI-backed session, or only those owned by
   * `ownedBy` when one session tears down while others stay live (the agent
   * package disposes a per-run session on every `runAgent` return).
   */
  interruptAll(ownedBy?: ExecutionRegistry): void {
    const interrupted = new Set<ExecutionId>();
    const interrupt = (entry: T): void => {
      if (ownedBy && entry.executions !== ownedBy) return;
      if (interrupted.has(entry.executionId)) return;
      const { childStreamId, executions } = entry;
      const handle = executions.getAgentHandleByStream(childStreamId);
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
