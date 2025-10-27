// Local imports - webview
import { INPUT_FILE, ELEMENT_IDS } from '../constants.js';
import { mainViewState } from '../mainViewState.js';
import { fileList } from './FileList.js';
import { fileSelect } from './FileSelect.js';
import { safeGetElementById } from '@common/domUtils.js';

const INPUT_FILE_ID = INPUT_FILE;
const OUTPUT_FILES_ID = ELEMENT_IDS.OUTPUT_FILES;
const OUTPUT_FILES_CONTAINER_ID = ELEMENT_IDS.OUTPUT_FILES_CONTAINER;

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

    if (outputFilesDiv.children.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.className = 'file-list-placeholder';
      placeholder.textContent =
        'No extra outputs selected. Click "Add" to choose files.';
      outputFilesDiv.appendChild(placeholder);
    }

    this.state.save();
  }

  /** Initialize the output files container based on state */
  initializeOutputContainer() {
    const container = safeGetElementById(OUTPUT_FILES_CONTAINER_ID);
    if (!container) return;

    const state = this.state.get();
    const shouldShow = Boolean(state && state.outputFilesActive);

    if (shouldShow) {
      container.setAttribute('open', '');
    } else {
      container.removeAttribute('open');
    }
  }
}

export const outputFilesManager = new OutputFilesManager(
  mainViewState,
  fileList,
  fileSelect,
);
