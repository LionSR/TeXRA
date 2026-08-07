import { describe, expect, it } from 'vitest';

import {
  COMPACT_EDIT_APPROVAL_MAX_ROWS,
  editApprovalDiffRowsBudget,
  formatEditApprovalHunkCount,
} from '@cli/chat/tui/modals/EditApproval';
import { confirmCardFeedbackRows } from '@cli/chat/tui/modals/confirmCardRowsBudget';

type BudgetInput = Parameters<typeof editApprovalDiffRowsBudget>[0];

describe('CLI edit approval layout', () => {
  it.each<{ name: string; input: BudgetInput; expected: number }>([
    {
      name: 'reserves footer rows when the approval title wraps',
      input: {
        availableRows: 16,
        columns: 80,
        title:
          'Apply edit to /private/tmp/texra-queued-transcript-gZNBeZ/bolzano_weierstrass.tex?',
      },
      expected: 6,
    },
    {
      name: 'reserves feedback input rows while collecting a rejection note',
      input: {
        availableRows: 16,
        columns: 80,
        feedbackMode: true,
        title: 'Apply edit to proof.tex?',
      },
      expected: 5,
    },
    {
      name: 'keeps a usable diff line on very short terminals',
      input: {
        availableRows: 7,
        columns: 40,
        title: 'Apply edit to proof.tex?',
      },
      expected: 1,
    },
    {
      name: 'preserves the generous fallback when terminal rows are unknown',
      input: { columns: 80, title: 'Apply edit to proof.tex?' },
      expected: 30,
    },
  ])('$name', ({ input, expected }) => {
    expect(editApprovalDiffRowsBudget(input)).toBe(expected);
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

  it('accounts for wrapped feedback placeholders on narrow terminals', () => {
    expect(
      confirmCardFeedbackRows({
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

  it('pluralizes the hunk count in the summary line', () => {
    expect(formatEditApprovalHunkCount(1)).toBe('1 hunk');
    expect(formatEditApprovalHunkCount(2)).toBe('2 hunks');
  });
});
