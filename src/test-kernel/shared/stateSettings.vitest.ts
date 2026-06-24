// Standard library imports
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - catalog + accessor
import { KNOWN_TEXRA_KEYS } from '@cli/schemas/knownKeys';
import { CORE_SETTING_PATHS } from '@shared/schemas/coreSettings';
import {
  STATE_SETTINGS,
  STATE_SETTING_KEYS,
  settingEnumOptions,
  type SettingStore,
  type StateSettingEntry,
} from '@shared/schemas/stateSettings';
import {
  readSetting,
  resetSetting,
  settingDefault,
  writeSetting,
} from '@shared/config/settingsAccess';

// Local imports - canonical defaults + keys the catalog must agree with
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_MARK_COMMITS,
  DEFAULT_GIT_WORKTREE_SUPPORT,
} from '@shared/constants/git';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latex';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// Local imports - shared store fakes
import {
  isStored,
  makeFakeSettingsStores,
} from '@test/support/settingsStoresFake';

const VALID_STORES: ReadonlySet<SettingStore> = new Set<SettingStore>([
  'config',
  'workspaceState',
  'globalState',
]);

const CLASS_D_KEY_PATTERN = /migrated|version|onboarding|history|cache/i;

/** Expected default-when-absent for each catalog key, from the real getters. */
const EXPECTED_DEFAULTS: Record<string, unknown> = {
  [WorkspaceStateKey.GIT_MARK_COMMITS]: DEFAULT_GIT_MARK_COMMITS,
  [WorkspaceStateKey.GIT_AUTHOR_NAME]: DEFAULT_GIT_AUTHOR_NAME,
  [WorkspaceStateKey.GIT_AUTHOR_EMAIL]: DEFAULT_GIT_AUTHOR_EMAIL,
  [WorkspaceStateKey.GIT_WORKTREE_SUPPORT]: DEFAULT_GIT_WORKTREE_SUPPORT,
  [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE]:
    LATEX_CONFIG_DEFAULTS.workflowAutoCompile,
  [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS]:
    LATEX_CONFIG_DEFAULTS.workflowAutoCompileTimeoutMs,
  [WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF]:
    LATEX_CONFIG_DEFAULTS.workflowAutoOpenPdf,
  [WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE]:
    LATEX_CONFIG_DEFAULTS.workflowRejectOnCompileFailure,
  [WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS]:
    LATEX_CONFIG_DEFAULTS.latexdiffBetweenRounds,
  [WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS]:
    LATEX_CONFIG_DEFAULTS.latexdiffTimeoutMs,
  [WorkspaceStateKey.LATEXDIFF_MATH_MARKUP]:
    LATEX_CONFIG_DEFAULTS.latexdiffMathMarkup,
  [WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY]:
    LATEX_CONFIG_DEFAULTS.latexdiffChangesOnly,
  [WorkspaceStateKey.LATEX_FORMATTER]: LATEX_CONFIG_DEFAULTS.latexFormatter,
};

describe('state settings catalog', () => {
  it('uses unique canonical keys', () => {
    assert.equal(new Set(STATE_SETTING_KEYS).size, STATE_SETTING_KEYS.length);
  });

  it('every CLI-host entry names an existing consumer file', () => {
    for (const entry of STATE_SETTINGS) {
      if (!entry.hosts.includes('cli')) {
        continue;
      }
      assert.ok(
        entry.cliConsumer,
        `${entry.key} is surfaced to the CLI but declares no cliConsumer`,
      );
      assert.ok(
        existsSync(resolve(process.cwd(), entry.cliConsumer as string)),
        `${entry.key} cliConsumer does not exist: ${entry.cliConsumer}`,
      );
    }
  });

  it('uses valid, coherent storage slots', () => {
    for (const entry of STATE_SETTINGS) {
      assert.ok(VALID_STORES.has(entry.store), `${entry.key} invalid store`);
      if (entry.cliStore !== undefined) {
        assert.ok(
          VALID_STORES.has(entry.cliStore),
          `${entry.key} invalid cliStore`,
        );
        // A cliStore override only makes sense when the CLI consumes the entry.
        assert.ok(
          entry.hosts.includes('cli'),
          `${entry.key} declares cliStore but no 'cli' host`,
        );
        // Global and project scope must not be mixed between the two slots.
        const storeIsGlobal = entry.store === 'globalState';
        const cliStoreIsGlobal = entry.cliStore === 'globalState';
        assert.equal(
          storeIsGlobal,
          cliStoreIsGlobal,
          `${entry.key} mixes global and project scope across store/cliStore`,
        );
      }
    }
  });

  it('excludes Class-D internal state keys', () => {
    for (const key of STATE_SETTING_KEYS) {
      assert.ok(
        !CLASS_D_KEY_PATTERN.test(key),
        `${key} looks like internal (Class-D) state and must not be a setting`,
      );
    }
  });

  it('pairs enum entries with one description per schema option', () => {
    for (const entry of STATE_SETTINGS) {
      const options = settingEnumOptions(entry);
      if (!options) {
        assert.equal(
          entry.enumDescriptions,
          undefined,
          `${entry.key} has enumDescriptions without an enum schema`,
        );
        continue;
      }
      assert.ok(
        entry.enumDescriptions,
        `${entry.key} enum entry is missing enumDescriptions`,
      );
      assert.equal(entry.enumDescriptions?.length, options.length, entry.key);
    }
  });

  it('shares no keys with the config-tree catalog', () => {
    // The two catalogs must stay disjoint: a state-backed key must never reach
    // the package.json generator via CoreSettingsShape, and a config key must
    // never be double-registered through the catalog.
    const coreKeys = new Set(CORE_SETTING_PATHS.map((path) => `texra.${path}`));
    for (const key of STATE_SETTING_KEYS) {
      assert.ok(
        !coreKeys.has(key),
        `${key} is in both CoreSettingsShape and STATE_SETTINGS`,
      );
    }
  });

  it('round-trips each `.prefault()` default to the real getter default', () => {
    for (const entry of STATE_SETTINGS) {
      assert.ok(
        Object.hasOwn(EXPECTED_DEFAULTS, entry.key),
        `${entry.key} has no expected default declared in the test`,
      );
      assert.deepEqual(
        settingDefault(entry),
        EXPECTED_DEFAULTS[entry.key],
        entry.key,
      );
    }
  });
});

