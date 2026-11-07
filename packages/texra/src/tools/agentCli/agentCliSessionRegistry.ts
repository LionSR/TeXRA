/**
 * The agent-CLI threads (Codex threads, Claude Code sessions) a turn is
 * running on in this session, one registry per plugin per session. A call
 * continuing a thread claims it for the turn's life: a second call on the
 * same thread while that turn runs is refused by the provider's tool,
 * since the provider's SDK holds one turn per thread at a time, and the
 * thread id itself lives with the provider.
 */
export class AgentCliSessionRegistry {
  private readonly busy = new Set<string>();

  /**
   * Claim `threadId` for one turn. Answers the release bound to this claim,
   * or undefined when a turn here already holds the thread.
   */
  claim(threadId: string): (() => void) | undefined {
    if (this.busy.has(threadId)) return undefined;
    this.busy.add(threadId);
    return () => {
      this.busy.delete(threadId);
    };
  }
}
