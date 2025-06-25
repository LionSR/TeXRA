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
  isOptionsVisible(options) {
    return options.style.display === 'block';
  }

  hasAnyChecked(checkboxIds) {
    return checkboxIds.some((id) => safeGetElementChecked(id));
  }

  setToggleIcon(toggle, icon, visible, active) {
    toggle.classList.toggle('active', active);
    toggle.innerHTML = `<i class="codicon codicon-${icon}"></i><i class="${
      visible ? CHEVRON_UP_CLASS : CHEVRON_DOWN_CLASS
    }"></i>`;
  }

  updateDropdownToggleState(toggleId, optionsId, checkboxIds, icon) {
    const toggle = safeGetElementById(toggleId);
    const options = safeGetElementById(optionsId);
    if (!toggle || !options) {
      console.warn(
        `[ToggleManager] Missing elements for ${toggleId} or ${optionsId}`,
      );
      return;
    }

    const visible = this.isOptionsVisible(options);
    const hasChecked = this.hasAnyChecked(checkboxIds);
    this.setToggleIcon(toggle, icon, visible, hasChecked);
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

      const toolConfigTargetInsideToggle =
        toggleToolConfig && toggleToolConfig.contains(e.target);
      const toolConfigTargetInsideOptions =
        toolConfigOptions && toolConfigOptions.contains(e.target);
      if (!toolConfigTargetInsideToggle && !toolConfigTargetInsideOptions) {
        if (toolConfigOptions) {
          toolConfigOptions.style.display = 'none';
          this.updateToolConfigToggleState();
        }
      }

      const autoExtractTargetInsideToggle =
        toggleAutoExtract && toggleAutoExtract.contains(e.target);
      const autoExtractTargetInsideOptions =
        autoExtractOptions && autoExtractOptions.contains(e.target);
      if (!autoExtractTargetInsideToggle && !autoExtractTargetInsideOptions) {
        if (autoExtractOptions) {
          autoExtractOptions.style.display = 'none';
          this.updateAutoToggleState();
        }
      }
    });
  }
}
