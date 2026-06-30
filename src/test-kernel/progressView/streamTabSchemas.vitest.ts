// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Local imports
import {
  selectPreferredLegacyInstruction,
  type LegacyInstructionEntry,
} from '@shared/schemas';

type LegacyInstructionCase = {
  title: string;
  record: Record<string, LegacyInstructionEntry>;
  preferredRunId?: string;
  expected: string;
};

describe('selectPreferredLegacyInstruction', () => {
  it.each<LegacyInstructionCase>([
    {
      title: 'prefers the explicitly selected legacy run when available',
      record: {
        older: { text: 'older instruction', timestamp: 100 },
        active: { text: 'active instruction', timestamp: 50 },
      },
      preferredRunId: 'active',
      expected: 'active instruction',
    },
    {
      title: 'falls back to the newest timestamp when no preferred run exists',
      record: {
        first: { text: 'first instruction', timestamp: 100 },
        latest: { text: 'latest instruction', timestamp: 200 },
      },
      preferredRunId: undefined,
      expected: 'latest instruction',
    },
    {
      title: 'falls back to later insertion order when timestamps are absent',
      record: {
        first: { text: 'first instruction' },
        second: { text: 'second instruction' },
      },
      preferredRunId: undefined,
      expected: 'second instruction',
    },
  ])('$title', ({ record, preferredRunId, expected }) => {
    assert.equal(
      selectPreferredLegacyInstruction(record, preferredRunId)?.text,
      expected,
    );
  });

  it('returns null when no legacy instructions exist', () => {
    assert.equal(selectPreferredLegacyInstruction({}), null);
  });
});
