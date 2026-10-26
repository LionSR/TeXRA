import { describe, expect, it } from 'vitest';

import { cliRunStanding } from '@cli/runtime/toolUseResumeData';
import type { RunOutcome } from '@shared/schemas';

describe('CLI history status formatting', () => {
  /** The frozen status mapping alone. */
  const statusOf = (resumable: boolean, phase?: RunOutcome): string =>
    cliRunStanding({ resumable, phase }).status;

  it('keeps failed terminal outcomes in the frozen status even when resumable', () => {
    expect(statusOf(false, 'failed')).toBe('failed');
    // The NDJSON `status` field is frozen; a failed run that can continue is
    // offered through the sibling `resumable` boolean instead.
    expect(statusOf(true, 'failed')).toBe('failed');
  });
});
