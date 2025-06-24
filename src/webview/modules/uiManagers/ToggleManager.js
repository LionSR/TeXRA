import { safeGetElementById, safeGetElementChecked } from '@common/domUtils.js';
import {
  CHEVRON_UP_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/webviewContext.js';
import {
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
} from '../constants.js';

export class ToggleManager {
  updateDropdownToggleState(toggleId, optionsId, checkboxIds, icon) {
    const toggle = safeGetElementById(toggleId);
    const options = safeGetElementById(optionsId);
    const isVisible = options.style.display === 'block';

    const hasChecked = checkboxIds.some((id) => safeGetElementChecked(id));
    if (toggle) {
      toggle.classList.toggle('active', hasChecked);
      toggle.innerHTML = `<i class="codicon codicon-${icon}"></i><i class="${
        isVisible ? CHEVRON_UP_CLASS : CHEVRON_DOWN_CLASS
      }"></i>`;
    }
  }

  updateAutoToggleState() {
    this.updateDropdownToggleState(
      'toggleAutoExtract',
      'autoExtractOptions',
      CHECK_BOXES_AUTO_EXTRACT,
      'wand',
    );
  }

  updateToolConfigToggleState() {
    this.updateDropdownToggleState(
      'toggleToolConfig',
      'toolConfigOptions',
      CHECK_BOXES_TOOL_USE,
      'tools',
    );
  }

  setupDocumentListeners() {
    document.addEventListener('click', (e) => {
      const toolConfigOptions = safeGetElementById('toolConfigOptions');
      const autoExtractOptions = safeGetElementById('autoExtractOptions');
      const toggleToolConfig = safeGetElementById('toggleToolConfig');
      const toggleAutoExtract = safeGetElementById('toggleAutoExtract');

      if (
        !toggleToolConfig?.contains(e.target) &&
        !toolConfigOptions?.contains(e.target)
      ) {
        if (toolConfigOptions) {
          toolConfigOptions.style.display = 'none';
          this.updateToolConfigToggleState();
        }
      }
      if (
        !toggleAutoExtract?.contains(e.target) &&
        !autoExtractOptions?.contains(e.target)
      ) {
        if (autoExtractOptions) {
          autoExtractOptions.style.display = 'none';
          this.updateAutoToggleState();
        }
      }
    });
  }
}
