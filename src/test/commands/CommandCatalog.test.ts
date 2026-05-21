// Standard library imports
import { strict as assert } from 'assert';
import { createRequire } from 'module';

// Local imports - commands
import { commandCatalog, commandKeybindings } from '@shared/commands/catalog';

interface PackageCommand {
  command: string;
  title: string;
  shortTitle?: string;
  category: string;
  icon?: string;
  enablement?: string;
}

interface PackageKeybinding {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

interface PackageJson {
  contributes: {
    commands: PackageCommand[];
    keybindings?: PackageKeybinding[];
  };
}

const packageRequire = createRequire(__filename);
const packageJson = packageRequire(
  '../../../packages/extension/package.json',
) as PackageJson;

function normalizeCommand(command: PackageCommand): PackageCommand {
  return {
    command: command.command,
    title: command.title,
    ...(command.shortTitle == null ? {} : { shortTitle: command.shortTitle }),
    category: command.category,
    ...(command.icon == null ? {} : { icon: command.icon }),
    ...(command.enablement == null ? {} : { enablement: command.enablement }),
  };
}

function normalizeCatalogCommands(): PackageCommand[] {
  return commandCatalog.map((entry) =>
    normalizeCommand({
      command: entry.id,
      title: entry.title,
      ...('shortTitle' in entry ? { shortTitle: entry.shortTitle } : {}),
      category: entry.category,
      ...('icon' in entry ? { icon: entry.icon } : {}),
      ...('enablement' in entry ? { enablement: entry.enablement } : {}),
    }),
  );
}

describe('commandCatalog', () => {
  it('matches package command contributions', () => {
    assert.deepEqual(
      normalizeCatalogCommands(),
      packageJson.contributes.commands.map(normalizeCommand),
    );
  });

  it('matches package keybinding contributions', () => {
    assert.deepEqual(
      commandKeybindings,
      packageJson.contributes.keybindings ?? [],
    );
  });
});
