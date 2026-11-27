import { Result, Schema } from 'effect';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@ui/settings';
import { html, render } from 'lit';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import { readSelectValue } from '@ui/wa/selectTemplates';
import { resolvePostMessageTargetOrigin } from '../shared/postMessageOrigin';

import { createOverlayDialog } from './overlayDialog';

interface DesktopSettingsDialog {
  open(tab?: SettingsTarget): void;
  close(): void;
  /** Swap in a fresh view after the active project changed. */
  remount(): void;
}

export const DesktopThemePreferenceSchema = Schema.Literals([
  'system',
  'light',
  'dark',
]);
type ThemePreference = typeof DesktopThemePreferenceSchema.Type;

/**
 * Settings as a popup over the shell. The one `<settings-app>` is mounted on
 * first open and stays in the dialog afterwards, so its state survives
 * closing and reopening. Its settings IPC is per project, so a project switch
 * replaces it with a new `<settings-app>`: the constructor resets the
 * module-level settings state, and connecting posts the `webviewReady` the new
 * project's IPC answers with its snapshot, so no control shows the previous
 * project's values while that snapshot loads.
 */
export function createDesktopSettingsDialog(
  appRoot: HTMLElement,
  hooks: {
    getTheme(): ThemePreference;
    setTheme(theme: ThemePreference): void;
  },
): DesktopSettingsDialog {
  const content = document.createElement('div');
  content.classList.add('desktop-settings-content');
  const createSettingsView = (): HTMLElement => {
    const view = document.createElement('settings-app');
    view.setAttribute('data-desktop-view', 'settings');
    const appearance = document.createElement('section');
    appearance.slot = 'appearance';
    render(
      html`
        <div class="settings-row">
          <div class="settings-row-text">
            <label for="desktopTheme" class="settings-row-label">Theme</label>
            <span id="desktopThemeHelp" class="settings-row-help">
              Match your OS or pick a fixed appearance.
            </span>
          </div>
          <div class="settings-row-control">
            <wa-select
              id="desktopTheme"
              size="s"
              aria-describedby="desktopThemeHelp"
              .value=${hooks.getTheme()}
              @change=${(event: Event) => {
                const result = Schema.decodeUnknownResult(
                  DesktopThemePreferenceSchema,
                )(readSelectValue(event));
                if (Result.isSuccess(result)) hooks.setTheme(result.success);
              }}
            >
              <wa-option value="system">System</wa-option>
              <wa-option value="light">Light</wa-option>
              <wa-option value="dark">Dark</wa-option>
            </wa-select>
          </div>
        </div>
      `,
      appearance,
    );
    view.append(appearance);
    return view;
  };
  let settingsView = createSettingsView();

  const { dialog } = createOverlayDialog({
    appRoot,
    prefix: 'desktop-settings',
    closeLabel: 'Close settings',
    title: 'Settings',
    content,
  });
  dialog.lightDismiss = true;

  return {
    open(tab) {
      if (!settingsView.isConnected) content.append(settingsView);
      dialog.open = true;
      if (tab == null) return;
      // The view's own listener selects the tab, as for a host push.
      window.postMessage(
        { command: SETTINGS_VIEW_COMMANDS.SET_TAB, tab },
        resolvePostMessageTargetOrigin(window.location.origin),
      );
    },
    close: () => {
      dialog.open = false;
    },
    remount() {
      if (!settingsView.isConnected) return;
      const next = createSettingsView();
      settingsView.replaceWith(next);
      settingsView = next;
    },
  };
}
