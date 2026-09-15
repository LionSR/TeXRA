import { render, type TemplateResult } from 'lit';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';

/**
 * Renders a Lit template into a detached element for the desktop's
 * imperative (non-Lit-component) DOM overlays — shared so the overlay
 * chrome can build its buttons through the same `@shared/wa` helpers as the
 * Lit-based renderer surfaces instead of hand-assembling `wa-button`
 * attributes.
 */
export function renderElement(template: TemplateResult): HTMLElement {
  const container = document.createElement('div');
  render(template, container);
  const element = container.firstElementChild;
  if (!element) throw new Error('renderElement: template produced no element');
  return element as HTMLElement;
}

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
  return renderElement(
    renderIconActionButton({
      icon: 'xmark',
      label,
      size: 'l',
      className: `${className} desktop-overlay-close icon-button focus-ring-inset`,
      onClick: onClose,
    }),
  );
}

/**
 * Shared scaffolding for the desktop's imperative `wa-dialog` overlays
 * (PDF, prompt): one shell — `withoutHeader` / `lightDismiss` / `aria-label`,
 * a titled header, an absolutely-positioned close button, and the
 * `appRoot.append` — so each overlay owns only its content and behavior and
 * the near-identical shells (and their `desktop-*` class families) cannot
 * drift.
 */
interface OverlayDialogOptions {
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

interface OverlayDialogHandle {
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
