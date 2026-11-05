import { describe, expect, it } from 'vitest';

import {
  confirmCardKeyDecision,
  confirmCardKeyRows,
} from '@cli/chat/tui/modals/ConfirmCardState';

describe('CLI confirm-card key handling', () => {
  const feedbackRows = confirmCardKeyRows({ kind: 'bash' });
  const reject = { action: 'reject' };

  it('approves with y, collects rejection feedback with n, and rejects with escape', () => {
    expect(confirmCardKeyDecision('y', {}, 'bash', feedbackRows)).toEqual({
      action: 'approve',
    });
    expect(confirmCardKeyDecision('Y', {}, 'bash', feedbackRows)).toEqual({
      action: 'approve',
    });
    expect(confirmCardKeyDecision('n', {}, 'bash', feedbackRows)).toBe(
      'feedback',
    );
    expect(
      confirmCardKeyDecision('', { escape: true }, 'bash', feedbackRows),
    ).toEqual(reject);
    expect(confirmCardKeyDecision('\u001B', {}, 'bash', feedbackRows)).toEqual(
      reject,
    );
    expect(
      confirmCardKeyDecision('\u001Bn', {}, 'bash', feedbackRows),
    ).toBeUndefined();
  });
});
