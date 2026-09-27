// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports - commands
import {
  commandCatalog,
  commandKeybindings,
  type CommandCatalogEntry,
} from '@shared/commands/catalog';

describe('commandCatalog', () => {
  // package.json contributes.commands/keybindings are code-generated from the
  // catalog by scripts/sync-package-contributes.mjs; these are the CI diff
  // checks that fail when the committed manifest drifts from the catalog.

  // commandKeybindings is derived from a hand-mirrored order list
  // (commandKeybindingOrder) in catalog.ts; this guards the silent-drift case
  // where a catalog entry gains a keybinding without being added to that list.
  it('covers every catalog entry that carries a keybinding', () => {
    // `as const satisfies` yields a union of per-entry shapes; only some
    // members declare `keybinding`, so widen to the catalog entry surface.
    // Desktop-only rows carry keybindings the desktop shortcut registry owns;
    // `commandKeybindings` is the VS Code manifest's list, so scope to rows
    // that reach the manifest.
    const keybindingEntryCount = (
      commandCatalog as readonly CommandCatalogEntry[]
    ).filter(
      (entry) => entry.host !== 'desktop' && entry.keybinding !== undefined,
    ).length;
    assert.strictEqual(keybindingEntryCount, commandKeybindings.length);
  });
});
