// Local imports - webview
import { INPUT_FILE, ELEMENT_IDS } from '../constants.js';
import { mainViewState } from '../mainViewState.js';
import { fileList } from './FileList.js';
import { fileSelect } from './FileSelect.js';
import {
  safeGetElementById,
  setChevronIcon,
  setExpandedState,
} from '@common/domUtils.js';

const INPUT_FILE_ID = INPUT_FILE;
const OUTPUT_FILES_ID = ELEMENT_IDS.OUTPUT_FILES;
const OUTPUT_FILES_CONTAINER_ID = ELEMENT_IDS.OUTPUT_FILES_CONTAINER;
const TOGGLE_OUTPUT_FILES_ID = ELEMENT_IDS.TOGGLE_OUTPUT_FILES;

/**
 * Manages output files UI logic.
 */
export class OutputFilesManager {
  constructor(state, list, select) {
    this.state = state;
    this.fileList = list;
    this.fileSelect = select;
  }

  /** Initialize the output files list with the input file */
  initializeOutputFiles() {
    const state = this.state.get();
    const inputFileDiv = safeGetElementById(INPUT_FILE_ID);
    const outputFilesDiv = safeGetElementById(OUTPUT_FILES_ID);
    if (!outputFilesDiv) return;

    outputFilesDiv.innerHTML = '';
    const inputFile = inputFileDiv?.value;

    // Determine initial files to display (priority order)
    const initialFiles = this._getInitialOutputFiles(state, inputFile);
    initialFiles.forEach((file) => this.fileList.add(OUTPUT_FILES_ID, file));

    // Add any opened files from workspace
    const openedFiles = state?.openedFiles ?? [];
    openedFiles.forEach((file) => this.fileList.add(OUTPUT_FILES_ID, file));

    // Show placeholder if empty
    if (outputFilesDiv.children.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.className = 'file-list-placeholder';
      placeholder.textContent =
        'No extra outputs selected. Click "Add" to choose files.';
      outputFilesDiv.appendChild(placeholder);
    }

    this.state.save();
  }

  /** Determine which files to initially show based on state priority */
  _getInitialOutputFiles(state, inputFile) {
    if (!inputFile) return [];

    // Priority 1: Previously saved output files
    if (state.outputFiles?.length > 0) {
      return state.outputFiles;
    }

    // Priority 2: Agent default output files
    const agentDefaults = this.fileSelect.getAgentDefaultOutputFiles();
    if (agentDefaults.length > 0) {
      return agentDefaults;
    }

    // Priority 3: Input file + additional input files
    const files = [inputFile];
    const additionalInputs =
      state.inputFiles?.filter((f) => f !== inputFile) ?? [];
    return files.concat(additionalInputs);
  }

  /** Toggle visibility of the output files container */
  toggleOutputFiles() {
    const container = safeGetElementById(OUTPUT_FILES_CONTAINER_ID);
    if (!container) return;

    const containerVisible = container.style.display !== 'none';

    if (!containerVisible) {
      this.initializeOutputFiles();
    }

    this.fileList.toggle(OUTPUT_FILES_ID, TOGGLE_OUTPUT_FILES_ID);
  }

  /** Initialize the output files container based on state */
  initializeOutputContainer() {
    const container = safeGetElementById(OUTPUT_FILES_CONTAINER_ID);
    const toggleIcon = safeGetElementById(TOGGLE_OUTPUT_FILES_ID);

    if (container && toggleIcon) {
      const state = this.state.get();
      const shouldShow = state && state.outputFilesActive;

      container.style.display = shouldShow ? 'block' : 'none';
      setChevronIcon(toggleIcon, shouldShow);
      setExpandedState(container, '.file-select', shouldShow);
    }
  }
}

export const outputFilesManager = new OutputFilesManager(
  mainViewState,
  fileList,
  fileSelect,
);
