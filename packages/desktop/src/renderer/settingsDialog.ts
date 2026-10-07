import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@settingsView/frontend';
import { html, render } from 'lit';
import { z } from 'zod';
import type { SettingsTarget } from '@shared/settingsView/settingsViewMessages';
import { resolvePostMessageTargetOrigin } from '@shared/postMessageOrigin';
import { readSelectValue } from '@ui/wa/selectTemplates';

import { buildDesktopSettingsTabMessage } from '../shared/desktopCommandSurface';
import { createOverlayDialog } from './overlayDialog';

interface DesktopSettingsDialog {
  open(tab?: SettingsTarget): void;
  isOpen(): boolean;
  /** Swap in a fresh view after the active project changed. */
  remount(): void;
}

export const DesktopThemePreferenceSchema = z.enum(['system', 'light', 'dark']);
type ThemePreference = z.infer<typeof DesktopThemePreferenceSchema>;

/**
 * Settings as a popup over the shell. The one `<settings-app>` is mounted on
 * first open and stays in the dialog afterwards, so its state survives
 * closing and reopening. Its settings IPC is per project, so a project switch
 * replaces it with a new `<settings-app>`: the constructor resets the
 * module-level settings state, and connecting posts the `webviewReady` the new
 * project's IPC answers with its snapshot, so no control shows the previous
 * project's values while that snapshot loads. `onShown` / `onHidden` let
 * the shell hide the native browser view while the dialog is up: a
 * WebContentsView paints over renderer DOM, the dialog included.
 */
export function createDesktopSettingsDialog(
  appRoot: HTMLElement,
  hooks: {
    onShown(): void;
    onHidden(): void;
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
              Choose light or dark, or follow your system appearance.
            </span>
          </div>
          <div class="settings-row-control">
            <wa-select
              id="desktopTheme"
              size="s"
              aria-describedby="desktopThemeHelp"
              .value=${hooks.getTheme()}
              @change=${(event: Event) => {
                const result = DesktopThemePreferenceSchema.safeParse(
                  readSelectValue(event),
                );
                if (result.success) hooks.setTheme(result.data);
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

  const { dialog, subtitleEl } = createOverlayDialog({
    appRoot,
    prefix: 'desktop-settings',
    ariaLabel: 'Settings',
    closeLabel: 'Close settings',
    title: 'Settings',
    content,
  });
  subtitleEl.hidden = true;
  dialog.lightDismiss = true;
  // Nested WebAwesome popups (selects, dropdowns) inside the settings view
  // emit their own show/hide events, which bubble; only the dialog's count.
  dialog.addEventListener('wa-show', (event) => {
    if (event.target === dialog) hooks.onShown();
  });
  dialog.addEventListener('wa-after-hide', (event) => {
    if (event.target === dialog) hooks.onHidden();
  });

  return {
    open(tab) {
      if (!settingsView.isConnected) content.append(settingsView);
      dialog.open = true;
      if (tab == null) return;
      window.postMessage(
        buildDesktopSettingsTabMessage(tab),
        resolvePostMessageTargetOrigin(window.location.origin),
      );
    },
    isOpen: () => dialog.open,
    remount() {
      if (!settingsView.isConnected) return;
      const next = createSettingsView();
      settingsView.replaceWith(next);
      settingsView = next;
    },
  };
}
