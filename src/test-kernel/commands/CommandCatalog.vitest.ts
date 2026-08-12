// Standard library imports
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports - commands
import {
  commandCatalog,
  commandKeybindings,
  packageCommandContributions,
  type CommandCatalogEntry,
} from '@shared/commands/catalog';

interface PackageJson {
  contributes: {
    commands: unknown[];
    keybindings?: unknown[];
  };
}

// Anchor on the repo root (vitest runs from it) rather than import.meta.url:
// this file is type-checked under the CommonJS tsconfig as well, which
// rejects import.meta (matches settingsConfiguration.vitest.ts).
const packageRequire = createRequire(`${process.cwd()}/package.json`);
const packageJson = packageRequire(
  './packages/extension/package.json',
) as PackageJson;

describe('commandCatalog', () => {
  // package.json contributes.commands/keybindings are code-generated from the
  // catalog by scripts/sync-package-contributes.mjs; these are the CI diff
  // checks that fail when the committed manifest drifts from the catalog.
  it('matches package command contributions', () => {
    assert.deepEqual(
      packageJson.contributes.commands,
      packageCommandContributions,
    );
  });

  it('matches package keybinding contributions', () => {
    assert.deepEqual(
      packageJson.contributes.keybindings ?? [],
      commandKeybindings,
    );
  });

  // commandKeybindings is derived from a hand-mirrored order list
  // (commandKeybindingOrder) in catalog.ts; this guards the silent-drift case
  // where a catalog entry gains a keybinding without being added to that list.
  it('covers every catalog entry that carries a keybinding', () => {
    // `as const satisfies` yields a union of per-entry shapes; only some
    // members declare `keybinding`, so widen to the catalog entry surface.
    const keybindingEntryCount = (
      commandCatalog as readonly CommandCatalogEntry[]
    ).filter((entry) => entry.keybinding !== undefined).length;
    assert.strictEqual(keybindingEntryCount, commandKeybindings.length);
  });
});
