// Standard library imports
import { strict as assert } from 'assert';
import { createRequire } from 'module';

// Local imports - commands
import { commandCatalog, commandKeybindings } from '@commands/catalog';

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

const require = createRequire(__filename);
const packageJson = require('../../../package.json') as PackageJson;

function normalizeCatalogCommands(): PackageCommand[] {
  return commandCatalog.map((entry) => {
    const command: PackageCommand = {
      command: entry.id,
      title: entry.title,
      category: entry.category,
    };
    if ('shortTitle' in entry) command.shortTitle = entry.shortTitle;
    if ('icon' in entry) command.icon = entry.icon;
    if ('enablement' in entry) command.enablement = entry.enablement;
    return command;
  });
}

describe('commandCatalog', () => {
  it('matches package command contributions', () => {
    assert.deepEqual(
      normalizeCatalogCommands(),
      packageJson.contributes.commands,
    );
  });

  it('matches package keybinding contributions', () => {
    assert.deepEqual(
      commandKeybindings,
      packageJson.contributes.keybindings ?? [],
    );
  });
});
