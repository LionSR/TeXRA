// Node imports
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it, vi } from 'vitest';

// Local imports
import { KNOWN_TEXRA_KEYS } from '@cli/schemas/knownKeys';
import * as logger from '@logger/logUtils';
import { TEXRA_APPROVAL_POLICY_CONFIG_KEY } from '@shared/approvalPolicy';
import {
  ALL_SETTINGS,
  AGENT_SKILLS_CONFIG_KEY,
  CLI_STATE_SETTINGS,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_TOOL_PATH_PROTECTION_ENABLED,
  STATE_SETTINGS,
  settingByKey,
  settingEnumChoices,
  settingEnumOptions,
  modelsTabSettings,
  settingsViewSettingByKey,
  settingsViewSnapshotEntries,
  dispatchSettingsViewOutbound,
  stateSettingByKey,
  REASONING_LEVEL_OPTIONS,
  CLAUDE_AGENT_DEFAULT_EFFORT,
  CLAUDE_AGENT_DEFAULT_MODEL,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ModelCompactionThresholdPercentSchema,
  ModelRetryMaxAttemptsSchema,
} from '@shared/schemas';
import type {
  DerivedSettingsSnapshot,
  SettingHost,
  SettingStore,
  StateSettingEntry,
} from '@shared/schemas';
import { buildSettingsSnapshotMessage } from '@shared/settingsView/handlers/settingsSnapshot';
import {
  DEFAULT_HELPER_MODEL,
  PROVIDER_ENDPOINT_STATE_ENTRIES,
  PROVIDER_STATE_ENTRIES,
} from '@shared/constants/providers';
import {
  readSetting,
  resetSetting,
  settingDefault,
  writeSetting,
} from '@shared/config/settingsAccess';
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_CONFIG_FIELD_TO_KEY,
} from '@shared/constants/latexConfig';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { REPO_ROOT } from '@test/support/repoScan';
import { installPlatform } from '@test/support/setupPlatform';
import {
  isStored,
  makeFakeSettingsStores,
} from '@test/support/settingsStoresFake';
import { getValidatedConfig } from '@utils/config/configUtils';

const VALID_STORES: ReadonlySet<SettingStore> = new Set<SettingStore>([
  'config',
  'workspaceState',
  'globalState',
]);

const SETTING_HOSTS: readonly SettingHost[] = ['vscode', 'cli', 'desktop'];

const CLI_RUNTIME_COMMAND_PATTERN =
  /^texra\s+(?:chat|run|agents run|multi-agent run|orchestrate)\b/;

function entryByKey(key: string): StateSettingEntry {
  const entry = stateSettingByKey(key);
  assert.ok(entry, `missing catalog entry ${key}`);
  return entry;
}

const CLASS_D_KEY_PATTERN = /migrated|version|onboarding|history|cache/i;
const PROVIDER_ENDPOINT_DEFAULTS = Object.fromEntries(
  PROVIDER_ENDPOINT_STATE_ENTRIES.map(({ endpointKey }) => [endpointKey, '']),
);
// Per-provider streaming defaults mirror the global streaming default (true):
// `getProviderStreaming` falls back to the global toggle when a key is unset.
const PROVIDER_STREAMING_DEFAULTS = Object.fromEntries(
  PROVIDER_STATE_ENTRIES.flatMap(({ streamingKey }) =>
    streamingKey ? [[streamingKey, true]] : [],
  ),
);

