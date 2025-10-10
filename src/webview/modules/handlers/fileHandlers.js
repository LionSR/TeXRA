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
 * @param {Function} ctx.setupFileListHandler
 */
export function createFileHandlers(ctx) {
  const { postHandle, getElement, setToggleIcon, setupFileListHandler } = ctx;
  const createSetFileHandler = (fileType, domId) => (message) => {
    fileSelect.update(domId, message.files);
    postHandle();
  };

  const createFileSelectedHandler = (fileType, domId) => (message) => {
    safeSetElementValue(domId, message.filePath);
    postHandle();
  };

  const createSetFilesHandler = (fileType, listId, toggleId) => (message) => {
    fileList.update(listId, toggleId, message.files);
    const listEl = getElement(listId);
    if (listEl) {
      setupFileListHandler(fileType, listEl);
    }
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
    if (listDiv) {
      setupFileListHandler('media', listDiv);
    }

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
      const currentBaseFile = currentBaseFileDiv.value;
      fileSelect.update(BASE_FILE, message.files);

      const state = mainViewState.get();
      const storedBaseFile = state?.baseFile;

      if (storedBaseFile && message.files.includes(storedBaseFile)) {
        currentBaseFileDiv.value = storedBaseFile;
      } else if (
        message.preserveBaseFile &&
        currentBaseFile &&
        message.files.includes(currentBaseFile)
      ) {
        currentBaseFileDiv.value = currentBaseFile;
      }

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