describe('knownKeys derivation', () => {
  it('recognizes every catalog key (no unknown-key warnings)', () => {
    for (const key of STATE_SETTING_KEYS) {
      assert.ok(
        KNOWN_TEXRA_KEYS.has(key),
        `${key} missing from KNOWN_TEXRA_KEYS`,
      );
    }
  });
});

// --- accessor round-trip ----------------------------------------------------

function entryByKey(key: string): StateSettingEntry {
  const entry = STATE_SETTINGS.find((e) => e.key === key);
  assert.ok(entry, `missing catalog entry ${key}`);
  return entry as StateSettingEntry;
}

describe('settingsAccess', () => {
  it('reads the default when the key is absent', () => {
    const { stores } = makeFakeSettingsStores();
    const entry = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    assert.equal(
      readSetting(entry, stores, 'extension'),
      DEFAULT_GIT_MARK_COMMITS,
    );
  });

  it('routes extension writes to the canonical store', async () => {
    const { stores, config, workspaceState } = makeFakeSettingsStores();
    const entry = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    await writeSetting(entry, false, stores, 'extension');
    assert.equal(isStored(workspaceState, entry.key), true);
    assert.equal(isStored(config, entry.key), false);
    assert.equal(readSetting(entry, stores, 'extension'), false);
  });

  it('routes CLI writes to the cliStore override (config)', async () => {
    const { stores, config, workspaceState } = makeFakeSettingsStores();
    const entry = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    await writeSetting(entry, false, stores, 'cli');
    assert.equal(isStored(config, entry.key), true);
    assert.equal(isStored(workspaceState, entry.key), false);
    // The config write used the default 'workspace' target.
    assert.deepEqual(config.inspect(entry.key), {
      globalValue: undefined,
      workspaceValue: false,
      effectiveValue: false,
    });
    assert.equal(readSetting(entry, stores, 'cli'), false);
  });

  it('rejects values that fail the entry schema', async () => {
    const { stores } = makeFakeSettingsStores();
    const entry = entryByKey(WorkspaceStateKey.LATEX_FORMATTER);
    await assert.rejects(() =>
      writeSetting(entry, 'not-a-formatter', stores, 'extension'),
    );
  });

  it('reset deletes the key so the default reappears', async () => {
    const { stores, workspaceState } = makeFakeSettingsStores();
    const entry = entryByKey(WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY);
    await writeSetting(entry, false, stores, 'extension');
    assert.equal(isStored(workspaceState, entry.key), true);
    await resetSetting(entry, stores, 'extension');
    assert.equal(isStored(workspaceState, entry.key), false);
    assert.equal(
      readSetting(entry, stores, 'extension'),
      LATEX_CONFIG_DEFAULTS.latexdiffChangesOnly,
    );
  });

  it('falls back to the default for a stored value that no longer validates', () => {
    const { stores, workspaceState } = makeFakeSettingsStores();
    const entry = entryByKey(WorkspaceStateKey.LATEX_FORMATTER);
    void workspaceState.update(entry.key, 'stale-bogus-value');
    assert.equal(
      readSetting(entry, stores, 'extension'),
      LATEX_CONFIG_DEFAULTS.latexFormatter,
    );
  });
});
