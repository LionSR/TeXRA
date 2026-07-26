// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - shortcut contract
import {
  DESKTOP_SHORTCUT_EVENTS,
  keyboardEventToAccelerator,
  type DesktopShortcutState,
  type DesktopShortcutUpdate,
} from '@shared/commands/shortcutPreferences';

// Local imports - test DOM
import { useLitComponentTestDom } from './litComponentTestUtils';

async function loadShortcutsTab() {
  return import('@settingsView/frontend/tabs/ShortcutsTab');
}

describe('shortcuts-tab', () => {
  useLitComponentTestDom(loadShortcutsTab);

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
    await loadShortcutsTab();
    const element = document.createElement('shortcuts-tab');
    element.desktopHost = true;
    document.body.append(element);

    const state: DesktopShortcutState = {
      entries: [
        {
          id: 'texra.desktop.showCommands',
          label: 'Show Commands',
          category: 'TeXRA',
          defaultAccelerator: 'Command+K',
          accelerator: 'Command+K',
        },
      ],
    };
    window.dispatchEvent(
      new CustomEvent(DESKTOP_SHORTCUT_EVENTS.STATE, { detail: state }),
    );
    await element.updateComplete;

    expect(element.shadowRoot?.textContent).toContain('Show Commands');
    const update = vi.fn<(event: Event) => void>();
    window.addEventListener(DESKTOP_SHORTCUT_EVENTS.UPDATE, update);
    const recorder =
      element.shadowRoot?.querySelector<HTMLElement>('.shortcut-recorder');
    recorder?.click();
    recorder?.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'p',
        metaKey: true,
        shiftKey: true,
      }),
    );

    expect(update).toHaveBeenCalledOnce();
    const detail = (update.mock.calls[0]?.[0] as CustomEvent).detail as
      DesktopShortcutUpdate | undefined;
    expect(detail).toEqual({
      id: 'texra.desktop.showCommands',
      accelerator: 'Command+Shift+P',
    });
    window.removeEventListener(DESKTOP_SHORTCUT_EVENTS.UPDATE, update);
  });
});
