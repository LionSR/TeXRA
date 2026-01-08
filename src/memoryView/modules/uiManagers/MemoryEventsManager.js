// Local imports - memory view
import { COMMANDS, ELEMENT_IDS } from '../constants.js';
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';

/**
 * Registers global event listeners for the memory view.
 */
export class MemoryEventsManager {
  constructor() {
    this.handlers = [];
  }

  setup() {
    const refreshHandler = () => {
      vscode.postMessage({ command: COMMANDS.GET_MEMORY_DATA });
    };
    addEventListenerSafely(
      ELEMENT_IDS.REFRESH_MEMORY_BTN,
      'click',
      refreshHandler,
    );
    const refreshButton = safeGetElementById(ELEMENT_IDS.REFRESH_MEMORY_BTN);
    if (refreshButton) {
      this.handlers.push({
        element: refreshButton,
        type: 'click',
        handler: refreshHandler,
      });
    }

    const openFolderHandler = () => {
      vscode.postMessage({ command: COMMANDS.OPEN_MEMORY_FOLDER });
    };
    addEventListenerSafely(
      ELEMENT_IDS.OPEN_MEMORY_FOLDER_BTN,
      'click',
      openFolderHandler,
    );
    const openFolderButton = safeGetElementById(
      ELEMENT_IDS.OPEN_MEMORY_FOLDER_BTN,
    );
    if (openFolderButton) {
      this.handlers.push({
        element: openFolderButton,
        type: 'click',
        handler: openFolderHandler,
      });
    }

    const list = safeGetElementById(ELEMENT_IDS.MEMORY_LIST);
    if (!list) {
      return;
    }

    const listHandler = (event) => {
      const target = event.target.closest('[data-command]');
      if (!target) {
        return;
      }

      const command = target.dataset.command;
      const storagePath = target.dataset.path;
      if (command === COMMANDS.OPEN_MEMORY_FILE && storagePath) {
        vscode.postMessage({ command, storagePath });
      }
    };

    list.addEventListener('click', listHandler);
    this.handlers.push({ element: list, type: 'click', handler: listHandler });
  }

  dispose() {
    this.handlers.forEach(({ element, type, handler }) => {
      element.removeEventListener(type, handler);
    });
    this.handlers = [];
  }
}
