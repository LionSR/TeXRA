// Local imports - progress view
import { TOOLBAR_BUTTONS, ELEMENT_IDS } from '../constants.js';
// Local imports - common helpers
import { safeGetElementById } from '@common/domUtils.js';
import { createIconButton } from '@common/templateUtils.js';

/**
 * Manages toolbar rendering.
 */
export class Toolbar {
  /**
   * @param {import('./Status.js').Status} [status] - Optional Status instance to notify on render
   */
  constructor(status) {
    this._status = status;
  }

  render(agentCategory = 'workflow') {
    const container = safeGetElementById(ELEMENT_IDS.TOOLBAR_CONTAINER);
    if (!container) {
      console.error('Toolbar.render: toolbarContainer not found');
      return;
    }
    container.innerHTML = '';
    const buttons = TOOLBAR_BUTTONS[agentCategory] ?? TOOLBAR_BUTTONS.workflow;
    const buttonIds = buttons.map((btn) => btn.id);
    container.dataset.agentMode = agentCategory;
    // Notify Status of new button IDs to keep them in sync
    this._status?.setCurrentButtonIds(buttonIds);
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
          console.error(
            'Toolbar.render: button creation returned null:',
            def.id,
          );
        }
      } catch (error) {
        console.error('Toolbar.render: error creating button:', def.id, error);
      }
    });
  }
}
