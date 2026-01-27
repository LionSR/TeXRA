/**
 * LogList component - declarative log rendering.
 *
 * Receives data via properties and delegates rendering to TaskGroupList.
 * Handles event delegation for clicks, toggles, and file links.
 *
 * Uses Shadow DOM with modular styles for encapsulation.
 */

// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

// Local imports - side-effect: register component
import './TaskGroupList';

// Local imports - shared webview
import { postMessage } from '@shared/vscode';

// Local imports - shared utilities
import { copyWithFeedback } from '@shared/utils/clipboard';
import { ToggleStateStore } from '@shared/state/ToggleStateStore';
import { WebviewStateManager } from '@shared/state/WebviewStateManager';

// Local imports - shared styles
import { codiconStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - progress view constants
import { COMMANDS } from '../constants';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - progress view components (type-only for @query reference)
import type { TaskGroupList } from './TaskGroupList';

// Local imports - shared schemas
import type { LogMessageData, TaskGroup } from '@shared/schemas';

type LogListState = {
  groupToggleStates?: Array<[string, boolean]>;
  [key: string]: unknown;
};

@customElement('log-list')
export class LogList extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    ...logStyles,
  ];

  // Reactive properties - passed from parent
  @property({ type: Array }) groups: TaskGroup[] = [];
  @property({ type: Array }) messages: LogMessageData[] = [];
  @property({ type: String }) activeRunId: string | null = null;
  @property({ type: Boolean }) isToolUse = false;

  /** Reference to child TaskGroupList for scroll operations */
  @query('task-group-list')
  private taskGroupList?: TaskGroupList;

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

  override connectedCallback(): void {
    super.connectedCallback();
    // Use component-level listeners instead of document-level
    // Events bubble to the host element for delegated handling
    // Note: Toggle icon rotation is handled by CSS via details[open] selector
    this.addEventListener('click', this.handleClickEvent);
    this.addEventListener('file-click', this.handleFileClickEvent);
  }

  override disconnectedCallback(): void {
    this.removeEventListener('click', this.handleClickEvent);
    this.removeEventListener('file-click', this.handleFileClickEvent);
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
    // Scroll to bottom after render via public method on child component
    this.taskGroupList?.scrollToBottom();
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

  /** Handle click events for file links, copy buttons, etc. */
  private handleClickEvent = async (event: Event): Promise<void> => {
    if (!(event instanceof MouseEvent)) return;
    const fileLink = this.findTargetInPath<HTMLElement>(event, '.file-link');
    if (fileLink?.dataset.file) {
      postMessage(COMMANDS.OPEN_FILE, {
        file: fileLink.dataset.file,
        ...(fileLink.dataset.fileLine && {
          line: Number(fileLink.dataset.fileLine),
        }),
      });
      return;
    }

    const latexRef = this.findTargetInPath<HTMLElement>(event, '.latex-ref');
    if (latexRef?.dataset.label) {
      postMessage(COMMANDS.OPEN_LABEL, { label: latexRef.dataset.label });
      return;
    }

    const copyButton = this.findTargetInPath<HTMLElement>(
      event,
      '.banner-content-copy',
    );
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

    const codeBlockCopy = this.findTargetInPath<HTMLElement>(
      event,
      '.code-block-copy',
    );
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

  private findTargetInPath<T extends Element>(
    event: Event,
    selector: string,
  ): T | null {
    for (const node of event.composedPath()) {
      if (node instanceof Element && node.matches(selector)) {
        return node as T;
      }
    }
    return null;
  }

  /** Handle file-click events from Shadow DOM components. */
  private handleFileClickEvent = (event: Event): void => {
    const { file, line } = (
      event as CustomEvent<{ file: string; line?: number }>
    ).detail;
    if (file) {
      postMessage(COMMANDS.OPEN_FILE, {
        file,
        ...(line !== undefined && { line }),
      });
    }
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'log-list': LogList;
  }
}
