// Local imports - progress view
import { COMMANDS, ELEMENT_IDS } from '../constants.js';
import { progressViewState } from '../progressViewState.js';
import { copyWithFeedback } from '../utils.js';

// Local imports
import { addEventListenerSafely } from '@common/domUtils.js';
import { vscode } from '@common/webviewContext.js';

/**
 * Manages event handling and state application.
 */
export class EventsManager {
  /**
   * Sets up all event listeners for the UI
   */
  setupEventListeners() {
    // Stream tab selection handler (vscode-tree)
    addEventListenerSafely(
      ELEMENT_IDS.STREAM_TABS,
      'vsc-tree-select',
      (event) => {
        const detail = event.detail;
        const selectedItems = Array.isArray(detail)
          ? detail
          : Array.isArray(detail?.selection)
            ? detail.selection
            : [];
        const firstItem = selectedItems[0];
        const stream = firstItem?.dataset?.stream;
        if (!stream) {
          return;
        }
        vscode.postMessage({
          command: COMMANDS.SWITCH_STREAM,
          stream,
        });
      },
    );

    // Stream tab delete button handler
    addEventListenerSafely(
      ELEMENT_IDS.STREAM_TABS,
      'click',
      (e) => {
        // Use composedPath to handle shadow DOM clicks
        const path = e.composedPath();
        const deleteButton = path.find((el) =>
          el.classList?.contains('tab-delete'),
        );

        if (deleteButton?.dataset?.stream) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          vscode.postMessage({
            command: COMMANDS.DELETE_STREAM,
            stream: deleteButton.dataset.stream,
          });
        }
      },
      true,
    ); // Use capture phase

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
        if (element && element.dataset.command) {
          const data = { command: element.dataset.command };
          if (element.dataset.file) data.file = element.dataset.file;
          if (element.dataset.base) data.base = element.dataset.base;
          if (element.dataset.prev) data.prev = element.dataset.prev;
          vscode.postMessage(data);
        }
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
          const target = event?.target;
          const filter =
            typeof target?.value === 'string' && target.value
              ? target.value
              : radioGroup.value;
          if (!filter) {
            return;
          }
          if (progressViewState.agentTypeFilter !== filter) {
            progressViewState.agentTypeFilter = filter;
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

    // Track collapsible open state emitted by the VS Code elements component
    document.addEventListener(
      'vsc-collapsible-toggle',
      (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        if (
          target.classList.contains('banner-details') ||
          target.classList.contains('file-list-details') ||
          target.classList.contains('latexdiff-details') ||
          target.classList.contains('statistics-details')
        ) {
          // Tool-use entries also carry banner-details, so they flow through
          // this branch without needing a dedicated class check.
          const detail = /** @type {{ open?: boolean }} */ (e.detail);
          const isOpen =
            typeof detail?.open === 'boolean'
              ? detail.open
              : target.hasAttribute('open');
          target.dataset.isOpen = isOpen ? 'true' : 'false';
        }
      },
      true,
    );

    // Handle clicks on file links inside file-list-details blocks
    document.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) {
        return;
      }
      const link = e.target.closest('.file-link');
      if (link && link.dataset.file) {
        vscode.postMessage({
          command: COMMANDS.OPEN_FILE,
          file: link.dataset.file,
        });
      }
    });

    // Handle copy actions for banner content
    document.addEventListener('click', async (e) => {
      if (!(e.target instanceof Element)) {
        return;
      }
      const copyButton = e.target.closest('.banner-content-copy');
      if (!copyButton) {
        return;
      }

      // Prevent collapsible from toggling when clicking action buttons
      e.stopPropagation();

      const contentElem = copyButton
        .closest('.banner-details')
        ?.querySelector('.banner-content');
      if (!contentElem) {
        return;
      }

      const rawContent = contentElem.dataset.rawContent;
      const textToCopy = rawContent ?? contentElem.textContent ?? '';
      if (!textToCopy.trim()) {
        return;
      }

      await copyWithFeedback(copyButton, textToCopy, {
        defaultTitle:
          copyButton.dataset.defaultTitle ||
          copyButton.getAttribute('title') ||
          'Copy content',
        successTitle: copyButton.dataset.successTitle || 'Copied!',
      });
    });

    // Handle clicks on LaTeX references within logs
    document.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) {
        return;
      }
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
