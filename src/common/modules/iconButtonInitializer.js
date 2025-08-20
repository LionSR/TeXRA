// Local imports - common
// Local imports
import { createIconButton } from '@common/templateUtils.js';

/**
 * Replace buttons with a `data-icon` attribute using icon button templates.
 * The original button's id, title, class, disabled state, and dataset
 * (excluding the `icon` value) are preserved. Any text inside the button is
 * appended after the generated icon element.
 *
 * @param {Document|HTMLElement} scope - Element to search within.
 */
export function initializeIconButtons(scope = document) {
  const buttons = scope.querySelectorAll('button[data-icon]');
  buttons.forEach((btn) => {
    const icon = btn.dataset.icon;
    if (!icon) return;

    const { id, title, className, disabled } = btn;
    const dataset = { ...btn.dataset };
    delete dataset.icon;

    const newBtn = createIconButton({
      id,
      icon,
      title: title || '',
      className: className || '',
      disabled: disabled || false,
      dataset,
    });
    if (!newBtn) return;

    const text = btn.textContent.trim();
    btn.replaceWith(newBtn);
    if (text) newBtn.append(' ', text);
  });
}
