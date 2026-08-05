// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  DraftAttachmentStore,
  shouldCollapsePaste,
} from '@cli/chat/tui/input/draftAttachments';

const img = (name: string) => ({
  path: `/p/${name}`,
  mediaType: 'image/png',
  displayName: name,
});

describe('shouldCollapsePaste', () => {
  it('keeps short single-line pastes inline', () => {
    expect(shouldCollapsePaste('a short paste')).toBe(false);
  });

  it('collapses pastes longer than the char threshold', () => {
    expect(shouldCollapsePaste('x'.repeat(801))).toBe(true);
  });

  it('collapses pastes with more than two newlines but not fewer', () => {
    expect(shouldCollapsePaste('a\nb\nc\nd')).toBe(true); // 3 newlines
    expect(shouldCollapsePaste('a\nb')).toBe(false); // 1 newline
  });
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

  it('omits the line count for a single-line paste', () => {
    expect(store.addPastedText('x'.repeat(801))).toBe('[Pasted text #1]');
  });

  it('shares one id space between text and image chips', () => {
    expect(store.addPastedText('a\nb\nc\nd')).toBe('[Pasted text #1 +3 lines]');
    expect(store.addPastedImage(img('a.png'))).toBe('[Image #2]');
  });

  it('expands multiple text chips with no spurious re-match', () => {
    const c1 = store.addPastedText('A\nA\nA\nA');
    const c2 = store.addPastedText('B\nB\nB\nB');
    expect(store.expandText(`${c1} mid ${c2}`)).toBe(
      'A\nA\nA\nA mid B\nB\nB\nB',
    );
  });

  it('leaves image chips untouched when expanding text', () => {
    const chip = store.addPastedImage(img('a.png'));
    expect(store.expandText(`look ${chip}`)).toBe(`look ${chip}`);
  });

  it('drops backed image chips from history text after expanding pasted text', () => {
    const text = store.addPastedText('A\nB\nC\nD');
    const image = store.addPastedImage(img('a.png'));
    expect(store.expandTextForHistory(`look ${text} ${image} done`)).toBe(
      'look A\nB\nC\nD done',
    );
    expect(store.resolveMedia(`look ${text} ${image} done`)).toEqual([
      '/p/a.png',
    ]);
  });

  it('does not strip chip-like text from pasted text history', () => {
    const text = store.addPastedText('literal [Image #2]');
    const image = store.addPastedImage(img('a.png'));
    expect(store.expandTextForHistory(`${text} ${image}`)).toBe(
      'literal [Image #2]',
    );
  });

  it('resolves only image chips still present in the draft (orphan gate)', () => {
    const kept = store.addPastedImage(img('a.png'));
    store.addPastedImage(img('b.png')); // orphaned — chip removed from draft
    expect(store.resolveMedia(`keep ${kept}`)).toEqual(['/p/a.png']);
  });

  it('clears entries and resets the id counter', () => {
    store.addPastedText('a\nb\nc\nd');
    expect(store.isEmpty()).toBe(false);
    store.clear();
    expect(store.isEmpty()).toBe(true);
    expect(store.addPastedText('x\ny\nz\nw')).toBe('[Pasted text #1 +3 lines]');
  });
});
