// Node imports
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import { KNOWN_TEXRA_KEYS } from '@cli/schemas/knownKeys';
import { CORE_SETTING_PATHS } from '@shared/schemas/coreSettings';
import {
  CLI_STATE_SETTINGS,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_MARK_COMMITS,
  DEFAULT_GIT_WORKTREE_SUPPORT,
  STATE_SETTINGS,
  STATE_SETTING_KEYS,
  settingEnumChoices,
  settingEnumOptions,
  stateSettingByKey,
  type SettingStore,
  type StateSettingEntry,
} from '@shared/schemas/stateSettings';
import {
  API_ACCESS_MODE_OPTIONS,
  REASONING_LEVEL_OPTIONS,
} from '@shared/schemas/settingsViewMessages';
import { PROVIDER_ENDPOINT_STATE_ENTRIES } from '@shared/constants/providers';
import {
  readSetting,
  resetSetting,
  settingDefault,
  writeSetting,
} from '@shared/config/settingsAccess';
import {
  CLAUDE_AGENT_DEFAULT_EFFORT,
  CLAUDE_AGENT_DEFAULT_MODEL,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
} from '@shared/schemas/agentCliSettings';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latex';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  isStored,
  makeFakeSettingsStores,
} from '@test/support/settingsStoresFake';

const VALID_STORES: ReadonlySet<SettingStore> = new Set<SettingStore>([
  'config',
  'workspaceState',
  'globalState',
]);

const CLI_RUNTIME_COMMAND_PATTERN =
  /^texra\s+(?:chat|run|agents run|multi-agent run|orchestrate)\b/;

