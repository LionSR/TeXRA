// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { RUN_OUTCOME } from '@shared/schemas';
import { deriveRunOutcome } from '@shared/runs/runStatus';

describe('run outcome algebra', () => {
  it.each([
    {
      flags: { failed: false, cancelled: false },
      expected: RUN_OUTCOME.COMPLETED,
    },
    {
      flags: { failed: false, cancelled: true },
      expected: RUN_OUTCOME.CANCELLED,
    },
    { flags: { failed: true, cancelled: false }, expected: RUN_OUTCOME.FAILED },
    // Failure wins over a concurrent interrupt — a run that failed and was
    // then stopped is still a failure.
    { flags: { failed: true, cancelled: true }, expected: RUN_OUTCOME.FAILED },
  ])(
    'derives outcomes with failed > cancelled > completed priority ($flags)',
    ({ flags, expected }) => {
      expect(deriveRunOutcome(flags)).toBe(expected);
    },
  );
});
