// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';

// Local imports - progress view
import {
  clearFollowUpInputTransientStateStore,
  deleteFollowUpInputTransientState,
  getFollowUpInputTransientState,
} from '@progressView/frontend/followUpInputState';

describe('follow-up input transient state', () => {
  beforeEach(() => {
    clearFollowUpInputTransientStateStore();
  });

  it('returns stable, independent state for each stream', () => {
    const streamA = getFollowUpInputTransientState('stream-a');
    const streamB = getFollowUpInputTransientState('stream-b');

    streamA.pendingImages = [
      {
        fileName: 'pasted-a.png',
        base64: 'AAAA',
        mediaType: 'image/png',
      },
    ];

    expect(getFollowUpInputTransientState('stream-a')).toBe(streamA);
    expect(streamB.pendingImages).toEqual([]);
  });

  it('invalidates pending work before releasing a deleted stream', () => {
    const deleted = getFollowUpInputTransientState('stream-a');
    const pendingPaste = new Promise<void>(() => {});
    deleted.pendingImagePastes.add(pendingPaste);
    deleted.sendAfterImagePastes = true;

    deleteFollowUpInputTransientState('stream-a');

    expect(deleted.imagePasteRevision).toBe(1);
    expect(deleted.pendingImagePastes.size).toBe(0);
    expect(deleted.sendAfterImagePastes).toBe(false);
    expect(getFollowUpInputTransientState('stream-a')).not.toBe(deleted);
  });

  it('invalidates every stream during a frontend reset', () => {
    const streamA = getFollowUpInputTransientState('stream-a');
    const streamB = getFollowUpInputTransientState('stream-b');
    streamA.sendAfterImagePastes = true;
    streamB.sendAfterImagePastes = true;

    clearFollowUpInputTransientStateStore();

    expect(streamA.imagePasteRevision).toBe(1);
    expect(streamB.imagePasteRevision).toBe(1);
    expect(streamA.sendAfterImagePastes).toBe(false);
    expect(streamB.sendAfterImagePastes).toBe(false);
  });
});
