// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - shared schemas
import { AgentCategory } from '@shared/schemas';
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
      showLauncher(): void;
      openWorkbench(kind: 'settings' | 'logs'): void;
      showSettings(tab?: string): void;
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
    entry: { id: string; label: string } | undefined,
    onExecute: (id: string) => boolean | Promise<boolean>,
  ): boolean;
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
    },
    {
      id: 'texra.desktop.showLogs',
      label: 'Show Logs',
      category: 'TeXRA',
    },
    {
      id: 'texra.showModels',
      label: 'Show Models',
      category: 'TeXRA',
    },
  ];

  it('filters command entries by label, category, and id tokens', async () => {
    const { filterCommandPaletteEntries } = await loadDesktopCommandPalette();

    expect(
      filterCommandPaletteEntries(entries, 'logs').map((entry) => entry.id),
    ).toEqual(['texra.desktop.showLogs']);
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

  // wa-dialog + wa-input wiring (Lit-rendered web components). The DOM
  // polyfills installed by useLitComponentTestDom above let those WA
  // components register and animate inside jsdom.
  function paletteInput(
    element: HTMLElement,
  ): HTMLElement & { value: string | null } {
    const waInput = element.querySelector<
      HTMLElement & { value: string | null }
    >('wa-input.desktop-command-palette-input');
    if (!waInput) throw new Error('wa-input not found');
    return waInput;
  }

  function paletteCommandIds(element: HTMLElement): (string | undefined)[] {
    return [
      ...element.querySelectorAll<HTMLButtonElement>(
        '.desktop-command-palette-item',
      ),
    ].map((item) => item.dataset.commandId);
  }

  async function mountPalette(
    options: Partial<
      Parameters<DesktopCommandPaletteModule['createDesktopCommandPalette']>[0]
    > = {},
  ): Promise<DesktopCommandPaletteController> {
    const { createDesktopCommandPalette } = await loadDesktopCommandPalette();
    const controller = createDesktopCommandPalette({
      document,
      actions: createActionsStub(),
      platform: 'darwin',
      ...options,
    });
    document.body.append(controller.element);
    await flushDialogTicks();
    return controller;
  }

  function createActionsStub() {
    return {
      showLauncher: vi.fn(),
      openWorkbench: vi.fn(),
      showSettings: vi.fn(),
    };
  }

  function setWaInputValue(element: HTMLElement, value: string): void {
    const waInput = paletteInput(element);
    waInput.value = value;
    waInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('renders catalog entries and dispatches the active command on Enter', async () => {
    const actions = createActionsStub();
    const controller = await mountPalette({ actions });

    expect(controller.element.getAttribute('aria-label')).toBe(
      'Command palette',
    );

    controller.open();
    await flushDialogTicks();

    expect(controller.element.open).toBe(true);
    expect(paletteCommandIds(controller.element).length).toBeGreaterThan(1);

    setWaInputValue(controller.element, 'models');
    await flushDialogTicks();

    expect(paletteCommandIds(controller.element)).toEqual(['texra.showModels']);

    // Enter on the wa-input forwards the keydown to the palette's keydown
    // handler, which dispatches the active command and closes the dialog.
    pressKey(paletteInput(controller.element), { key: 'Enter' });
    await flushDialogTicks();

    expect(actions.showSettings).toHaveBeenCalledWith('models');
    expect(controller.element.open).toBe(false);
  });

  it('adds current streams as switch commands when opened', async () => {
    const actions = {
      ...createActionsStub(),
      showStream: vi.fn(),
    };
    let streams: DesktopPaletteStream[] = [];
    const controller = await mountPalette({
      actions,
      getStreams: () => streams,
    });

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

    expect(paletteCommandIds(controller.element)).toEqual([
      'texra.desktop.switchStream:stream-proof',
    ]);

    pressKey(paletteInput(controller.element), { key: 'Enter' });
    await flushDialogTicks();

    expect(actions.showStream).toHaveBeenCalledWith('stream-proof');
    expect(controller.element.open).toBe(false);
  });

  it('clicking an item dispatches its command and closes the dialog', async () => {
    const actions = createActionsStub();
    const controller = await mountPalette({ actions });
    controller.open();
    await flushDialogTicks();

    const button = controller.element.querySelector<HTMLButtonElement>(
      '.desktop-command-palette-item[data-command-id="texra.showMainView"]',
    );
    expect(button).not.toBeNull();
    button!.click();
    await flushDialogTicks();

    expect(actions.showLauncher).toHaveBeenCalledOnce();
    expect(controller.element.open).toBe(false);
  });

  it('arrow keys advance the active selection through filtered entries', async () => {
    const controller = await mountPalette();
    controller.open();
    await flushDialogTicks();

    const selectedIndex = () =>
      [
        ...controller.element.querySelectorAll<HTMLButtonElement>(
          '.desktop-command-palette-item',
        ),
      ].findIndex((item) => item.getAttribute('aria-selected') === 'true');

    expect(selectedIndex()).toBe(0);

    const waInput = paletteInput(controller.element);
    pressKey(waInput, { key: 'ArrowDown' });
    await flushDialogTicks();
    expect(selectedIndex()).toBe(1);

    pressKey(waInput, { key: 'ArrowUp' });
    await flushDialogTicks();
    expect(selectedIndex()).toBe(0);
  });

  it('exposes the wa-input value through the shadow-root native input', async () => {
    const controller = await mountPalette();
    controller.open();
    await flushDialogTicks();

    // wa-input wraps a native <input> in shadow DOM. Look it up via the host
    // wa-input tag, then descend into its shadow root for the real input.
    expect(
      paletteInput(controller.element).shadowRoot?.querySelector('input'),
    ).toBeTruthy();
  });
});