/** Expected default-when-absent for each catalog key, from the real getters. */
const EXPECTED_DEFAULTS: Record<string, unknown> = {
  [WorkspaceStateKey.GIT_MARK_COMMITS]: true,
  [WorkspaceStateKey.GIT_AUTHOR_NAME]: DEFAULT_GIT_AUTHOR_NAME,
  [WorkspaceStateKey.GIT_AUTHOR_EMAIL]: DEFAULT_GIT_AUTHOR_EMAIL,
  [WorkspaceStateKey.GIT_WORKTREE_SUPPORT]: false,
  [GlobalStateKey.ALLOW_ORCHESTRATOR_KILL]: true,
  [GlobalStateKey.DETACH_SUBAGENTS_ON_STOP]: false,
  [GlobalStateKey.MEMORY_ENABLED]: true,
  [WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED]:
    DEFAULT_TOOL_PATH_PROTECTION_ENABLED,
  [WorkspaceStateKey.CODEX_SANDBOX_MODE]: CODEX_SANDBOX_MODE_DEFAULT,
  [WorkspaceStateKey.CODEX_REASONING_EFFORT]: CODEX_REASONING_EFFORT_DEFAULT,
  [WorkspaceStateKey.CODEX_APPROVAL_POLICY]: CODEX_APPROVAL_POLICY_DEFAULT,
  [WorkspaceStateKey.CLAUDE_AGENT_MODEL]: CLAUDE_AGENT_DEFAULT_MODEL,
  [WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE]:
    CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  [WorkspaceStateKey.CLAUDE_AGENT_EFFORT]: CLAUDE_AGENT_DEFAULT_EFFORT,
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
  [GlobalStateKey.WEBSOCKET_OPENAI]: false,
  ...PROVIDER_ENDPOINT_DEFAULTS,
  ...PROVIDER_STREAMING_DEFAULTS,
  [GlobalStateKey.STREAMING_GLOBAL]: true,
  [GlobalStateKey.HELPER_MODEL]: DEFAULT_HELPER_MODEL,
  [GlobalStateKey.PREFER_SHORT_MODEL_NAMES]: false,
  [GlobalStateKey.USE_OPENROUTER]: false,
  [GlobalStateKey.KIMI_CODE_PREFER]: false,
  // Region defaults mirror the PROVIDER_REGISTRY `region.default` facts the
  // `regionSet()` getter reads through `readPlatformSetting`.
  [GlobalStateKey.MOONSHOT_USE_CHINA]: true,
  [GlobalStateKey.DASHSCOPE_USE_CHINA]: false,
  [GlobalStateKey.MINIMAX_USE_CHINA]: false,
  [GlobalStateKey.GLM_USE_CHINA]: true,
  [GlobalStateKey.GLM_CODING_PLAN]: false,
  [GlobalStateKey.DISABLED_TOOLS]: [],
  [WorkspaceStateKey.DISABLED_SKILLS]: [],
  [WorkspaceStateKey.DISABLED_SKILL_SOURCES]: [],
};

/** Every canonical `texra.*` key in the state-backed catalog. */
const STATE_SETTING_KEYS: readonly string[] = STATE_SETTINGS.map(
  (entry) => entry.key,
);

