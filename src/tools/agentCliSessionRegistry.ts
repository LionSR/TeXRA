import { getExecutionStore } from '@agent/storage';
import type { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

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

  constructor(private readonly persistedSessionKey: string) {}

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
    void getExecutionStore(entry.executionId)
      .write(this.persistedSessionKey, sessionId)
      .catch(() => {});
  }

  isActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.kind === 'active';
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

  releaseMany(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) {
      this.release(sessionId);
    }
  }

  interruptAll(): void {
    for (const state of [...this.sessions.values()]) {
      if (state.kind === 'reserved') continue;
      const { childStreamId, executions } = state.entry;
      executions.getAgentHandleByStream(childStreamId)?.interrupt();
    }
  }
}
