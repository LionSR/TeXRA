import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamTabId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  projectStreamArtifacts: vi.fn((_: unknown, streamId: StreamTabId) => ({
    streamId,
  })),
  session: { snapshots: {} },
}));

vi.mock('@agent/runtime', () => ({
  tryDefaultSession: () => mocks.session,
}));

vi.mock('@controllers/session/StreamArtifactProjection', () => ({
  projectStreamArtifacts: mocks.projectStreamArtifacts,
}));

const { resetCliState } = await import('@cli/chat/tui/state/cliState');
const {
  beginLoadedStreamsReconcile,
  markArtifactStreamHydrated,
  readStreamArtifacts,
} = await import('@cli/chat/tui/state/subscribeStreamArtifacts');

describe('stream artifact hydration reconciliation', () => {
  beforeEach(() => {
    resetCliState();
    mocks.projectStreamArtifacts.mockClear();
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
    expect(readStreamArtifacts(retained)).toEqual({ streamId: retained });
  });
});
