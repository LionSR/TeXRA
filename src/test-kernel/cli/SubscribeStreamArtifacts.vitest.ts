// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultSession } from '@agent/runtime';
import { resetCliState } from '@cli/chat/tui/state/cliState';
import {
  beginLoadedStreamsReconcile,
  hydrateStreamArtifacts,
  markArtifactStreamHydrated,
  readStreamArtifacts,
} from '@cli/chat/tui/state/subscribeStreamArtifacts';
import type { StreamTabId } from '@shared/schemas';
import { StreamSnapshotPreloadError } from '@transcript';

describe('stream artifact hydration reconciliation', () => {
  beforeEach(() => {
    resetCliState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('does not treat partial field authority as full-stream hydration', async () => {
    const streamId = 'partial-authority@gpt#abc123def' as StreamTabId;
    const snapshots = defaultSession().snapshots;
    vi.spyOn(snapshots, 'preload').mockRejectedValueOnce(
      new StreamSnapshotPreloadError(
        new Error('historical sidecar unreadable'),
        streamId,
        {
          outputFiles: false,
          missingOutputs: false,
          compileFailures: false,
          usage: false,
          todos: false,
          plan: true,
        },
      ),
    );

    await expect(hydrateStreamArtifacts(snapshots, streamId)).resolves.toEqual({
      kind: 'partial',
      authoritativeFields: {
        outputFiles: false,
        missingOutputs: false,
        compileFailures: false,
        usage: false,
        todos: false,
        plan: true,
      },
      error: expect.any(StreamSnapshotPreloadError),
    });
    expect(readStreamArtifacts(streamId)).toBeUndefined();
  });
});
