import { describe, expect, it } from 'vitest';

import { ResponseChainState } from '@agent/modelHandlers/openai/ResponseChainState';

describe('ResponseChainState', () => {
  it('starts with no chain anchor and zeroed bookkeeping', () => {
    const state = new ResponseChainState();

    expect(state.getPreviousResponseId()).toBeNull();
    expect(state.hasPreviousResponseId()).toBe(false);
    expect(state.getSentMessagesCount()).toBe(0);
    expect(state.getCumulativeInputTokens()).toBe(0);
    expect(state.getIsCompacted()).toBe(false);
    expect(state.hasLoggedOpenRouterSkip()).toBe(false);
  });

  it('records a chainable response and reports its anchor', () => {
    const state = new ResponseChainState();

    state.recordChained('resp-1', 3);

    expect(state.getPreviousResponseId()).toBe('resp-1');
    expect(state.hasPreviousResponseId()).toBe(true);
    expect(state.getSentMessagesCount()).toBe(3);
  });

  it('invalidateChain drops the anchor and sent count but preserves token history', () => {
    const state = new ResponseChainState();
    state.recordChained('resp-1', 3);
    state.setCumulativeInputTokens(500);
    state.markCompactionApplied();

    state.invalidateChain();

    expect(state.getPreviousResponseId()).toBeNull();
    expect(state.getSentMessagesCount()).toBe(0);
    expect(state.getIsCompacted()).toBe(false);
    // Cumulative tokens survive so shouldCompact() can still trigger.
    expect(state.getCumulativeInputTokens()).toBe(500);
  });

  it('setPreviousResponseId is a raw setter that does not touch other bookkeeping', () => {
    const state = new ResponseChainState();
    state.recordChained('resp-1', 3);
    state.setCumulativeInputTokens(500);

    state.setPreviousResponseId(null);

    expect(state.getPreviousResponseId()).toBeNull();
    // Unlike invalidateChain(), the raw setter leaves sentMessages untouched.
    expect(state.getSentMessagesCount()).toBe(3);
    expect(state.getCumulativeInputTokens()).toBe(500);
  });

  it('resetConversationState zeroes bookkeeping without touching the anchor', () => {
    const state = new ResponseChainState();
    state.recordChained('resp-1', 3);
    state.setCumulativeInputTokens(500);
    state.markOpenRouterSkipLogged();

    state.resetConversationState();

    expect(state.getPreviousResponseId()).toBe('resp-1');
    expect(state.getSentMessagesCount()).toBe(0);
    expect(state.getCumulativeInputTokens()).toBe(0);
    expect(state.getIsCompacted()).toBe(false);
    expect(state.hasLoggedOpenRouterSkip()).toBe(false);
  });

  it('clearChainForCompaction only clears the anchor', () => {
    const state = new ResponseChainState();
    state.recordChained('resp-1', 3);

    state.clearChainForCompaction();

    expect(state.getPreviousResponseId()).toBeNull();
    expect(state.getSentMessagesCount()).toBe(3);
  });

  it('markCompactionApplied resets sent messages and flags compacted', () => {
    const state = new ResponseChainState();
    state.recordChained('resp-1', 3);

    state.markCompactionApplied();

    expect(state.getSentMessagesCount()).toBe(0);
    expect(state.getIsCompacted()).toBe(true);
  });

  it('clearCompactedFlag resets the compacted flag only', () => {
    const state = new ResponseChainState();
    state.markCompactionApplied();

    state.clearCompactedFlag();

    expect(state.getIsCompacted()).toBe(false);
    expect(state.getSentMessagesCount()).toBe(0);
  });

  it('markOpenRouterSkipLogged is idempotent and observable via hasLoggedOpenRouterSkip', () => {
    const state = new ResponseChainState();

    expect(state.hasLoggedOpenRouterSkip()).toBe(false);
    state.markOpenRouterSkipLogged();
    expect(state.hasLoggedOpenRouterSkip()).toBe(true);
    state.markOpenRouterSkipLogged();
    expect(state.hasLoggedOpenRouterSkip()).toBe(true);
  });
});
