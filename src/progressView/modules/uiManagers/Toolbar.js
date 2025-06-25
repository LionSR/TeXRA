// Local imports
import { TOOLBAR_BUTTONS } from '../constants.js';
import { createIconButton } from '@common/templateUtils.js';

/**
 * Manages toolbar rendering.
 */
export class Toolbar {
  render() {
    const container = document.getElementById('toolbarContainer');
    if (!container) {
      console.error('Toolbar.render: toolbarContainer not found');
      return;
    }
    container.innerHTML = '';
    TOOLBAR_BUTTONS.forEach((def) => {
      try {
        const btn = createIconButton({
          id: def.id,
          icon: def.icon,
          title: def.title,
          className: def.className,
          disabled: def.disabled,
          dataset: { command: def.command },
        });
        container.appendChild(btn);
      } catch (error) {
        console.error('Toolbar.render: error creating button:', def.id, error);
      }
    });
  }
}
