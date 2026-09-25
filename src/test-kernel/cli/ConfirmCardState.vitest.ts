import { describe, expect, it } from 'vitest';

import { confirmCardKeyAction } from '@cli/chat/tui/modals/ConfirmCardState';

describe('CLI confirm-card key handling', () => {
  const feedbackRejection = {
    allowAlways: false,
    rejectionMode: 'feedback',
  } as const;
  const immediateRejection = {
    allowAlways: false,
    rejectionMode: 'immediate',
  } as const;

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
