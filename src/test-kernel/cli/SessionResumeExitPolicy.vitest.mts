// Focused test for the preserve-on-exit predicate that decides whether a
// suspended tool-use session is left untouched (so its flow record survives
// for `texra resume`) or interrupted on shutdown. See the rationale on
// chatTuiIsResumableIdleOnExit: interrupting clears the resumable state, so an
// idle/WAITING session ("interruptible but not stoppable") must be preserved.

import { describe, expect, it } from 'vitest';

import { chatTuiIsResumableIdleOnExit } from '@cli/chat/tui/state/sessionRunState';

describe('chatTuiIsResumableIdleOnExit', () => {
  it('preserves an idle/WAITING session (interruptible, not stoppable)', () => {
    expect(
      chatTuiIsResumableIdleOnExit({
        canInterruptActiveRun: true,
        canStopActiveRun: false,
      }),
    ).toBe(true);
  });

  it('does not preserve an actively-running turn (interrupt it on exit)', () => {
    expect(
      chatTuiIsResumableIdleOnExit({
        canInterruptActiveRun: true,
        canStopActiveRun: true,
      }),
    ).toBe(false);
  });

  it('does not preserve when there is no pending run at all', () => {
    expect(
      chatTuiIsResumableIdleOnExit({
        canInterruptActiveRun: false,
        canStopActiveRun: false,
      }),
    ).toBe(false);
  });
});
