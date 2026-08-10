import { render } from 'lit';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';

/**
 * Small icon-only close button shared by the desktop's imperative dialog
 * overlays (PDF, prompt) — each wires it to its own `dialog.open = false`
 * handler.
 */
function createDialogCloseButton(
  className: string,
  label: string,
  onClose: () => void,
): HTMLElement {
  const close = document.createElement('wa-button');
  close.classList.add(
    className,
    'desktop-overlay-close',
    'icon-button',
    'is-size-l',
    'focus-ring-inset',
  );
  close.setAttribute('appearance', 'plain');
  close.setAttribute('size', 's');
  close.setAttribute('type', 'button');
  close.setAttribute('aria-label', label);
  close.setAttribute('title', label);
  render(waIcon('xmark'), close);
  close.addEventListener('click', onClose);
  return close;
}

/**
 * Shared scaffolding for the desktop's imperative `wa-dialog` overlays
 * (PDF, prompt). Each overlay used to hand-build the same shell —
 * `withoutHeader` / `lightDismiss` / `aria-label`, a titled header,
 * an absolutely-positioned close button, and the `appRoot.append`. Centralizing
 * it keeps overlays owning only their content and behavior, and stops the
 * near-identical shells (and their `desktop-*` class families) from drifting.
 */
export interface OverlayDialogOptions {
  appRoot: HTMLElement;
  /**
   * CSS class family. Derives `${prefix}-overlay`, `${prefix}-close`,
   * `${prefix}-body` / `-header` / `-title` / `-subtitle`.
   */
  prefix: string;
  ariaLabel: string;
  closeLabel: string;
  /** The overlay's content element (PDF iframe, prompt form). */
  content: HTMLElement;
  /** Wraps `content` in a titled `<section>` header shell. */
  title: string;
}

export interface OverlayDialogHandle {
  dialog: WaDialog;
  titleEl: HTMLElement;
  subtitleEl: HTMLElement;
}

/** Build a closed wa-dialog shell with shared chrome and append it to `appRoot`. */
export function createOverlayDialog(
  options: OverlayDialogOptions,
): OverlayDialogHandle {
  const { prefix } = options;
  const dialog = document.createElement('wa-dialog') as WaDialog;
  dialog.classList.add(`${prefix}-overlay`);
  dialog.withoutHeader = true;
  dialog.lightDismiss = false;
  dialog.setAttribute('aria-label', options.ariaLabel);

  const body = document.createElement('section');
  body.classList.add(`${prefix}-body`);
  const header = document.createElement('header');
  header.classList.add(`${prefix}-header`);
  const titleEl = document.createElement('h2');
  titleEl.classList.add(`${prefix}-title`);
  titleEl.textContent = options.title;
  const subtitleEl = document.createElement('p');
  subtitleEl.classList.add(`${prefix}-subtitle`);
  header.append(titleEl, subtitleEl);
  body.append(header, options.content);
  dialog.append(body);

  dialog.append(
    createDialogCloseButton(`${prefix}-close`, options.closeLabel, () => {
      dialog.open = false;
    }),
  );
  options.appRoot.append(dialog);
  return { dialog, titleEl, subtitleEl };
}
