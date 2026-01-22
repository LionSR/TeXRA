// Local imports - progress view
import { COMMANDS, ELEMENT_IDS, GROUP_DOM_IDS } from '../constants.js';
import { progressViewState } from '../progressViewState.js';

// Local imports - common
import { copyWithFeedback } from '@common/clipboardUtils.js';
import {
  addEventListenerSafely,
  setChevronIconHorizontal,
} from '@common/domUtils.js';
import { vscode } from '@common/webviewContext.js';

// Classes that support toggle icon updates
const TOGGLE_ICON_CLASSES = [
  'banner-details',
  'file-list-details',
  'latexdiff-details',
  'statistics-details',
];

/**
 * Manages event handling and state application.
 */
export class EventsManager {
  /**
   * Apply saved toggle states to any groups already in the DOM
   */
  applyToggleStates() {
    const taskGroups = progressViewState.taskGroups.getGroupMap();
    for (const [groupId] of taskGroups) {
      const isCollapsed = progressViewState.toggleStates.get(groupId);
      const detailsElem = document.getElementById(
        `${GROUP_DOM_IDS.DETAILS_PREFIX}${groupId}`,
      );

      if (detailsElem && isCollapsed !== undefined) {
        detailsElem.open = !isCollapsed;
      }
    }
  }

  /**
   * Sets up all event listeners for the UI
   */
  setup() {
    // Stream tab click handler
    addEventListenerSafely(ELEMENT_IDS.STREAM_TABS, 'click', (e) => {
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
    addEventListenerSafely(ELEMENT_IDS.TOOLBAR_CONTAINER, 'click', (e) => {
      const button = e.target.closest('[data-command]');
      if (!button || button.disabled) return;

      const command = button.dataset.command;
      const activeStream = progressViewState.activeStream;

      if (activeStream) {
        vscode.postMessage({ command, stream: activeStream });
      }
    });

    // File list button handler
    addEventListenerSafely(
      ELEMENT_IDS.GENERATED_FILES,
      'click',
      (e) => {
        const element = e.target.closest('[data-command]');
        if (!element?.dataset.command) return;

        const { command, file, base, prev } = element.dataset;
        vscode.postMessage({
          command,
          ...(file && { file }),
          ...(base && { base }),
          ...(prev && { prev }),
        });
      },
      true,
    );

    // Delete all button handler
    addEventListenerSafely(ELEMENT_IDS.DELETE_ALL_BTN, 'click', () => {
      vscode.postMessage({ command: COMMANDS.DELETE_ALL });
    });

    addEventListenerSafely('sortButtons', 'click', (e) => {
      const btn = e.target.closest('.sort-btn');
      if (btn && btn.dataset.sort) {
        vscode.postMessage({
          command: COMMANDS.SORT_STREAMS,
          sortBy: btn.dataset.sort,
        });
      }
    });

    // Handle agent filter radio group changes
    const radioGroup = document.getElementById(
      ELEMENT_IDS.AGENT_FILTER_CONTAINER,
    );
    if (radioGroup) {
      const attachRadioListener = () => {
        addEventListenerSafely(radioGroup, 'change', (event) => {
          if (!(event?.target instanceof Element)) {
            return;
          }

          const selectedRadio =
            event.target.closest('vscode-radio') ||
            radioGroup.querySelector('vscode-radio[checked]');
          const filter =
            selectedRadio?.value || selectedRadio?.getAttribute('value') || '';

          if (!filter) {
            return;
          }

          if (progressViewState.agentCategoryFilter !== filter) {
            progressViewState.agentCategoryFilter = filter;
            progressViewState.pendingFilterUpdate = true;
            // Persist the new selection immediately so updates don't snap back
            vscode.postMessage({
              command: COMMANDS.FILTER_STREAMS,
              filter,
            });
          }
        });
      };

      // Wait for web component to be ready if needed
      if (radioGroup.updateComplete) {
        radioGroup.updateComplete.then(attachRadioListener);
      } else {
        attachRadioListener();
      }
    }

    // Handle toggle events for collapsible details elements
    document.addEventListener(
      'toggle',
      (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }

        const hasToggleClass = TOGGLE_ICON_CLASSES.some((cls) =>
          target.classList.contains(cls),
        );
        if (!hasToggleClass) return;

        const toggleIcon = target.querySelector('.toggle-icon');
        if (toggleIcon) {
          setChevronIconHorizontal(toggleIcon, target.open);
        }
      },
      true,
    );

    // Unified click handler for document-level interactions
    document.addEventListener('click', async (e) => {
      if (!(e.target instanceof Element)) return;

      // File link clicks
      const fileLink = e.target.closest('.file-link');
      if (fileLink?.dataset.file) {
        const message = {
          command: COMMANDS.OPEN_FILE,
          file: fileLink.dataset.file,
        };
        // Include line number if specified
        if (fileLink.dataset.fileLine) {
          message.line = parseInt(fileLink.dataset.fileLine, 10);
        }
        vscode.postMessage(message);
        return;
      }

      // LaTeX reference clicks
      const latexRef = e.target.closest('.latex-ref');
      if (latexRef?.dataset.label) {
        vscode.postMessage({
          command: COMMANDS.OPEN_LABEL,
          label: latexRef.dataset.label,
        });
        return;
      }

      // Banner content copy
      const copyButton = e.target.closest('.banner-content-copy');
      if (copyButton) {
        e.stopPropagation();
        const contentElem = copyButton
          .closest('.banner-details')
          ?.querySelector('.banner-content');
        if (!contentElem) return;

        const textToCopy =
          contentElem.dataset.rawContent ?? contentElem.textContent ?? '';
        if (!textToCopy.trim()) return;

        await copyWithFeedback(copyButton, textToCopy, {
          defaultTitle:
            copyButton.dataset.defaultTitle ||
            copyButton.getAttribute('title') ||
            'Copy content',
          successTitle: copyButton.dataset.successTitle || 'Copied!',
        });
        return;
      }

      // Code block copy button
      const codeBlockCopy = e.target.closest('.code-block-copy');
      if (codeBlockCopy) {
        e.stopPropagation();
        const codeBlock = codeBlockCopy.closest('.code-block');
        const codeElem = codeBlock?.querySelector('code');
        if (!codeElem) return;

        const textToCopy = codeElem.textContent ?? '';
        if (!textToCopy.trim()) return;

        await copyWithFeedback(codeBlockCopy, textToCopy, {
          defaultTitle: 'Copy to clipboard',
          successTitle: 'Copied!',
          successClass: 'copied',
        });
      }
    });
  }
}
