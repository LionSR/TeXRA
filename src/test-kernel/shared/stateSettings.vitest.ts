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
  CORE_SETTING_PATHS,
  AGENT_SKILLS_CONFIG_KEY,
  CLI_STATE_SETTINGS,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_MARK_COMMITS,
  DEFAULT_GIT_WORKTREE_SUPPORT,
  DEFAULT_TOOL_PATH_PROTECTION_ENABLED,
  STATE_SETTINGS,
  settingEnumChoices,
  settingEnumOptions,
  settingsViewSettingByKey,
  settingsViewSnapshotEntries,
  SETTINGS_SNAPSHOT_COMMANDS,
  dispatchSettingsViewOutbound,
  stateSettingByKey,
  REASONING_LEVEL_OPTIONS,
  CLAUDE_AGENT_DEFAULT_EFFORT,
  CLAUDE_AGENT_DEFAULT_MODEL,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
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
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latexConfig';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { REPO_ROOT } from '@test/support/repoScan';
import {
  isStored,
  makeFakeSettingsStores,
} from '@test/support/settingsStoresFake';

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
  [WorkspaceStateKey.GIT_MARK_COMMITS]: DEFAULT_GIT_MARK_COMMITS,
  [WorkspaceStateKey.GIT_AUTHOR_NAME]: DEFAULT_GIT_AUTHOR_NAME,
  [WorkspaceStateKey.GIT_AUTHOR_EMAIL]: DEFAULT_GIT_AUTHOR_EMAIL,
  [WorkspaceStateKey.GIT_WORKTREE_SUPPORT]: DEFAULT_GIT_WORKTREE_SUPPORT,
  [WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL]: true,
  [WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP]: false,
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
};

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

  it('every editable CLI row documents a runtime-reachability path', () => {
    for (const entry of ALL_SETTINGS) {
      if (!entry.surfaces?.cliConfig) continue;
      const honor = entry.honoredBy.cli;
      assert.ok(
        honor,
        `${entry.key} is editable in /config but no CLI reader honors it`,
      );
      const reachability = honor.reachability;
      assert.ok(
        reachability,
        `${entry.key} is editable in /config but declares no reachability`,
      );
      assert.match(
        reachability.command,
        CLI_RUNTIME_COMMAND_PATTERN,
        `${entry.key} reachability command is not a recognized runtime command: ${reachability.command}`,
      );
      const throughSegments = reachability.through
        .split('->')
        .map((segment) => segment.trim())
        .filter(Boolean);
      assert.ok(
        throughSegments.includes(honor.reader),
        `${entry.key} reachability path must include its CLI reader as a path segment: ${honor.reader}`,
      );
      for (const segment of throughSegments) {
        assert.ok(
          existsSync(resolve(REPO_ROOT, segment)),
          `${entry.key} reachability path segment does not exist: ${segment}`,
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
    // Locks the catalog wording the extension's LaTeXTab composes its
    // <wa-select> labels from.
    const mathMarkup = entryByKey(WorkspaceStateKey.LATEXDIFF_MATH_MARKUP);
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

    const formatter = entryByKey(WorkspaceStateKey.LATEX_FORMATTER);
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
    const labelsFor = (key: WorkspaceStateKey): string[] =>
      (settingEnumChoices(entryByKey(key)) ?? []).map(
        (option) => `${option.value} — ${option.label}`,
      );

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
      'claude-opus-5 — Opus 5',
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
    //  - the provider routing/region toggles (Prefer Kimi Code, the China
    //    region switches, GLM Coding Plan) are the same catalog rows the
    //    Models tab renders via `surfaces.models`, read through
    //    providerConfig/ProxyConfigResolver during CLI model dispatch.
    //  - the Kimi Code prefer switch is read by ModelFactory when dispatching
    //    dual-backend Kimi models in CLI runs.
    //  - agent skills is read by buildUserVars (userVars) when assembling
    //    tool-use agent prompts, skipping skill discovery when disabled.
    //  - texra.approvalPolicy is read by cliConfig / cliContext and seeded onto
    //    SessionHandle before bash/edit approval boundaries decide.
    // auto-open-pdf (no CLI opener), latexdiff, and the formatter are
    // intentionally excluded. Changing the CLI roster must be a deliberate edit
    // here, not an accident of flipping `honoredBy.cli` or `surfaces.cliConfig`.
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
        WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
        WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
        WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
        WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
        ...PROVIDER_ENDPOINT_STATE_ENTRIES.map(
          ({ endpointKey }) => endpointKey,
        ),
        GlobalStateKey.WEBSOCKET_OPENAI,
        GlobalStateKey.USE_OPENROUTER,
        GlobalStateKey.KIMI_CODE_PREFER,
        GlobalStateKey.MOONSHOT_USE_CHINA,
        GlobalStateKey.DASHSCOPE_USE_CHINA,
        GlobalStateKey.MINIMAX_USE_CHINA,
        GlobalStateKey.GLM_USE_CHINA,
        GlobalStateKey.GLM_CODING_PLAN,
        GlobalStateKey.DISABLED_TOOLS,
        AGENT_SKILLS_CONFIG_KEY,
        TEXRA_APPROVAL_POLICY_CONFIG_KEY,
      ].sort(),
    );
  });

  it('shares no keys with the config-tree catalog', () => {
    // The two catalogs must stay disjoint: a state-backed key must never reach
    // the shared config schema via CoreSettingsShape, and a config key must
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

describe('catalog-derived settings snapshots', () => {
  // The durable boundary this PR creates: a snapshot's outbound payload, its
  // backend read, and the row list are the same thing. Adding a row to a
  // snapshot must reach the wire without another edit, and the arm's
  // `strictObject` must accept exactly what the builder produces.
  it("puts exactly the snapshot's catalog rows on the wire", () => {
    const { stores } = makeFakeSettingsStores();

    for (const snapshot of Object.keys(
      SETTINGS_SNAPSHOT_COMMANDS,
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
      // The multi-agent arm alone carries a non-catalog field.
      const posted =
        snapshot === 'multi-agent'
          ? { ...message, reliabilitySettings: [] }
          : message;
      assert.equal(
        dispatchSettingsViewOutbound(posted, {
          [message.command]: () => {},
        } as never),
        true,
        `${snapshot} arm rejected its own builder output`,
      );
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

  it('recognizes exactly the Core paths a CLI reader honors', () => {
    // The derived whitelist replaced two hand-kept path lists; this pins the
    // whole Core half of it so a mis-filed `honoredBy` cannot silently widen or
    // narrow what `.texra/config.json` accepts.
    const honoredCorePaths = CORE_SETTING_PATHS.filter((path) =>
      KNOWN_TEXRA_KEYS.has(`texra.${path}`),
    );
    assert.deepEqual(
      [...honoredCorePaths].sort(),
      CORE_SETTING_PATHS.filter(
        (path) => path !== 'agentReview.runOnCommit',
      ).toSorted(),
      'only agentReview.runOnCommit is extension-only',
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
    assert.equal(
      readSetting(entry, stores, 'vscode'),
      DEFAULT_GIT_MARK_COMMITS,
    );
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
      expectedDefault: DEFAULT_GIT_MARK_COMMITS,
    });
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
