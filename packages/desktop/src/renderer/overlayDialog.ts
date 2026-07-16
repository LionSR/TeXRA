import { render } from 'lit';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';

/**
 * Small icon-only close button shared by the desktop's imperative dialog
 * overlays (settings, diff, PDF) — each wires it to its own `dialog.open =
 * false` handler.
 */
function createDialogCloseButton(
  className: string,
  label: string,
  onClose: () => void,
): HTMLElement {
  const close = document.createElement('wa-button');
  close.classList.add(className);
  close.setAttribute('appearance', 'plain');
  close.setAttribute('size', 'small');
  close.setAttribute('aria-label', label);
  close.setAttribute('title', label);
  render(waIcon('xmark'), close);
  close.addEventListener('click', onClose);
  return close;
}

/**
 * Shared scaffolding for the desktop's imperative `wa-dialog` overlays
 * (settings, diff, PDF). Each overlay used to hand-build the same shell —
 * `withoutHeader` / `lightDismiss` / `aria-label`, an optional titled header,
 * an absolutely-positioned close button, and the `appRoot.append`. Centralizing
 * it keeps overlays owning only their content and behavior, and stops the
 * near-identical shells (and their `desktop-*` class families) from drifting.
 */
export interface OverlayDialogOptions {
  appRoot: HTMLElement;
  /**
   * CSS class family. Derives `${prefix}-overlay` and `${prefix}-close`, plus
   * `${prefix}-body` / `-header` / `-title` / `-subtitle` when `title` is set.
   */
  prefix: string;
  ariaLabel: string;
  closeLabel: string;
  /** The overlay's content element (iframe, diff view, settings-app). */
  content: HTMLElement;
  /** When set, wraps `content` in a titled `<section>` header shell. */
  title?: string;
  /** Use Web Awesome's accessible header and built-in close control. */
  nativeHeader?: boolean;
  /** Extra attributes to set on the dialog (e.g. `data-route-button`). */
  attributes?: Record<string, string>;
}

export interface OverlayDialogHandle {
  dialog: WaDialog;
  /** Present only when `title` was supplied (the diff/PDF header overlays). */
  titleEl?: HTMLElement;
  subtitleEl?: HTMLElement;
}

/** Build a closed wa-dialog shell with shared chrome and append it to `appRoot`. */
export function createOverlayDialog(
  options: OverlayDialogOptions,
): OverlayDialogHandle {
  const { prefix } = options;
  const dialog = document.createElement('wa-dialog') as WaDialog;
  dialog.classList.add(`${prefix}-overlay`);
  dialog.withoutHeader = options.nativeHeader !== true;
  dialog.label = options.title ?? options.ariaLabel;
  dialog.lightDismiss = false;
  dialog.setAttribute('aria-label', options.ariaLabel);
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    dialog.setAttribute(name, value);
  }

  let titleEl: HTMLElement | undefined;
  let subtitleEl: HTMLElement | undefined;
  if (options.title == null || options.nativeHeader) {
    dialog.append(options.content);
  } else {
    const body = document.createElement('section');
    body.classList.add(`${prefix}-body`);
    const header = document.createElement('header');
    header.classList.add(`${prefix}-header`);
    titleEl = document.createElement('h2');
    titleEl.classList.add(`${prefix}-title`);
    titleEl.textContent = options.title;
    subtitleEl = document.createElement('p');
    subtitleEl.classList.add(`${prefix}-subtitle`);
    header.append(titleEl, subtitleEl);
    body.append(header, options.content);
    dialog.append(body);
  }

  if (!options.nativeHeader) {
    dialog.append(
      createDialogCloseButton(`${prefix}-close`, options.closeLabel, () => {
        dialog.open = false;
      }),
    );
  }
  options.appRoot.append(dialog);
  return { dialog, titleEl, subtitleEl };
}
