import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  isStored,
  makeFakeSettingsStores,
} from '@test/support/settingsStoresFake';
import {
  buildConfigListItems,
  buildEnumItems,
  coerceSettingInput,
  ConfigForm,
  formatSettingValue,
  isConfigResetInput,
  settingDisplayName,
  settingEditKind,
  settingStoreLabel,
  validateSettingInput,
} from '@cli/chat/tui/forms/ConfigForm';
import {
  buildConfigCategoryItems,
  configCategoryLabel,
} from '@cli/chat/tui/forms/configCategories';
import {
  listSlashCommands,
  unregisterSlashCommand,
} from '@cli/chat/tui/commands/slashRegistry';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import { openCliSlashCommandForm } from '@cli/chat/tui/commands/slashForms';
import {
  activeForm,
  resetCliState,
  sessionMeta,
} from '@cli/chat/tui/state/cliState';
import {
  CLI_STATE_SETTINGS,
  STATE_SETTINGS,
  type StateSettingEntry,
} from '@shared/schemas/stateSettings';
import { DEFAULT_GIT_AUTHOR_NAME } from '@shared/constants/git';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { getGitAuthorEnv } from '@utils/system/gitAuthorEnv';

const invalidateModelOptionsCache = vi.hoisted(() => vi.fn());

vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache,
}));

beforeEach(() => {
  invalidateModelOptionsCache.mockClear();
});

afterEach(() => {
  for (const cmd of [...listSlashCommands()]) unregisterSlashCommand(cmd.name);
  resetCliState();
});

function entryByKey(key: string): StateSettingEntry {
  const entry = STATE_SETTINGS.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`missing catalog entry ${key}`);
  return entry;
}

function renderConfigFormProps(): {
  entries?: readonly StateSettingEntry[];
  readValue?: (entry: StateSettingEntry) => unknown;
  writeValue?: (
    entry: StateSettingEntry,
    value: unknown,
  ) => void | Promise<void>;
  resetValue?: (entry: StateSettingEntry) => void | Promise<void>;
  openForm?: (formName: string) => void;
} {
  const node = activeForm.get()?.render(() => {}, 20) as {
    type?: (props: unknown) => unknown;
    props?: unknown;
  };
  if (typeof node?.type !== 'function') {
    throw new TypeError('Expected /config form adapter element');
  }
  const rendered = node.type(node.props) as {
    props?: ReturnType<typeof Object>;
  };
  return (rendered.props ?? {}) as ReturnType<typeof renderConfigFormProps>;
}

