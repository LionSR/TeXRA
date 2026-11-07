// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  EMPTY_DRAFT,
  resolveImages,
  withPastedImage,
  withText,
} from '@cli/chat/tui/input/draftAttachments';

const img = (name: string) => ({
  path: `/p/${name}`,
  mediaType: 'image/png',
  displayName: name,
});

describe('Draft attachments', () => {
  it('resolves only image chips still present in the draft (orphan gate)', () => {
    const kept = withPastedImage(EMPTY_DRAFT, img('a.png'));
    // orphaned — chip removed from draft
    const orphaned = withPastedImage(kept.draft, img('b.png'));
    const draft = withText(orphaned.draft, `keep ${kept.chip}`);
    expect(resolveImages(draft).map((e) => e.path)).toEqual(['/p/a.png']);
  });
});
