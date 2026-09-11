import { describe, expect, it } from 'vitest';

import {
  confirmCardCompactChromeRows,
  confirmCardFeedbackHints,
  confirmCardKeyAction,
  confirmCardKeyHints,
  confirmCardKeyHintsForWidth,
  confirmCardPulsedTitle,
} from '@cli/chat/tui/modals/ConfirmCardState';
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';

describe('CLI confirm-card key handling', () => {
  const feedbackRejection = {
    allowAlways: false,
    rejectionMode: 'feedback',
  } as const;
  const immediateRejection = {
    allowAlways: false,
    rejectionMode: 'immediate',
  } as const;

  const sessionCommandsLabel = 'approve commands for session';
  const compactCommandHints = [
    { key: 'y', action: 'approve' },
    { key: 'n', action: 'reject' },
    { key: 'a', action: 'all commands' },
    { key: 'Esc', action: 'reject' },
  ];

  function hintsForWidth(
    alwaysAllowLabel: string,
    maxColumns: number,
  ): ReturnType<typeof confirmCardKeyHintsForWidth> {
    return confirmCardKeyHintsForWidth({ alwaysAllowLabel, maxColumns });
  }

  function renderHints(
    hints: ReturnType<typeof confirmCardKeyHintsForWidth>,
  ): string {
    return hints.map((hint) => `${hint.key} ${hint.action}`).join(' · ');
  }

  it('approves with y, collects rejection feedback with n, and rejects with escape', () => {
    expect(confirmCardKeyAction('y', {}, feedbackRejection)).toBe('approve');
    expect(confirmCardKeyAction('Y', {}, feedbackRejection)).toBe('approve');
    expect(confirmCardKeyAction('n', {}, feedbackRejection)).toBe('feedback');
    expect(confirmCardKeyAction('', { escape: true }, feedbackRejection)).toBe(
      'reject',
    );
    expect(confirmCardKeyAction('\u001B', {}, feedbackRejection)).toBe(
      'reject',
    );
    expect(confirmCardKeyAction('\u001Bn', {}, feedbackRejection)).toBe(
      'ignore',
    );
  });

  it('rejects immediately when feedback has no consumer', () => {
    expect(confirmCardKeyAction('n', {}, immediateRejection)).toBe('reject');
  });

  it('does not reserve a second key for rejection feedback', () => {
    expect(confirmCardKeyAction('e', {}, feedbackRejection)).toBe('ignore');
  });

  it('only enables approve-always where the modal allows it', () => {
    expect(
      confirmCardKeyAction(
        'a',
        {},
        {
          allowAlways: true,
          rejectionMode: 'feedback',
        },
      ),
    ).toBe('approveAlways');
    expect(confirmCardKeyAction('a', {}, feedbackRejection)).toBe('ignore');
  });
});
