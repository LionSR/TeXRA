/**
 * Presentation loading and storage-root replacement: what `load()` reads, and
 * how a workspace move is serialized against in-flight stream deletions.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import { AgentCategory, STREAM_PHASE, type StreamTabId } from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { createLifecycleOptions } from '@test/support/ProgressControllerHarnesses';
import { createTestSession } from '@test/support/sessionTestUtils';

import {
  createIsolatedRecordingBackend,
  createLiveStoreSession,
} from './progressBackendHarness';

async function expectDeletionBeforeStorageRootReplacement(
  deletionKind: 'one-stream' | 'all-streams',
): Promise<void> {
  const session = await createLiveStoreSession();
  const { backend } = createIsolatedRecordingBackend(session);
  const stream = `${deletionKind}-before-root-move` as StreamTabId;
  const operations: string[] = [];
  let finishDeletion: (() => void) | undefined;
  const deletionBlocked = new Promise<void>((resolve) => {
    finishDeletion = resolve;
  });
  if (deletionKind === 'one-stream') {
    vi.spyOn(backend.state, 'clearStream').mockImplementation(async () => {
      operations.push('delete:start');
      await deletionBlocked;
      operations.push('delete:end');
      return 'deleted';
    });
  } else {
    vi.spyOn(backend.state, 'clearAll').mockImplementation(async () => {
      operations.push('delete:start');
      await deletionBlocked;
      operations.push('delete:end');
      return { active: new Set(), failed: new Set() };
    });
  }
  const reloadAfterStorageRootChange = vi
    .spyOn(session, 'reloadAfterStorageRootChange')
    .mockImplementation(async () => {
      operations.push('reload');
      return true;
    });
  backend.state.streamLogs.ensureStream(stream);

  try {
    const deletion =
      deletionKind === 'one-stream'
        ? backend.deleteStream(stream)
        : backend.deleteAllStreams();
    await vi.waitFor(() => {
      expect(operations).toEqual(['delete:start']);
    });
    const workspaceMove = backend.reloadAfterStorageRootChange();
    await Promise.resolve();

    expect(reloadAfterStorageRootChange).not.toHaveBeenCalled();
    finishDeletion?.();
    await deletion;
    await workspaceMove;

    expect(operations).toEqual(['delete:start', 'delete:end', 'reload']);
  } finally {
    finishDeletion?.();
  }
}

async function expectDeletionReleasesEarlierRootReplacement(
  deletionKind: 'one-stream' | 'all-streams',
): Promise<void> {
  const session = createTestSession();
  const stream = `${deletionKind}-releases-root-move` as StreamTabId;
  const operations: string[] = [];
  let releaseReload: (() => void) | undefined;
  const reloadBlocked = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  const reloadAfterStorageRootChange = vi
    .spyOn(session, 'reloadAfterStorageRootChange')
    .mockImplementation(async () => {
      operations.push('reload:start');
      await reloadBlocked;
      operations.push('reload:end');
      return true;
    });
  const lifecycle = createLifecycleOptions({
    stopStream: vi.fn(() => {
      operations.push('stop');
      releaseReload?.();
    }),
  });
  const { backend } = createIsolatedRecordingBackend(session, lifecycle);
  backend.state.streamLogs.ensureStream(stream);
  session.status.transition(
    stream,
    STREAM_PHASE.RUNNING,
    STREAM_TRANSITION_CAUSE.LIFECYCLE,
  );
  vi.spyOn(session.executions, 'getAgentHandleByStream').mockReturnValue(
    {} as never,
  );
  vi.spyOn(backend.state, 'waitForOwnedExecutionRelease').mockResolvedValue();
  if (deletionKind === 'one-stream') {
    vi.spyOn(backend.state, 'clearStream').mockImplementation(async () => {
      operations.push('delete');
      return 'deleted';
    });
  } else {
    vi.spyOn(backend.state, 'clearAll').mockImplementation(async () => {
      operations.push('delete');
      return { active: new Set(), failed: new Set() };
    });
  }

  try {
    const workspaceMove = backend.reloadAfterStorageRootChange();
    await vi.waitFor(() =>
      expect(reloadAfterStorageRootChange).toHaveBeenCalledOnce(),
    );
    const deletion =
      deletionKind === 'one-stream'
        ? backend.deleteStream(stream)
        : backend.deleteAllStreams();

    await deletion;
    await workspaceMove;

    expect(operations).toEqual(['reload:start', 'stop', 'reload:end']);
  } finally {
    releaseReload?.();
  }
}

async function expectRetentionNoticeDoesNotBlockStorageRootReplacement(
  deletionKind: 'one-stream' | 'all-streams',
): Promise<void> {
  let finishNotice: (() => void) | undefined;
  const noticeBlocked = new Promise<void>((resolve) => {
    finishNotice = resolve;
  });
  const lifecycle = createLifecycleOptions({
    notifyDeletionRetained: vi.fn(() => noticeBlocked),
  });
  const session = createTestSession();
  const reloadAfterStorageRootChange = vi
    .spyOn(session, 'reloadAfterStorageRootChange')
    .mockResolvedValue(false);
  const { backend } = createIsolatedRecordingBackend(session, lifecycle);
  const stream = `${deletionKind}-retained-before-root-move` as StreamTabId;
  backend.state.streamLogs.ensureStream(stream);
  if (deletionKind === 'one-stream') {
    vi.spyOn(backend.state, 'clearStream').mockResolvedValue('active');
  } else {
    vi.spyOn(backend.state, 'clearAll').mockResolvedValue({
      active: new Set([stream]),
      failed: new Set(),
    });
  }

  try {
    const deletion =
      deletionKind === 'one-stream'
        ? backend.deleteStream(stream)
        : backend.deleteAllStreams();
    await vi.waitFor(() =>
      expect(lifecycle.notifyDeletionRetained).toHaveBeenCalled(),
    );
    const workspaceMove = backend.reloadAfterStorageRootChange();

    await vi.waitFor(() =>
      expect(reloadAfterStorageRootChange).toHaveBeenCalledOnce(),
    );
    finishNotice?.();
    await deletion;
    await workspaceMove;
  } finally {
    finishNotice?.();
  }
}

describe('ProgressBackend', () => {
  it('loads a presentation without reloading its live transcript', async () => {
    const session = await createLiveStoreSession();
    const waitUntilReady = vi.spyOn(session, 'waitUntilReady');
    const reload = vi.spyOn(session.transcripts, 'reload');
    const { backend } = createIsolatedRecordingBackend(session);

    await backend.load();

    expect(waitUntilReady).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it('uses the session-owned replacement boundary after a workspace move', async () => {
    const session = await createLiveStoreSession();
    const reloadAfterStorageRootChange = vi
      .spyOn(session, 'reloadAfterStorageRootChange')
      .mockResolvedValue(true);
    const transcriptReload = vi.spyOn(session.transcripts, 'reload');
    const { backend } = createIsolatedRecordingBackend(session);
    const resetPresentation = vi.spyOn(
      backend.state,
      'resetAfterStorageRootChange',
    );
    const clearBridge = vi.spyOn(backend.webviewBridge, 'clearAll');

    await backend.reloadAfterStorageRootChange();

    expect(reloadAfterStorageRootChange).toHaveBeenCalledOnce();
    expect(resetPresentation).toHaveBeenCalledOnce();
    expect(clearBridge).toHaveBeenCalledOnce();
    expect(transcriptReload).not.toHaveBeenCalled();
  });

  it('keeps presentation caches when the effective storage root is unchanged', async () => {
    const session = await createLiveStoreSession();
    vi.spyOn(session, 'reloadAfterStorageRootChange').mockResolvedValue(false);
    const { backend } = createIsolatedRecordingBackend(session);
    const resetPresentation = vi.spyOn(
      backend.state,
      'resetAfterStorageRootChange',
    );
    const clearBridge = vi.spyOn(backend.webviewBridge, 'clearAll');
    const loadPresentation = vi.spyOn(backend.state, 'load');

    await backend.reloadAfterStorageRootChange();

    expect(resetPresentation).not.toHaveBeenCalled();
    expect(clearBridge).not.toHaveBeenCalled();
    expect(loadPresentation).not.toHaveBeenCalled();
  });

  it('reconciles presentation caches after a partial session reload', async () => {
    const session = await createLiveStoreSession();
    const reloadError = new Error('snapshot hydration failed');
    vi.spyOn(session, 'reloadAfterStorageRootChange').mockRejectedValue(
      reloadError,
    );
    const { backend } = createIsolatedRecordingBackend(session);
    const resetPresentation = vi.spyOn(
      backend.state,
      'resetAfterStorageRootChange',
    );
    const clearBridge = vi.spyOn(backend.webviewBridge, 'clearAll');
    const loadPresentation = vi
      .spyOn(backend.state, 'load')
      .mockResolvedValue();

    await expect(backend.reloadAfterStorageRootChange()).rejects.toBe(
      reloadError,
    );

    expect(resetPresentation).toHaveBeenCalledOnce();
    expect(clearBridge).toHaveBeenCalledOnce();
    expect(loadPresentation).toHaveBeenCalledOnce();
  });

  it('retries presentation loading after the storage root already moved', async () => {
    const session = await createLiveStoreSession();
    vi.spyOn(session, 'reloadAfterStorageRootChange')
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const { backend } = createIsolatedRecordingBackend(session);
    const presentationError = new Error('presentation load failed');
    const loadPresentation = vi
      .spyOn(backend.state, 'load')
      .mockRejectedValueOnce(presentationError)
      .mockResolvedValue();

    await expect(backend.reloadAfterStorageRootChange()).rejects.toBe(
      presentationError,
    );
    await expect(
      backend.reloadAfterStorageRootChange(),
    ).resolves.toBeUndefined();

    expect(loadPresentation).toHaveBeenCalledTimes(2);
  });

  it('serializes complete presentation reloads across rapid workspace moves', async () => {
    const session = await createLiveStoreSession();
    let finishFirstReload: ((replaced: boolean) => void) | undefined;
    const firstReload = new Promise<boolean>((resolve) => {
      finishFirstReload = resolve;
    });
    const reloadAfterStorageRootChange = vi
      .spyOn(session, 'reloadAfterStorageRootChange')
      .mockReturnValueOnce(firstReload)
      .mockResolvedValue(true);
    const { backend } = createIsolatedRecordingBackend(session);

    const first = backend.reloadAfterStorageRootChange();
    const second = backend.reloadAfterStorageRootChange();
    await Promise.resolve();

    expect(reloadAfterStorageRootChange).toHaveBeenCalledOnce();
    finishFirstReload?.(true);
    await first;
    await second;

    expect(reloadAfterStorageRootChange).toHaveBeenCalledTimes(2);
  });

  it('finishes the initial presentation load before a workspace move', async () => {
    const session = await createLiveStoreSession();
    vi.spyOn(session, 'waitUntilReady').mockResolvedValue();
    const reloadAfterStorageRootChange = vi
      .spyOn(session, 'reloadAfterStorageRootChange')
      .mockResolvedValue(true);
    const { backend } = createIsolatedRecordingBackend(session);
    let finishInitialLoad: (() => void) | undefined;
    const initialLoadBlocked = new Promise<void>((resolve) => {
      finishInitialLoad = resolve;
    });
    vi.spyOn(backend.state, 'load')
      .mockReturnValueOnce(initialLoadBlocked)
      .mockResolvedValue();

    const initialLoad = backend.load();
    await vi.waitFor(() => {
      expect(backend.state.load).toHaveBeenCalledOnce();
    });
    const workspaceMove = backend.reloadAfterStorageRootChange();
    await Promise.resolve();

    expect(reloadAfterStorageRootChange).not.toHaveBeenCalled();
    finishInitialLoad?.();
    await initialLoad;
    await workspaceMove;

    expect(reloadAfterStorageRootChange).toHaveBeenCalledOnce();
  });

  it('finishes a one-stream deletion before replacing the storage root', async () => {
    await expectDeletionBeforeStorageRootReplacement('one-stream');
  });

  it('finishes an all-stream deletion before replacing the storage root', async () => {
    await expectDeletionBeforeStorageRootReplacement('all-streams');
  });

  it('releases an earlier root replacement without deleting from its new root', async () => {
    await expectDeletionReleasesEarlierRootReplacement('one-stream');
  });

  it('releases an earlier root replacement without clearing its new root', async () => {
    await expectDeletionReleasesEarlierRootReplacement('all-streams');
  });

  it('does not retain the storage queue for a one-stream notice', async () => {
    await expectRetentionNoticeDoesNotBlockStorageRootReplacement('one-stream');
  });

  it('does not retain the storage queue for an all-stream notice', async () => {
    await expectRetentionNoticeDoesNotBlockStorageRootReplacement(
      'all-streams',
    );
  });
});
