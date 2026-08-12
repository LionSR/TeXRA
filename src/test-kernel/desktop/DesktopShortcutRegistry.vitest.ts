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
      showSettings(tabIndex?: number): void;
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
): Promise<ShortcutRegistry> {
  const { createDesktopShortcutRegistry } = await loadShortcutRegistry();
  return createDesktopShortcutRegistry({
    document,
    actions: {
      showLauncher: vi.fn(),
      openWorkbench: vi.fn(),
      showSettings: vi.fn(),
    },
    openCommands,
    platform: 'darwin',
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

  it('installs one shared service and removes it on disposal', async () => {
    const registry = await createRegistry();

    expect(getDesktopShortcutService()).toBe(registry);
    registry.dispose();
    expect(getDesktopShortcutService()).toBeUndefined();
  });
});
