import { describe, expect, it } from 'vitest';

import { editApprovalDiffRowsBudget } from '@cli/chat/tui/modals/EditApproval';

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

  it('keeps a usable one-line diff on very short terminals', () => {
    expect(
      editApprovalDiffRowsBudget({
        availableRows: 8,
        columns: 80,
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
});
