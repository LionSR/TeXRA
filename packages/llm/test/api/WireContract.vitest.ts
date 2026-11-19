/**
 * The live matrix, replayed: every case a live run recorded under
 * `LLM_RECORD=1` (`test-live/cassettes/`) runs again here against a local
 * server answering from its cassette, with no key and no network. A codec
 * change that no longer reads what the provider actually sent fails here
 * before it reaches the live tier. A route or case with no cassette adds
 * nothing; recording one is how it joins.
 */

// Third-party imports
import { it } from '@effect/vitest';
import { describe } from 'vitest';

// Local imports - the live tier
import { recordedCases, replayCase } from '../../test-live/support.js';
import { ROUTES } from '../../test-live/routes.js';

describe('the recorded wire contract', () => {
  for (const { name, wireCase, cassette } of recordedCases())
    it.live(
      `${ROUTES[name].protocol}: ${wireCase.describe} ${wireCase.it}`,
      () => replayCase(name, wireCase, cassette),
    );
});
