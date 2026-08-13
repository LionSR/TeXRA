// Server-side conversation-chain state, shared by every provider that lets the
// backend hold the transcript and continues it by id.
//
// Two handlers chain today and they name the same concept differently on the
// wire: the OpenAI Responses API sends `previous_response_id`, the Google
// Interactions API sends `previous_interaction_id`. Underneath, both need the
// identical four facts, which this collaborator owns:
//
//   - the chain ANCHOR id to continue from (null = no chain, resend everything)
//   - how many messages/steps that anchor already covers (the delta boundary)
//   - the running input-token count that drives the compaction trigger
//   - whether the last turn was compacted, so the next one resends in full
//
// The handler asks "what's the current anchor / do I need to send everything"
// instead of mutating loose fields itself — every field here is private,
// reachable only through the narrow methods below.
//
// Like the handlers it attaches to, an instance is single-turn: do not share it
// across concurrent invocations (see each handler's class doc).

export class ServerChainState {
  /** The chain anchor id, or null when not chaining. */
  private anchorId: string | null = null;
  /** Number of messages already covered by the anchor (or by a full resend). */
  private sentCount = 0;
  /** Cumulative input tokens across the conversation (for the compaction trigger). */
  private cumulativeInputTokens = 0;
  /** Whether the conversation has just been compacted (next turn resends all). */
  private sendAllNextTurn = false;

  /** The chain anchor to continue from, or null if not chaining. */
  getAnchorId(): string | null {
    return this.anchorId;
  }

  hasAnchor(): boolean {
    return this.anchorId !== null;
  }

  getSentCount(): number {
    return this.sentCount;
  }

  getCumulativeInputTokens(): number {
    return this.cumulativeInputTokens;
  }

  setCumulativeInputTokens(tokens: number): void {
    this.cumulativeInputTokens = tokens;
  }

  getSendAllNextTurn(): boolean {
    return this.sendAllNextTurn;
  }

  /** Reset every field for a new session: the chain anchor plus all
   *  conversation bookkeeping. Unlike {@link invalidateChain}, the token
   *  history goes too — a new session has no history to compact. */
  resetChainForNewSession(): void {
    this.anchorId = null;
    this.sentCount = 0;
    this.cumulativeInputTokens = 0;
    this.sendAllNextTurn = false;
  }

  /** Drop server-side chain state while preserving local token history
   *  (cumulativeInputTokens survives so the compaction trigger can still fire). */
  invalidateChain(): void {
    this.anchorId = null;
    this.sentCount = 0;
    this.sendAllNextTurn = false;
  }

  /** Record a successful, chainable response: the new anchor plus how many
   *  messages it now covers. */
  recordChained(anchorId: string, sentCount: number): void {
    this.anchorId = anchorId;
    this.sentCount = sentCount;
  }

  /** Compaction replaced server-side history with a local summary; the prior
   *  chain anchor no longer applies. Called before token counting so the
   *  estimate doesn't double-count the replaced history. */
  clearChainForCompaction(): void {
    this.anchorId = null;
  }

  /** Record that a compaction was applied this call: the next turn resends
   *  every message (sentCount resets, sendAllNextTurn flags the send-all path). */
  markCompactionApplied(): void {
    this.sentCount = 0;
    this.sendAllNextTurn = true;
  }

  /** Reset the send-all flag after a successful request (ready for the next
   *  compaction check). */
  clearSendAllNextTurn(): void {
    this.sendAllNextTurn = false;
  }
}
