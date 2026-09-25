// Node imports
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { describe, vi } from 'vitest';

// Local imports
import * as logger from '@logger/logUtils';
import {
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
} from '@shared/schemas';
import {
  ALL_SETTINGS,
  CLI_CONFIG_SLOT_KEYS,
  STATE_SETTINGS,
  settingEnumOptions,
  settingByKey,
  settingsViewSettingByKey,
  settingsViewSnapshotEntries,
} from '@shared/state/stateSettings';
import { dispatchSettingsViewOutbound } from '@shared/settingsView/settingsViewMessages';
import type {
  SettingHost,
  SettingStore,
  StateSettingEntry,
} from '@shared/state/stateSettings';
import type { DerivedSettingsSnapshot } from '@shared/settingsView/settingsViewMessages';
import { buildSettingsSnapshotMessage } from '@shared/settingsView/handlers/settingsSnapshot';
import {
  readSetting,
  resetSetting,
  writeSetting,
} from '@shared/config/settingsAccess';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latexConfig';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  FakeScopedConfigProvider,
  FakeStateStore,
} from '@test/support/FakePlatform';
import { REPO_ROOT } from '@test/support/repoScan';
import { installPlatform } from '@test/support/setupPlatform';
import {
  isStored,
  makeFakeSettingsStores,
} from '@test/support/settingsStoresFake';
import { orchestratorKillDenial } from '@tools/executions/killPolicy';
import { readSettingFrom } from '@utils/config/platformSettings';

const VALID_STORES: ReadonlySet<SettingStore> = new Set<SettingStore>([
  'config',
  'workspaceState',
  'globalState',
]);

const SETTING_HOSTS: readonly SettingHost[] = ['vscode', 'cli', 'desktop'];

function entryByKey(key: string): StateSettingEntry {
  const entry = settingByKey(key);
  assert.ok(entry, `missing catalog entry ${key}`);
  return entry;
}

/** Every canonical `texra.*` key in the state-backed catalog. */
const STATE_SETTING_KEYS: readonly string[] = STATE_SETTINGS.map(
  (entry) => entry.key,
);

