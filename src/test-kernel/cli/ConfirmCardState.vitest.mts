import { describe, expect, it } from 'vitest';

import {
  confirmCardKeyAction,
  confirmCardKeyHints,
} from '@cli/chat/tui/modals/ConfirmCardState';

describe('CLI confirm-card key handling', () => {
  it('keeps y/n and escape approval behavior', () => {
    expect(confirmCardKeyAction('y', {}, false)).toBe('approve');
    expect(confirmCardKeyAction('Y', {}, false)).toBe('approve');
    expect(confirmCardKeyAction('n', {}, false)).toBe('reject');
    expect(confirmCardKeyAction('', { escape: true }, false)).toBe('reject');
  });

  it('enters feedback mode with e', () => {
    expect(confirmCardKeyAction('e', {}, false)).toBe('feedback');
  });

  it('only enables approve-always where the modal allows it', () => {
    expect(confirmCardKeyAction('a', {}, true)).toBe('approveAlways');
    expect(confirmCardKeyAction('a', {}, false)).toBe('ignore');
  });

  it('keeps session-wide approval hints compact enough for approval modals', () => {
    expect(
      confirmCardKeyHints({
        alwaysAllowLabel: 'approve session',
      }),
    ).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'a', action: 'approve session' },
      { key: 'e', action: 'feedback' },
      { key: 'Esc', action: 'cancel' },
    ]);

    const rendered = confirmCardKeyHints({
      alwaysAllowLabel: 'approve session',
    })
      .map((hint) => `${hint.key} ${hint.action}`)
      .join(' · ');
    expect(rendered.length).toBeLessThanOrEqual(72);
  });
});
