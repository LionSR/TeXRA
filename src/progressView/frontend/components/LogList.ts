/**
 * LogList component - declarative log rendering.
 *
 * Consumes streamStateContext to get groups, messages, activeRunId, and isToolUse.
 * Delegates rendering to TaskGroupList.
 * Handles event delegation for clicks, toggles, and file links.
 *
 * Uses Shadow DOM with modular styles for encapsulation.
 */

// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, query, state } from 'lit/decorators.js';
import { z } from 'zod';

// Local imports - side-effect: register component
import './TaskGroupList';

// Local imports - shared webview
import { postMessage, vscode } from '@shared/vscode';

// Local imports - shared utilities
import { copyWithFeedback } from '@shared/utils/clipboard';
import { ToggleStateStore } from '@shared/state/ToggleStateStore';
import { PersistedState, createWebviewStorage } from '@shared/state';

// Local imports - shared styles
import { codiconStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - progress view constants
import { COMMANDS } from '../constants';

// Local imports - progress view contexts
import {
  streamStateContext,
  type StreamContextValue,
} from '../contexts/streamContexts';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - progress view formatters
import { getCopyContent } from '../formatters/copyContentStore';

// Local imports - progress view components (type-only for @query reference)
import type { TaskGroupList } from './TaskGroupList';

// Local imports - shared schemas
import type { LogMessageData, TaskGroup } from '@shared/schemas';

const LogListStateSchema = z
  .object({
    groupToggleStates: z.array(z.tuple([z.string(), z.boolean()])).catch([]),
  })
  .catch({ groupToggleStates: [] });

type LogListState = z.infer<typeof LogListStateSchema>;

@customElement('log-list')
export class LogList extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    ...logStyles,
  ];

  // Context consumption - state provided by ProgressApp
  @consume({ context: streamStateContext, subscribe: true })
  @state()
  private streamContext?: StreamContextValue;

  // Computed getters from context
  private get groups(): TaskGroup[] {
    return this.streamContext?.streamState?.taskGroups ?? [];
  }

  private get messages(): LogMessageData[] {
    return this.streamContext?.streamState?.logs ?? [];
  }

  private get activeRunId(): string | null {
    return this.streamContext?.runId ?? null;
  }

  private get isToolUse(): boolean {
    return this.streamContext?.isToolUse ?? false;
  }

  /** Reference to child TaskGroupList for scroll operations */
  @query('task-group-list')
  private taskGroupList?: TaskGroupList;

  // Non-reactive state
  private storage = createWebviewStorage(vscode);
  private stateManager?: PersistedState<LogListState>;
  private toggleStates: ToggleStateStore;
  private activeStreamId: string | null = null;

  constructor() {
    super();
    this.toggleStates = new ToggleStateStore(() => this.saveToggleStates());
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

  protected willUpdate(): void {
    const streamId = this.streamContext?.streamInfo?.name ?? null;
    if (streamId === this.activeStreamId) {
      return;
    }
    this.activeStreamId = streamId;
    this.initializeState(streamId);
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
    // Scroll to bottom after render if the user is already near the end
    this.taskGroupList?.scrollToBottomIfNearEnd();
  }

  // ============================================================
  // Private methods
  // ============================================================

  private saveToggleStates(): void {
    if (!this.stateManager) {
      return;
    }
    try {
      this.stateManager.update({
        groupToggleStates: this.toggleStates.entries(),
      });
    } catch (error) {
      console.error('[LogList] Failed to save toggle states', error);
    }
  }

  private initializeState(streamId: string | null): void {
    this.toggleStates = new ToggleStateStore(() => this.saveToggleStates());
    if (!streamId) {
      this.stateManager = undefined;
      return;
    }
    const storageKey = `logListState:${streamId}`;
    this.stateManager = new PersistedState(
      this.storage,
      storageKey,
      LogListStateSchema,
    );
    const previous = this.stateManager.getState();
    if (previous.groupToggleStates.length > 0) {
      this.toggleStates.load(previous.groupToggleStates);
    }
  }

  /** Handle click events for file links, copy buttons, etc. */
  private async handleClickEvent(event: Event): Promise<void> {
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

    // Handle copy buttons - content is stored in the copy registry
    const copyButton = this.findTargetInPath<HTMLElement>(
      event,
      '[data-copy-id]',
    );
    if (copyButton) {
      event.stopPropagation();
      const copyId = copyButton.dataset.copyId ?? '';
      const textToCopy = copyId ? (getCopyContent(copyId) ?? '') : '';
      if (!textToCopy.trim()) return;

      const isCodeBlock = copyButton.dataset.copyType === 'code-block';
      await copyWithFeedback(copyButton, textToCopy, {
        defaultTitle:
          copyButton.dataset.defaultTitle ||
          copyButton.getAttribute('title') ||
          'Copy to clipboard',
        successTitle: copyButton.dataset.successTitle || 'Copied!',
        successClass: isCodeBlock ? 'copied' : undefined,
      });
    }
  }

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
  private handleFileClickEvent(event: Event): void {
    const { file, line } = (
      event as CustomEvent<{ file: string; line?: number }>
    ).detail;
    if (file) {
      postMessage(COMMANDS.OPEN_FILE, {
        file,
        ...(line !== undefined && { line }),
      });
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'log-list': LogList;
  }
}
