// Focused test for the preserve-on-exit predicate that decides whether a
// suspended tool-use session is left untouched (so its flow record survives
// for `texra resume`) or interrupted on shutdown. See the rationale on
// chatTuiIsResumableIdleOnExit: interrupting clears the resumable state, so an
// idle/WAITING session with a live flow must be preserved, while a claimed
// resume slot that is still rehydrating must be interrupted.

import { describe, expect, it } from 'vitest';

import { chatTuiIsResumableIdleOnExit } from '@cli/chat/tui/state/sessionRunState';

describe('chatTuiIsResumableIdleOnExit', () => {
  it.each([
    ['live idle flow', true, false, true, true],
    ['pre-live rehydration', true, false, false, false],
    ['actively running turn', true, true, true, false],
    ['no pending run', false, false, false, false],
  ] as const)(
    '%s',
    (
      _name,
      canInterruptActiveRun,
      canStopActiveRun,
      hasActiveToolUseFlow,
      expected,
    ) => {
      expect(
        chatTuiIsResumableIdleOnExit({
          canInterruptActiveRun,
          canStopActiveRun,
          hasActiveToolUseFlow,
        }),
      ).toBe(expected);
    },
  );
});