function reachabilitySegments(through: string): string[] {
  return through
    .split('->')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

const CLASS_D_KEY_PATTERN = /migrated|version|onboarding|history|cache/i;
const PROVIDER_ENDPOINT_DEFAULTS = Object.fromEntries(
  PROVIDER_ENDPOINT_STATE_ENTRIES.map(({ endpointKey }) => [endpointKey, '']),
);

/** Expected default-when-absent for each catalog key, from the real getters. */
const EXPECTED_DEFAULTS: Record<string, unknown> = {
  [WorkspaceStateKey.GIT_MARK_COMMITS]: DEFAULT_GIT_MARK_COMMITS,
  [WorkspaceStateKey.GIT_AUTHOR_NAME]: DEFAULT_GIT_AUTHOR_NAME,
  [WorkspaceStateKey.GIT_AUTHOR_EMAIL]: DEFAULT_GIT_AUTHOR_EMAIL,
  [WorkspaceStateKey.GIT_WORKTREE_SUPPORT]: DEFAULT_GIT_WORKTREE_SUPPORT,
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
  [GlobalStateKey.USE_OPENROUTER]: false,
  [GlobalStateKey.KIMI_CODE_PREFER]: false,
  [GlobalStateKey.DISABLED_TOOLS]: [],
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

  it('every CLI-host entry documents a runtime-reachability path', () => {
    for (const entry of STATE_SETTINGS) {
      if (!entry.hosts.includes('cli')) {
        assert.equal(
          entry.cliRuntimeReachability,
          undefined,
          `${entry.key} documents CLI reachability but is not CLI-hosted`,
        );
        continue;
      }

      const reachability = entry.cliRuntimeReachability;
      assert.ok(
        reachability,
        `${entry.key} is surfaced to the CLI but declares no cliRuntimeReachability`,
      );
      assert.match(
        reachability.command,
        CLI_RUNTIME_COMMAND_PATTERN,
        `${entry.key} reachability command is not a recognized runtime command: ${reachability.command}`,
      );
      const cliConsumer = entry.cliConsumer;
      assert.ok(
        cliConsumer,
        `${entry.key} reachability path cannot be checked without cliConsumer`,
      );
      const throughSegments = reachabilitySegments(reachability.through);
      assert.ok(
        throughSegments.includes(cliConsumer),
        `${entry.key} reachability path must include its cliConsumer as a path segment: ${cliConsumer}`,
      );
      for (const segment of throughSegments) {
        assert.ok(
          existsSync(resolve(process.cwd(), segment)),
          `${entry.key} reachability path segment does not exist: ${segment}`,
        );
      }
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

  it('drives the LaTeX tab enum option labels from catalog metadata', () => {
    // Locks the catalog wording the extension's LaTeXTab now composes its
    // <wa-select> labels from, so the displayed options stay byte-identical to
    // the previously hand-listed arrays.
    const mathMarkup = stateSettingByKey(
      WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
    );
    assert.ok(mathMarkup);
    const mathMarkupLabels = (settingEnumOptions(mathMarkup) ?? []).map(
      (value, index) => {
        const base = `${value} — ${mathMarkup.enumDescriptions?.[index]}`;
        return value === LATEX_CONFIG_DEFAULTS.latexdiffMathMarkup
          ? `${base} (default)`
          : base;
      },
    );
    assert.deepEqual(mathMarkupLabels, [
      'off — suppress markup',
      'whole — equation-level',
      'coarse — within equations (default)',
      'fine — small changes inside equations',
    ]);

    const formatter = stateSettingByKey(WorkspaceStateKey.LATEX_FORMATTER);
    assert.ok(formatter);
    const formatterLabels = (settingEnumOptions(formatter) ?? []).map(
      (value) =>
        value === LATEX_CONFIG_DEFAULTS.latexFormatter
          ? `${value} (default)`
          : value,
    );
    assert.deepEqual(formatterLabels, [
      'latexindent (default)',
      'tex-fmt',
      'none',
    ]);
  });

  it('drives the AI Agents tab enum option labels from catalog metadata', () => {
    const labelsFor = (key: WorkspaceStateKey): string[] => {
      const entry = stateSettingByKey(key);
      assert.ok(entry, `missing catalog entry ${key}`);
      return (settingEnumChoices(entry) ?? []).map(
        (option) => `${option.value} — ${option.label}`,
      );
    };

    assert.deepEqual(labelsFor(WorkspaceStateKey.CODEX_SANDBOX_MODE), [
      'read-only — Read-only',
      'workspace-write — Workspace write',
      'danger-full-access — Full access',
    ]);
    assert.deepEqual(labelsFor(WorkspaceStateKey.CODEX_REASONING_EFFORT), [
      'low — Low',
      'medium — Medium',
      'high — High',
      'xhigh — Extra high',
    ]);
    assert.deepEqual(labelsFor(WorkspaceStateKey.CODEX_APPROVAL_POLICY), [
      'never — Auto approve',
      'on-request — Ask when requested',
      'untrusted — Ask for untrusted',
      'on-failure — Ask on failure',
    ]);
    assert.deepEqual(labelsFor(WorkspaceStateKey.CLAUDE_AGENT_MODEL), [
      'claude-sonnet-5 — Sonnet 5',
      'claude-fable-5 — Fable 5',
      'claude-opus-4-8 — Opus 4.8',
      'claude-haiku-4-5-20251001 — Haiku 4.5',
    ]);
    assert.deepEqual(
      labelsFor(WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE),
      [
        'default — Prompt for risky actions',
        'acceptEdits — Auto-accept edits',
        'bypassPermissions — Bypass all (dangerous)',
        'plan — Plan only (read-only)',
      ],
    );
    assert.deepEqual(labelsFor(WorkspaceStateKey.CLAUDE_AGENT_EFFORT), [
      'low — Low',
      'medium — Medium',
      'high — High',
      'xhigh — Extra high',
      'max — Maximum',
    ]);
  });

  it('drives model-profile option labels from shared metadata', () => {
    assert.deepEqual(
      REASONING_LEVEL_OPTIONS.map(
        (option) => `${option.value} — ${option.label}`,
      ),
      [
        'none — None',
        'low — Low',
        'medium — Medium',
        'high — High',
        'xhigh — Extra High',
        'max — Max',
      ],
    );
    assert.deepEqual(
      API_ACCESS_MODE_OPTIONS.map(
        (option) => `${option.value} — ${option.label} — ${option.description}`,
      ),
      [
        'included — Use Included Access — Works automatically. No setup needed. Does not apply to OpenRouter — those models always use your OpenRouter key. Bring your own provider API keys to use more of your own quota and avoid relay caps.',
        'personal — Use My Own Keys — Provide your own API keys from OpenAI, Anthropic, etc. This uses your provider account directly for higher limits and models outside Included Access.',
      ],
    );
  });

  it('exposes exactly the verified CLI-consumed settings', () => {
    // Each entry below is confirmed to actually take effect in the CLI:
    //  - git author identity is merged into spawned commands (execUtils) and
    //    drives worktree delegation (DelegationTools);
    //  - Codex and Claude Code agent defaults are read by their tool runtimes
    //    when a headless tool-use run launches either external CLI;
    //  - the workflow compile settings run in `texra workflow` / `texra run`
    //    (the reflection flow, via OutputNode/runCompileCheck).
    //  - the OpenAI WebSocket toggle is read by the Responses handler the CLI
    //    runs (and lets the Codex backend attempt WebSocket).
    //  - provider endpoints are read by the proxy resolver used by CLI model
    //    handlers before falling back to provider defaults.
    //  - the Kimi Code prefer switch is read by ModelFactory when dispatching
    //    dual-backend Kimi models in CLI runs.
    // auto-open-pdf (no CLI opener), latexdiff, and the formatter are
    // intentionally excluded. Changing the CLI roster must be a deliberate edit
    // here, not an accident of flipping `hosts`.
    assert.deepEqual(
      [...CLI_STATE_SETTINGS].map((entry) => entry.key).sort(),
      [
        WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
        WorkspaceStateKey.CLAUDE_AGENT_MODEL,
        WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
        WorkspaceStateKey.CODEX_APPROVAL_POLICY,
        WorkspaceStateKey.CODEX_REASONING_EFFORT,
        WorkspaceStateKey.CODEX_SANDBOX_MODE,
        WorkspaceStateKey.GIT_AUTHOR_EMAIL,
        WorkspaceStateKey.GIT_AUTHOR_NAME,
        WorkspaceStateKey.GIT_MARK_COMMITS,
        WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
        WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
        WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
        WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
        ...PROVIDER_ENDPOINT_STATE_ENTRIES.map(
          ({ endpointKey }) => endpointKey,
        ),
        GlobalStateKey.WEBSOCKET_OPENAI,
        GlobalStateKey.USE_OPENROUTER,
        GlobalStateKey.KIMI_CODE_PREFER,
        GlobalStateKey.DISABLED_TOOLS,
      ].sort(),
    );
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
  it('recognizes config-slot CLI keys, but warns on state.json keys in config.json', () => {
    for (const entry of CLI_STATE_SETTINGS) {
      const readFromConfig = (entry.cliStore ?? entry.store) === 'config';
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
});

// --- accessor round-trip ----------------------------------------------------

function entryByKey(key: string): StateSettingEntry {
  const entry = STATE_SETTINGS.find((e) => e.key === key);
  assert.ok(entry, `missing catalog entry ${key}`);
  return entry;
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

  it('reset deletes a config-slot (ConfigProvider) key too', async () => {
    const { stores, config } = makeFakeSettingsStores();
    const entry = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    await writeSetting(entry, false, stores, 'cli');
    assert.equal(isStored(config, entry.key), true);
    await resetSetting(entry, stores, 'cli');
    assert.equal(isStored(config, entry.key), false);
    assert.equal(readSetting(entry, stores, 'cli'), DEFAULT_GIT_MARK_COMMITS);
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
