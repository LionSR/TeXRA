// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopCommandPaletteModule {
  filterDesktopCommandPaletteEntries(
    entries: DesktopPaletteEntry[],
    query: string,
  ): DesktopPaletteEntry[];
  getNextDesktopCommandPaletteIndex(
    currentIndex: number,
    itemCount: number,
    delta: number,
  ): number;
  isCommandPaletteShortcut(event: KeyboardEvent): boolean;
}

interface DesktopPaletteEntry {
  id: string;
  label: string;
  category: string;
  accelerator?: string;
}

async function loadDesktopCommandPalette(): Promise<DesktopCommandPaletteModule> {
  return import(
    moduleFileUrl(desktopSourcePath('renderer', 'desktopCommandPalette.ts'))
  ) as Promise<DesktopCommandPaletteModule>;
}

describe('desktop command palette', () => {
  const entries = [
    {
      id: 'texra.showMainView',
      label: 'Show Launcher',
      category: 'TeXRA',
      accelerator: 'Command+Option+M',
    },
    {
      id: 'texra.showProgressView',
      label: 'Show Progress',
      category: 'TeXRA',
      accelerator: 'Command+Option+P',
    },
    {
      id: 'texra.showModels',
      label: 'Show Models',
      category: 'TeXRA',
    },
  ];

  it('filters command entries by label, category, and id tokens', async () => {
    const { filterDesktopCommandPaletteEntries } =
      await loadDesktopCommandPalette();

    expect(
      filterDesktopCommandPaletteEntries(entries, 'progress').map(
        (entry) => entry.id,
      ),
    ).toEqual(['texra.showProgressView']);
    expect(
      filterDesktopCommandPaletteEntries(entries, 'texra models').map(
        (entry) => entry.id,
      ),
    ).toEqual(['texra.showModels']);
    expect(
      filterDesktopCommandPaletteEntries(entries, '').map((entry) => entry.id),
    ).toEqual(entries.map((entry) => entry.id));
  });

  it('wraps active command selection through filtered entries', async () => {
    const { getNextDesktopCommandPaletteIndex } =
      await loadDesktopCommandPalette();

    expect(getNextDesktopCommandPaletteIndex(0, 3, 1)).toBe(1);
    expect(getNextDesktopCommandPaletteIndex(2, 3, 1)).toBe(0);
    expect(getNextDesktopCommandPaletteIndex(0, 3, -1)).toBe(2);
    expect(getNextDesktopCommandPaletteIndex(0, 0, 1)).toBe(-1);
  });

  it('uses the native command palette shortcut shape', async () => {
    const { isCommandPaletteShortcut } = await loadDesktopCommandPalette();

    expect(
      isCommandPaletteShortcut({ key: 'k', metaKey: true } as KeyboardEvent),
    ).toBe(true);
    expect(
      isCommandPaletteShortcut({ key: 'k', ctrlKey: true } as KeyboardEvent),
    ).toBe(true);
    expect(
      isCommandPaletteShortcut({
        key: 'k',
        metaKey: true,
        shiftKey: true,
      } as KeyboardEvent),
    ).toBe(false);
  });
});
