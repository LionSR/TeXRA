// Third-party imports
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

// Local imports - shared schemas
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopCommandPaletteModule {
  createDesktopCommandPalette(options: {
    document: Document;
    actions: {
      showRoute(route: string): void;
      showSettings(tabIndex?: number): void;
    };
    platform?: NodeJS.Platform;
  }): {
    element: HTMLElement;
    open(): void;
    close(): void;
  };
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

  it('renders catalog entries and dispatches the active command', async () => {
    const { createDesktopCommandPalette } = await loadDesktopCommandPalette();
    const dom = new JSDOM('<button id="trigger">Commands</button>');
    const actions = {
      showRoute: vi.fn(),
      showSettings: vi.fn(),
    };
    const controller = createDesktopCommandPalette({
      document: dom.window.document,
      actions,
      platform: 'darwin',
    });

    dom.window.document.body.append(controller.element);
    controller.open();

    const input = controller.element.querySelector<HTMLInputElement>(
      '.desktop-command-palette-input',
    );
    const initialItems = controller.element.querySelectorAll<HTMLButtonElement>(
      '.desktop-command-palette-item',
    );
    expect(input).not.toBeNull();
    expect(initialItems.length).toBeGreaterThan(1);

    input!.value = 'models';
    input!.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const filteredItems =
      controller.element.querySelectorAll<HTMLButtonElement>(
        '.desktop-command-palette-item',
      );
    expect([...filteredItems].map((item) => item.dataset.commandId)).toEqual([
      'texra.showModels',
    ]);

    input!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
      }),
    );
    expect(actions.showSettings).toHaveBeenCalledWith(SETTINGS_TAB.MODELS);
    expect(controller.element.hidden).toBe(true);
  });

  it('traps focus while open and restores focus when closed', async () => {
    const { createDesktopCommandPalette } = await loadDesktopCommandPalette();
    const dom = new JSDOM('<button id="trigger">Commands</button>');
    const trigger =
      dom.window.document.querySelector<HTMLButtonElement>('#trigger');
    const controller = createDesktopCommandPalette({
      document: dom.window.document,
      actions: {
        showRoute: vi.fn(),
        showSettings: vi.fn(),
      },
      platform: 'darwin',
    });

    dom.window.document.body.append(controller.element);
    trigger?.focus();
    controller.open();

    const input = controller.element.querySelector<HTMLInputElement>(
      '.desktop-command-palette-input',
    );
    expect(dom.window.document.activeElement).toBe(input);

    input!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(
      dom.window.document.activeElement?.classList.contains(
        'desktop-command-palette-item',
      ),
    ).toBe(true);

    dom.window.document.activeElement?.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
      }),
    );
    expect(dom.window.document.activeElement).toBe(input);

    input!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }),
    );
    expect(controller.element.hidden).toBe(true);
    expect(dom.window.document.activeElement).toBe(trigger);
  });

  it('keeps the original focus restoration target across repeated opens', async () => {
    const { createDesktopCommandPalette } = await loadDesktopCommandPalette();
    const dom = new JSDOM('<button id="trigger">Commands</button>');
    const trigger =
      dom.window.document.querySelector<HTMLButtonElement>('#trigger');
    const controller = createDesktopCommandPalette({
      document: dom.window.document,
      actions: {
        showRoute: vi.fn(),
        showSettings: vi.fn(),
      },
      platform: 'darwin',
    });

    dom.window.document.body.append(controller.element);
    trigger?.focus();
    controller.open();
    expect(
      controller.element.querySelector<HTMLInputElement>(
        '.desktop-command-palette-input',
      ),
    ).toBe(dom.window.document.activeElement);

    controller.open();
    controller.close();

    expect(dom.window.document.activeElement).toBe(trigger);
  });

  it('does not steal command palette shortcuts from text entry targets', async () => {
    const { createDesktopCommandPalette } = await loadDesktopCommandPalette();
    const dom = new JSDOM(
      '<button id="trigger">Commands</button><input id="search" />',
    );
    const trigger =
      dom.window.document.querySelector<HTMLButtonElement>('#trigger');
    const search =
      dom.window.document.querySelector<HTMLInputElement>('#search');
    const controller = createDesktopCommandPalette({
      document: dom.window.document,
      actions: {
        showRoute: vi.fn(),
        showSettings: vi.fn(),
      },
      platform: 'darwin',
    });

    dom.window.document.body.append(controller.element);
    search?.focus();
    search?.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        bubbles: true,
      }),
    );
    expect(controller.element.hidden).toBe(true);

    trigger?.focus();
    trigger?.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        bubbles: true,
      }),
    );
    expect(controller.element.hidden).toBe(false);
  });
});
