import { WebviewStateManager } from '@common/webviewState.js';
import {
  MULTIPLE_SELECTIONS,
  CHECK_BOXES,
  VALUE_ELEMENTS,
  CHECK_BOXES_TOOL_USE,
  CHECK_BOXES_AUTO_EXTRACT,
} from './constants.js';
import { fileList } from './uiManagers/FileList.js';
import {
  CHEVRON_UP_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/webviewContext.js';
import {
  safeGetElementValue,
  safeGetElementById,
  safeGetElementChecked,
  safeSetElementValue,
  safeSetElementChecked,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';

/**
 * Manages persistent state for the webview.
 */
export class WebviewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
  }

  get() {
    return this.stateManager.getState();
  }

  set(state) {
    this.stateManager.setState(state);
  }

  update(partial) {
    this.stateManager.update(partial);
  }

  /** Initialize UI with default state */
  setDefaults() {
    const autoExtractToggle = safeGetElementById('toggleAutoExtract');
    const autoExtractOptions = safeGetElementById('autoExtractOptions');
    if (autoExtractToggle && autoExtractOptions) {
      autoExtractToggle.classList.remove('active');
      autoExtractToggle.innerHTML = `<i class="codicon codicon-wand"></i><i class="${CHEVRON_DOWN_CLASS}"></i>`;
      autoExtractOptions.style.display = 'none';
    }

    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      fileList.setVisibility(id, toggleId, false);
      const listDiv = safeGetElementById(id);
      if (listDiv) {
        listDiv.innerHTML = '';
      }
    });

    const latexdiffsContent = safeGetElementById('latexdiffsContent');
    const toggleLatexdiffs = safeGetElementById('toggleLatexdiffs');
    if (latexdiffsContent && toggleLatexdiffs) {
      latexdiffsContent.style.display = 'none';
      toggleLatexdiffs.innerHTML = `<i class="${CHEVRON_DOWN_CLASS}"></i>`;
    }

    this.save();
  }

  /** Restore state from VS Code storage */
  restore() {
    const previousState = this.stateManager.getState();
    if (previousState) {
      const defaults = { agent: 'correct', commit: 'HEAD' };

      VALUE_ELEMENTS.forEach((id) => {
        safeSetElementValue(id, previousState[id] ?? defaults[id] ?? '');
      });

      CHECK_BOXES.forEach((id) => {
        safeSetElementChecked(id, previousState[id] ?? false);
      });

      const autoExtractToggle = safeGetElementById('toggleAutoExtract');
      const autoExtractOptions = safeGetElementById('autoExtractOptions');
      const hasAutoExtractChecked = CHECK_BOXES_AUTO_EXTRACT.some((id) =>
        safeGetElementChecked(id),
      );
      if (autoExtractToggle && autoExtractOptions) {
        autoExtractToggle.classList.toggle('active', hasAutoExtractChecked);
        autoExtractToggle.innerHTML = `<i class="codicon codicon-wand"></i><i class="${CHEVRON_DOWN_CLASS}"></i>`;
        autoExtractOptions.style.display = 'none';
      }

      const toggleToolConfig = safeGetElementById('toggleToolConfig');
      const toolConfigOptions = safeGetElementById('toolConfigOptions');
      const hasToolConfigChecked = CHECK_BOXES_TOOL_USE.some((id) =>
        safeGetElementChecked(id),
      );
      if (toggleToolConfig && toolConfigOptions) {
        toggleToolConfig.classList.toggle('active', hasToolConfigChecked);
        toggleToolConfig.innerHTML = `<i class="codicon codicon-tools"></i><i class="${CHEVRON_DOWN_CLASS}"></i>`;
        toolConfigOptions.style.display = 'none';
      }

      MULTIPLE_SELECTIONS.forEach((id) => {
        const toggleId = `toggle${capitalize(id)}`;
        const selectDiv = safeGetElementById(id);
        if (!selectDiv) {
          console.warn(`Element with id '${id}' not found`);
          return;
        }
        selectDiv.innerHTML = '';

        const filesArray = previousState[id] ?? [];
        const isVisible = previousState[`${id}Visible`];

        if (filesArray && filesArray.length > 0) {
          filesArray.forEach((file) => {
            fileList.add(id, file);
          });
          fileList.setVisibility(
            id,
            toggleId,
            isVisible !== undefined ? isVisible : true,
          );
        } else {
          fileList.setVisibility(id, toggleId, false);
        }
      });

      const latexdiffsContent = safeGetElementById('latexdiffsContent');
      const toggleLatexdiffs = safeGetElementById('toggleLatexdiffs');
      if (latexdiffsContent && toggleLatexdiffs) {
        const visible = previousState.latexdiffsVisible ?? false;
        latexdiffsContent.style.display = visible ? 'block' : 'none';
        toggleLatexdiffs.innerHTML = `<i class="${
          visible ? CHEVRON_UP_CLASS : CHEVRON_DOWN_CLASS
        }"></i>`;
      }
    } else {
      this.setDefaults();
    }

    fileList.hideEmpty(MULTIPLE_SELECTIONS);
  }

  /** Persist current UI state */
  save() {
    const state = {
      latexdiffsVisible:
        safeGetElementById('latexdiffsContent')?.style.display === 'block',
    };

    VALUE_ELEMENTS.forEach((id) => {
      const value = safeGetElementValue(id);
      if (value !== undefined) {
        state[id] = value;
      }
    });

    CHECK_BOXES.forEach((id) => {
      state[id] = safeGetElementChecked(id);
    });

    MULTIPLE_SELECTIONS.forEach((id) => {
      const elementDiv = safeGetElementById(id);
      if (!elementDiv) return;
      const containerDiv = safeGetElementById(`${id}Container`);
      state[`${id}Visible`] =
        containerDiv && containerDiv.style.display === 'block';
      state[id] = fileList.getSelected(elementDiv);
    });

    this.stateManager.setState(state);
  }
}

export const webviewState = new WebviewState();
