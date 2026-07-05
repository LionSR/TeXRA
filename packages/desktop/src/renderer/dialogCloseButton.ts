import { render } from 'lit';
import { waIcon } from '@shared/wa/webAwesomeIcons';

/**
 * Small icon-only close button shared by the desktop's imperative dialog
 * overlays (settings, diff, PDF) — each wires it to its own `dialog.open =
 * false` handler.
 */
export function createDialogCloseButton(
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
