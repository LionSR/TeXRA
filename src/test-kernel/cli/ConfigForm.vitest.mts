import { afterEach, describe, expect, it } from 'vitest';

import {
  buildConfigListItems,
  buildEnumItems,
  ConfigForm,
  formatSettingValue,
  settingDisplayName,
  settingEditKind,
  settingStoreLabel,
} from '@cli/chat/tui/forms/ConfigForm';
import {
  listSlashCommands,
  unregisterSlashCommand,
} from '@cli/chat/tui/commands/slashRegistry';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import { openCliSlashCommandForm } from '@cli/chat/tui/commands/slashForms';
import { cliState, resetCliState } from '@cli/chat/tui/state/cliState';
import {
  CLI_STATE_SETTINGS,
  STATE_SETTINGS,
  type StateSettingEntry,
} from '@shared/schemas/stateSettings';
import { DEFAULT_GIT_AUTHOR_NAME } from '@shared/constants/git';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { getGitAuthorEnv } from '@utils/system/gitAuthorEnv';
import {
  isStored,
  makeFakeSettingsStores,
} from '@test/support/settingsStoresFake';

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
} {
  const node = cliState.activeForm.get()?.render(() => {}, 20) as {
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

    expect(settingEditKind(markCommits)).toBe('boolean');
    expect(settingEditKind(authorName)).toBe('readonly');
    expect(settingEditKind(formatter)).toBe('enum');
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

  it('strips the texra prefix for display names', () => {
    expect(
      settingDisplayName(entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS)),
    ).toBe('git.markCommits');
  });

  it('builds list items with read-only rows disabled', () => {
    const items = buildConfigListItems(CLI_STATE_SETTINGS, (entry) =>
      entry.key === WorkspaceStateKey.GIT_MARK_COMMITS ? true : 'texra-ai',
    );
    const markCommits = items.find(
      (item) => item.value === WorkspaceStateKey.GIT_MARK_COMMITS,
    );
    const authorName = items.find(
      (item) => item.value === WorkspaceStateKey.GIT_AUTHOR_NAME,
    );

    expect(markCommits).toMatchObject({
      label: 'git.markCommits',
      disabled: false,
    });
    expect(markCommits?.description).toContain('on');
    expect(markCommits?.description).toContain('config');
    expect(authorName).toMatchObject({ disabled: true });
    expect(authorName?.description).toContain('read-only');
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
    expect(cliState.activeForm.get()?.commandName).toBe('config');

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
});
