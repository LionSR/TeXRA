// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports - shared
import { formatAgentOptionLabel } from '@shared/utils/selectTemplates';

describe('select template labels', () => {
  it('trims agent picker labels before description separators', () => {
    assert.equal(
      formatAgentOptionLabel('Engineer \u2014 software team lead'),
      'Engineer',
    );
    assert.equal(
      formatAgentOptionLabel('Research --- derivations & numerics'),
      'Research',
    );
    assert.equal(formatAgentOptionLabel('changeReviewer'), 'changeReviewer');
  });
});
