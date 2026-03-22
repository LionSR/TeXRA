/**
 * Promise-based queue for follow-up messages in a tool-use session.
 *
 * This is a standalone data structure with no dependencies on other
 * toolUse modules, allowing it to be imported without circular dependency issues.
 */

/**
 * A follow-up item that can be queued for a tool-use session.
 *
 * - `text`: A plain text follow-up message (user message, subagent delivery, etc.)
 * - `resume_tool`: A structured request to resume a WAITING subagent with follow-up
 *   instructions, allowing the orchestrator to queue resume requests into the
 *   follow-up queue for automatic processing.
 */
export type FollowUpItem =
  | { kind: 'text'; content: string }
  | { kind: 'resume_tool'; executionId: string; instruction: string };

/** Create a text follow-up item from a plain string. */
export function textFollowUp(content: string): FollowUpItem {
  return { kind: 'text', content };
}

/** Create a resume_tool follow-up item. */
export function resumeToolFollowUp(
  executionId: string,
  instruction: string,
): FollowUpItem {
  return { kind: 'resume_tool', executionId, instruction };
}

/** Extract display text from a follow-up item (for UI display). */
export function followUpDisplayText(item: FollowUpItem): string {
  if (item.kind === 'text') return item.content;
  return `[resume_tool: ${item.executionId}] ${item.instruction}`;
}

export class FollowUpQueue {
  private readonly queued: FollowUpItem[] = [];
  private resolver: ((value: FollowUpItem | null) => void) | null = null;

  /** Resolves pending wait with value and clears resolver */
  private resolveWait(value: FollowUpItem | null): void {
    const resolver = this.resolver;
    this.resolver = null;
    resolver?.(value);
  }

  enqueue(value: FollowUpItem): void {
    if (this.resolver) {
      this.resolveWait(value);
    } else {
      this.queued.push(value);
    }
  }

  /** Convenience method to enqueue a plain text follow-up. */
  enqueueText(value: string): void {
    this.enqueue(textFollowUp(value));
  }

  isEmpty(): boolean {
    return this.queued.length === 0;
  }

  drain(): FollowUpItem[] {
    return this.queued.splice(0);
  }

  waitForNext(
    checkInterruption: () => boolean,
  ): Promise<FollowUpItem | null> {
    if (!this.isEmpty()) {
      return Promise.resolve(this.queued.shift()!);
    }
    if (checkInterruption()) {
      return Promise.resolve(null);
    }
    return new Promise<FollowUpItem | null>((resolve) => {
      this.resolver = resolve;
    });
  }

  /**
   * Wait for at least one item, then drain all available.
   * Returns all queued items as an array.
   */
  async waitAndDrainAll(
    checkInterruption: () => boolean,
  ): Promise<FollowUpItem[] | null> {
    const first = await this.waitForNext(checkInterruption);
    if (first === null) {
      return null;
    }
    // Drain any additional items that arrived while waiting
    const rest = this.drain();
    if (rest.length === 0) {
      return [first];
    }
    return [first, ...rest];
  }

  cancelWait(): void {
    this.resolveWait(null);
  }

  clear(): void {
    this.queued.length = 0;
  }

  dispose(): void {
    this.cancelWait();
    this.clear();
  }

  /**
   * Get a copy of all queued items for display purposes.
   * This doesn't modify the queue.
   */
  getAll(): FollowUpItem[] {
    return [...this.queued];
  }
}
