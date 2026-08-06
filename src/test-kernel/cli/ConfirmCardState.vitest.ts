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

describe('confirmCardPulsedTitle', () => {
  it('alternates a solid/hollow dot ahead of the title every second', () => {
    expect(confirmCardPulsedTitle(0, 'Run command?')).toBe('● Run command?');
    expect(confirmCardPulsedTitle(1000, 'Run command?')).toBe('○ Run command?');
    expect(confirmCardPulsedTitle(2000, 'Run command?')).toBe('● Run command?');
  });

  it('only advances once per whole second', () => {
    expect(confirmCardPulsedTitle(999, 'x')).toBe(
      confirmCardPulsedTitle(0, 'x'),
    );
  });
});

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

  it('shows scoped session-wide approval hints for approval modals', () => {
    expect(
      confirmCardKeyHints({
        alwaysAllowLabel: 'approve commands for session',
      }),
    ).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject with note' },
      { key: 'a', action: 'approve commands for session' },
      { key: 'Esc', action: 'reject' },
    ]);

    expect(
      confirmCardKeyHints({
        alwaysAllowLabel: 'approve edits for session',
      }),
    ).toContainEqual({ key: 'a', action: 'approve edits for session' });

    const compactRendered = confirmCardKeyHintsForWidth({
      alwaysAllowLabel: 'approve commands for session',
      maxColumns: 80,
    })
      .map((hint) => `${hint.key} ${hint.action}`)
      .join(' · ');
    expect(compactRendered).toContain('a approve commands for session');
    expect(compactRendered).toContain('n reject with note');
    expect(compactRendered.length).toBeLessThanOrEqual(80);
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
        alwaysAllowLabel: 'approve commands for session',
        maxColumns: 80,
      }),
    ).toEqual(
      confirmCardKeyHints({
        alwaysAllowLabel: 'approve commands for session',
      }),
    );

    const compact = confirmCardKeyHintsForWidth({
      alwaysAllowLabel: 'approve commands for session',
      maxColumns: 60,
    });

    expect(compact).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'a', action: 'all commands' },
      { key: 'Esc', action: 'reject' },
    ]);
    expect(
      compact.map((hint) => `${hint.key} ${hint.action}`).join(' · ').length,
    ).toBeLessThanOrEqual(60);

    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve edits for session',
        maxColumns: 60,
      }),
    ).toContainEqual({ key: 'a', action: 'all edits' });

    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: DELEGATION_APPROVAL_COPY.cliAction,
        // ConfirmCard reserves four columns of an actual 72-column terminal
        // for its border and padding.
        maxColumns: 68,
      }),
    ).toContainEqual({
      key: 'a',
      action: DELEGATION_APPROVAL_COPY.cliCompactAction,
    });
  });

  it('keeps the approve-all hint on mid-width terminals', () => {
    const compact = confirmCardKeyHintsForWidth({
      alwaysAllowLabel: 'approve commands for session',
      maxColumns: 62,
    });

    expect(compact).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'a', action: 'all commands' },
      { key: 'Esc', action: 'reject' },
    ]);
    expect(
      compact.map((hint) => `${hint.key} ${hint.action}`).join(' · ').length,
    ).toBeLessThanOrEqual(62);
  });

  it('drops optional approval hints before hiding cancel on narrow terminals', () => {
    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve commands for session',
        maxColumns: 54,
      }),
    ).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'a', action: 'all commands' },
      { key: 'Esc', action: 'reject' },
    ]);

    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve commands for session',
        maxColumns: 36,
      }),
    ).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'Esc', action: 'reject' },
    ]);

    expect(
      confirmCardKeyHintsForWidth({
        alwaysAllowLabel: 'approve commands for session',
        maxColumns: 10,
      }),
    ).toEqual([{ key: 'Esc', action: 'reject' }]);
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
