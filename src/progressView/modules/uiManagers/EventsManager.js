// Third-party imports
import Split from 'split.js';
// Local imports
import { progressViewState } from '../progressViewState.js';
import { COMMANDS, SPLIT_SIZES, ELEMENT_IDS } from '../constants.js';
import {
  CHEVRON_RIGHT_CLASS,
  CHEVRON_DOWN_CLASS,
  vscode,
} from '@common/webviewContext.js';

/**
 * Manages event handling and state application.
 */
export class EventsManager {
  /**
   * Apply saved toggle states to any groups already in the DOM
   */
  applyToggleStates() {
    const taskGroups = progressViewState.taskGroups.getAll();
    for (const [groupId, _] of taskGroups) {
      const isCollapsed = progressViewState.toggleStates.get(groupId);
      const detailsElem = document.getElementById(`group-${groupId}`);

      if (detailsElem && isCollapsed !== undefined) {
        detailsElem.open = !isCollapsed;
      }
    }
  }

  /**
   * Sets up all event listeners for the UI
   */
  setupEventListeners() {
    // Stream tab click handler
    document
      .getElementById(ELEMENT_IDS.STREAM_TABS)
      .addEventListener('click', (e) => {
        const tabButton = e.target.closest('.tab');
        const deleteButton = e.target.closest('.tab-delete');

        if (tabButton && tabButton.dataset.stream) {
          vscode.postMessage({
            command: COMMANDS.SWITCH_STREAM,
            stream: tabButton.dataset.stream,
          });
        } else if (deleteButton && deleteButton.dataset.stream) {
          vscode.postMessage({
            command: COMMANDS.DELETE_STREAM,
            stream: deleteButton.dataset.stream,
          });
        }
      });

    // Toolbar click handler
    document
      .getElementById(ELEMENT_IDS.TOOLBAR_CONTAINER)
      .addEventListener('click', (e) => {
        const button = e.target.closest('button[data-command]');
        if (!button || button.disabled) return;

        const command = button.dataset.command;
        const activeStream = progressViewState.getActiveStream();

        if (activeStream) {
          vscode.postMessage({ command, stream: activeStream });
        }
      });

    // File list toggle - removed as filesToggle element doesn't exist in the HTML
    // This appears to be orphaned code from a previous design

    // File list button handler
    document.getElementById(ELEMENT_IDS.GENERATED_FILES).addEventListener(
      'click',
      (e) => {
        const button = e.target.closest('button');
        if (button && button.dataset.command) {
          const data = { command: button.dataset.command };
          if (button.dataset.file) data.file = button.dataset.file;
          if (button.dataset.base) data.base = button.dataset.base;
          vscode.postMessage(data);
        }
      },
      true,
    );

    // Delete all button handler
    const deleteAllBtn = document.getElementById(ELEMENT_IDS.DELETE_ALL_BTN);
    if (deleteAllBtn) {
      deleteAllBtn.addEventListener('click', () => {
        vscode.postMessage({ command: COMMANDS.DELETE_ALL });
      });
    }

    // Initialize split view
    Split(['.content-area', '.tabs'], {
      sizes: [SPLIT_SIZES.CONTENT, SPLIT_SIZES.TABS],
      minSize: [200, 100],
      gutterSize: 5,
      cursor: 'col-resize',
    });

    // Handle special-details and file-list-details toggle events
    document.addEventListener(
      'toggle',
      (e) => {
        if (
          e.target &&
          (e.target.classList.contains('special-details') ||
            e.target.classList.contains('file-list-details') ||
            e.target.classList.contains('latexdiff-details'))
        ) {
          const toggleIcon = e.target.querySelector('.toggle-icon');
          if (toggleIcon) {
            const isOpen = e.target.open;
            toggleIcon.className = `${
              isOpen ? CHEVRON_DOWN_CLASS : CHEVRON_RIGHT_CLASS
            } toggle-icon`;
          }
        }
      },
      true,
    );

    // Handle clicks on file links inside file-list-details blocks
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.file-link');
      if (link && link.dataset.file) {
        vscode.postMessage({
          command: COMMANDS.OPEN_FILE,
          file: link.dataset.file,
        });
      }
    });

    // Handle clicks on LaTeX references within logs
    document.addEventListener('click', (e) => {
      const ref = e.target.closest('.latex-ref');
      if (ref && ref.dataset.label) {
        vscode.postMessage({
          command: COMMANDS.OPEN_LABEL,
          label: ref.dataset.label,
        });
      }
    });
  }
}
