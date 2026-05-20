import { describe, expect, it } from 'vitest';

import {
  confirmCardKeyAction,
  confirmCardKeyHints,
} from '../../../packages/cli/src/chat/tui/modals/ConfirmCardState';

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

  it('keeps session-wide approval in the full key-hint list', () => {
    expect(
      confirmCardKeyHints({
        alwaysAllowLabel: 'approve edits this session',
      }),
    ).toEqual([
      { key: 'y', action: 'approve' },
      { key: 'n', action: 'reject' },
      { key: 'a', action: 'approve edits this session' },
      { key: 'e', action: 'reject with feedback' },
      { key: 'Esc', action: 'cancel' },
    ]);
  });
});
