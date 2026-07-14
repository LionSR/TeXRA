import { describe, expect, it } from 'vitest';

import {
  confirmCardCompactChromeRows,
  confirmCardFeedbackHints,
  confirmCardKeyAction,
  confirmCardKeyHints,
  confirmCardKeyHintsForWidth,
} from '@cli/chat/tui/modals/ConfirmCardState';

describe('CLI confirm-card key handling', () => {
  it('approves with y, collects rejection feedback with n, and cancels with escape', () => {
    expect(confirmCardKeyAction('y', {}, false)).toBe('approve');
    expect(confirmCardKeyAction('Y', {}, false)).toBe('approve');
    expect(confirmCardKeyAction('n', {}, false)).toBe('feedback');
    expect(confirmCardKeyAction('', { escape: true }, false)).toBe('reject');
    expect(confirmCardKeyAction('\u001B', {}, false)).toBe('reject');
    expect(confirmCardKeyAction('\u001Bn', {}, false)).toBe('ignore');
  });

  it('does not reserve a second key for rejection feedback', () => {
    expect(confirmCardKeyAction('e', {}, false)).toBe('ignore');
  });

  it('only enables approve-always where the modal allows it', () => {
    expect(confirmCardKeyAction('a', {}, true)).toBe('approveAlways');
    expect(confirmCardKeyAction('a', {}, false)).toBe('ignore');
  });

  it('shows scoped session-wide approval hints for approval modals', () => {
    expect(
      confirmCardKeyHints({
        alwaysAllowLabel: 'approve all',
      }),
    ).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject & note' },
      { key: 'a', action: 'approve all' },
      { key: 'Esc', action: 'cancel' },
    ]);

    expect(
      confirmCardKeyHints({
        alwaysAllowLabel: 'approve edits for session',
      }),
    ).toContainEqual({ key: 'a', action: 'approve edits for session' });

    const compactRendered = confirmCardKeyHintsForWidth({
      alwaysAllowLabel: 'approve all',
      maxColumns: 72,
    })
      .map((hint) => `${hint.key} ${hint.action}`)
      .join(' · ');
    expect(compactRendered).toContain('a approve all');
    expect(compactRendered).toContain('n reject & note');
    expect(compactRendered.length).toBeLessThanOrEqual(72);
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
        alwaysAllowLabel: 'approve all',
        maxColumns: 80,
      }),
    ).toEqual(
      confirmCardKeyHints({
        alwaysAllowLabel: 'approve all',
      }),
    );

    const compact = confirmCardKeyHintsForWidth({
      alwaysAllowLabel: 'approve all',
      maxColumns: 60,
    });

    expect(compact).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject & note' },
      { key: 'a', action: 'approve all' },
      { key: 'Esc', action: 'cancel' },
    ]);
    expect(
      compact.map((hint) => `${hint.key} ${hint.action}`).join(' · ').length,
    ).toBeLessThanOrEqual(60);

    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve edits for session',
        maxColumns: 60,
      }),
    ).toContainEqual({ key: 'a', action: 'edit session' });

    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve all delegated tasks for this session',
        maxColumns: 72,
      }),
    ).toContainEqual({ key: 'a', action: 'all delegated tasks' });
  });

  it('keeps the approve-all hint on mid-width terminals', () => {
    const compact = confirmCardKeyHintsForWidth({
      alwaysAllowLabel: 'approve all',
      maxColumns: 50,
    });

    expect(compact).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'a', action: 'all' },
      { key: 'Esc', action: 'cancel' },
    ]);
    expect(
      compact.map((hint) => `${hint.key} ${hint.action}`).join(' · ').length,
    ).toBeLessThanOrEqual(50);
  });

  it('drops optional approval hints before hiding cancel on narrow terminals', () => {
    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve all',
        maxColumns: 42,
      }),
    ).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'a', action: 'all' },
      { key: 'Esc', action: 'cancel' },
    ]);

    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve all',
        maxColumns: 36,
      }),
    ).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'Esc', action: 'cancel' },
    ]);

    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve all',
        maxColumns: 10,
      }),
    ).toEqual([{ key: 'Esc', action: 'cancel' }]);
  });

  it('reports stacked compact chrome rows for long extra actions', () => {
    const options = {
      title: 'Approve plan?',
      extraActions: [{ key: 'r', action: 'approve & run' }],
    };

    expect(confirmCardCompactChromeRows({ ...options, columns: 60 })).toBe(2);
    expect(confirmCardCompactChromeRows({ ...options, columns: 100 })).toBe(1);
  });
});
