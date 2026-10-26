// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { DraftAttachmentStore } from '@cli/chat/tui/input/draftAttachments';

const img = (name: string) => ({
  path: `/p/${name}`,
  mediaType: 'image/png',
  displayName: name,
});

describe('DraftAttachmentStore', () => {
  let store: DraftAttachmentStore;

  beforeEach(() => {
    store = new DraftAttachmentStore();
  });

  it('formats a text chip with the newline count and expands it back', () => {
    const content = 'line1\nline2\nline3\nline4'; // 3 newlines
    const chip = store.addPastedText(content);
    expect(chip).toBe('[Pasted text #1 +3 lines]');
    expect(store.expandText(`see ${chip} ok`)).toBe(`see ${content} ok`);
  });

  it('expands multiple text chips with no spurious re-match', () => {
    const c1 = store.addPastedText('A\nA\nA\nA');
    const c2 = store.addPastedText('B\nB\nB\nB');
    expect(store.expandText(`${c1} mid ${c2}`)).toBe(
      'A\nA\nA\nA mid B\nB\nB\nB',
    );
  });

  it('resolves only image chips still present in the draft (orphan gate)', () => {
    const kept = store.addPastedImage(img('a.png'));
    store.addPastedImage(img('b.png')); // orphaned — chip removed from draft
    expect(store.resolveImages(`keep ${kept}`).map((e) => e.path)).toEqual([
      '/p/a.png',
    ]);
  });
});
