// Local imports - webview
import { INPUT_FILE, ELEMENT_IDS } from '../constants.js';
import { mainViewState } from '../mainViewState.js';
import { fileList } from './FileList.js';
import { fileSelect } from './FileSelect.js';
import { safeGetElementById } from '@common/domUtils.js';

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

  /** Hydrate the output files list and container from persisted state */
  hydrate(persistedState = this.state.get() ?? {}, options = {}) {
    const { fallbackToAgentDefaults = true, visible } = options;

    const inputFileDiv = safeGetElementById(INPUT_FILE_ID);
    const outputFilesDiv = safeGetElementById(OUTPUT_FILES_ID);
    if (!outputFilesDiv) return;

    const inputFile = inputFileDiv?.value;
    const stateOutputs = Array.isArray(persistedState.outputFiles)
      ? persistedState.outputFiles.filter(Boolean)
      : [];

    const derivedOutputs = [...stateOutputs];

    if (derivedOutputs.length === 0 && fallbackToAgentDefaults && inputFile) {
      const agentDefaults = this.fileSelect.getAgentDefaultOutputFiles();
      if (agentDefaults.length > 0) {
        agentDefaults.forEach((file) => {
          if (!derivedOutputs.includes(file)) {
            derivedOutputs.push(file);
          }
        });
      } else {
        derivedOutputs.push(inputFile);
        const additionalInputs = Array.isArray(persistedState.inputFiles)
          ? persistedState.inputFiles
          : [];
        additionalInputs.forEach((file) => {
          if (file && file !== inputFile && !derivedOutputs.includes(file)) {
            derivedOutputs.push(file);
          }
        });
      }
    }

    const openedFiles = Array.isArray(persistedState.openedFiles)
      ? persistedState.openedFiles
      : [];
    openedFiles.forEach((file) => {
      if (file && !derivedOutputs.includes(file)) {
        derivedOutputs.push(file);
      }
    });

    const visibility =
      typeof visible === 'boolean'
        ? visible
        : Boolean(
            persistedState.outputFilesActive ??
              persistedState.outputFilesVisible,
          );

    this.fileList.hydrate(OUTPUT_FILES_ID, {
      files: derivedOutputs,
      visible: visibility,
      placeholder: 'No extra outputs selected. Click "Add" to choose files.',
    });

    const listDiv = safeGetElementById(OUTPUT_FILES_ID);
    if (listDiv) {
      const resolvedOutputs = this.fileList.getSelected(listDiv);
      this.state.update({
        outputFiles: resolvedOutputs,
        outputFilesActive: visibility,
      });
    }
  }

  /** Toggle visibility of the output files container */
  toggleOutputFiles() {
    const container = safeGetElementById(OUTPUT_FILES_CONTAINER_ID);
    if (!container) return;

    const containerVisible = container.style.display !== 'none';

    if (!containerVisible) {
      this.hydrate(this.state.get(), { fallbackToAgentDefaults: true });
    }

    this.fileList.toggle(OUTPUT_FILES_ID, TOGGLE_OUTPUT_FILES_ID);
  }
}

export const outputFilesManager = new OutputFilesManager(
  mainViewState,
  fileList,
  fileSelect,
);
mainViewState.registerOutputFilesManager(outputFilesManager);
