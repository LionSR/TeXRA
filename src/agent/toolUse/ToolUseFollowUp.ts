/**
 * Tool-use follow-up message handling.
 *
 * Provides:
 * - Promise-based queue for follow-up messages in tool-use sessions
 * - Static manager for queue instances indexed by stream ID
 * - Coordination for routing follow-ups to active/resuming/pending sessions
 */

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { getToolUseAgent } from '@agent/toolUse/ToolUseAgentRegistry';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { AgentLogger } from '@logger/AgentLogger';

// Lazy imports to avoid circular dependency
// ToolUseSessionManager and ToolUseSessionPersistence are imported at runtime
import type { ToolUseSessionSnapshot } from './ToolUseSessionManager';

const logger = new AgentLogger('ToolUseFollowUp');

// ============================================================================
// Follow-Up Queue (Instance)
// ============================================================================

/**
 * Promise-based queue for follow-up messages in a tool-use session.
 */
export class FollowUpQueue {
  private readonly queued: string[] = [];
  private resolver: ((value: string | null) => void) | null = null;
  private readonly listeners = new Set<() => void>();

  enqueue(value: string): void {
    if (this.resolver) {
      const resolver = this.resolver;
      this.resolver = null;
      resolver(value);
    } else {
      this.queued.push(value);
    }
    this.notifyListeners();
  }

  isEmpty(): boolean {
    return this.queued.length === 0;
  }

  size(): number {
    return this.queued.length;
  }

  drain(): string[] {
    return this.queued.splice(0);
  }

  waitForNext(checkInterruption: () => boolean): Promise<string | null> {
    if (!this.isEmpty()) {
      return Promise.resolve(this.queued.shift()!);
    }
    if (checkInterruption()) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      this.resolver = resolve;
    });
  }

  cancelWait(): void {
    if (this.resolver) {
      const resolver = this.resolver;
      this.resolver = null;
      resolver(null);
    }
  }

  clear(): void {
    this.queued.length = 0;
  }

  dispose(): void {
    this.cancelWait();
    this.clear();
    this.listeners.clear();
  }

  onEnqueue(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async runIfIdle<T>(
    work: () => Promise<T>,
  ): Promise<{ aborted: boolean; result?: T }> {
    if (!this.isEmpty()) {
      return { aborted: true };
    }

    let aborted = false;
    const unsubscribe = this.onEnqueue(() => {
      aborted = true;
    });

    try {
      const result = await work();
      if (aborted || !this.isEmpty()) {
        return { aborted: true, result };
      }
      return { aborted: false, result };
    } finally {
      unsubscribe();
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// ============================================================================
// Follow-Up Queue Manager (Static)
// ============================================================================

/**
 * Static manager for follow-up queues indexed by stream ID.
 */
export class ToolUseFollowUpQueue {
  private static readonly queues = new Map<StreamTabId, FollowUpQueue>();
  private static readonly resuming = new Set<StreamTabId>();

  static acquire(streamId: StreamTabId): FollowUpQueue {
    let queue = this.queues.get(streamId);
    if (!queue) {
      queue = new FollowUpQueue();
      this.queues.set(streamId, queue);
    }
    return queue;
  }

  static release(streamId: StreamTabId): void {
    const queue = this.queues.get(streamId);
    if (!queue) {
      return;
    }
    queue.dispose();
    this.queues.delete(streamId);
    this.resuming.delete(streamId);
    logger.debug(`Released follow-up queue for stream ${streamId}.`);
  }

  static markResuming(streamId: StreamTabId): FollowUpQueue {
    const queue = this.acquire(streamId);
    if (!this.resuming.has(streamId)) {
      this.resuming.add(streamId);
      logger.debug(`Marked stream ${streamId} as resuming.`);
    }
    return queue;
  }

  static clearResuming(streamId: StreamTabId): void {
    if (!this.resuming.delete(streamId)) {
      return;
    }
    logger.debug(`Cleared resuming session tracking for stream ${streamId}.`);
  }

  static isResuming(streamId: StreamTabId): boolean {
    return this.resuming.has(streamId);
  }

  static enqueue(streamId: StreamTabId, followUp: string): boolean {
    const queue = this.queues.get(streamId);
    if (!queue) {
      return false;
    }
    queue.enqueue(followUp);
    logger.debug(`Queued follow-up for stream ${streamId}.`);
    return true;
  }

  static drain(streamId: StreamTabId): string[] {
    const queue = this.queues.get(streamId);
    if (!queue) {
      return [];
    }
    const drained = queue.drain();
    logger.debug(
      `Drained ${drained.length} queued follow-ups for stream ${streamId}.`,
    );
    return drained;
  }

  static get(streamId: StreamTabId): FollowUpQueue | undefined {
    return this.queues.get(streamId);
  }
}

// ============================================================================
// Follow-Up Coordination
// ============================================================================

/**
 * Send a follow-up message to a tool-use session.
 *
 * Routes the message based on session state:
 * 1. Active agent: direct append
 * 2. Resuming session: queue for later
 * 3. Pending snapshot: lazy resume with follow-up
 * 4. No session: show warning
 */
export async function sendFollowUp(
  streamId: StreamTabId,
  text: string,
): Promise<void> {
  // Try active agent first
  const agent = getToolUseAgent(streamId);
  if (agent) {
    try {
      agent.session.appendFollowUp(text);
    } catch (error) {
      logger.error('Failed to send follow-up to active agent.', {
        data: error,
      });
      await vscode.window.showErrorMessage(
        `Failed to send follow-up: ${(error as Error).message}`,
      );
    }
    return;
  }

  // Queue if session is resuming
  if (ToolUseFollowUpQueue.isResuming(streamId)) {
    if (ToolUseFollowUpQueue.enqueue(streamId, text)) {
      logger.debug(`Queued follow-up while stream ${streamId} is resuming.`);
      return;
    }
  }

  // Lazy resume from snapshot if available
  const { ToolUseSessionManager } = await import('./ToolUseSessionManager');
  const { ToolUseSessionPersistence } =
    await import('./ToolUseSessionPersistence');

  const pendingSnapshot = ToolUseSessionManager.getByStream(streamId);
  if (pendingSnapshot) {
    logger.debug(`Resuming agent lazily for stream ${streamId}.`);
    await ToolUseSessionPersistence.resumeFromSnapshot(pendingSnapshot, text);
    return;
  }

  // No session found
  logger.debug(`No active session found for follow-up on stream ${streamId}.`);
  void vscode.window.showWarningMessage(
    'No active tool-use session found for this follow-up.',
  );
}
