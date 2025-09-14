// Local imports - webview
import {
  FILE_TYPES,
  INPUT_FILE,
  REFERENCE_FILE,
  AUXILIARY_FILE,
  MEDIA_FILE,
  EDITED_FILE,
  BASE_FILE,
  ELEMENT_IDS,
} from '../constants.js';
import { mainViewState } from '../mainViewState.js';
import { fileList } from '../uiManagers/FileList.js';
import { fileSelect } from '../uiManagers/FileSelect.js';
import { safeSetElementValue } from '@common/domUtils.js';
import {
  getSingleFileId,
  getMultipleFilesId,
  getMultipleFilesContainerId,
  getToggleId,
} from '@common/domIdUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
// Local imports - utilities
import { vscode } from '@common/webviewContext.js';

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

  function handleSetInputFile(message) {
    fileSelect.update(INPUT_FILE, message.files);
    postHandle();
  }

  function handleSetReferenceFile(message) {
    fileSelect.update(REFERENCE_FILE, message.files);
    postHandle();
  }

  function handleSetAuxiliaryFile(message) {
    fileSelect.update(AUXILIARY_FILE, message.files);
    postHandle();
  }

  function handleSetMediaFile(message) {
    fileSelect.update(MEDIA_FILE, message.files);
    postHandle();
  }

  function handleSetEditedFile(message) {
    fileSelect.update(EDITED_FILE, message.files);
    postHandle();
  }

  function handleInputFileSelected(message) {
    safeSetElementValue(INPUT_FILE, message.filePath);
    postHandle();
  }

  function handleReferenceFileSelected(message) {
    safeSetElementValue(REFERENCE_FILE, message.filePath);
    postHandle();
  }

  function handleAuxiliaryFileSelected(message) {
    safeSetElementValue(AUXILIARY_FILE, message.filePath);
    postHandle();
  }

  function handleMediaFileSelected(message) {
    safeSetElementValue(MEDIA_FILE, message.filePath);
    postHandle();
  }

  function handleEditedFileSelected(message) {
    safeSetElementValue(EDITED_FILE, message.filePath);
    postHandle();
  }

  function handleSetDefaultOutputFiles(message) {
    fileSelect.setAgentDefaultOutputFiles(message.files || []);
    postHandle();
  }

  function handleSetInputFiles(message) {
    const listId = getMultipleFilesId('input');
    fileList.update(listId, getToggleId(listId), message.files);
    const listEl = getElement(listId);
    if (listEl) {
      setupFileListHandler('input', listEl);
    }
    postHandle();
  }

  function handleSetReferenceFiles(message) {
    const listId = getMultipleFilesId('reference');
    fileList.update(listId, getToggleId(listId), message.files);
    const listEl = getElement(listId);
    if (listEl) {
      setupFileListHandler('reference', listEl);
    }
    postHandle();
  }

  function handleSetAuxiliaryFiles(message) {
    const listId = getMultipleFilesId('auxiliary');
    fileList.update(listId, getToggleId(listId), message.files);
    const listEl = getElement(listId);
    if (listEl) {
      setupFileListHandler('auxiliary', listEl);
    }
    postHandle();
  }

  function handleSetMediaFiles(message) {
    const listId = getMultipleFilesId('media');
    fileList.update(listId, getToggleId(listId), message.files);
    const listEl = getElement(listId);
    if (listEl) {
      setupFileListHandler('media', listEl);
    }
    postHandle();
  }

  function handleAddMediaFile(message) {
    const listId = getMultipleFilesId('media');
    const listDiv = getElement(listId);
    const existingFiles = listDiv ? fileList.getSelected(listDiv) : [];
    fileList.update(listId, getToggleId(listId), [
      ...existingFiles,
      message.file,
    ]);
    if (listDiv) {
      setupFileListHandler('media', listDiv);
    }

    const container = getElement(getMultipleFilesContainerId('media'));
    if (container && container.style.display === 'none') {
      container.style.display = 'block';
      const toggleIcon = getElement(getToggleId(listId));
      setToggleIcon(toggleIcon, true);
    }

    postHandle();
  }

  function handleSetOutputFiles(message) {
    fileList.update(
      ELEMENT_IDS.OUTPUT_FILES,
      ELEMENT_IDS.TOGGLE_OUTPUT_FILES,
      message.files,
    );
    const outputEl = getElement(ELEMENT_IDS.OUTPUT_FILES);
    if (outputEl) {
      setupFileListHandler('output', outputEl);
    }
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

  function handleSetOpenedFiles(message) {
    if (message.fileType) {
      const fileType = message.fileType.replace('Files', '');
      const singleFileId = getSingleFileId(fileType);
      const multipleFileId = getMultipleFilesId(fileType);
      const toggleId = getToggleId(multipleFileId);

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

  return {
    // single file
    [MAIN_VIEW_COMMANDS.SET_INPUT_FILE]: handleSetInputFile,
    [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILE]: handleSetReferenceFile,
    [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILE]: handleSetAuxiliaryFile,
    [MAIN_VIEW_COMMANDS.SET_MEDIA_FILE]: handleSetMediaFile,
    [MAIN_VIEW_COMMANDS.SET_EDITED_FILE]: handleSetEditedFile,
    [MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED]: handleInputFileSelected,
    [MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED]: handleReferenceFileSelected,
    [MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED]: handleAuxiliaryFileSelected,
    [MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED]: handleMediaFileSelected,
    [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: handleEditedFileSelected,
    [MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES]: handleSetDefaultOutputFiles,
    // multi file
    [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: handleSetInputFiles,
    [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES]: handleSetReferenceFiles,
    [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES]: handleSetAuxiliaryFiles,
    [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: handleSetMediaFiles,
    [MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE]: handleAddMediaFile,
    [MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES]: handleSetOutputFiles,
    // misc
    [MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS]: handleSetRecentCommits,
    [MAIN_VIEW_COMMANDS.SET_CURRENT_FILE]: handleSetCurrentFile,
    [MAIN_VIEW_COMMANDS.SET_OPENED_FILES]: handleSetOpenedFiles,
    [MAIN_VIEW_COMMANDS.SET_BASE_FILE]: handleSetBaseFile,
  };
}
