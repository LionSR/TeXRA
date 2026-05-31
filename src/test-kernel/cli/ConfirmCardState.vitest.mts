import { describe, expect, it } from 'vitest';

import {
  confirmCardFeedbackHints,
  confirmCardKeyAction,
  confirmCardKeyHints,
  confirmCardKeyHintsForWidth,
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

  it('shows submit/back hints while collecting rejection feedback', () => {
    expect(confirmCardFeedbackHints()).toEqual([
      { key: 'Enter', action: 'send note' },
      { key: 'Esc', action: 'back' },
    ]);
  });

  it('compacts long optional approval hints before hiding cancel', () => {
    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve session',
        maxColumns: 80,
      }),
    ).toEqual(confirmCardKeyHints({ alwaysAllowLabel: 'approve session' }));

    const compact = confirmCardKeyHintsForWidth({
      alwaysAllowLabel: 'approve session',
      maxColumns: 56,
    });

    expect(compact).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'a', action: 'session' },
      { key: 'e', action: 'note' },
      { key: 'Esc', action: 'cancel' },
    ]);
    expect(
      compact.map((hint) => `${hint.key} ${hint.action}`).join(' · ').length,
    ).toBeLessThanOrEqual(56);
  });

  it('drops optional approval hints before hiding cancel on narrow terminals', () => {
    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve session',
        maxColumns: 42,
      }),
    ).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'e', action: 'note' },
      { key: 'Esc', action: 'cancel' },
    ]);

    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve session',
        maxColumns: 36,
      }),
    ).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'Esc', action: 'cancel' },
    ]);

    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve session',
        maxColumns: 10,
      }),
    ).toEqual([{ key: 'Esc', action: 'cancel' }]);
  });
});
