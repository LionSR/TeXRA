// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';

// Local imports
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import {
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
} from '@shared/schemas';
import { settingEnumOptions, settingByKey } from '@shared/state/stateSettings';
import type {
  SettingHost,
  StateSettingEntry,
} from '@shared/state/stateSettings';
import {
  readSetting,
  resetSetting,
  writeSetting,
} from '@shared/config/settingsAccess';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  FakeScopedConfigProvider,
  FakeStateStore,
} from '@test/support/FakePlatform';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { installPlatform } from '@test/support/setupPlatform';
import {
  isStored,
  makeFakeSettingsStores,
} from '@test/support/settingsStoresFake';
import {
  TEXRA_SETTINGS,
  TexraStateKey,
} from '@texra/shared/settingsView/texraSettings';
import { LATEX_CONFIG_DEFAULTS } from '@texra/shared/constants/latexConfig';
import { buildSettingsSnapshotMessage } from '@texra/shared/settingsView/handlers/settingsSnapshot';
import type { DerivedSettingsSnapshot } from '@texra/shared/settingsView/settingsViewMessages';
import { dispatchSettingsViewOutbound } from '@texra/shared/settingsView/settingsViewMessages';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
import { orchestratorKillDenial } from '@tools/executions/killPolicy';
import { readSettingFrom } from '@utils/config/platformSettings';

function entryByKey(key: string): StateSettingEntry {
  const entry = settingByKey(key);
  assert.ok(entry, `missing catalog entry ${key}`);
  return entry;
}

describe('state settings catalog', () => {
  it('pairs enum entries with aligned display metadata', () => {
    const stateRows = TEXRA_SETTINGS.rows.filter(
      (entry) => entry.slot !== 'config',
    );
    for (const entry of stateRows) {
      const options = settingEnumOptions(entry);
      if (!options) {
        assert.equal(
          entry.enumDescriptions,
          undefined,
          `${entry.key} has enumDescriptions without an enum schema`,
        );
        assert.equal(
          entry.enumLabels,
          undefined,
          `${entry.key} has enumLabels without an enum schema`,
        );
        continue;
      }
      assert.ok(
        entry.enumDescriptions || entry.enumLabels,
        `${entry.key} enum entry is missing display metadata`,
      );
      if (entry.enumDescriptions) {
        assert.equal(entry.enumDescriptions.length, options.length, entry.key);
      }
      if (entry.enumLabels) {
        assert.equal(entry.enumLabels.length, options.length, entry.key);
      }
    }
  });
});

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

  it.effect(
    'builds the LaTeX message from validated catalog values and defaults',
    () =>
      Effect.gen(function* () {
        const logs = captureLogEntries();
        const { stores, workspaceState } = makeFakeSettingsStores();
        yield* workspaceState.update(
          DocumentsStateKey.WORKFLOW_AUTO_COMPILE,
          false,
        );
        yield* workspaceState.update(
          DocumentsStateKey.LATEXDIFF_MATH_MARKUP,
          'stale-bogus-value',
        );
        yield* workspaceState.update(TexraStateKey.LATEX_FORMATTER, 'tex-fmt');

        try {
          const message = yield* buildSettingsSnapshotMessage('latex', {
            ...stores,
            host: 'desktop',
          });

          assert.equal(message.snapshot, 'latex');
          assert.equal(
            message.values[DocumentsStateKey.WORKFLOW_AUTO_COMPILE],
            false,
          );
          assert.equal(
            message.values[DocumentsStateKey.LATEXDIFF_MATH_MARKUP],
            LATEX_CONFIG_DEFAULTS.latexdiffMathMarkup,
          );
          assert.equal(
            message.values[TexraStateKey.LATEX_FORMATTER],
            'tex-fmt',
          );
          assert.equal(logs.at('WARN', 'settingsAccess').length, 1);
        } finally {
          setLogSink(null);
        }
      }).pipe(Effect.provide(effectDiagnosticsLayer('Trace'))),
  );
});

/**
 * The set the CLI builds from this same export for its unknown-key walk over
 * `.texra/config.json` (`packages/cli/src/runtime/cliConfig.ts`).
 */
const KNOWN_TEXRA_KEYS: ReadonlySet<string> = new Set(
  TEXRA_SETTINGS.configSlotKeys,
);