describe('state settings catalog', () => {
  it('uses unique canonical keys', () => {
    assert.equal(new Set(STATE_SETTING_KEYS).size, STATE_SETTING_KEYS.length);
  });

  it('backs every LaTeX config field with a catalog entry', () => {
    for (const [field, key] of Object.entries(LATEX_CONFIG_FIELD_TO_KEY)) {
      assert.ok(settingByKey(key), `${field} has no catalog entry: ${key}`);
    }
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
  it("puts exactly the snapshot's catalog rows on the wire", () => {
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
      const message = buildSettingsSnapshotMessage(snapshot, stores, 'vscode');
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
          Object.entries(message.values).filter(([key]) => key !== omittedKey),
        );
        assert.equal(
          dispatchSettingsViewOutbound({ ...message, values: partialValues }, {
            [message.command]: () => {},
          } as never),
          false,
          `${snapshot} arm accepted missing key ${omittedKey}`,
        );
      }
    }
  });

  it('builds the LaTeX message from validated catalog values and defaults', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { stores, workspaceState } = makeFakeSettingsStores();
    void workspaceState.update(WorkspaceStateKey.WORKFLOW_AUTO_COMPILE, false);
    void workspaceState.update(WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS, 25000);
    void workspaceState.update(
      WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
      'stale-bogus-value',
    );
    void workspaceState.update(WorkspaceStateKey.LATEX_FORMATTER, 'tex-fmt');

    try {
      const message = buildSettingsSnapshotMessage('latex', stores, 'desktop');

      assert.equal(message.snapshot, 'latex');
      assert.equal(
        message.values[WorkspaceStateKey.WORKFLOW_AUTO_COMPILE],
        false,
      );
      assert.equal(
        message.values[WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS],
        LATEX_CONFIG_DEFAULTS.workflowAutoCompileTimeoutMs,
      );
      assert.equal(
        message.values[WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS],
        25000,
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
  });
});

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
  async function assertResetRestoresDefault(options: {
    key: string;
    host: SettingHost;
    storeName: 'config' | 'workspaceState';
    expectedDefault: unknown;
  }): Promise<void> {
    const fake = makeFakeSettingsStores();
    const entry = entryByKey(options.key);
    const store = fake[options.storeName];
    await writeSetting(entry, false, fake.stores, options.host);
    assert.equal(isStored(store, entry.key), true);
    await resetSetting(entry, fake.stores, options.host);
    assert.equal(isStored(store, entry.key), false);
    assert.equal(
      readSetting(entry, fake.stores, options.host),
      options.expectedDefault,
    );
  }

  it('reads the default when the key is absent', () => {
    const { stores } = makeFakeSettingsStores();
    const entry = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    assert.equal(readSetting(entry, stores, 'vscode'), true);
  });

  it('routes extension writes to the canonical store', async () => {
    const { stores, config, workspaceState } = makeFakeSettingsStores();
    const entry = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    await writeSetting(entry, false, stores, 'vscode');
    assert.equal(isStored(workspaceState, entry.key), true);
    assert.equal(isStored(config, entry.key), false);
    assert.equal(readSetting(entry, stores, 'vscode'), false);
  });

  it('routes CLI writes to the CLI slot (config)', async () => {
    const { stores, config, workspaceState } = makeFakeSettingsStores();
    const entry = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    await writeSetting(entry, false, stores, 'cli');
    assert.equal(isStored(config, entry.key), true);
    assert.equal(isStored(workspaceState, entry.key), false);
    // The config write used the default 'workspace' target.
    assert.deepEqual(config.inspect(entry.key), {
      globalValue: undefined,
      workspaceValue: false,
    });
    assert.equal(readSetting(entry, stores, 'cli'), false);
  });

  it('routes telemetry writes to global configuration', async () => {
    const { stores, config } = makeFakeSettingsStores();
    const entry = settingsViewSettingByKey('texra.telemetry.enabled');
    assert.ok(entry);

    await writeSetting(entry, false, stores, 'vscode');

    assert.deepEqual(config.inspect(entry.key), {
      globalValue: false,
      workspaceValue: undefined,
    });
  });

  it('routes CLI endpoint writes to global state', async () => {
    const { stores, config, globalState } = makeFakeSettingsStores();
    const entry = entryByKey(GlobalStateKey.ENDPOINT_GOOGLE);
    await writeSetting(entry, 'https://example.invalid/v1', stores, 'cli');
    assert.equal(isStored(globalState, entry.key), true);
    assert.equal(isStored(config, entry.key), false);
    assert.equal(
      readSetting(entry, stores, 'cli'),
      'https://example.invalid/v1',
    );
  });

  it('rejects values that fail the entry schema', async () => {
    const { stores } = makeFakeSettingsStores();
    const entry = entryByKey(WorkspaceStateKey.LATEX_FORMATTER);
    await assert.rejects(() =>
      writeSetting(entry, 'not-a-formatter', stores, 'vscode'),
    );
  });

  it('reset deletes the key so the default reappears', async () => {
    await assertResetRestoresDefault({
      key: WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY,
      host: 'vscode',
      storeName: 'workspaceState',
      expectedDefault: LATEX_CONFIG_DEFAULTS.latexdiffChangesOnly,
    });
  });

  it('reset deletes a config-slot (ConfigProvider) key too', async () => {
    await assertResetRestoresDefault({
      key: WorkspaceStateKey.GIT_MARK_COMMITS,
      host: 'cli',
      storeName: 'config',
      expectedDefault: true,
    });
  });

  // Restored from the deleted `SettingsProfileController` suite, whose
  // "does not mask a compaction value that runtime still reads directly" case
  // turned out not to be obsolete: the settings row must never display a
  // number the runtime is not actually using. Row and runtime now share one
  // resolution rule — the *merged* config scope, validated against the row's
  // own schema — so this pins both halves. A `configTarget: 'global'` on
  // either row breaks the workspace-override case; dropping validation from
  // either runtime reader breaks the out-of-range case.
  it('resolves reliability rows exactly as their runtime readers do', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const reliabilityRows = [
      {
        setting: MODEL_COMPACTION_THRESHOLD_SETTING,
        schema: ModelCompactionThresholdPercentSchema,
        inRange: 40,
        outOfRange: 101,
      },
      {
        setting: MODEL_RETRY_MAX_ATTEMPTS_SETTING,
        schema: ModelRetryMaxAttemptsSchema,
        inRange: 4,
        outOfRange: 6,
      },
    ];
    try {
      for (const { setting, schema, inRange, outOfRange } of reliabilityRows) {
        const entry = settingsViewSettingByKey(setting.configKey);
        assert.ok(entry, `missing settings-view row ${setting.configKey}`);
        assert.equal(
          entry.configTarget,
          undefined,
          `${setting.configKey} must not narrow itself to one config scope`,
        );
        for (const stored of [undefined, inRange, outOfRange]) {
          const { stores, config } = makeFakeSettingsStores();
          if (stored !== undefined) config.set(setting.configKey, stored);
          await installPlatform({}, { config });
          assert.equal(
            readSetting(entry, stores, 'vscode'),
            // The exact expression both runtime readers use.
            getValidatedConfig(setting.configKey, schema, setting.defaultValue),
            `${setting.configKey} stored=${String(stored)}`,
          );
        }
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the default for a stored value that no longer validates', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { stores, workspaceState } = makeFakeSettingsStores();
    const entry = entryByKey(WorkspaceStateKey.LATEX_FORMATTER);
    void workspaceState.update(entry.key, 'stale-bogus-value');
    try {
      assert.equal(
        readSetting(entry, stores, 'vscode'),
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
  });
});
