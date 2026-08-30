import { describe, expect, it, vi } from 'vitest';

import type { CommandPaletteController } from '@desktop/renderer/desktopCommandPalette';
import { createDesktopShortcutBootstrap } from '@desktop/renderer/desktopShortcutBootstrap';
import type { DesktopShortcutRegistry } from '@desktop/renderer/desktopShortcutRegistry';
import { getDesktopShortcutService } from '@shared/commands/shortcutPreferences';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

interface ShortcutRegistry {
  entries(): readonly {
    id: string;
    accelerator?: string;
  }[];
  subscribe(listener: () => void): () => void;
  update(id: string, accelerator: string | undefined): void;
  dispose(): void;
}

interface ShortcutRegistryModule {
  createDesktopShortcutRegistry(options: {
    document: Document;
    actions: {
      showLauncher(): void;
      openWorkbench(kind: 'settings' | 'logs'): void;
      showSettings(tab?: string): void;
      toggleSidePanel(): void;
    };
    openCommands(): void;
    platform?: NodeJS.Platform;
  }): ShortcutRegistry;
}

async function loadShortcutRegistry(): Promise<ShortcutRegistryModule> {
  return import('@desktop/renderer/desktopShortcutRegistry') as unknown as Promise<ShortcutRegistryModule>;
}

async function createRegistry(
  openCommands: () => void = vi.fn(),
  overrides: {
    platform?: NodeJS.Platform;
    toggleSidePanel?: () => void;
  } = {},
): Promise<ShortcutRegistry> {
  const { createDesktopShortcutRegistry } = await loadShortcutRegistry();
  return createDesktopShortcutRegistry({
    document,
    actions: {
      showLauncher: vi.fn(),
      openWorkbench: vi.fn(),
      showSettings: vi.fn(),
      toggleSidePanel: overrides.toggleSidePanel ?? vi.fn(),
    },
    openCommands,
    platform: overrides.platform ?? 'darwin',
  });
}

describe('desktop shortcut registry', () => {
  useLitComponentTestDom(loadShortcutRegistry);

  it('keeps ordinary typing inside text fields and dispatches modified shortcuts', async () => {
    const openCommands = vi.fn();
    const registry = await createRegistry(openCommands);
    const input = document.createElement('input');
    document.body.append(input);

    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'k',
      }),
    );
    expect(openCommands).not.toHaveBeenCalled();

    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'k',
        metaKey: true,
      }),
    );
    expect(openCommands).toHaveBeenCalledOnce();
    registry.dispose();
  });

  it('dispatches the Toggle Side Panel chord its menu advertises', async () => {
    // Regression: the menu stored `CommandOrControl+Alt+B` while the keydown
    // converter produces `Command+Option+B` on darwin and `Control+Alt+B`
    // elsewhere, so the advertised shortcut dispatched nothing on any platform.
    for (const platform of ['darwin', 'win32'] as const) {
      const toggleSidePanel = vi.fn();
      const registry = await createRegistry(vi.fn(), {
        platform,
        toggleSidePanel,
      });

      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'b',
          altKey: true,
          ...(platform === 'darwin' ? { metaKey: true } : { ctrlKey: true }),
        }),
      );

      expect(toggleSidePanel).toHaveBeenCalledOnce();
      registry.dispose();
    }
  });

  it('retries partial shortcut bootstrap without duplicating installation', async () => {
    const { createDesktopShortcutRegistry } = await loadShortcutRegistry();
    const paletteElement = document.createElement('div');
    paletteElement.dataset.testShortcutPalette = '';
    const palette: CommandPaletteController = {
      element: paletteElement,
      open: vi.fn(),
      close: vi.fn(),
    };
    let paletteAttempts = 0;
    const createPalette = vi.fn(
      (_registry: DesktopShortcutRegistry): CommandPaletteController => {
        paletteAttempts += 1;
        if (paletteAttempts === 1) {
          throw new Error('palette construction failed');
        }
        return palette;
      },
    );
    const appendPalette = vi.fn((element: HTMLElement) => {
      document.body.append(element);
    });
    const renderHints = vi.fn().mockImplementationOnce(() => {
      throw new Error('shell render failed');
    });
    let registry: DesktopShortcutRegistry | undefined;
    const createRegistry = vi.fn(
      (openCommands: () => void): DesktopShortcutRegistry => {
        registry = createDesktopShortcutRegistry({
          document,
          actions: {
            showLauncher: vi.fn(),
            openWorkbench: vi.fn(),
            showSettings: vi.fn(),
            toggleSidePanel: vi.fn(),
          },
          openCommands,
          platform: 'darwin',
        }) as unknown as DesktopShortcutRegistry;
        vi.spyOn(registry, 'subscribe');
        vi.spyOn(registry, 'dispose');
        return registry;
      },
    );
    const bootstrap = createDesktopShortcutBootstrap({
      createRegistry,
      createPalette,
      appendPalette,
      onShortcutsChanged: (entries) => {
        expect(bootstrap.entries()).toEqual(entries);
        renderHints();
      },
    });

    expect(bootstrap.ensure).toThrow('palette construction failed');
    expect(bootstrap.ensure).toThrow('shell render failed');
    expect(bootstrap.ensure).not.toThrow();
    bootstrap.ensure();
    registry?.update('texra.desktop.showCommands', 'Command+K');

    expect(createRegistry).toHaveBeenCalledOnce();
    expect(createPalette).toHaveBeenCalledTimes(2);
    expect(appendPalette).toHaveBeenCalledOnce();
    expect(
      document.body.querySelectorAll('[data-test-shortcut-palette]'),
    ).toHaveLength(1);
    expect(paletteElement.isConnected).toBe(true);
    expect(registry?.subscribe).toHaveBeenCalledTimes(2);
    expect(renderHints).toHaveBeenCalledTimes(3);

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'k',
        metaKey: true,
      }),
    );
    expect(palette.open).toHaveBeenCalledOnce();

    bootstrap.dispose();
    bootstrap.dispose();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'k',
        metaKey: true,
      }),
    );
    registry?.update('texra.desktop.showCommands', 'Command+K');

    expect(paletteElement.isConnected).toBe(false);
    expect(registry?.dispose).toHaveBeenCalledOnce();
    expect(palette.open).toHaveBeenCalledOnce();
    expect(renderHints).toHaveBeenCalledTimes(3);
    expect(getDesktopShortcutService()).toBeUndefined();
  });

  it('installs one shared service and removes it on disposal', async () => {
    const registry = await createRegistry();

    expect(getDesktopShortcutService()).toBe(registry);
    registry.dispose();
    expect(getDesktopShortcutService()).toBeUndefined();
  });
});
