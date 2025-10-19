// Local imports - progress view
// Local imports
import { TOOLBAR_BUTTONS, ELEMENT_IDS } from '../constants.js';
import { createIconButton } from '@common/templateUtils.js';

/**
 * Manages toolbar rendering.
 */
export class Toolbar {
  render(sessionKind = 'workflow') {
    const container = document.getElementById(ELEMENT_IDS.TOOLBAR_CONTAINER);
    if (!container) {
      console.error('Toolbar.render: toolbarContainer not found');
      return;
    }
    container.innerHTML = '';
    const buttons = TOOLBAR_BUTTONS[sessionKind] ?? TOOLBAR_BUTTONS.workflow;
    container.dataset.agentMode = sessionKind;
    buttons.forEach((def) => {
      try {
        const dataset = { command: def.command, ...(def.dataset ?? {}) };
        const btn = createIconButton({
          id: def.id,
          icon: def.icon,
          title: def.title,
          className: def.className,
          disabled: def.disabled,
          dataset,
        });
        if (btn) {
          container.appendChild(btn);
        } else {
          console.error('Toolbar.render: button creation returned null:', def.id);
        }
      } catch (error) {
        console.error('Toolbar.render: error creating button:', def.id, error);
      }
    });
  }
}
