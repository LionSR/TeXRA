// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - shared shortcut contract
import {
  DESKTOP_SHORTCUT_INVALID_BACKUP_KEY,
  DESKTOP_SHORTCUT_STORAGE_KEY,
  getDesktopShortcutService,
} from '@shared/commands/shortcutPreferences';

// Local imports - test DOM
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
      showRoute(route: string): void;
      showSettings(tabIndex?: number): void;
    };
    openCommands(): void;
    platform?: NodeJS.Platform;
  }): ShortcutRegistry;
}

async function loadShortcutRegistry(): Promise<ShortcutRegistryModule> {
  return import('@desktop/renderer/desktopShortcutRegistry') as unknown as Promise<ShortcutRegistryModule>;
}

describe('desktop shortcut registry', () => {
  useLitComponentTestDom(loadShortcutRegistry);

  it('keeps ordinary typing inside text fields and dispatches modified shortcuts', async () => {
    const { createDesktopShortcutRegistry } = await loadShortcutRegistry();
    const openCommands = vi.fn();
    const registry = createDesktopShortcutRegistry({
      document,
      actions: {
        showRoute: vi.fn(),
        showSettings: vi.fn(),
      },
      openCommands,
      platform: 'darwin',
    });
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

  it('backs up malformed persisted preferences before an explicit update', async () => {
    const { createDesktopShortcutRegistry } = await loadShortcutRegistry();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const malformed = '{"texra.desktop.showCommands":42}';
    const storage = document.defaultView?.localStorage;
    if (!storage) throw new Error('Test DOM localStorage is unavailable.');
    storage.setItem(DESKTOP_SHORTCUT_STORAGE_KEY, malformed);
    const registry = createDesktopShortcutRegistry({
      document,
      actions: {
        showRoute: vi.fn(),
        showSettings: vi.fn(),
      },
      openCommands: vi.fn(),
      platform: 'darwin',
    });

    expect(
      registry
        .entries()
        .find((entry) => entry.id === 'texra.desktop.showCommands'),
    ).toMatchObject({ accelerator: 'Command+K' });
    expect(warning).toHaveBeenCalledOnce();
    registry.update('texra.desktop.showCommands', 'Command+Shift+K');

    expect(storage.getItem(DESKTOP_SHORTCUT_INVALID_BACKUP_KEY)).toBe(
      malformed,
    );
    expect(
      JSON.parse(storage.getItem(DESKTOP_SHORTCUT_STORAGE_KEY) ?? '{}'),
    ).toMatchObject({
      'texra.desktop.showCommands': 'Command+Shift+K',
    });
    registry.dispose();
  });

  it('does not attach a key listener when the shared service is already installed', async () => {
    const { createDesktopShortcutRegistry } = await loadShortcutRegistry();
    const first = createDesktopShortcutRegistry({
      document,
      actions: {
        showRoute: vi.fn(),
        showSettings: vi.fn(),
      },
      openCommands: vi.fn(),
      platform: 'darwin',
    });
    const leakedOpenCommands = vi.fn();

    expect(() =>
      createDesktopShortcutRegistry({
        document,
        actions: {
          showRoute: vi.fn(),
          showSettings: vi.fn(),
        },
        openCommands: leakedOpenCommands,
        platform: 'darwin',
      }),
    ).toThrow();

    first.dispose();
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'k',
        metaKey: true,
      }),
    );
    expect(leakedOpenCommands).not.toHaveBeenCalled();
  });

  it('installs one shared service and removes it on disposal', async () => {
    const { createDesktopShortcutRegistry } = await loadShortcutRegistry();
    const registry = createDesktopShortcutRegistry({
      document,
      actions: {
        showRoute: vi.fn(),
        showSettings: vi.fn(),
      },
      openCommands: vi.fn(),
      platform: 'darwin',
    });

    expect(getDesktopShortcutService()).toBe(registry);
    registry.dispose();
    expect(getDesktopShortcutService()).toBeUndefined();
  });
});
