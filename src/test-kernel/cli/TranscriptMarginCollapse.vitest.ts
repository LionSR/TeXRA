// Yoga does not collapse adjacent margins, so a boundary where both entries
// declare a separator costs two blank rows unless the layout collapses them.
// These pin the collapse at the geometry SSOT, where every render path and
// every row budget reads it.

import { describe, expect, it } from 'vitest';

import { transcriptEntryLayout } from '@cli/chat/tui/panes/transcriptEntryLayout';
import type { ConversationEntry } from '@cli/chat/tui/state/cliState';

const user = (id: string, text = 'a user turn'): ConversationEntry =>
  ({ id, role: 'user', text, finalized: true }) as ConversationEntry;

const assistant = (id: string): ConversationEntry =>
  ({
    id,
    role: 'assistant',
    text: 'a reply',
    finalized: true,
  }) as ConversationEntry;

const phase = (id: string): ConversationEntry =>
  ({
    id,
    role: 'phase',
    phaseLabel: 'Scan',
    finalized: true,
  }) as ConversationEntry;

const topRows = (
  entry: ConversationEntry,
  previousEntry?: ConversationEntry,
): number =>
  transcriptEntryLayout(entry, { previousEntry, width: 60 }).marginTopRows;

describe('transcript entry margin collapse', () => {
  it('keeps the declared top margin when no previous entry is known', () => {
    // Callers that cannot identify the entry above (the live pane's first row,
    // the row-budget estimators) must keep reserving the full separator.
    expect(topRows(user('u1'))).toBe(1);
    expect(topRows(phase('p1'))).toBe(1);
  });

  it('absorbs the top margin into the previous entry’s bottom margin', () => {
    // Both sides declare 1, so the boundary is worth 1 row, not 2.
    expect(topRows(user('u2'), user('u1'))).toBe(0);
    expect(topRows(phase('p1'), user('u1'))).toBe(0);
  });

  it('keeps the separator when the entry above declares none', () => {
    // An assistant turn has no bottom margin, so the next turn owns the gap.
    expect(topRows(user('u2'), assistant('a1'))).toBe(1);
    expect(topRows(phase('p1'), assistant('a1'))).toBe(1);
  });

  it('leaves entries that declare no top margin alone', () => {
    expect(topRows(assistant('a1'), user('u1'))).toBe(0);
    expect(topRows(assistant('a2'), assistant('a1'))).toBe(0);
  });

  it('does not change the bottom margin an entry declares', () => {
    const withPrevious = transcriptEntryLayout(user('u2'), {
      previousEntry: user('u1'),
      width: 60,
    });
    const without = transcriptEntryLayout(user('u2'), { width: 60 });
    expect(withPrevious.marginBottomRows).toBe(without.marginBottomRows);
    expect(withPrevious.marginBottomRows).toBe(1);
  });
});