describe('ConfigForm helpers', () => {
  it('rosters exactly the CLI-consumed catalog entries', () => {
    expect([...CLI_STATE_SETTINGS].map((entry) => entry.key)).toEqual(
      STATE_SETTINGS.filter((entry) => entry.hosts.includes('cli')).map(
        (entry) => entry.key,
      ),
    );
    expect(CLI_STATE_SETTINGS.length).toBeGreaterThan(0);
    // Every rostered entry must be reachable from the CLI's store set.
    for (const entry of CLI_STATE_SETTINGS) {
      expect(entry.hosts).toContain('cli');
    }
  });

  it('classifies edit kinds from the entry schema', () => {
    const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    const authorName = entryByKey(WorkspaceStateKey.GIT_AUTHOR_NAME);
    const formatter = entryByKey(WorkspaceStateKey.LATEX_FORMATTER);
    const tools = entryByKey(GlobalStateKey.DISABLED_TOOLS);
    const timeout = entryByKey(
      WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
    );

    expect(settingEditKind(markCommits)).toBe('boolean');
    expect(settingEditKind(authorName)).toBe('string');
    expect(settingEditKind(formatter)).toBe('enum');
    expect(settingEditKind(tools)).toBe('form');
    expect(settingEditKind(timeout)).toBe('number');
  });

  it('coerces text-editor input by kind', () => {
    expect(coerceSettingInput('texra-ai', false)).toEqual({
      ok: true,
      value: 'texra-ai',
    });
    expect(coerceSettingInput('', false)).toEqual({ ok: true, value: '' });
    expect(coerceSettingInput('120000', true)).toEqual({
      ok: true,
      value: 120000,
    });
    expect(coerceSettingInput('  90000 ', true)).toEqual({
      ok: true,
      value: 90000,
    });
    expect(coerceSettingInput('', true)).toEqual({
      ok: false,
      message: 'Enter a number, or press Ctrl+R to reset.',
    });
    expect(coerceSettingInput('abc', true)).toEqual({
      ok: false,
      message: 'Enter a finite number.',
    });
    expect(coerceSettingInput('Infinity', true)).toEqual({
      ok: false,
      message: 'Enter a finite number.',
    });
  });

  it('validates coerced text input against the setting schema', () => {
    const timeout = entryByKey(
      WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
    );
    expect(validateSettingInput(timeout, '120000', true)).toEqual({
      ok: true,
      value: 120000,
    });

    const invalid = validateSettingInput(timeout, '0', true);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).not.toBe('');
  });

  it('recognizes parsed and raw Ctrl+R reset input', () => {
    expect(isConfigResetInput('r', { ctrl: true })).toBe(true);
    expect(isConfigResetInput('\u0012', {})).toBe(true);
    expect(isConfigResetInput('r', { meta: true })).toBe(false);
  });

  it('formats values for display', () => {
    expect(formatSettingValue(true)).toBe('on');
    expect(formatSettingValue(false)).toBe('off');
    expect(formatSettingValue('')).toBe('(empty)');
    expect(formatSettingValue('latexindent')).toBe('latexindent');
    expect(formatSettingValue(120000)).toBe('120000');
  });

  it('labels the store the CLI reads from (cliStore wins)', () => {
    expect(
      settingStoreLabel(entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS)),
    ).toBe('config');
    expect(
      settingStoreLabel(entryByKey(WorkspaceStateKey.LATEX_FORMATTER)),
    ).toBe('workspaceState');
  });

  it('prefers compact titles and falls back to stripped keys for display names', () => {
    expect(
      settingDisplayName(entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS)),
    ).toBe('Mark agent commits');

    expect(
      settingDisplayName({
        key: 'texra.example.record',
        schema: z.record(z.string(), z.string()).prefault({}),
        description: 'A record setting with no inline editor.',
        category: 'example',
        store: 'workspaceState',
        hosts: ['vscode'],
      }),
    ).toBe('example.record');
  });

  it('builds list items showing value + store, with editable rows enabled', () => {
    const items = buildConfigListItems(CLI_STATE_SETTINGS, (entry) =>
      entry.key === WorkspaceStateKey.GIT_MARK_COMMITS ? true : 'texra-ai',
    );
    const markCommits = items.find(
      (item) => item.value === WorkspaceStateKey.GIT_MARK_COMMITS,
    );
    const authorName = items.find(
      (item) => item.value === WorkspaceStateKey.GIT_AUTHOR_NAME,
    );
    const tools = items.find(
      (item) => item.value === GlobalStateKey.DISABLED_TOOLS,
    );

    expect(markCommits).toMatchObject({
      label: 'Mark agent commits',
      disabled: false,
    });
    expect(markCommits?.description).toContain('on');
    expect(markCommits?.description).toContain('config');
    // Strings/numbers are now editable, so no row is read-only in the roster.
    expect(authorName).toMatchObject({ disabled: false });
    expect(authorName?.description).not.toContain('read-only');
    expect(tools).toMatchObject({
      label: 'Tool integrations',
      description: 'open /tools · globalState',
      disabled: false,
    });
  });

  it('groups settings by catalog category with readable labels and counts', () => {
    const entries = [
      entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS),
      entryByKey(WorkspaceStateKey.GIT_AUTHOR_NAME),
      entryByKey(WorkspaceStateKey.CODEX_REASONING_EFFORT),
    ];

    expect(buildConfigCategoryItems(entries)).toEqual([
      {
        value: 'git',
        label: 'Git and worktrees',
        description: '2 settings',
      },
      {
        value: 'ai-agents',
        label: 'AI agents',
        description: '1 setting',
      },
    ]);
    expect(configCategoryLabel('custom-provider')).toBe('Custom Provider');
  });

  it('marks an unsupported schema kind read-only', () => {
    const recordEntry: StateSettingEntry = {
      key: 'texra.example.record',
      schema: z.record(z.string(), z.string()).prefault({}),
      description: 'A record setting with no inline editor.',
      category: 'example',
      store: 'workspaceState',
      hosts: ['vscode'],
    };
    expect(settingEditKind(recordEntry)).toBe('readonly');
    const [item] = buildConfigListItems([recordEntry], () => ({}));
    expect(item).toMatchObject({ disabled: true });
    expect(item?.description).toContain('read-only');
  });

  it('builds enum items from catalog enum metadata', () => {
    const formatter = entryByKey(WorkspaceStateKey.LATEX_FORMATTER);
    const items = buildEnumItems(formatter);
    expect(items.map((item) => item.value)).toEqual([
      'latexindent',
      'tex-fmt',
      'none',
    ]);
    expect(items[0]?.description).toBeTruthy();
  });

  it('exports a renderable component', () => {
    expect(typeof ConfigForm).toBe('function');
  });
});