describe('knownKeys derivation', () => {
  it('whitelists config-slot keys, not state.json keys', () => {
    assert.equal(KNOWN_TEXRA_KEYS.has('texra.model'), true);
    // A workspaceState-backed setting is read from state.json, not config.json,
    // so it must NOT be whitelisted there (a config.json entry is a no-op the
    // unknown-key warning should catch).
    assert.equal(
      KNOWN_TEXRA_KEYS.has(DocumentsStateKey.WORKFLOW_AUTO_COMPILE),
      false,
    );
  });
});

describe('settingsAccess', () => {
  const assertResetRestoresDefault = Effect.fn(function* (options: {
    key: string;
    host: SettingHost;
    storeName: 'config' | 'workspaceState' | 'repoState';
    expectedDefault: unknown;
  }) {
    const fake = makeFakeSettingsStores();
    const entry = entryByKey(options.key);
    const store = fake[options.storeName];
    yield* writeSetting(entry, false, { ...fake.stores, host: options.host });
    assert.equal(yield* isStored(store, entry.key), true);
    yield* resetSetting(entry, { ...fake.stores, host: options.host });
    assert.equal(yield* isStored(store, entry.key), false);
    assert.equal(
      yield* readSetting(entry, { ...fake.stores, host: options.host }),
      options.expectedDefault,
    );
  });

  it.effect('routes extension writes to the canonical store', () =>
    Effect.gen(function* () {
      const { stores, config, repoState } = makeFakeSettingsStores();
      const entry = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
      yield* writeSetting(entry, false, stores);
      assert.equal(yield* isStored(repoState, entry.key), true);
      assert.equal(yield* isStored(config, entry.key), false);
      assert.equal(yield* readSetting(entry, stores), false);
    }),
  );

  it.effect('preferring a subscription route turns OpenRouter off', () =>
    Effect.gen(function* () {
      const { stores, globalState } = makeFakeSettingsStores();
      yield* globalState.update(GlobalStateKey.USE_OPENROUTER, true);
      yield* writeSetting(
        entryByKey('texra.xaiGrok.preferSubscription'),
        true,
        stores,
      );
      assert.equal(
        yield* globalState.get(GlobalStateKey.USE_OPENROUTER),
        false,
      );
    }),
  );

  it.effect('routes telemetry writes to global configuration', () =>
    Effect.gen(function* () {
      const { stores, config } = makeFakeSettingsStores();
      const entry = TEXRA_SETTINGS.settingsViewByKey('texra.telemetry.enabled');
      assert.ok(entry);

      yield* writeSetting(entry, false, stores);

      assert.deepEqual(config.inspect(entry.key), {
        globalValue: false,
        workspaceValue: undefined,
      });
    }),
  );

  it.effect('routes CLI endpoint writes to global state', () =>
    Effect.gen(function* () {
      const { stores, config, globalState } = makeFakeSettingsStores();
      const entry = entryByKey(GlobalStateKey.ENDPOINT_GOOGLE);
      yield* writeSetting(entry, 'https://example.invalid/v1', {
        ...stores,
        host: 'cli',
      });
      assert.equal(yield* isStored(globalState, entry.key), true);
      assert.equal(yield* isStored(config, entry.key), false);
      assert.equal(
        yield* readSetting(entry, { ...stores, host: 'cli' }),
        'https://example.invalid/v1',
      );
    }),
  );

  it.effect('reset deletes the key so the default reappears', () =>
    Effect.gen(function* () {
      yield* assertResetRestoresDefault({
        key: DocumentsStateKey.LATEXDIFF_CHANGES_ONLY,
        host: 'vscode',
        storeName: 'workspaceState',
        expectedDefault: LATEX_CONFIG_DEFAULTS.latexdiffChangesOnly,
      });
    }),
  );

  it.effect('reset deletes a repository-slot key too', () =>
    Effect.gen(function* () {
      yield* assertResetRestoresDefault({
        key: WorkspaceStateKey.GIT_MARK_COMMITS,
        host: 'cli',
        storeName: 'repoState',
        expectedDefault: true,
      });
    }),
  );

  // Restored from the deleted `SettingsProfileController` suite, whose
  // "does not mask a compaction value that runtime still reads directly" case
  // turned out not to be obsolete: the settings row must never display a
  // number the runtime is not actually using. Row and runtime now share one
  // reader (`readSetting`), so what is left to pin is the resolution it must
  // keep: the *merged* config scope, validated against the row's own schema.
  // A `configTarget: 'global'` on either row breaks the workspace-override
  // case; dropping the row's bounds breaks the out-of-range case.
  it.effect(
    'resolves reliability rows on the merged scope, bounded by their schema',
    () =>
      Effect.gen(function* () {
        captureLogEntries();
        const reliabilityRows = [
          {
            setting: MODEL_COMPACTION_THRESHOLD_SETTING,
            inRange: 40,
            outOfRange: 101,
          },
          {
            setting: MODEL_RETRY_MAX_ATTEMPTS_SETTING,
            inRange: 4,
            outOfRange: 6,
          },
        ];
        try {
          for (const { setting, inRange, outOfRange } of reliabilityRows) {
            const entry = TEXRA_SETTINGS.settingsViewByKey(setting.configKey);
            assert.ok(entry, `missing settings-view row ${setting.configKey}`);
            assert.equal(
              entry.configTarget,
              undefined,
              `${setting.configKey} must not narrow itself to one config scope`,
            );
            const cases = [
              [undefined, setting.defaultValue],
              [inRange, inRange],
              [outOfRange, setting.defaultValue],
            ] as const;
            for (const [stored, expected] of cases) {
              const { stores, config } = makeFakeSettingsStores();
              if (stored !== undefined) config.set(setting.configKey, stored);
              yield* Effect.promise(() => installPlatform({}, { config }));
              assert.equal(
                yield* readSetting(entry, stores),
                expected,
                `${setting.configKey} stored=${String(stored)}`,
              );
            }
          }
        } finally {
          setLogSink(null);
        }
      }).pipe(Effect.provide(effectDiagnosticsLayer('Trace'))),
  );

  // #12710: the five Models-tab provider toggles declare `configTarget:
  // 'global'`, so `readSetting` resolves them on the global scope alone. The
  // run now reads them through the same catalog reader (`readSettingFrom` in
  // `packages/harness/src/agent/runtime/run/modelBinding.ts`), where it used to read the
  // merged config and could therefore honor a workspace override the tab had
  // no way to show. One scope, one answer, both sides.
  it.effect(
    'resolves the Models-tab provider toggles on the global scope alone',
    () =>
      Effect.gen(function* () {
        const rows = [
          'texra.model.gpt5ReasoningSummary',
          'texra.model.useGoogleInteractionsServerState',
          'texra.model.useGoogleBackgroundResponses',
          'texra.model.useBackgroundResponses',
          'texra.model.openaiParallelToolCalls',
        ];
        for (const key of rows) {
          const entry = settingByKey(key);
          assert.ok(entry, `missing catalog entry ${key}`);
          assert.equal(entry.configTarget, 'global', `${key} configTarget`);
          const config = new FakeScopedConfigProvider();
          config.seedGlobal(key, true);
          config.seedWorkspace(key, false);
          const stores = {
            host: 'vscode' as const,
            config,
            workspaceState: new FakeStateStore(),
            repoState: new FakeStateStore(),
            globalState: new FakeStateStore(),
          };
          assert.equal(yield* readSetting(entry, stores), true, key);
          assert.equal(yield* readSettingFrom<boolean>(stores, key), true, key);
        }
      }),
  );

  it.effect(
    'falls back to the default for a stored value that no longer validates',
    () =>
      Effect.gen(function* () {
        const logs = captureLogEntries();
        const { stores, workspaceState } = makeFakeSettingsStores();
        const entry = entryByKey(TexraStateKey.LATEX_FORMATTER);
        yield* workspaceState.update(entry.key, 'stale-bogus-value');
        try {
          assert.equal(
            yield* readSetting(entry, stores),
            LATEX_CONFIG_DEFAULTS.latexFormatter,
          );
          const warnings = logs.at('WARN', 'settingsAccess');
          assert.equal(warnings.length, 1);
          assert.ok(
            String(warnings[0]?.message).startsWith(
              `Ignoring invalid persisted value for setting "${entry.key}"`,
            ),
          );
        } finally {
          setLogSink(null);
        }
      }).pipe(Effect.provide(effectDiagnosticsLayer('Trace'))),
  );

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
