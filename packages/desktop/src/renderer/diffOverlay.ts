import { render } from 'lit';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import type { DesktopShowDiffMessage } from '../desktopDiffMessages';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';

interface DiffViewElement extends HTMLElement {
  originalText: string;
  proposedText: string;
  language: string;
}

export interface DiffOverlayController {
  open(payload: DesktopShowDiffMessage): void;
  close(): void;
}

export function createDiffOverlay(appRoot: HTMLElement): DiffOverlayController {
  let dialog: WaDialog | null = null;
  let viewEl: DiffViewElement | null = null;
  let titleEl: HTMLElement | null = null;
  let subtitleEl: HTMLElement | null = null;

  function ensure(): WaDialog {
    if (dialog) return dialog;
    const d = document.createElement('wa-dialog') as WaDialog;
    d.classList.add('desktop-diff-overlay');
    d.withoutHeader = true;
    d.lightDismiss = false;
    d.setAttribute('aria-label', 'Compare files');

    const body = document.createElement('section');
    body.classList.add('desktop-diff-body');

    const header = document.createElement('header');
    header.classList.add('desktop-diff-header');
    const t = document.createElement('h2');
    t.classList.add('desktop-diff-title');
    t.textContent = 'Compare';
    titleEl = t;
    const s = document.createElement('p');
    s.classList.add('desktop-diff-subtitle');
    subtitleEl = s;
    header.append(t, s);

    // Lazily create the <texra-diff-view> on first show (Monaco is heavy
    // to import; defer until actually needed). The element is reused
    // across re-opens — Lit's @property setter handles content swaps.
    const view = document.createElement('texra-diff-view') as DiffViewElement;
    view.classList.add('desktop-diff-view');
    viewEl = view;

    body.append(header, view);
    d.append(body);

    const close = document.createElement('wa-button');
    close.classList.add('desktop-diff-close');
    close.setAttribute('appearance', 'plain');
    close.setAttribute('size', 'small');
    close.setAttribute('aria-label', 'Close diff');
    close.setAttribute('title', 'Close diff');
    render(waIcon('xmark'), close);
    close.addEventListener('click', () => {
      d.open = false;
    });
    d.append(close);

    appRoot.append(d);
    dialog = d;
    return d;
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

  return { open, close };
}
