// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';

// Local imports
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { orchestratorKillDenial } from '@tools/executions/killPolicy';
import { ALLOW_ORCHESTRATOR_KILL_SETTING } from '@texra-ai/harness/schemas';

describe('Settings', () => {
  // #11797: the kill gate's permissive default answers only for an absent
  // key; a stored value that fails the schema denies, loudly.
  it.effect('denies orchestrator kills on an invalid stored policy', () =>
    Effect.gen(function* () {
      const { stores, globalState } = makeFakeSettingsStores();
      assert.equal(yield* orchestratorKillDenial(stores), undefined);
      yield* globalState.update(ALLOW_ORCHESTRATOR_KILL_SETTING.key, 'false');
      const denial = yield* orchestratorKillDenial(stores);
      assert.match(String(denial), /denied: .* is invalid/);
    }),
  );
});