describe('state settings catalog', () => {
  it('uses unique canonical keys', () => {
    assert.equal(new Set(STATE_SETTING_KEYS).size, STATE_SETTING_KEYS.length);
  });

  it('every honoring host names an existing reader file', () => {
    for (const entry of ALL_SETTINGS) {
      for (const host of SETTING_HOSTS) {
        const honor = entry.honoredBy[host];
        if (!honor) continue;
        assert.ok(
          existsSync(resolve(REPO_ROOT, honor.reader)),
          `${entry.key} ${host} reader does not exist: ${honor.reader}`,
        );
        assert.ok(
          !honor.reader.startsWith('packages/extension/') || host === 'vscode',
          `${entry.key} ${host} reader lives inside the extension host: ${honor.reader}`,
        );
        assert.ok(
          !honor.reader.startsWith('packages/cli/') || host === 'cli',
          `${entry.key} ${host} reader lives inside the CLI host: ${honor.reader}`,
        );
        assert.ok(
          !honor.reader.startsWith('packages/desktop/') || host === 'desktop',
          `${entry.key} ${host} reader lives inside the desktop host: ${honor.reader}`,
        );
      }
    }
  });

  it('every declared writer names an existing host-compatible file', () => {
    for (const entry of ALL_SETTINGS) {
      for (const host of SETTING_HOSTS) {
        const write = entry.writtenBy?.[host];
        if (!write) continue;
        assert.ok(
          existsSync(resolve(REPO_ROOT, write.writer)),
          `${entry.key} ${host} writer does not exist: ${write.writer}`,
        );
        assert.ok(
          !write.writer.startsWith('packages/extension/') || host === 'vscode',
          `${entry.key} ${host} writer lives inside the extension host: ${write.writer}`,
        );
        assert.ok(
          !write.writer.startsWith('packages/cli/') || host === 'cli',
          `${entry.key} ${host} writer lives inside the CLI host: ${write.writer}`,
        );
        assert.ok(
          !write.writer.startsWith('packages/desktop/') || host === 'desktop',
          `${entry.key} ${host} writer lives inside the desktop host: ${write.writer}`,
        );
      }
    }
  });

  it('gives every honoring host a storage slot', () => {
    for (const entry of ALL_SETTINGS) {
      for (const host of SETTING_HOSTS) {
        if (!entry.honoredBy[host]) continue;
        assert.ok(
          entry.slots[host],
          `${entry.key} is honored by ${host} but has no ${host} slot`,
        );
      }
    }
  });

  it('uses valid, coherent storage slots', () => {
    for (const entry of ALL_SETTINGS) {
      const slots = Object.values(entry.slots);
      assert.ok(slots.length > 0, `${entry.key} declares no storage slot`);
      for (const slot of slots) {
        assert.ok(VALID_STORES.has(slot), `${entry.key} invalid slot ${slot}`);
      }
      // Global and project scope must not be mixed across hosts.
      const globals = slots.filter((slot) => slot === 'globalState').length;
      assert.ok(
        globals === 0 || globals === slots.length,
        `${entry.key} mixes global and project scope across hosts`,
      );
    }
  });

  it('pairs enum entries with aligned display metadata', () => {
    for (const entry of STATE_SETTINGS) {
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
        'multi-agent': true,
        latex: true,
        memory: true,
      } satisfies Record<DerivedSettingsSnapshot, true>;
      for (const snapshot of Object.keys(
        derivedSnapshots,
      ) as DerivedSettingsSnapshot[]) {
        const message = yield* buildSettingsSnapshotMessage(
          snapshot,
          stores,
          'vscode',
        );
        assert.ok(
          Object.keys(message.values).length > 0,
          `${snapshot} carries no rows`,
        );
        assert.deepEqual(
          Object.keys(message.values).sort(),
          settingsViewSnapshotEntries(snapshot)
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
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const { stores, workspaceState } = makeFakeSettingsStores();
        yield* workspaceState.update(
          WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
          false,
        );
        yield* workspaceState.update(
          WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
          'stale-bogus-value',
        );
        yield* workspaceState.update(
          WorkspaceStateKey.LATEX_FORMATTER,
          'tex-fmt',
        );

        try {
          const message = yield* buildSettingsSnapshotMessage(
            'latex',
            stores,
            'desktop',
          );

          assert.equal(message.snapshot, 'latex');
          assert.equal(
            message.values[WorkspaceStateKey.WORKFLOW_AUTO_COMPILE],
            false,
          );
          assert.equal(
            message.values[WorkspaceStateKey.LATEXDIFF_MATH_MARKUP],
            LATEX_CONFIG_DEFAULTS.latexdiffMathMarkup,
          );
          assert.equal(
            message.values[WorkspaceStateKey.LATEX_FORMATTER],
            'tex-fmt',
          );
          assert.equal(warn.mock.calls.length, 1);
        } finally {
          warn.mockRestore();
        }
      }),
  );
});

/**
 * The set the CLI builds from this same export for its unknown-key walk over
 * `.texra/config.json` (`packages/cli/src/runtime/cliConfig.ts`).
 */
const KNOWN_TEXRA_KEYS: ReadonlySet<string> = new Set(CLI_CONFIG_SLOT_KEYS);

describe('knownKeys derivation', () => {
  it('recognizes config-slot CLI keys, but warns on state.json keys in config.json', () => {
    for (const entry of ALL_SETTINGS) {
      if (!entry.honoredBy.cli) continue;
      const readFromConfig = entry.slots.cli === 'config';
      assert.equal(
        KNOWN_TEXRA_KEYS.has(entry.key),
        readFromConfig,
        `${entry.key}: config-recognition should match read-from-config=${readFromConfig}`,
      );
    }
    // A workspaceState-backed setting is read from state.json, not config.json,
    // so it must NOT be whitelisted there (a config.json entry is a no-op the
    // unknown-key warning should catch).
    assert.equal(
      KNOWN_TEXRA_KEYS.has(WorkspaceStateKey.WORKFLOW_AUTO_COMPILE),
      false,
    );
  });

  it('recognizes exactly the config-file keys a CLI reader honors', () => {
    // The derived whitelist replaced two hand-kept path lists; this pins the
    // whole config-file half of it so a mis-filed `honoredBy` cannot silently
    // widen or narrow what `.texra/config.json` accepts.
    const configKeys = ALL_SETTINGS.filter(
      (entry) => entry.slots.cli === 'config',
    ).map((entry) => entry.key);
    assert.deepEqual(
      configKeys.filter((key) => KNOWN_TEXRA_KEYS.has(key)).toSorted(),
      configKeys
        .filter((key) => key !== 'texra.agentReview.runOnCommit')
        .toSorted(),
      'only texra.agentReview.runOnCommit is extension-only',
    );
  });
});

describe('settingsAccess', () => {
  const assertResetRestoresDefault = Effect.fn(function* (options: {
    key: string;
    host: SettingHost;
    storeName: 'config' | 'workspaceState';
    expectedDefault: unknown;
  }) {
    const fake = makeFakeSettingsStores();
    const entry = entryByKey(options.key);
    const store = fake[options.storeName];
    yield* writeSetting(entry, false, fake.stores, options.host);
    assert.equal(yield* isStored(store, entry.key), true);
    yield* resetSetting(entry, fake.stores, options.host);
    assert.equal(yield* isStored(store, entry.key), false);
    assert.equal(
      yield* readSetting(entry, fake.stores, options.host),
      options.expectedDefault,
    );
  });

  it.effect('reads the default when the key is absent', () =>
    Effect.gen(function* () {
      const { stores } = makeFakeSettingsStores();
      const entry = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
      assert.equal(yield* readSetting(entry, stores, 'vscode'), true);
    }),
  );

  it.effect('routes extension writes to the canonical store', () =>
    Effect.gen(function* () {
      const { stores, config, workspaceState } = makeFakeSettingsStores();
      const entry = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
      yield* writeSetting(entry, false, stores, 'vscode');
      assert.equal(yield* isStored(workspaceState, entry.key), true);
      assert.equal(yield* isStored(config, entry.key), false);
      assert.equal(yield* readSetting(entry, stores, 'vscode'), false);
    }),
  );

  it.effect('routes CLI writes to the CLI slot (config)', () =>
    Effect.gen(function* () {
      const { stores, config, workspaceState } = makeFakeSettingsStores();
      const entry = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
      yield* writeSetting(entry, false, stores, 'cli');
      assert.equal(yield* isStored(config, entry.key), true);
      assert.equal(yield* isStored(workspaceState, entry.key), false);
      // The config write used the default 'workspace' target.
      assert.deepEqual(config.inspect(entry.key), {
        globalValue: undefined,
        workspaceValue: false,
      });
      assert.equal(yield* readSetting(entry, stores, 'cli'), false);
    }),
  );

  it.effect('routes telemetry writes to global configuration', () =>
    Effect.gen(function* () {
      const { stores, config } = makeFakeSettingsStores();
      const entry = settingsViewSettingByKey('texra.telemetry.enabled');
      assert.ok(entry);

      yield* writeSetting(entry, false, stores, 'vscode');

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
      yield* writeSetting(entry, 'https://example.invalid/v1', stores, 'cli');
      assert.equal(yield* isStored(globalState, entry.key), true);
      assert.equal(yield* isStored(config, entry.key), false);
      assert.equal(
        yield* readSetting(entry, stores, 'cli'),
        'https://example.invalid/v1',
      );
    }),
  );

  it.effect('rejects values that fail the entry schema', () =>
    Effect.gen(function* () {
      const { stores } = makeFakeSettingsStores();
      const entry = entryByKey(WorkspaceStateKey.LATEX_FORMATTER);
      const exit = yield* Effect.exit(
        writeSetting(entry, 'not-a-formatter', stores, 'vscode'),
      );
      assert.ok(Exit.isFailure(exit));
    }),
  );

  it.effect('reset deletes the key so the default reappears', () =>
    Effect.gen(function* () {
      yield* assertResetRestoresDefault({
        key: WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY,
        host: 'vscode',
        storeName: 'workspaceState',
        expectedDefault: LATEX_CONFIG_DEFAULTS.latexdiffChangesOnly,
      });
    }),
  );

  it.effect('reset deletes a config-slot (ConfigProvider) key too', () =>
    Effect.gen(function* () {
      yield* assertResetRestoresDefault({
        key: WorkspaceStateKey.GIT_MARK_COMMITS,
        host: 'cli',
        storeName: 'config',
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
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
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
            const entry = settingsViewSettingByKey(setting.configKey);
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
                yield* readSetting(entry, stores, 'vscode'),
                expected,
                `${setting.configKey} stored=${String(stored)}`,
              );
            }
          }
        } finally {
          warn.mockRestore();
        }
      }),
  );

  // #12710: the five Models-tab provider toggles declare `configTarget:
  // 'global'`, so `readSetting` resolves them on the global scope alone. The
  // run now reads them through the same catalog reader (`readSettingFrom` in
  // `src/agent/runtime/run/modelBinding.ts`), where it used to read the
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
            config,
            workspaceState: new FakeStateStore(),
            globalState: new FakeStateStore(),
          };
          assert.equal(yield* readSetting(entry, stores, 'vscode'), true, key);
          assert.equal(yield* readSettingFrom<boolean>(stores, key), true, key);
        }
      }),
  );

  it.effect(
    'falls back to the default for a stored value that no longer validates',
    () =>
      Effect.gen(function* () {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const { stores, workspaceState } = makeFakeSettingsStores();
        const entry = entryByKey(WorkspaceStateKey.LATEX_FORMATTER);
        yield* workspaceState.update(entry.key, 'stale-bogus-value');
        try {
          assert.equal(
            yield* readSetting(entry, stores, 'vscode'),
            LATEX_CONFIG_DEFAULTS.latexFormatter,
          );
          assert.equal(warn.mock.calls.length, 1);
          assert.equal(warn.mock.calls[0]?.[0], 'settingsAccess');
          assert.ok(
            String(warn.mock.calls[0]?.[1]).startsWith(
              `Ignoring invalid persisted value for setting "${entry.key}"`,
            ),
          );
        } finally {
          warn.mockRestore();
        }
      }),
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
