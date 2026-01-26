/**
 * LogList component - declarative log rendering.
 *
 * Receives data via properties and delegates rendering to TaskGroupList.
 * Handles event delegation for clicks, toggles, and file links.
 */

// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - side-effect: register component
import './TaskGroupList';

// Local imports - shared webview
import { postMessage } from '@shared/vscode';

// Local imports - shared utilities
import { copyWithFeedback } from '@shared/utils/clipboard';
import { scrollToBottom, setChevronIconHorizontal } from '@shared/utils/dom';
import { ToggleStateStore } from '@shared/state/ToggleStateStore';
import { WebviewStateManager } from '@shared/state/WebviewStateManager';

// Local imports - progress view constants
import { COMMANDS, ELEMENT_IDS } from '../constants';

// Local imports - shared schemas
import type { LogMessageData, TaskGroup } from '@shared/schemas';

type LogListState = {
  groupToggleStates?: Array<[string, boolean]>;
  [key: string]: unknown;
};

@customElement('log-list')
export class LogList extends LitElement {
  // Reactive properties - passed from parent
  @property({ type: Array }) groups: TaskGroup[] = [];
  @property({ type: Array }) messages: LogMessageData[] = [];
  @property({ type: String }) activeRunId: string | null = null;
  @property({ type: Boolean }) isToolUse = false;

  // Non-reactive state
  private stateManager: WebviewStateManager<LogListState>;
  private toggleStates: ToggleStateStore;

  constructor() {
    super();
    this.stateManager = new WebviewStateManager<LogListState>();
    const previous = this.stateManager.getState();
    this.toggleStates = new ToggleStateStore(() => this.saveToggleStates());
    if (Array.isArray(previous?.groupToggleStates)) {
      this.toggleStates.load(previous.groupToggleStates);
    }
  }

  protected override createRenderRoot(): HTMLElement {
    // Use Light DOM for CSS compatibility with existing styles
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Use component-level listeners instead of document-level
    // Since LogList uses Light DOM, events bubble naturally to this element
    this.addEventListener('toggle', this.handleToggleEvent, { capture: true });
    this.addEventListener('click', this.handleClickEvent as EventListener);
    this.addEventListener(
      'file-click',
      this.handleFileClickEvent as EventListener,
    );
  }

  override disconnectedCallback(): void {
    this.removeEventListener('toggle', this.handleToggleEvent, {
      capture: true,
    });
    this.removeEventListener('click', this.handleClickEvent as EventListener);
    this.removeEventListener(
      'file-click',
      this.handleFileClickEvent as EventListener,
    );
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    return html`
      <task-group-list
        .groups=${this.groups}
        .messages=${this.messages}
        .activeRunId=${this.activeRunId}
        ?isToolUse=${this.isToolUse}
        .toggleStates=${this.toggleStates}
      ></task-group-list>
    `;
  }

  override updated(): void {
    // Scroll to bottom after render
    const container = this.querySelector(`#${ELEMENT_IDS.LOG_CONTENT}`);
    if (container instanceof HTMLElement) {
      scrollToBottom(container);
    }
  }

  // ============================================================
  // Private methods
  // ============================================================

  private saveToggleStates(): void {
    try {
      this.stateManager.update({
        groupToggleStates: this.toggleStates.entries(),
      });
    } catch (error) {
      console.error('[LogList] Failed to save toggle states', error);
    }
  }

  /** Handle details toggle events for chevron icon rotation */
  private handleToggleEvent = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const hasToggleClass = [
      'banner-details',
      'file-list-details',
      'latexdiff-details',
      'statistics-details',
    ].some((cls) => target.classList.contains(cls));
    if (!hasToggleClass) return;

    const toggleIcon = target.querySelector('.toggle-icon');
    if (
      toggleIcon instanceof HTMLElement &&
      target instanceof HTMLDetailsElement
    ) {
      setChevronIconHorizontal(toggleIcon, target.open);
    }
  };

  /** Handle click events for file links, copy buttons, etc. */
  private handleClickEvent = async (event: MouseEvent): Promise<void> => {
    const target = event.target as Element | null;
    if (!target) return;

    const fileLink = target.closest('.file-link') as HTMLElement | null;
    if (fileLink?.dataset.file) {
      postMessage(COMMANDS.OPEN_FILE, {
        file: fileLink.dataset.file,
        ...(fileLink.dataset.fileLine && {
          line: Number(fileLink.dataset.fileLine),
        }),
      });
      return;
    }

    const latexRef = target.closest('.latex-ref') as HTMLElement | null;
    if (latexRef?.dataset.label) {
      postMessage(COMMANDS.OPEN_LABEL, { label: latexRef.dataset.label });
      return;
    }

    const copyButton = target.closest(
      '.banner-content-copy',
    ) as HTMLElement | null;
    if (copyButton) {
      event.stopPropagation();
      const contentElem = copyButton
        .closest('.banner-details')
        ?.querySelector('.banner-content') as HTMLElement | null;
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

    const codeBlockCopy = target.closest(
      '.code-block-copy',
    ) as HTMLElement | null;
    if (codeBlockCopy) {
      event.stopPropagation();
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
  };

  /** Handle file-click events from Shadow DOM components. */
  private handleFileClickEvent = (
    event: CustomEvent<{ file: string; line?: number }>,
  ): void => {
    const { file, line } = event.detail;
    if (file) {
      postMessage(COMMANDS.OPEN_FILE, {
        file,
        ...(line !== undefined && { line }),
      });
    }
  };
}
