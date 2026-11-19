import { render, type TemplateResult } from 'lit';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';

/**
 * Renders a Lit template into a detached element for the desktop's
 * imperative (non-Lit-component) DOM overlays — shared so the overlay
 * chrome can build its buttons through the same `@ui/wa` helpers as the
 * Lit-based renderer surfaces instead of hand-assembling `wa-button`
 * attributes.
 */
export function renderElement(template: TemplateResult): HTMLElement {
  const container = document.createElement('div');
  render(template, container);
  const element = container.firstElementChild;
  if (!(element instanceof HTMLElement))
    throw new Error('renderElement: template produced no HTML element');
  return element;
}

/**
 * Shared scaffolding for the desktop's imperative `wa-dialog` overlays
 * (Settings, prompt, discard): one shell — `withoutHeader` / `lightDismiss` /
 * `aria-label`, a titled header with an aligned close button, and the
 * `appRoot.append` — so each overlay owns only its content and behavior.
 * Every shell carries the one `desktop-overlay` class family; `prefix` names
 * the overlay for its own layout and for tests.
 */
interface OverlayDialogOptions {
  appRoot: HTMLElement;
  /** Derives the dialog's `${prefix}-overlay` and its `${prefix}-close`. */
  prefix: string;
  ariaLabel: string;
  closeLabel: string;
  /** The overlay's content element (settings view, prompt form). */
  content: HTMLElement;
  /** Wraps `content` in a titled `<section>` header shell. */
  title: string;
}

interface OverlayDialogHandle {
  dialog: WaDialog;
  titleEl: HTMLElement;
}

/** Build a closed wa-dialog shell with shared chrome and append it to `appRoot`. */
export function createOverlayDialog(
  options: OverlayDialogOptions,
): OverlayDialogHandle {
  const { prefix } = options;
  const dialog = document.createElement('wa-dialog');
  dialog.classList.add('desktop-overlay', `${prefix}-overlay`);
  dialog.withoutHeader = true;
  dialog.lightDismiss = false;
  dialog.setAttribute('aria-label', options.ariaLabel);

  const body = document.createElement('section');
  body.classList.add('desktop-overlay-body');
  const header = document.createElement('header');
  header.classList.add('desktop-overlay-header');
  const titleEl = document.createElement('h2');
  titleEl.classList.add('desktop-overlay-title');
  titleEl.textContent = options.title;
  header.append(
    titleEl,
    renderElement(
      renderIconActionButton({
        icon: 'xmark',
        label: options.closeLabel,
        size: 's',
        className: `${prefix}-close icon-button focus-ring-inset`,
        onClick: () => {
          dialog.open = false;
        },
      }),
    ),
  );
  body.append(header, options.content);
  dialog.append(body);

  options.appRoot.append(dialog);
  return { dialog, titleEl };
}
