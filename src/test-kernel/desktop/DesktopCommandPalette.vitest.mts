// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - shared schemas
import { AgentCategory } from '@shared/schemas/agent';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';
import { delay } from '@utils/core';

// Local imports - test DOM utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

interface DesktopCommandPaletteController {
  element: HTMLElement & { open: boolean };
  open(): void;
  close(): void;
}

interface DesktopCommandPaletteModule {
  createDesktopCommandPalette(options: {
    document: Document;
    actions: {
      showRoute(route: string): void;
      showSettings(tabIndex?: number): void;
      showStream?(streamId: string): void;
    };
    getStreams?: () => DesktopPaletteStream[];
    platform?: NodeJS.Platform;
    canOpen?: () => boolean;
  }): DesktopCommandPaletteController;
  filterCommandPaletteEntries<T extends { id: string; label: string }>(
    entries: readonly T[],
    query: string,
  ): T[];
  getNextCommandPaletteIndex(
    currentIndex: number,
    itemCount: number,
    delta: number,
  ): number;
  executeCommandPaletteEntry(
    entry: { id: string; label: string; enabled: boolean } | undefined,
    onExecute: (id: string) => boolean | Promise<boolean>,
  ): boolean;
  isCommandPaletteShortcut(event: KeyboardEvent): boolean;
}

interface DesktopPaletteStream {
  name: string;
  label: string;
  agentCategory: string;
  creationTimestamp: number;
  description?: string;
  agent?: string;
  modelLabel?: string;
}

async function loadDesktopCommandPalette(): Promise<DesktopCommandPaletteModule> {
  return import('@desktop/renderer/desktopCommandPalette') as unknown as Promise<DesktopCommandPaletteModule>;
}

// wa-dialog's show/hide flow chains a few requestAnimationFrame and
// animateWithClass ticks before settling; flushing several macrotasks lets
// those promise/timer callbacks resolve in jsdom (which has no real raf).
async function flushDialogTicks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await delay(0);
  }
}

function pressKey(target: EventTarget, init: KeyboardEventInit): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, ...init }),
  );
}

