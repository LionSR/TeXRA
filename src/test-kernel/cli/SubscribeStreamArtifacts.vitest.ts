// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { resetCliState } from '@cli/chat/tui/state/cliState';
import { readStreamArtifacts } from '@cli/chat/tui/state/subscribeStreamArtifacts';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { snapshotFacts } from '@test/support/storeTestDrivers';

describe('stream artifact projection gating', () => {
  beforeEach(() => {
    resetCliState();
  });

  it('projects exactly the streams the store still has provenance for', async () => {
    const store = defaultSession().snapshots;
    const dropped = 'dropped@gpt#abc123def' as StreamTabId;
    const retained = 'retained@gpt#def456abc' as StreamTabId;
    // A live write ahead of any seed establishes provenance on its own.
    snapshotFacts(store).addUsage(dropped, 'dropped-run' as ExecutionId, {
      inputTokens: 10,
      outputTokens: 2,
      cost: 0.1,
    });
    expect(readStreamArtifacts(dropped)).toBeDefined();

    // `load` claims an authoritative stream set: it evicts every other record
    // synchronously, so the gate turns off for `dropped` with no host-side
    // hydration bookkeeping to reconcile.
    await store.load([retained]);

    expect(readStreamArtifacts(dropped)).toBeUndefined();
    expect(readStreamArtifacts(retained)).toBeDefined();
  });
});
