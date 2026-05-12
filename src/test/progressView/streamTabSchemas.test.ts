// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { selectPreferredLegacyInstruction } from '@progressView/persistence/streamTabSchemas';

describe('selectPreferredLegacyInstruction', () => {
  it('prefers the explicitly selected legacy run when available', () => {
    const result = selectPreferredLegacyInstruction(
      {
        older: { text: 'older instruction', timestamp: 100 },
        active: { text: 'active instruction', timestamp: 50 },
      },
      'active',
    );

    assert.equal(result?.text, 'active instruction');
  });

  it('falls back to the newest timestamp when no preferred run exists', () => {
    const result = selectPreferredLegacyInstruction({
      first: { text: 'first instruction', timestamp: 100 },
      latest: { text: 'latest instruction', timestamp: 200 },
    });

    assert.equal(result?.text, 'latest instruction');
  });

  it('falls back to later insertion order when timestamps are absent', () => {
    const result = selectPreferredLegacyInstruction({
      first: { text: 'first instruction' },
      second: { text: 'second instruction' },
    });

    assert.equal(result?.text, 'second instruction');
  });

  it('returns null when no legacy instructions exist', () => {
    const result = selectPreferredLegacyInstruction({});

    assert.equal(result, null);
  });
});
