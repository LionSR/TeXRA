// Local imports
import { safeGetElementById, updateChevronIcon } from '@common/domUtils.js';

import { mainViewState } from '../mainViewState.js';
import { fileList } from './FileList.js';
import { fileSelect } from './FileSelect.js';
import { INPUT_FILE, ELEMENT_IDS } from '../constants.js';

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

    if (inputFile) {
      if (state.outputFiles && state.outputFiles.length > 0) {
        state.outputFiles.forEach((file) => {
          this.fileList.add(OUTPUT_FILES_ID, file);
        });
      } else if (
        this.fileSelect.getAgentDefaultOutputFiles().length > 0 &&
        (!state.outputFiles || state.outputFiles.length === 0)
      ) {
        this.fileSelect.getAgentDefaultOutputFiles().forEach((file) => {
          this.fileList.add(OUTPUT_FILES_ID, file);
        });
      } else {
        this.fileList.add(OUTPUT_FILES_ID, inputFileDiv?.value);
        if (state.inputFiles && state.inputFiles.length > 0) {
          state.inputFiles.forEach((file) => {
            if (file !== inputFile) {
              this.fileList.add(OUTPUT_FILES_ID, file);
            }
          });
        }
      }
    }

    const openedFiles = this.state.get()?.openedFiles ?? [];
    openedFiles.forEach((file) => {
      this.fileList.add(OUTPUT_FILES_ID, file);
    });

    this.state.save();
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
      updateChevronIcon(toggleIcon, shouldShow);
    }
  }
}

export const outputFilesManager = new OutputFilesManager(
  mainViewState,
  fileList,
  fileSelect,
);
