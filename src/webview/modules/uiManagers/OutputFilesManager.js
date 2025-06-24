// Local imports
import { safeGetElementById } from '@common/domUtils.js';
import {
  CHEVRON_UP_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/webviewContext.js';
import { webviewState } from '../webviewState.js';
import { fileList } from './FileList.js';
import { fileSelect } from './FileSelect.js';

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
    const inputFileDiv = safeGetElementById('inputFile');
    const outputFilesDiv = safeGetElementById('outputFiles');
    const inputFile = inputFileDiv?.value;

    if (inputFile && outputFilesDiv) {
      if (state.outputFiles && state.outputFiles.length > 0) {
        outputFilesDiv.innerHTML = '';
        state.outputFiles.forEach((file) => {
          this.fileList.add('outputFiles', file);
        });
      } else if (
        this.fileSelect.getAgentDefaultOutputFiles().length > 0 &&
        (!state.outputFiles || state.outputFiles.length === 0)
      ) {
        outputFilesDiv.innerHTML = '';
        this.fileSelect.getAgentDefaultOutputFiles().forEach((file) => {
          this.fileList.add('outputFiles', file);
        });
      } else {
        outputFilesDiv.innerHTML = '';
        this.fileList.add('outputFiles', inputFileDiv.value);
        if (state.inputFiles && state.inputFiles.length > 0) {
          state.inputFiles.forEach((file) => {
            if (file !== inputFile) {
              this.fileList.add('outputFiles', file);
            }
          });
        }
      }
    } else if (outputFilesDiv) {
      outputFilesDiv.innerHTML = '';
    }

    const openedFiles = this.state.get()?.openedFiles ?? [];
    openedFiles.forEach((file) => {
      this.fileList.add('outputFiles', file);
    });

    this.state.save();
  }

  /** Toggle visibility of the output files container */
  toggleOutputFiles() {
    const containerVisible =
      safeGetElementById('outputFilesContainer').style.display !== 'none';

    if (containerVisible) {
      this.fileList.toggle('outputFiles', 'toggleOutputFiles');
    } else {
      this.initializeOutputFiles();
      this.fileList.toggle('outputFiles', 'toggleOutputFiles');
    }
  }

  /** Initialize the output files container based on state */
  initializeOutputContainer() {
    const container = safeGetElementById('outputFilesContainer');
    const toggleIcon = safeGetElementById('toggleOutputFiles');

    if (container && toggleIcon) {
      const state = this.state.get();
      const shouldShow = state && state.outputFilesActive;

      container.style.display = shouldShow ? 'block' : 'none';
      toggleIcon.innerHTML = `<i class="${
        shouldShow ? CHEVRON_UP_CLASS : CHEVRON_DOWN_CLASS
      }"></i>`;
    }
  }
}

export const outputFilesManager = new OutputFilesManager(
  webviewState,
  fileList,
  fileSelect,
);
