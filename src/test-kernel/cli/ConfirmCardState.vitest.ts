import { describe, expect, it } from 'vitest';

import {
  confirmCardKeyDecision,
  confirmCardKeyRows,
} from '@cli/chat/tui/modals/ConfirmCardState';
import { APPROVE_SESSION_ACTION } from '@texra/shared/session/surfaceDecision';

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

  it('only enables approve-always where the modal allows it', () => {
    const rows = confirmCardKeyRows({ alwaysAllowLabel: 'approve all' });
    expect(confirmCardKeyDecision('a', {}, rows)).toEqual({
      action: APPROVE_SESSION_ACTION,
    });
    expect(confirmCardKeyDecision('a', {}, feedbackRows)).toBeUndefined();
  });
});
