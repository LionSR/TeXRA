// Response-chaining state for the OpenAI Responses API.
//
// Owns the `previous_response_id` chain anchor plus the client-side
// conversation bookkeeping that decides what a turn resends: how many
// messages the anchor already covers (`sentMessages`), the running input-token
// count that drives compaction, and whether the last turn was already sent in
// full (post-compaction). The handler asks this collaborator "what's the
// current chain anchor / do I need to send everything" instead of mutating
// `previousResponseId` or a `conversationState` bag itself — every field here
// is private, reachable only through the narrow methods below.
//
// Like the handler it's attached to, an instance is single-turn: do not share
// it across concurrent invocations (see the handler's class doc).

export class ResponseChainState {
  /** The `previous_response_id` chain anchor, or null when not chaining. */
  private previousResponseId: string | null = null;
  /** Number of messages already covered by the chain anchor (or by a full resend). */
  private sentMessages = 0;
  /** Cumulative input tokens across the conversation (for the compaction trigger). */
  private cumulativeInputTokens = 0;
  /** Whether the conversation has just been compacted (next turn resends all). */
  private isCompacted = false;
  /** Whether the OpenRouter compaction-skip debug line has already been logged. */
  private openRouterSkipLogged = false;

  /** The chain anchor to send as `previous_response_id`, or null if not chaining. */
  getPreviousResponseId(): string | null {
    return this.previousResponseId;
  }

  hasPreviousResponseId(): boolean {
    return this.previousResponseId !== null;
  }

  /** Raw anchor setter — used for manual resume and for clearing on error paths
   *  that must NOT also reset the sent-messages / compacted bookkeeping (see
   *  {@link invalidateChain} for the variant that does). */
  setPreviousResponseId(id: string | null): void {
    this.previousResponseId = id;
  }

  getSentMessagesCount(): number {
    return this.sentMessages;
  }

  getCumulativeInputTokens(): number {
    return this.cumulativeInputTokens;
  }

  setCumulativeInputTokens(tokens: number): void {
    this.cumulativeInputTokens = tokens;
  }

  getIsCompacted(): boolean {
    return this.isCompacted;
  }

  hasLoggedOpenRouterSkip(): boolean {
    return this.openRouterSkipLogged;
  }

  markOpenRouterSkipLogged(): void {
    this.openRouterSkipLogged = true;
  }

  /** Reset all conversation bookkeeping for a new session. Does not touch the
   *  chain anchor — callers that also want to drop it call
   *  {@link setPreviousResponseId}(null) alongside this. */
  resetConversationState(): void {
    this.sentMessages = 0;
    this.cumulativeInputTokens = 0;
    this.isCompacted = false;
    this.openRouterSkipLogged = false;
  }

  /** Drop server-side chain state while preserving local token history
   *  (cumulativeInputTokens survives so shouldCompact() can still trigger). */
  invalidateChain(): void {
    this.previousResponseId = null;
    this.sentMessages = 0;
    this.isCompacted = false;
  }

  /** Record a successful, chainable response: the new anchor plus how many
   *  messages it now covers. */
  recordChained(responseId: string, sentMessagesCount: number): void {
    this.previousResponseId = responseId;
    this.sentMessages = sentMessagesCount;
  }

  /** Compaction replaced server-side history with a local summary; the prior
   *  chain anchor no longer applies. Called before token counting so the
   *  estimate doesn't double-count the replaced history. */
  clearChainForCompaction(): void {
    this.previousResponseId = null;
  }

  /** Record that a compaction was applied this call: the next turn resends
   *  every message (sentMessages resets, isCompacted flags the send-all path). */
  markCompactionApplied(): void {
    this.sentMessages = 0;
    this.isCompacted = true;
  }

  /** Reset the compacted flag after a successful request (ready for the next
   *  compaction check). */
  clearCompactedFlag(): void {
    this.isCompacted = false;
  }
}
