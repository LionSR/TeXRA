import { describe, expect, it } from 'vitest';

import {
  COMPACT_EDIT_APPROVAL_MAX_ROWS,
  editApprovalDiffRowsBudget,
  editApprovalFeedbackRows,
  formatEditApprovalHunkCount,
} from '@cli/chat/tui/modals/EditApproval';

describe('CLI edit approval layout', () => {
  it('reserves footer rows when the approval title wraps', () => {
    const title =
      'Apply edit to /private/tmp/texra-queued-transcript-gZNBeZ/bolzano_weierstrass.tex?';

    expect(
      editApprovalDiffRowsBudget({
        availableRows: 16,
        columns: 80,
        title,
      }),
    ).toBe(6);
  });

  it('includes the pulse prefix when a dynamic edit title reaches the width boundary', () => {
    const title = `Apply edit to ${'x'.repeat(31)}?`;
    expect(title).toHaveLength(46);

    expect(
      editApprovalDiffRowsBudget({
        availableRows: 16,
        columns: 50,
        title,
      }),
    ).toBe(6);
  });

  it('reserves feedback input rows while collecting a rejection note', () => {
    expect(
      editApprovalDiffRowsBudget({
        availableRows: 16,
        columns: 80,
        feedbackMode: true,
        title: 'Apply edit to proof.tex?',
      }),
    ).toBe(5);
  });

  it('accounts for wrapped feedback placeholders on narrow terminals', () => {
    expect(
      editApprovalFeedbackRows({
        columns: 16,
        placeholder: 'Needs a smaller proof step',
        value: '',
      }),
    ).toBe(4);

    expect(
      editApprovalDiffRowsBudget({
        availableRows: 16,
        columns: 16,
        feedbackMode: true,
        feedbackPlaceholder: 'Needs a smaller proof step',
        title: 'Edit?',
      }),
    ).toBe(3);
  });

  it('uses compact diff rows on short terminals', () => {
    expect(COMPACT_EDIT_APPROVAL_MAX_ROWS).toBe(9);
    expect(
      editApprovalDiffRowsBudget({
        availableRows: 9,
        columns: 80,
        title: 'Apply edit to draft.tex?',
      }),
    ).toBe(3);
  });

  it('keeps a usable diff line on very short terminals', () => {
    expect(
      editApprovalDiffRowsBudget({
        availableRows: 7,
        columns: 40,
        title: 'Apply edit to proof.tex?',
      }),
    ).toBe(1);
  });

  it('preserves the generous fallback when terminal rows are unknown', () => {
    expect(
      editApprovalDiffRowsBudget({
        columns: 80,
        title: 'Apply edit to proof.tex?',
      }),
    ).toBe(30);
  });

  it('pluralizes the hunk count in the summary line', () => {
    expect(formatEditApprovalHunkCount(1)).toBe('1 hunk');
    expect(formatEditApprovalHunkCount(2)).toBe('2 hunks');
  });
});
