import { getExecutionStore } from '@agent/storage';
import type { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

export interface AgentCliSessionEntry {
  childStreamId: StreamTabId;
  executionId: ExecutionId;
  executions: ExecutionRegistry;
}

export class AgentCliSessionRegistry<T extends AgentCliSessionEntry> {
  private readonly sessions = new Map<string, T>();

  constructor(private readonly persistedSessionKey: string) {}

  /**
   * Register an active external-agent session and persist its SDK id for later
   * display or cross-reference after an extension reload clears memory.
   */
  register(sessionId: string, entry: T): void {
    this.sessions.set(sessionId, entry);
    void getExecutionStore(entry.executionId)
      .write(this.persistedSessionKey, sessionId)
      .catch(() => {});
  }

  isActive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  lookup(sessionId: string): T | undefined {
    return this.sessions.get(sessionId);
  }

  release(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  releaseMany(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) {
      this.release(sessionId);
    }
  }

  interruptAll(): void {
    for (const { childStreamId, executions } of [...this.sessions.values()]) {
      executions.getAgentHandleByStream(childStreamId)?.interrupt();
    }
  }
}
