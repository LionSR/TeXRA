import { describe, expect, it } from 'vitest';

import { ServerChainState } from '@agent/modelHandlers/support/ServerChainState';

describe('ServerChainState', () => {
  it('starts with no chain anchor and zeroed bookkeeping', () => {
    const state = new ServerChainState();

    expect(state.getAnchorId()).toBeNull();
    expect(state.hasAnchor()).toBe(false);
    expect(state.getSentCount()).toBe(0);
    expect(state.getCumulativeInputTokens()).toBe(0);
    expect(state.getSendAllNextTurn()).toBe(false);
  });

  it('records a chainable response and reports its anchor', () => {
    const state = new ServerChainState();

    state.recordChained('resp-1', 3);

    expect(state.getAnchorId()).toBe('resp-1');
    expect(state.hasAnchor()).toBe(true);
    expect(state.getSentCount()).toBe(3);
  });

  it('invalidateChain drops the anchor and sent count but preserves token history', () => {
    const state = new ServerChainState();
    state.recordChained('resp-1', 3);
    state.setCumulativeInputTokens(500);
    state.markCompactionApplied();

    state.invalidateChain();

    expect(state.getAnchorId()).toBeNull();
    expect(state.getSentCount()).toBe(0);
    expect(state.getSendAllNextTurn()).toBe(false);
    // Cumulative tokens survive so the compaction trigger can still fire.
    expect(state.getCumulativeInputTokens()).toBe(500);
  });

  it('resetChainForNewSession drops the anchor and every bookkeeping field', () => {
    const state = new ServerChainState();
    state.recordChained('resp-1', 3);
    state.setCumulativeInputTokens(500);
    state.markCompactionApplied();

    state.resetChainForNewSession();

    expect(state.getAnchorId()).toBeNull();
    expect(state.hasAnchor()).toBe(false);
    expect(state.getSentCount()).toBe(0);
    // Unlike invalidateChain(), a new session also drops the token history.
    expect(state.getCumulativeInputTokens()).toBe(0);
    expect(state.getSendAllNextTurn()).toBe(false);
  });

  it('clearChainForCompaction only clears the anchor', () => {
    const state = new ServerChainState();
    state.recordChained('resp-1', 3);

    state.clearChainForCompaction();

    expect(state.getAnchorId()).toBeNull();
    expect(state.getSentCount()).toBe(3);
  });

  it('markCompactionApplied resets the sent count and flags a full resend', () => {
    const state = new ServerChainState();
    state.recordChained('resp-1', 3);

    state.markCompactionApplied();

    expect(state.getSentCount()).toBe(0);
    expect(state.getSendAllNextTurn()).toBe(true);
  });

  it('clearSendAllNextTurn resets the send-all flag only', () => {
    const state = new ServerChainState();
    state.markCompactionApplied();

    state.clearSendAllNextTurn();

    expect(state.getSendAllNextTurn()).toBe(false);
    expect(state.getSentCount()).toBe(0);
  });
});
