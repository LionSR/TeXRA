import { afterEach, describe, expect, it } from 'vitest';

import {
  buildConfigListItems,
  buildEnumItems,
  CLI_CONFIG_ROSTER,
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
  STATE_SETTINGS,
  type StateSettingEntry,
} from '@shared/schemas/stateSettings';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

afterEach(() => {
  for (const cmd of [...listSlashCommands()]) unregisterSlashCommand(cmd.name);
  resetCliState();
});

function entryByKey(key: string): StateSettingEntry {
  const entry = STATE_SETTINGS.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`missing catalog entry ${key}`);
  return entry;
}

class FakeStore {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return this.data.has(key) ? (this.data.get(key) as T) : (defaultValue as T);
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
    return Promise.resolve();
  }
  has(key: string): boolean {
    return this.data.has(key);
  }
}

class FakeConfig extends FakeStore {
  update(key: string, value: unknown, _target?: string): Promise<void> {
    return super.update(key, value);
  }
}

function makeStores(): {
  stores: SettingsStores;
  config: FakeConfig;
} {
  const config = new FakeConfig();
  return {
    stores: {
      config: config as unknown as SettingsStores['config'],
      workspaceState:
        new FakeStore() as unknown as SettingsStores['workspaceState'],
      globalState: new FakeStore() as unknown as SettingsStores['globalState'],
    },
    config,
  };
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
    expect([...CLI_CONFIG_ROSTER].map((entry) => entry.key)).toEqual(
      STATE_SETTINGS.filter((entry) => entry.hosts.includes('cli')).map(
        (entry) => entry.key,
      ),
    );
    expect(CLI_CONFIG_ROSTER.length).toBeGreaterThan(0);
    // Every rostered entry must be reachable from the CLI's store set.
    for (const entry of CLI_CONFIG_ROSTER) {
      expect(entry.hosts).toContain('cli');
    }
  });

  it('classifies edit kinds by value type and enum metadata', () => {
    const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    const authorName = entryByKey(WorkspaceStateKey.GIT_AUTHOR_NAME);
    const formatter = entryByKey(WorkspaceStateKey.LATEX_FORMATTER);

    expect(settingEditKind(markCommits, true)).toBe('boolean');
    expect(settingEditKind(authorName, 'texra-ai')).toBe('readonly');
    expect(settingEditKind(formatter, 'latexindent')).toBe('enum');
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
    const items = buildConfigListItems(CLI_CONFIG_ROSTER, (entry) =>
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
      getConfigStores: () => makeStores().stores,
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
    const { stores, config } = makeStores();
    // Seed the git-author config slot the CLI reads from.
    void config.update(WorkspaceStateKey.GIT_MARK_COMMITS, false);

    registerBuiltinSlashCommands({ getConfigStores: () => stores });
    expect(openCliSlashCommandForm('config', '')).toBe(true);
    expect(cliState.activeForm.get()?.commandName).toBe('config');

    const props = renderConfigFormProps();
    expect(props.entries?.map((entry) => entry.key)).toEqual(
      CLI_CONFIG_ROSTER.map((entry) => entry.key),
    );

    const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    expect(props.readValue?.(markCommits)).toBe(false);
  });

  it('persists writes through the accessor to the CLI store', async () => {
    const { stores, config } = makeStores();
    registerBuiltinSlashCommands({ getConfigStores: () => stores });
    openCliSlashCommandForm('config', '');

    const props = renderConfigFormProps();
    const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    await props.writeValue?.(markCommits, false);

    expect(config.has(WorkspaceStateKey.GIT_MARK_COMMITS)).toBe(true);
    expect(props.readValue?.(markCommits)).toBe(false);
  });
});