describe('desktop command palette', () => {
  // Pure-helper tests still need the Lit/JSDOM globals installed because the
  // module under test imports lit-html at top level. Sharing the same DOM
  // setup across all tests in this file keeps lit-html's captured `document`
  // pointing at the jsdom-backed instance.
  useLitComponentTestDom(loadDesktopCommandPalette);

  const entries = [
    {
      id: 'texra.showMainView',
      label: 'Show Launcher',
      category: 'TeXRA',
      accelerator: 'Command+Option+M',
      enabled: true,
    },
    {
      id: 'texra.showProgressView',
      label: 'Show Progress',
      category: 'TeXRA',
      accelerator: 'Command+Option+P',
      enabled: true,
    },
    {
      id: 'texra.showModels',
      label: 'Show Models',
      category: 'TeXRA',
      enabled: true,
    },
  ];

  it('filters command entries by label, category, and id tokens', async () => {
    const { filterCommandPaletteEntries } = await loadDesktopCommandPalette();

    expect(
      filterCommandPaletteEntries(entries, 'progress').map((entry) => entry.id),
    ).toEqual(['texra.showProgressView']);
    expect(
      filterCommandPaletteEntries(entries, 'texra models').map(
        (entry) => entry.id,
      ),
    ).toEqual(['texra.showModels']);
    expect(
      filterCommandPaletteEntries(entries, '').map((entry) => entry.id),
    ).toEqual(entries.map((entry) => entry.id));
  });

  it('wraps active command selection through filtered entries', async () => {
    const { getNextCommandPaletteIndex } = await loadDesktopCommandPalette();

    expect(getNextCommandPaletteIndex(0, 3, 1)).toBe(1);
    expect(getNextCommandPaletteIndex(2, 3, 1)).toBe(0);
    expect(getNextCommandPaletteIndex(0, 3, -1)).toBe(2);
    expect(getNextCommandPaletteIndex(0, 0, 1)).toBe(-1);
  });

  it('does not dispatch disabled command palette entries', async () => {
    const { executeCommandPaletteEntry } = await loadDesktopCommandPalette();
    const actions = {
      showSettings: vi.fn(),
    };

    expect(
      executeCommandPaletteEntry(
        {
          id: 'texra.showModels',
          label: 'Show Models',
          enabled: false,
        },
        () => {
          actions.showSettings();
          return true;
        },
      ),
    ).toBe(false);
    expect(actions.showSettings).not.toHaveBeenCalled();
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

  // wa-dialog + wa-input wiring (Lit-rendered web components). The DOM
  // polyfills installed by useLitComponentTestDom above let those WA
  // components register and animate inside jsdom.
  function findInputElement(
    element: HTMLElement & { open: boolean },
  ): HTMLInputElement | null {
    // wa-input wraps a native <input> in shadow DOM. Look it up via the host
    // wa-input tag, then descend into its shadow root for the real input.
    const waInput = element.querySelector(
      'wa-input.desktop-command-palette-input',
    );
    return (
      waInput?.shadowRoot?.querySelector<HTMLInputElement>('input') ?? null
    );
  }

  function setWaInputValue(
    element: HTMLElement & { open: boolean },
    value: string,
  ): void {
    const waInput = element.querySelector(
      'wa-input.desktop-command-palette-input',
    ) as (HTMLElement & { value: string | null }) | null;
    if (!waInput) throw new Error('wa-input not found');
    waInput.value = value;
    waInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('renders catalog entries and dispatches the active command on Enter', async () => {
    const { createDesktopCommandPalette } = await loadDesktopCommandPalette();
    const actions = {
      showRoute: vi.fn(),
      showSettings: vi.fn(),
    };
    const controller = createDesktopCommandPalette({
      document,
      actions,
      platform: 'darwin',
    });

    document.body.append(controller.element);
    await flushDialogTicks();

    expect(controller.element.getAttribute('aria-label')).toBe(
      'Command palette',
    );

    controller.open();
    await flushDialogTicks();

    expect(controller.element.open).toBe(true);
    const initialItems = controller.element.querySelectorAll<HTMLButtonElement>(
      '.desktop-command-palette-item',
    );
    expect(initialItems.length).toBeGreaterThan(1);

    setWaInputValue(controller.element, 'models');
    await flushDialogTicks();

    const filteredItems =
      controller.element.querySelectorAll<HTMLButtonElement>(
        '.desktop-command-palette-item',
      );
    expect([...filteredItems].map((item) => item.dataset.commandId)).toEqual([
      'texra.showModels',
    ]);

    // Enter on the wa-input forwards the keydown to the palette's keydown
    // handler, which dispatches the active command and closes the dialog.
    const waInput = controller.element.querySelector(
      'wa-input.desktop-command-palette-input',
    )!;
    pressKey(waInput, { key: 'Enter' });
    await flushDialogTicks();

    expect(actions.showSettings).toHaveBeenCalledWith(SETTINGS_TAB.MODELS);
    expect(controller.element.open).toBe(false);
  });

  it('adds current streams as switch commands when opened', async () => {
    const { createDesktopCommandPalette } = await loadDesktopCommandPalette();
    const actions = {
      showRoute: vi.fn(),
      showSettings: vi.fn(),
      showStream: vi.fn(),
    };
    let streams: DesktopPaletteStream[] = [];
    const controller = createDesktopCommandPalette({
      document,
      actions,
      getStreams: () => streams,
      platform: 'darwin',
    });

    document.body.append(controller.element);
    await flushDialogTicks();

    streams = [
      {
        name: 'stream-proof',
        label: 'Spectral proof run',
        agentCategory: AgentCategory.Workflow,
        creationTimestamp: 1,
        description: 'Checking the main lemma',
      },
    ];
    controller.open();
    await flushDialogTicks();

    setWaInputValue(controller.element, 'spectral lemma');
    await flushDialogTicks();

    const filteredItems =
      controller.element.querySelectorAll<HTMLButtonElement>(
        '.desktop-command-palette-item',
      );
    expect([...filteredItems].map((item) => item.dataset.commandId)).toEqual([
      'texra.desktop.switchStream:stream-proof',
    ]);

    const waInput = controller.element.querySelector(
      'wa-input.desktop-command-palette-input',
    )!;
    pressKey(waInput, { key: 'Enter' });
    await flushDialogTicks();

    expect(actions.showStream).toHaveBeenCalledWith('stream-proof');
    expect(controller.element.open).toBe(false);
  });

  it('clicking an item dispatches its command and closes the dialog', async () => {
    const { createDesktopCommandPalette } = await loadDesktopCommandPalette();
    const actions = {
      showRoute: vi.fn(),
      showSettings: vi.fn(),
    };
    const controller = createDesktopCommandPalette({
      document,
      actions,
      platform: 'darwin',
    });
    document.body.append(controller.element);
    controller.open();
    await flushDialogTicks();

    const button = controller.element.querySelector<HTMLButtonElement>(
      '.desktop-command-palette-item[data-command-id="texra.showProgressView"]',
    );
    expect(button).not.toBeNull();
    button!.click();
    await flushDialogTicks();

    expect(actions.showRoute).toHaveBeenCalledWith('progress');
    expect(controller.element.open).toBe(false);
  });

  it('arrow keys advance the active selection through filtered entries', async () => {
    const { createDesktopCommandPalette } = await loadDesktopCommandPalette();
    const controller = createDesktopCommandPalette({
      document,
      actions: { showRoute: vi.fn(), showSettings: vi.fn() },
      platform: 'darwin',
    });
    document.body.append(controller.element);
    controller.open();
    await flushDialogTicks();

    const items = () =>
      controller.element.querySelectorAll<HTMLButtonElement>(
        '.desktop-command-palette-item',
      );
    const selectedIndex = () =>
      [...items()].findIndex(
        (item) => item.getAttribute('aria-selected') === 'true',
      );

    expect(selectedIndex()).toBe(0);

    const waInput = controller.element.querySelector(
      'wa-input.desktop-command-palette-input',
    )!;
    pressKey(waInput, { key: 'ArrowDown' });
    await flushDialogTicks();
    expect(selectedIndex()).toBe(1);

    pressKey(waInput, { key: 'ArrowUp' });
    await flushDialogTicks();
    expect(selectedIndex()).toBe(0);
  });

  it('honors the canOpen guard for global command palette shortcuts', async () => {
    const { createDesktopCommandPalette } = await loadDesktopCommandPalette();
    const controller = createDesktopCommandPalette({
      document,
      actions: { showRoute: vi.fn(), showSettings: vi.fn() },
      canOpen: () => false,
      platform: 'darwin',
    });
    document.body.append(controller.element);
    await flushDialogTicks();

    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    pressKey(trigger, { key: 'k', metaKey: true });
    await flushDialogTicks();

    expect(controller.element.open).toBe(false);
  });

  it('does not steal command palette shortcuts from text-entry targets', async () => {
    const { createDesktopCommandPalette } = await loadDesktopCommandPalette();
    const controller = createDesktopCommandPalette({
      document,
      actions: { showRoute: vi.fn(), showSettings: vi.fn() },
      platform: 'darwin',
    });
    document.body.append(controller.element);
    await flushDialogTicks();

    const search = document.createElement('input');
    document.body.append(search);
    search.focus();
    pressKey(search, { key: 'k', metaKey: true });
    await flushDialogTicks();

    expect(controller.element.open).toBe(false);
  });

  it('exposes the wa-input value through the shadow-root native input', async () => {
    const { createDesktopCommandPalette } = await loadDesktopCommandPalette();
    const controller = createDesktopCommandPalette({
      document,
      actions: { showRoute: vi.fn(), showSettings: vi.fn() },
      platform: 'darwin',
    });
    document.body.append(controller.element);
    controller.open();
    await flushDialogTicks();

    expect(findInputElement(controller.element)).not.toBeNull();
  });
});
