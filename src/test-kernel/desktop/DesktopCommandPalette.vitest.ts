// Node imports
import { setTimeout as delay } from 'node:timers/promises';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

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
    };
    platform?: NodeJS.Platform;
    canOpen?: () => boolean;
  }): DesktopCommandPaletteController;
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
  // The module under test imports lit-html at top level, so the Lit/JSDOM
  // globals must be installed before it loads; sharing the same DOM setup
  // across the file keeps lit-html's captured `document` pointing at the
  // jsdom-backed instance.
  useLitComponentTestDom(loadDesktopCommandPalette);

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

    const allCommandIds = paletteCommandIds(controller.element);

    setWaInputValue(controller.element, 'models');
    await flushDialogTicks();

    expect(paletteCommandIds(controller.element)).toEqual(['texra.showModels']);

    // A multi-token query matches across the row's category and label, and an
    // empty query restores the whole catalog.
    setWaInputValue(controller.element, 'texra models');
    await flushDialogTicks();
    expect(paletteCommandIds(controller.element)).toEqual(['texra.showModels']);

    setWaInputValue(controller.element, '');
    await flushDialogTicks();
    expect(paletteCommandIds(controller.element)).toEqual(allCommandIds);

    setWaInputValue(controller.element, 'models');
    await flushDialogTicks();

    // Enter on the wa-input forwards the keydown to the palette's keydown
    // handler, which dispatches the active command and closes the dialog.
    pressKey(paletteInput(controller.element), { key: 'Enter' });
    await flushDialogTicks();

    expect(actions.showSettings).toHaveBeenCalledWith('models/models');
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
});
