// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it } from 'vitest';

import { resetCliState } from '@cli/chat/tui/state/cliState';
import {
  beginLoadedStreamsReconcile,
  markArtifactStreamHydrated,
  readStreamArtifacts,
} from '@cli/chat/tui/state/subscribeStreamArtifacts';
import type { StreamTabId } from '@shared/schemas';

describe('stream artifact hydration reconciliation', () => {
  beforeEach(() => {
    resetCliState();
  });

  it('drops evicted hydration before marking the retained set', () => {
    const dropped = 'dropped@gpt#abc123def' as StreamTabId;
    const retained = 'retained@gpt#def456abc' as StreamTabId;
    markArtifactStreamHydrated(dropped);

    const reconciliation = beginLoadedStreamsReconcile([retained]);
    reconciliation.dropStale();

    expect(readStreamArtifacts(dropped)).toBeUndefined();
    expect(readStreamArtifacts(retained)).toBeUndefined();

    reconciliation.reconcile();

    expect(readStreamArtifacts(dropped)).toBeUndefined();
    expect(readStreamArtifacts(retained)).toBeDefined();
  });
});
