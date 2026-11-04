// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { DraftAttachmentStore } from '@cli/chat/tui/input/draftAttachments';

const img = (name: string) => ({
  path: `/p/${name}`,
  mediaType: 'image/png',
  displayName: name,
});

describe('DraftAttachmentStore', () => {
  it('resolves only image chips still present in the draft (orphan gate)', () => {
    const store = new DraftAttachmentStore();
    const kept = store.addPastedImage(img('a.png'));
    store.addPastedImage(img('b.png')); // orphaned — chip removed from draft
    expect(store.resolveImages(`keep ${kept}`).map((e) => e.path)).toEqual([
      '/p/a.png',
    ]);
  });
});
