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

  it('shows scoped session-wide approval hints for approval modals', () => {
    expect(
      confirmCardKeyHints({
        alwaysAllowLabel: sessionCommandsLabel,
      }),
    ).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject & note' },
      { key: 'a', action: sessionCommandsLabel },
      { key: 'Esc', action: 'reject' },
    ]);

    expect(
      confirmCardKeyHints({
        alwaysAllowLabel: 'approve edits for session',
      }),
    ).toContainEqual({ key: 'a', action: 'approve edits for session' });

    const compactRendered = renderHints(
      hintsForWidth(sessionCommandsLabel, 80),
    );
    expect(compactRendered).toContain(`a ${sessionCommandsLabel}`);
    expect(compactRendered).toContain('n reject & note');
    expect(compactRendered.length).toBeLessThanOrEqual(80);
  });

  it('uses the same note-free default for immediate rejection keys', () => {
    expect(confirmCardKeyHints({ rejectionMode: 'immediate' })).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'Esc', action: 'reject' },
    ]);
  });

  it('preserves the immediate rejection label in the narrow fallback', () => {
    expect(
      confirmCardKeyHintsForWidth({
        rejectionMode: 'immediate',
        rejectLabel: 'dismiss',
        maxColumns: 1,
      }),
    ).toEqual([{ key: 'Esc', action: 'dismiss' }]);
  });

  it('shows submit/back hints while collecting rejection feedback', () => {
    expect(confirmCardFeedbackHints()).toEqual([
      { key: 'Enter', action: 'send note' },
      { key: 'Esc', action: 'back' },
    ]);
  });

  it('compacts long optional approval hints before hiding cancel', () => {
    expect(hintsForWidth(sessionCommandsLabel, 80)).toEqual(
      confirmCardKeyHints({
        alwaysAllowLabel: sessionCommandsLabel,
      }),
    );

    const compact = hintsForWidth(sessionCommandsLabel, 60);

    expect(compact).toEqual(compactCommandHints);
    expect(renderHints(compact).length).toBeLessThanOrEqual(60);

    expect(hintsForWidth('approve edits for session', 60)).toContainEqual({
      key: 'a',
      action: 'all edits',
    });

    expect(
      hintsForWidth(
        DELEGATION_APPROVAL_COPY.cliAction,
        // ConfirmCard reserves four columns of an actual 72-column terminal
        // for its border and padding.
        68,
      ),
    ).toContainEqual({
      key: 'a',
      action: DELEGATION_APPROVAL_COPY.cliCompactAction,
    });

    const narrowDelegationHints = hintsForWidth(
      DELEGATION_APPROVAL_COPY.cliAction,
      // ConfirmCard reserves four columns of an actual 60-column terminal.
      56,
    );
    expect(narrowDelegationHints).toContainEqual({
      key: 'a',
      action: DELEGATION_APPROVAL_COPY.cliCompactAction,
    });
    expect(renderHints(narrowDelegationHints).length).toBeLessThanOrEqual(56);
  });

  it('keeps the approve-all hint on mid-width terminals', () => {
    const compact = hintsForWidth(sessionCommandsLabel, 62);

    expect(compact).toEqual(compactCommandHints);
    expect(renderHints(compact).length).toBeLessThanOrEqual(62);
  });

  it('drops optional approval hints before hiding cancel on narrow terminals', () => {
    expect(hintsForWidth(sessionCommandsLabel, 54)).toEqual(
      compactCommandHints,
    );

    expect(hintsForWidth(sessionCommandsLabel, 36)).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'Esc', action: 'reject' },
    ]);

    expect(hintsForWidth(sessionCommandsLabel, 10)).toEqual([
      { key: 'Esc', action: 'reject' },
    ]);
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
