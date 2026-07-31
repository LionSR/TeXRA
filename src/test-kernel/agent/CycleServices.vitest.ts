// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { buildFailedCycleOutcome } from '@agent/core/flows/CycleServices';

describe('cycle failure outcomes', () => {
  it('keeps the normalized error as the single failure description', () => {
    const outcome = buildFailedCycleOutcome(new Error('cycle failed'));

    expect(outcome).toEqual({
      failureLogEmitted: false,
      lastError: expect.objectContaining({ message: 'cycle failed' }),
    });
  });
});