describe('/config slash command wiring', () => {
  it('registers /config with a form and settings alias', () => {
    registerBuiltinSlashCommands({
      getConfigStores: () => makeFakeSettingsStores().stores,
    });
    const config = listSlashCommands().find((cmd) => cmd.name === 'config');
    expect(config).toEqual(
      expect.objectContaining({
        description: 'View and toggle settings',
        aliases: ['settings'],
        formComponent: expect.any(Function),
      }),
    );
  });

  it('wires the roster and reads through the injected CLI stores', () => {
    const { stores, config } = makeFakeSettingsStores();
    // Seed the git-author config slot the CLI reads from.
    void config.update(WorkspaceStateKey.GIT_MARK_COMMITS, false);

    registerBuiltinSlashCommands({ getConfigStores: () => stores });
    expect(openCliSlashCommandForm('config', '')).toBe(true);
    expect(activeForm.get()?.commandName).toBe('config');

    const props = renderConfigFormProps();
    expect(props.entries?.map((entry) => entry.key)).toEqual(
      CLI_STATE_SETTINGS.map((entry) => entry.key),
    );

    const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    expect(props.readValue?.(markCommits)).toBe(false);
  });

  it('persists writes through the accessor to the CLI store', async () => {
    const { stores, config } = makeFakeSettingsStores();
    registerBuiltinSlashCommands({ getConfigStores: () => stores });
    openCliSlashCommandForm('config', '');

    const props = renderConfigFormProps();
    const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    await props.writeValue?.(markCommits, false);

    expect(isStored(config, WorkspaceStateKey.GIT_MARK_COMMITS)).toBe(true);
    expect(props.readValue?.(markCommits)).toBe(false);
  });

  it('re-applies git author config so a toggle takes effect this session', async () => {
    const { stores } = makeFakeSettingsStores();
    registerBuiltinSlashCommands({ getConfigStores: () => stores });
    openCliSlashCommandForm('config', '');

    const props = renderConfigFormProps();
    const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);

    await props.writeValue?.(markCommits, true);
    expect(getGitAuthorEnv().GIT_AUTHOR_NAME).toBe(DEFAULT_GIT_AUTHOR_NAME);

    await props.writeValue?.(markCommits, false);
    expect(getGitAuthorEnv()).toEqual({});
  });

  it('resets a git setting (delete) and re-applies the identity', async () => {
    const { stores, config } = makeFakeSettingsStores();
    registerBuiltinSlashCommands({ getConfigStores: () => stores });
    openCliSlashCommandForm('config', '');

    const props = renderConfigFormProps();
    const authorName = entryByKey(WorkspaceStateKey.GIT_AUTHOR_NAME);

    await props.writeValue?.(authorName, 'someone-else');
    expect(isStored(config, WorkspaceStateKey.GIT_AUTHOR_NAME)).toBe(true);

    await props.resetValue?.(authorName);
    // The key is deleted, so reads fall back to the default identity.
    expect(isStored(config, WorkspaceStateKey.GIT_AUTHOR_NAME)).toBe(false);
    expect(props.readValue?.(authorName)).toBe(DEFAULT_GIT_AUTHOR_NAME);
  });

  it('switches to personal API mode when OpenRouter routing is enabled', async () => {
    resetCliState({
      agent: 'chat',
      model: 'deepseekT',
      modelSource: 'builtin-default',
      cwd: '/tmp/workspace',
      apiMode: 'included',
      approvalPolicy: 'ask',
      canDelegate: false,
      transcriptMode: 'persistent',
      version: 'test',
    });
    const { stores } = makeFakeSettingsStores();
    const selectedApiModes: string[] = [];
    registerBuiltinSlashCommands({
      getConfigStores: () => stores,
      onApiModeSelect: (apiMode) => {
        selectedApiModes.push(apiMode);
        sessionMeta.set({
          ...sessionMeta.get(),
          apiMode,
        });
      },
    });
    openCliSlashCommandForm('config', '');

    const props = renderConfigFormProps();
    const openRouter = entryByKey(GlobalStateKey.USE_OPENROUTER);

    await props.writeValue?.(openRouter, true);

    expect(selectedApiModes).toEqual(['personal']);
    expect(sessionMeta.get().apiMode).toBe('personal');
    expect(invalidateModelOptionsCache).toHaveBeenCalledOnce();
  });

  it('invalidates model options when OpenRouter routing is disabled or reset', async () => {
    const { stores } = makeFakeSettingsStores();
    registerBuiltinSlashCommands({ getConfigStores: () => stores });
    openCliSlashCommandForm('config', '');

    const props = renderConfigFormProps();
    const openRouter = entryByKey(GlobalStateKey.USE_OPENROUTER);

    await props.writeValue?.(openRouter, false);
    expect(invalidateModelOptionsCache).toHaveBeenCalledTimes(1);

    await props.resetValue?.(openRouter);
    expect(invalidateModelOptionsCache).toHaveBeenCalledTimes(2);
  });

  it('delegates catalog form rows through the slash form registry', () => {
    registerBuiltinSlashCommands({
      getConfigStores: () => makeFakeSettingsStores().stores,
    });
    openCliSlashCommandForm('config', '');

    const props = renderConfigFormProps();
    props.openForm?.('tools');

    expect(activeForm.get()?.commandName).toBe('tools');
  });
});
