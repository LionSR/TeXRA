import {
  DESKTOP_THEME_KIND,
  type DesktopThemeKind,
} from '@shared/schemas/commonViewMessages';
import { createOverlayDialog } from './overlayDialog';
import type { DesktopShowDiffMessage } from '../desktopDiffMessages';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';

interface DiffViewElement extends HTMLElement {
  originalText: string;
  proposedText: string;
  language: string;
  hostTheme: string;
}

export interface DiffOverlayController {
  open(payload: DesktopShowDiffMessage): void;
  close(): void;
  setTheme(theme: DesktopThemeKind): void;
}

export function createDiffOverlay(appRoot: HTMLElement): DiffOverlayController {
  let dialog: WaDialog | null = null;
  let viewEl: DiffViewElement | null = null;
  let titleEl: HTMLElement | null = null;
  let subtitleEl: HTMLElement | null = null;
  let currentTheme: DesktopThemeKind = DESKTOP_THEME_KIND.DARK;

  function ensure(): WaDialog {
    if (dialog) return dialog;
    // Lazily create the <texra-diff-view> on first show (Monaco is heavy
    // to import; defer until actually needed). The element is reused
    // across re-opens — Lit's @property setter handles content swaps.
    const view = document.createElement('texra-diff-view') as DiffViewElement;
    view.classList.add('desktop-diff-view');
    view.hostTheme = currentTheme;
    viewEl = view;

    const shell = createOverlayDialog({
      appRoot,
      prefix: 'desktop-diff',
      ariaLabel: 'Compare files',
      closeLabel: 'Close diff',
      title: 'Compare',
      content: view,
    });
    titleEl = shell.titleEl ?? null;
    subtitleEl = shell.subtitleEl ?? null;
    dialog = shell.dialog;
    return dialog;
  }

  function open(payload: DesktopShowDiffMessage): void {
    const d = ensure();
    if (titleEl) titleEl.textContent = payload.title;
    if (subtitleEl) {
      // Show the proposed path (the file the user is reviewing) — fall back
      // to the original or empty string. Purely informative.
      subtitleEl.textContent =
        payload.proposedPath ?? payload.originalPath ?? '';
    }
    if (viewEl) {
      viewEl.originalText = payload.originalText;
      viewEl.proposedText = payload.proposedText;
      viewEl.language = payload.language;
    }
    d.open = true;
  }

  function close(): void {
    if (dialog) dialog.open = false;
  }

  function setTheme(theme: DesktopThemeKind): void {
    currentTheme = theme;
    if (viewEl) viewEl.hostTheme = theme;
  }

  return { open, close, setTheme };
}
