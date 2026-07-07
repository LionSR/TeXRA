import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import { capWebFetchContent } from '@agent/modelHandlers/types/ServerToolTypes';

describe('capWebFetchContent', () => {
  it('includes the ellipsis in the advertised maximum length', () => {
    const capped = capWebFetchContent('x'.repeat(20_001));

    assert.equal(capped?.length, 20_000);
    assert.equal(capped?.endsWith('...'), true);
    assert.equal(capped, `${'x'.repeat(19_997)}...`);
  });
});
