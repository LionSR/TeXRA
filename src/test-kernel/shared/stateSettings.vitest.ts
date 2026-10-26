// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';

// Local imports
import { GlobalStateKey } from '@shared/state/stateKeys';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import { buildSettingsSnapshotMessage } from '@texra/shared/settingsView/handlers/settingsSnapshot';
import type { DerivedSettingsSnapshot } from '@texra/shared/settingsView/settingsViewMessages';
import { dispatchSettingsViewOutbound } from '@texra/shared/settingsView/settingsViewMessages';
import { orchestratorKillDenial } from '@tools/executions/killPolicy';

describe('catalog-derived settings snapshots', () => {
  // The durable boundary this PR creates: a snapshot's outbound payload, its
  // backend read, and the row list are the same thing. Adding a row to a
  // snapshot must reach the wire without another edit, and the arm's
  // `strictObject` must accept exactly what the builder produces.
  it.effect("puts exactly the snapshot's catalog rows on the wire", () =>
    Effect.gen(function* () {
      const { stores } = makeFakeSettingsStores();

      const derivedSnapshots = {
        approval: true,
        'git-author': true,
        skills: true,
        telemetry: true,
        agents: true,
        latex: true,
        memory: true,
      } satisfies Record<DerivedSettingsSnapshot, true>;
      for (const snapshot of Object.keys(
        derivedSnapshots,
      ) as DerivedSettingsSnapshot[]) {
        const message = yield* buildSettingsSnapshotMessage(snapshot, stores);
        assert.ok(
          Object.keys(message.values).length > 0,
          `${snapshot} carries no rows`,
        );
        assert.deepEqual(
          Object.keys(message.values).sort(),
          TEXRA_SETTINGS.snapshotEntries(snapshot)
            .map((entry) => entry.key)
            .sort(),
          `${snapshot} payload keys`,
        );
        assert.equal(
          dispatchSettingsViewOutbound(message, {
            [message.command]: () => {},
          } as never),
          true,
          `${snapshot} arm rejected its own builder output`,
        );

        for (const omittedKey of Object.keys(message.values)) {
          const partialValues = Object.fromEntries(
            Object.entries(message.values).filter(
              ([key]) => key !== omittedKey,
            ),
          );
          assert.equal(
            dispatchSettingsViewOutbound(
              { ...message, values: partialValues },
              {
                [message.command]: () => {},
              } as never,
            ),
            false,
            `${snapshot} arm accepted missing key ${omittedKey}`,
          );
        }
      }
    }),
  );
});

describe('Settings', () => {
  // #11797: the kill gate's permissive default answers only for an absent
  // key; a stored value that fails the schema denies, loudly.
  it.effect('denies orchestrator kills on an invalid stored policy', () =>
    Effect.gen(function* () {
      const { stores, globalState } = makeFakeSettingsStores();
      assert.equal(yield* orchestratorKillDenial(stores), undefined);
      yield* globalState.update(
        GlobalStateKey.ALLOW_ORCHESTRATOR_KILL,
        'false',
      );
      const denial = yield* orchestratorKillDenial(stores);
      assert.match(String(denial), /denied: .* is invalid/);
    }),
  );
});
