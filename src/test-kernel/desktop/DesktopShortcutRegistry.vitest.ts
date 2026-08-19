import { describe, expect, it, vi } from 'vitest';

import { getDesktopShortcutService } from '@shared/commands/shortcutPreferences';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

interface ShortcutRegistry {
  entries(): readonly {
    id: string;
    accelerator?: string;
  }[];
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

  it('installs one shared service and removes it on disposal', async () => {
    const registry = await createRegistry();

    expect(getDesktopShortcutService()).toBe(registry);
    registry.dispose();
    expect(getDesktopShortcutService()).toBeUndefined();
  });
});
