// Local imports - webview
import {
  MULTIPLE_SELECTIONS,
  CHECK_BOXES,
  VALUE_ELEMENTS,
  CHECK_BOXES_TOOL_USE,
  CHECK_BOXES_AUTO_EXTRACT,
  ELEMENT_IDS,
} from './constants.js';
import { fileList } from './uiManagers/FileList.js';
import {
  safeGetElementValue,
  safeGetElementById,
  safeGetElementChecked,
  safeSetElementValue,
  safeSetElementChecked,
  setChevronIcon,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { CHEVRON_DOWN_CLASS } from '@common/iconConstants.js';
import { WebviewStateManager } from '@common/webviewState.js';

/**
 * Manages persistent state for the main webview.
 */
export class MainViewState {
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
    const autoExtractToggle = safeGetElementById(
      ELEMENT_IDS.TOGGLE_AUTO_EXTRACT,
    );
    const autoExtractOptions = safeGetElementById(
      ELEMENT_IDS.AUTO_EXTRACT_OPTIONS,
    );
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

    const latexdiffsContent = safeGetElementById(
      ELEMENT_IDS.LATEXDIFFS_CONTENT,
    );
    const toggleLatexdiffs = safeGetElementById(ELEMENT_IDS.TOGGLE_LATEXDIFFS);
    if (latexdiffsContent && toggleLatexdiffs) {
      latexdiffsContent.style.display = 'none';
      setChevronIcon(toggleLatexdiffs, false);
    }

    this.save();
  }

  /** Restore state from VS Code storage */
  restore() {
    const previousState = this.stateManager.getState();
    if (previousState) {
      const defaults = { agent: 'correct', model: 'gemini25p', commit: 'HEAD' };

      VALUE_ELEMENTS.forEach((id) => {
        safeSetElementValue(id, previousState[id] ?? defaults[id] ?? '');
      });

      CHECK_BOXES.forEach((id) => {
        safeSetElementChecked(id, previousState[id] ?? false);
      });

      const autoExtractToggle = safeGetElementById(
        ELEMENT_IDS.TOGGLE_AUTO_EXTRACT,
      );
      const autoExtractOptions = safeGetElementById(
        ELEMENT_IDS.AUTO_EXTRACT_OPTIONS,
      );
      const hasAutoExtractChecked = CHECK_BOXES_AUTO_EXTRACT.some((id) =>
        safeGetElementChecked(id),
      );
      if (autoExtractToggle && autoExtractOptions) {
        autoExtractToggle.classList.toggle('active', hasAutoExtractChecked);
        autoExtractToggle.innerHTML = `<i class="codicon codicon-wand"></i><i class="${CHEVRON_DOWN_CLASS}"></i>`;
        autoExtractOptions.style.display = 'none';
      }

      const toggleToolConfig = safeGetElementById(
        ELEMENT_IDS.TOGGLE_TOOL_CONFIG,
      );
      const toolConfigOptions = safeGetElementById(
        ELEMENT_IDS.TOOL_CONFIG_OPTIONS,
      );
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

      const latexdiffsContent = safeGetElementById(
        ELEMENT_IDS.LATEXDIFFS_CONTENT,
      );
      const toggleLatexdiffs = safeGetElementById(
        ELEMENT_IDS.TOGGLE_LATEXDIFFS,
      );
      if (latexdiffsContent && toggleLatexdiffs) {
        const visible = previousState.latexdiffsVisible ?? false;
        latexdiffsContent.style.display = visible ? 'block' : 'none';
        setChevronIcon(toggleLatexdiffs, visible);
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
        safeGetElementById(ELEMENT_IDS.LATEXDIFFS_CONTENT)?.style.display ===
        'block',
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

export const mainViewState = new MainViewState();
fileList.setSaveFn(() => mainViewState.save());
