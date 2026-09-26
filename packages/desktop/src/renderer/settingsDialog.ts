import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@settingsView/frontend';
import type { AgentCategory } from '@shared/schemas';
import type { SettingsTarget } from '@shared/settingsView/settingsViewMessages';
import { resolvePostMessageTargetOrigin } from '@shared/postMessageOrigin';

import { buildDesktopSettingsTabMessage } from '../shared/desktopCommandSurface';
import { createOverlayDialog } from './overlayDialog';

interface DesktopSettingsDialog {
  open(tab?: SettingsTarget, agentSubTab?: AgentCategory): void;
}

/**
 * Settings as a popup over the shell. The one `<settings-app>` is mounted on
 * first open and stays in the dialog afterwards, so its state survives
 * closing and reopening. `onShown` / `onHidden` let the shell hide the native
 * browser view while the dialog is up: a WebContentsView paints over renderer
 * DOM, the dialog included.
 */
export function createDesktopSettingsDialog(
  appRoot: HTMLElement,
  hooks: { onShown(): void; onHidden(): void },
): DesktopSettingsDialog {
  const content = document.createElement('div');
  content.classList.add('desktop-settings-content');
  const settingsView = document.createElement('settings-app');
  settingsView.setAttribute('data-desktop-view', 'settings');

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
    open(tab, agentSubTab) {
      if (!settingsView.isConnected) content.append(settingsView);
      dialog.open = true;
      if (tab == null) return;
      window.postMessage(
        buildDesktopSettingsTabMessage(tab, agentSubTab),
        resolvePostMessageTargetOrigin(window.location.origin),
      );
    },
  };
}
