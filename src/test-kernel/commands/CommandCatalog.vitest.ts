// Third-party imports

// Standard library imports
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

// Local imports - commands
import {
  buildCommandManifestEntries,
  commandKeybindings,
} from '@shared/commands/catalog';

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

// Anchor on the repo root (vitest runs from it) rather than import.meta.url:
// this file is type-checked under the CommonJS tsconfig as well, which
// rejects import.meta (matches settingsConfiguration.vitest.ts).
const packageRequire = createRequire(`${process.cwd()}/package.json`);
const packageJson = packageRequire(
  './packages/extension/package.json',
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
  return buildCommandManifestEntries().map(normalizeCommand);
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
