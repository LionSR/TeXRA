// Local imports - webview
import {
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
  ELEMENT_IDS,
} from '../constants.js';
import {
  safeGetElementById,
  safeGetElementChecked,
  setChevronIcon,
} from '@common/domUtils.js';
import { createCodicon } from '@common/templateUtils.js';

export class ToggleManager {
  isOptionsVisible(options) {
    return options.style.display === 'block';
  }

  hasAnyChecked(checkboxIds) {
    return checkboxIds.some((id) => safeGetElementChecked(id));
  }

  setToggleIcon(toggle, icon, visible, active) {
    toggle.classList.toggle('active', active);
    toggle.innerHTML = '';
    const iconEl = createCodicon(icon);
    const chevron = createCodicon('chevron-down');
    if (iconEl) toggle.appendChild(iconEl);
    if (chevron) {
      setChevronIcon(chevron, visible);
      toggle.appendChild(chevron);
    }
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
      ELEMENT_IDS.TOGGLE_AUTO_EXTRACT,
      ELEMENT_IDS.AUTO_EXTRACT_OPTIONS,
      CHECK_BOXES_AUTO_EXTRACT,
      'wand',
    );
  }

  updateToolConfigToggleState() {
    this.updateDropdownToggleState(
      ELEMENT_IDS.TOGGLE_TOOL_CONFIG,
      ELEMENT_IDS.TOOL_CONFIG_OPTIONS,
      CHECK_BOXES_TOOL_USE,
      'tools',
    );
  }

  setupDocumentListeners() {
    document.addEventListener('click', (e) => {
      const autoExtractOptions = safeGetElementById(
        ELEMENT_IDS.AUTO_EXTRACT_OPTIONS,
      );
      const toggleAutoExtract = safeGetElementById(
        ELEMENT_IDS.TOGGLE_AUTO_EXTRACT,
      );

      if (
        !toggleAutoExtract?.contains(e.target) &&
        !autoExtractOptions?.contains(e.target)
      ) {
        if (autoExtractOptions) {
          autoExtractOptions.style.display = 'none';
          this.updateAutoToggleState();
        }
      }

      const toolConfigOptions = safeGetElementById(
        ELEMENT_IDS.TOOL_CONFIG_OPTIONS,
      );
      const toggleToolConfig = safeGetElementById(
        ELEMENT_IDS.TOGGLE_TOOL_CONFIG,
      );

      if (
        !toggleToolConfig?.contains(e.target) &&
        !toolConfigOptions?.contains(e.target)
      ) {
        if (toolConfigOptions) {
          toolConfigOptions.style.display = 'none';
          this.updateToolConfigToggleState();
        }
      }
    });
  }
}
