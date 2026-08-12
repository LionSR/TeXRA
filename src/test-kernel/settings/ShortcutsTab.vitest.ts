import { describe, expect, it, vi } from 'vitest';

import {
  installDesktopShortcutService,
  keyboardEventToAccelerator,
  type DesktopShortcutEntry,
  type DesktopShortcutService,
} from '@shared/commands/shortcutPreferences';

import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

describe('shortcuts-tab', () => {
  useLitComponentTestDom(
    () => import('@settingsView/frontend/tabs/ShortcutsTab'),
  );

  it('normalizes customizable desktop key chords', () => {
    expect(
      keyboardEventToAccelerator(
        {
          key: 'k',
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        } as KeyboardEvent,
        'darwin',
      ),
    ).toBe('Command+Shift+K');
    expect(
      keyboardEventToAccelerator(
        {
          key: 'F8',
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        } as KeyboardEvent,
        'linux',
      ),
    ).toBe('F8');
  });

  it('renders state and publishes captured shortcut changes', async () => {
    let entries: readonly DesktopShortcutEntry[] = [
      {
        id: 'texra.desktop.showCommands',
        label: 'Show Commands',
        category: 'TeXRA',
        defaultAccelerator: 'Command+K',
        accelerator: 'Command+K',
      },
    ];
    const listeners = new Set<
      (nextEntries: readonly DesktopShortcutEntry[]) => void
    >();
    const service: DesktopShortcutService = {
      entries: () => entries,
      subscribe: (listener) => {
        listeners.add(listener);
        listener(entries);
        return () => listeners.delete(listener);
      },
      update: vi.fn((id: string, accelerator: string | undefined) => {
        entries = entries.map((entry) =>
          entry.id === id ? { ...entry, accelerator } : entry,
        );
        for (const listener of listeners) listener(entries);
      }),
      reset: vi.fn(),
    };
    const uninstall = installDesktopShortcutService(service);
    try {
      const element =
        await mountComponent<HTMLElementTagNameMap['shortcuts-tab']>(
          'shortcuts-tab',
        );

      expect(element.shadowRoot?.textContent).toContain('Show Commands');
      const recorder =
        element.shadowRoot?.querySelector<HTMLElement>('.shortcut-recorder');
      recorder?.click();
      const isMac = navigator.platform.toLowerCase().includes('mac');
      recorder?.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          key: 'p',
          ctrlKey: !isMac,
          metaKey: isMac,
          shiftKey: true,
        }),
      );

      expect(service.update).toHaveBeenCalledWith(
        'texra.desktop.showCommands',
        isMac ? 'Command+Shift+P' : 'Control+Shift+P',
      );
    } finally {
      uninstall();
    }
  });
});
