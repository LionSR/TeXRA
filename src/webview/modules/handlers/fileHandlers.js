// Local imports - webview
import {
  FILE_TYPES,
  EDITED_FILE,
  BASE_FILE,
  ELEMENT_IDS,
} from '../constants.js';
import { mainViewState } from '../mainViewState.js';
import { fileList } from '../uiManagers/FileList.js';
import { fileSelect } from '../uiManagers/FileSelect.js';
import { safeSetElementValue } from '@common/domUtils.js';
import { capitalize, uncapitalize } from '@common/stringUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
// Local imports - utilities

/**
 * Create file related handlers.
 * @param {Object} ctx
 * @param {Function} ctx.postHandle
 * @param {Function} ctx.getElement
 * @param {Function} ctx.setToggleIcon
 */
export function createFileHandlers(ctx) {
  const { postHandle, getElement, setToggleIcon } = ctx;

  /**
   * Helper to get restoration options for a file select.
   * Captures current UI value and stored state value.
   */
  const getRestorationOptions = (domId) => {
    const selectDiv = getElement(domId);
    const state = mainViewState.get();
    return {
      currentValue: selectDiv?.value,
      storedValue: state?.[domId],
    };
  };

  const createSetFileHandler = (fileType, domId) => (message) => {
    const options = getRestorationOptions(domId);
    fileSelect.update(domId, message.files, options);
    postHandle();
  };

  const createFileSelectedHandler = (fileType, domId) => (message) => {
    safeSetElementValue(domId, message.filePath);
    postHandle();
  };

  const createSetFilesHandler = (fileType, listId, toggleId) => (message) => {
    fileList.update(listId, toggleId, message.files);
    postHandle();
  };

  const handlers = {};

  for (const fileType of FILE_TYPES) {
    const listId =
      fileType === 'output' ? ELEMENT_IDS.OUTPUT_FILES : `${fileType}Files`;
    const toggleId =
      fileType === 'output'
        ? ELEMENT_IDS.TOGGLE_OUTPUT_FILES
        : `toggle${capitalize(fileType)}Files`;

    handlers[MAIN_VIEW_COMMANDS[`SET_${fileType.toUpperCase()}_FILES`]] =
      createSetFilesHandler(fileType, listId, toggleId);

    if (fileType !== 'output') {
      const domId = `${fileType}File`;
      handlers[MAIN_VIEW_COMMANDS[`SET_${fileType.toUpperCase()}_FILE`]] =
        createSetFileHandler(fileType, domId);
      handlers[MAIN_VIEW_COMMANDS[`${fileType.toUpperCase()}_FILE_SELECTED`]] =
        createFileSelectedHandler(fileType, domId);
    }
  }

  handlers[MAIN_VIEW_COMMANDS.SET_EDITED_FILE] = createSetFileHandler(
    'edited',
    EDITED_FILE,
  );
  handlers[MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED] = createFileSelectedHandler(
    'edited',
    EDITED_FILE,
  );

  function handleAddMediaFile(message) {
    const listDiv = getElement('mediaFiles');
    const existingFiles = listDiv ? fileList.getSelected(listDiv) : [];
    fileList.update('mediaFiles', 'toggleMediaFiles', [
      ...existingFiles,
      message.file,
    ]);
    const container = getElement('mediaFilesContainer');
    if (container && container.style.display === 'none') {
      container.style.display = 'block';
      const toggleIcon = getElement('toggleMediaFiles');
      setToggleIcon(toggleIcon, true);
    }

    postHandle();
  }

  function handleSetDefaultOutputFiles(message) {
    fileSelect.setAgentDefaultOutputFiles(message.files || []);
    postHandle();
  }

  function handleSetRecentCommits(message) {
    fileSelect.handleRecentCommits(message);
    postHandle();
  }

  function handleSetCurrentFile(message) {
    fileSelect.handleSetCurrentFile({
      fileType: message.fileType,
      filePath: message.filePath,
    });
    postHandle();
  }

  function handleSetSelectedCommit(message) {
    fileSelect.handleSetSelectedCommit({
      commitHash: message.commitHash,
      commitLabel: message.commitLabel,
    });
    postHandle();
  }

  function handleSetOpenedFiles(message) {
    if (message.fileType) {
      const fileType = message.fileType.replace('Files', '');
      const singleFileId = `${uncapitalize(fileType)}File`;
      const multipleFileId = `${uncapitalize(fileType)}Files`;
      const toggleId = `toggle${capitalize(fileType)}Files`;

      let filesToAdd = message.files ?? [];
      if (message.shouldFilter) {
        const singleFileSelect = getElement(singleFileId);
        if (singleFileSelect && singleFileSelect.value) {
          filesToAdd = filesToAdd.filter((f) => f !== singleFileSelect.value);
        }
      }

      fileList.update(multipleFileId, toggleId, filesToAdd);
    }
    postHandle();
  }

  function handleSetBaseFile(message) {
    const currentBaseFileDiv = getElement(BASE_FILE);
    if (currentBaseFileDiv) {
      const options = getRestorationOptions(BASE_FILE);
      // Only restore currentValue if preserveBaseFile flag is set
      if (!message.preserveBaseFile) {
        options.currentValue = undefined;
      }
      fileSelect.update(BASE_FILE, message.files, options);
      // Read value after update to get the actual restored value
      fileSelect.updateEdited(currentBaseFileDiv.value);
    }
    postHandle();
  }

  handlers[MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES] =
    handleSetDefaultOutputFiles;
  handlers[MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE] = handleAddMediaFile;
  handlers[MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS] = handleSetRecentCommits;
  handlers[MAIN_VIEW_COMMANDS.SET_CURRENT_FILE] = handleSetCurrentFile;
  handlers[MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT] = handleSetSelectedCommit;
  handlers[MAIN_VIEW_COMMANDS.SET_OPENED_FILES] = handleSetOpenedFiles;
  handlers[MAIN_VIEW_COMMANDS.SET_BASE_FILE] = handleSetBaseFile;

  return handlers;
}
