import { describe, expect, it } from 'vitest';

import {
  confirmCardKeyDecision,
  confirmCardKeyRows,
} from '@cli/chat/tui/modals/ConfirmCardState';

describe('CLI confirm-card key handling', () => {
  const feedbackRows = confirmCardKeyRows({ rejectionMode: 'feedback' });
  const reject = { action: 'reject' };

  it('approves with y, collects rejection feedback with n, and rejects with escape', () => {
    expect(confirmCardKeyDecision('y', {}, feedbackRows)).toEqual({
      action: 'approve',
    });
    expect(confirmCardKeyDecision('Y', {}, feedbackRows)).toEqual({
      action: 'approve',
    });
    expect(confirmCardKeyDecision('n', {}, feedbackRows)).toBe('feedback');
    expect(confirmCardKeyDecision('', { escape: true }, feedbackRows)).toEqual(
      reject,
    );
    expect(confirmCardKeyDecision('\u001B', {}, feedbackRows)).toEqual(reject);
    expect(confirmCardKeyDecision('\u001Bn', {}, feedbackRows)).toBeUndefined();
  });
});
